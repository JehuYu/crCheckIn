import ExcelJS from 'exceljs'
import { prisma } from '../plugins/db.js'

/**
 * 格式化 Date 为 "YYYY-MM-DD HH:mm:ss"
 */
function fmtSecond(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 从 Excel buffer 导入学生名单
 * Excel 格式（无表头）：A列=教学班名，B列=行政班级，C列=学生姓名
 * @param {number} teacherId
 * @param {Buffer} buffer
 * @returns {Promise<number>} 新增学生数量
 */
export async function importStudentsFromExcel(teacherId, buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const worksheet = workbook.worksheets[0]

  // 收集每行数据，自动跳过表头（第一列值为"教学班"等文字时跳过）
  const HEADER_KEYWORDS = new Set(['教学班', '班级', '姓名', '行政班', '教学班名'])
  const rows = []
  worksheet.eachRow((row) => {
    const teachingClassName = row.getCell(1).value
    const homeClass = row.getCell(2).value
    const studentName = row.getCell(3).value
    // 跳过空行
    if (teachingClassName == null || String(teachingClassName).trim() === '') return
    if (studentName == null || String(studentName).trim() === '') return
    // 跳过表头行（第一列是已知表头关键字）
    if (HEADER_KEYWORDS.has(String(teachingClassName).trim())) return
    rows.push({
      teachingClassName: String(teachingClassName).trim(),
      homeClass: homeClass != null ? String(homeClass).trim() : '',
      studentName: String(studentName).trim(),
    })
  })

  // 按教学班分组
  const classMap = new Map()
  for (const row of rows) {
    if (!classMap.has(row.teachingClassName)) classMap.set(row.teachingClassName, [])
    classMap.get(row.teachingClassName).push({ homeClass: row.homeClass, studentName: row.studentName })
  }

  let count = 0

  for (const [teachingClassName, students] of classMap) {
    // upsert 教学班
    const result = await prisma.class.upsert({
      where: { teacherId_name: { teacherId, name: teachingClassName } },
      update: {},
      create: {
        teacherId,
        name: teachingClassName,
        signInConfig: { create: { startTime: null, endTime: null } },
      },
    })
    const classId = result.id

    // 查询已有学生
    const existing = await prisma.student.findMany({
      where: { classId },
      select: { name: true },
    })
    const existingSet = new Set(existing.map((s) => s.name))

    const seen = new Set()
    for (const { homeClass, studentName } of students) {
      if (existingSet.has(studentName) || seen.has(studentName)) continue
      seen.add(studentName)
      await prisma.student.create({ data: { name: studentName, homeClass, classId } })
      count++
    }
  }

  return count
}

/**
 * 导出签到记录（含行政班级）
 * @param {number} classId
 * @returns {Promise<Buffer>}
 */
export async function exportRecordsToExcel(classId) {
  const [students, records] = await Promise.all([
    prisma.student.findMany({ where: { classId }, orderBy: { name: 'asc' } }),
    prisma.signInRecord.findMany({ where: { classId } }),
  ])

  const recordMap = new Map(records.map((r) => [r.studentName, r]))

  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('签到记录')

  worksheet.addRow(['行政班级', '姓名', '签到状态', '计算机IP', '签到时间'])

  for (const student of students) {
    const rec = recordMap.get(student.name)
    if (rec) {
      worksheet.addRow([student.homeClass, student.name, '已签到', rec.computerName, fmtSecond(new Date(rec.signedAt))])
    } else {
      worksheet.addRow([student.homeClass, student.name, '未签到', '', ''])
    }
  }

  return workbook.xlsx.writeBuffer()
}

/**
 * 导出教学班座位表（按计算机IP排序，仅已签到学生）
 * 格式：标题行=教学班名，每行=计算机IP、行政班级+姓名
 * @param {number} classId
 * @returns {Promise<Buffer>}
 */
export async function exportSeatTableToExcel(classId) {
  const [cls, records] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId } }),
    prisma.signInRecord.findMany({
      where: { classId },
      include: { student: true },
      orderBy: { computerName: 'asc' },
    }),
  ])

  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('座位表')

  // 标题行
  const titleRow = worksheet.addRow([`${cls.name} 座位表`])
  titleRow.font = { bold: true, size: 14 }
  worksheet.mergeCells(`A1:C1`)
  titleRow.getCell(1).alignment = { horizontal: 'center' }

  // 表头
  const headerRow = worksheet.addRow(['计算机IP', '行政班级', '姓名'])
  headerRow.font = { bold: true }

  for (const rec of records) {
    const homeClass = rec.student?.homeClass ?? ''
    worksheet.addRow([rec.computerName, homeClass, rec.studentName])
  }

  // 列宽
  worksheet.getColumn(1).width = 20
  worksheet.getColumn(2).width = 15
  worksheet.getColumn(3).width = 12

  return workbook.xlsx.writeBuffer()
}

/**
 * 跨教学班模糊匹配学生姓名
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<{studentId, studentName, homeClass, classId, className}[]>}
 */
export async function matchStudents(query, limit = 15) {
  const students = await prisma.student.findMany({
    include: { class: true },
  })
  const lower = query.toLowerCase()
  return students
    .filter((s) => s.name.toLowerCase().includes(lower))
    .slice(0, limit)
    .map((s) => ({
      studentId: s.id,
      studentName: s.name,
      homeClass: s.homeClass,
      classId: s.classId,
      className: s.class.name,
    }))
}
