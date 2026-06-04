import ExcelJS from 'exceljs'
import path from 'node:path'
import { prisma } from '../plugins/db.js'
import { nameToPinyin } from '../utils/pinyin.js'
import { formatSecond } from '../utils/time.js'

const SCORE_IMPORT_EXTS = new Set(['.xlsx'])
const NAME_HEADERS = new Set(['姓名', '学生姓名', '名字', '学生', 'name', 'student'])
const IGNORED_HEADERS = new Set([
  '班级',
  '行政班',
  '行政班级',
  '教学班',
  '拼音',
  '拼音缩写',
  '缩写',
  '备注',
  'class',
  'homeclass',
  'pinyin',
])

function serviceError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function normalizeProjectName(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw serviceError('成绩项目名称不能为空')
  if (trimmed.length > 60) throw serviceError('成绩项目名称不能超过 60 个字符')
  return trimmed
}

function parseScoreValue(value) {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null
  const number = Number(raw)
  if (!Number.isFinite(number)) throw serviceError('成绩必须是有效数字')
  return number
}

function cellText(cell) {
  const value = cell?.value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('').trim()
    if (value.text !== undefined) return String(value.text).trim()
    if (value.result !== undefined) return String(value.result).trim()
    if (value.hyperlink !== undefined && value.text !== undefined) return String(value.text).trim()
    return String(value.toString?.() ?? '').trim()
  }
  return String(value).trim()
}

function cellScoreValue(cell) {
  const value = cell?.value
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'object' && value.result !== undefined) return parseScoreValue(value.result)
  return parseScoreValue(cellText(cell))
}

function sanitizeExcelValue(value) {
  const text = String(value ?? '')
  return /^[=+\-@]/.test(text) ? `'${text}` : text
}

function formatHomeClass(homeClass) {
  const value = String(homeClass || '').trim()
  if (!value) return ''
  return value.includes('班') ? value : `${value}班`
}

export function isAllowedScoreWorkbook(filename) {
  return SCORE_IMPORT_EXTS.has(path.extname(filename || '').toLowerCase())
}

export async function getScorebook(classId, { includeLogs = true } = {}) {
  const [cls, students, projects, scores, logs] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId }, select: { id: true, name: true } }),
    prisma.student.findMany({
      where: { classId },
      orderBy: [{ homeClass: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, homeClass: true, remark: true },
    }),
    prisma.scoreProject.findMany({
      where: { classId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, sortOrder: true, createdAt: true, updatedAt: true },
    }),
    prisma.studentScore.findMany({
      where: { project: { classId }, student: { classId } },
      select: { id: true, studentId: true, projectId: true, value: true, updatedAt: true },
    }),
    includeLogs
      ? prisma.scoreEntryLog.findMany({
          where: { project: { classId } },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            student: { select: { name: true, homeClass: true } },
            project: { select: { name: true } },
            teacher: { select: { username: true } },
          },
        })
      : Promise.resolve([]),
  ])

  if (!cls) throw serviceError('班级不存在', 404)

  const scoreMap = new Map(scores.map(score => [`${score.studentId}:${score.projectId}`, score]))

  return {
    class: cls,
    projects,
    students: students.map((student) => {
      const pinyin = nameToPinyin(student.name)
      const scoreValues = {}
      for (const project of projects) {
        const score = scoreMap.get(`${student.id}:${project.id}`)
        if (score) {
          scoreValues[project.id] = {
            id: score.id,
            value: score.value,
            updatedAt: score.updatedAt,
          }
        }
      }
      return {
        ...student,
        pinyin: {
          full: pinyin.full,
          initials: pinyin.initials,
          toned: pinyin.toned,
        },
        scores: scoreValues,
      }
    }),
    logs: logs.map(log => ({
      id: log.id,
      studentId: log.studentId,
      studentName: log.student?.name || '',
      homeClass: log.student?.homeClass || '',
      projectId: log.projectId,
      projectName: log.project?.name || '',
      teacherName: log.teacher?.username || '',
      oldValue: log.oldValue,
      newValue: log.newValue,
      createdAt: log.createdAt,
    })),
  }
}

export async function createScoreProject(classId, name) {
  const projectName = normalizeProjectName(name)
  const maxSort = await prisma.scoreProject.aggregate({
    where: { classId },
    _max: { sortOrder: true },
  })

  try {
    return await prisma.scoreProject.create({
      data: {
        classId,
        name: projectName,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
    })
  } catch (error) {
    if (error.code === 'P2002') throw serviceError('该成绩项目已存在', 409)
    throw error
  }
}

export async function saveStudentScore({ classId, studentId, projectId, value, teacherId = null }) {
  const parsedValue = parseScoreValue(value)

  return prisma.$transaction(async (tx) => {
    const [student, project] = await Promise.all([
      tx.student.findFirst({ where: { id: studentId, classId }, select: { id: true } }),
      tx.scoreProject.findFirst({ where: { id: projectId, classId }, select: { id: true } }),
    ])
    if (!student) throw serviceError('学生不属于当前班级', 404)
    if (!project) throw serviceError('成绩项目不存在', 404)

    const existing = await tx.studentScore.findUnique({
      where: { studentId_projectId: { studentId, projectId } },
    })
    const oldValue = existing?.value ?? null

    if (parsedValue === null) {
      if (existing) {
        await tx.studentScore.delete({ where: { id: existing.id } })
        await tx.scoreEntryLog.create({
          data: { projectId, studentId, teacherId, oldValue, newValue: null },
        })
      }
      return { ok: true, score: null }
    }

    if (existing && oldValue === parsedValue) {
      return { ok: true, score: existing }
    }

    const score = existing
      ? await tx.studentScore.update({
          where: { id: existing.id },
          data: { value: parsedValue },
        })
      : await tx.studentScore.create({
          data: { studentId, projectId, value: parsedValue },
        })

    await tx.scoreEntryLog.create({
      data: {
        projectId,
        studentId,
        scoreId: score.id,
        teacherId,
        oldValue,
        newValue: parsedValue,
      },
    })

    return { ok: true, score }
  })
}

async function findOrCreateProjects(classId, names) {
  const existing = await prisma.scoreProject.findMany({ where: { classId } })
  const byName = new Map(existing.map(project => [project.name, project]))
  const created = []

  for (const name of names) {
    if (byName.has(name)) continue
    const project = await createScoreProject(classId, name)
    byName.set(project.name, project)
    created.push(project.name)
  }

  return { byName, created }
}

function readImportShape(worksheet) {
  let headerRowNumber = 0
  let headers = []
  const maxProbeRows = Math.min(worksheet.rowCount, 10)

  for (let rowNumber = 1; rowNumber <= maxProbeRows; rowNumber++) {
    const row = worksheet.getRow(rowNumber)
    const values = []
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      values[colNumber] = cellText(cell)
    })
    const normalized = values.map(value => String(value || '').trim())
    if (normalized.some(value => NAME_HEADERS.has(value.toLowerCase()) || NAME_HEADERS.has(value))) {
      headerRowNumber = rowNumber
      headers = normalized
      break
    }
  }

  if (!headerRowNumber) {
    const row = worksheet.getRow(1)
    headerRowNumber = 1
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers[colNumber] = cellText(cell)
    })
  }

  let nameCol = -1
  const scoreColumns = []
  headers.forEach((header, colNumber) => {
    const label = String(header || '').trim()
    if (!label) return
    const normalized = label.toLowerCase().replace(/\s+/g, '')
    if (nameCol < 0 && (NAME_HEADERS.has(label) || NAME_HEADERS.has(normalized))) {
      nameCol = colNumber
      return
    }
    if (IGNORED_HEADERS.has(label) || IGNORED_HEADERS.has(normalized)) return
    scoreColumns.push({ colNumber, name: label })
  })

  if (nameCol < 0) throw serviceError('导入表必须包含“姓名”列')
  if (scoreColumns.length === 0) throw serviceError('导入表至少需要一个成绩列')
  return { headerRowNumber, nameCol, scoreColumns }
}

export async function importScoresFromExcel(classId, buffer, filename, teacherId = null) {
  if (!isAllowedScoreWorkbook(filename)) {
    throw serviceError('请上传 .xlsx 格式的成绩文件')
  }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw serviceError('Excel 中没有可读取的工作表')

  const { headerRowNumber, nameCol, scoreColumns } = readImportShape(worksheet)
  const projectNames = [...new Set(scoreColumns.map(column => normalizeProjectName(column.name)))]
  const { byName: projectsByName, created } = await findOrCreateProjects(classId, projectNames)
  const students = await prisma.student.findMany({
    where: { classId },
    select: { id: true, name: true },
  })
  const studentsByName = new Map(students.map(student => [student.name, student]))
  const unmatchedStudents = new Set()
  let importedScores = 0
  let matchedRows = 0
  let invalidCells = 0

  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber)
    const studentName = cellText(row.getCell(nameCol))
    if (!studentName) continue
    const student = studentsByName.get(studentName)
    if (!student) {
      unmatchedStudents.add(studentName)
      continue
    }
    let rowTouched = false
    for (const column of scoreColumns) {
      const raw = row.getCell(column.colNumber)
      const text = cellText(raw)
      if (!text && raw.value !== 0) continue
      let scoreValue
      try {
        scoreValue = cellScoreValue(raw)
      } catch {
        invalidCells += 1
        continue
      }
      if (scoreValue === null) continue
      const project = projectsByName.get(column.name)
      await saveStudentScore({
        classId,
        studentId: student.id,
        projectId: project.id,
        value: scoreValue,
        teacherId,
      })
      rowTouched = true
      importedScores += 1
    }
    if (rowTouched) matchedRows += 1
  }

  return {
    ok: true,
    importedScores,
    matchedRows,
    createdProjects: created,
    unmatchedStudents: [...unmatchedStudents],
    invalidCells,
  }
}

export async function exportScoresToExcel(classId) {
  const scorebook = await getScorebook(classId, { includeLogs: false })
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'crCheckIn'
  const worksheet = workbook.addWorksheet('成绩表', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  })

  const headers = ['行政班', '姓名', '拼音缩写', ...scorebook.projects.map(project => project.name)]
  worksheet.columns = headers.map((header, index) => ({
    header,
    key: `c${index}`,
    width: index <= 1 ? 14 : 12,
  }))

  worksheet.spliceRows(1, 0, [`${scorebook.class.name} 成绩表`])
  worksheet.mergeCells(1, 1, 1, headers.length)
  worksheet.getCell(1, 1).font = { bold: true, size: 14 }
  worksheet.getCell(1, 1).alignment = { horizontal: 'center' }
  worksheet.spliceRows(2, 0, [`导出时间：${formatSecond(new Date())}；学生 ${scorebook.students.length} 人；项目 ${scorebook.projects.length} 个`])
  worksheet.mergeCells(2, 1, 2, headers.length)
  worksheet.getCell(2, 1).font = { size: 10, color: { argb: 'FF64748B' } }
  worksheet.getCell(2, 1).alignment = { horizontal: 'center' }

  const headerRow = worksheet.getRow(3)
  headerRow.values = headers
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' }

  for (const student of scorebook.students) {
    const rowValues = [
      sanitizeExcelValue(formatHomeClass(student.homeClass)),
      sanitizeExcelValue(student.name),
      sanitizeExcelValue(student.pinyin.initials),
      ...scorebook.projects.map((project) => {
        const score = student.scores[project.id]
        return score?.value ?? ''
      }),
    ]
    worksheet.addRow(rowValues)
  }

  worksheet.views = [{ state: 'frozen', ySplit: 3 }]
  return workbook.xlsx.writeBuffer()
}
