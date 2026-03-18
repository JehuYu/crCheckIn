import ExcelJS from 'exceljs'
import { prisma } from '../plugins/db.js'
import { SEAT_LAYOUT } from './seat.js'

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
 * 行政班级格式化：没有"班"字则补上
 */
function fmtHomeClass(hc) {
  if (!hc) return ''
  return hc.endsWith('班') ? hc : hc + '班'
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

  const HEADER_KEYWORDS = new Set(['教学班', '班级', '姓名', '行政班', '教学班名'])
  const rows = []
  worksheet.eachRow((row) => {
    const teachingClassName = row.getCell(1).value
    const homeClass = row.getCell(2).value
    const studentName = row.getCell(3).value
    if (teachingClassName == null || String(teachingClassName).trim() === '') return
    if (studentName == null || String(studentName).trim() === '') return
    if (HEADER_KEYWORDS.has(String(teachingClassName).trim())) return
    rows.push({
      teachingClassName: String(teachingClassName).trim(),
      homeClass: homeClass != null ? String(homeClass).trim() : '',
      studentName: String(studentName).trim(),
    })
  })

  const classMap = new Map()
  for (const row of rows) {
    if (!classMap.has(row.teachingClassName)) classMap.set(row.teachingClassName, [])
    classMap.get(row.teachingClassName).push({ homeClass: row.homeClass, studentName: row.studentName })
  }

  let count = 0

  for (const [teachingClassName, students] of classMap) {
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

    const existing = await prisma.student.findMany({
      where: { classId },
      select: { name: true },
    })
    const existingSet = new Set(existing.map((s) => s.name))

    const seen = new Set()
    const toInsert = []
    for (const { homeClass, studentName } of students) {
      if (existingSet.has(studentName) || seen.has(studentName)) continue
      seen.add(studentName)
      toInsert.push({ name: studentName, homeClass, classId })
    }

    if (toInsert.length > 0) {
      const res = await prisma.student.createMany({ data: toInsert })
      count += res.count
    }
  }

  return count
}

/**
 * 导出签到记录（含行政班级）— 带样式，可直接打印
 * @param {number} classId
 * @returns {Promise<Buffer>}
 */
export async function exportRecordsToExcel(classId) {
  const [cls, students, records] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId } }),
    prisma.student.findMany({ where: { classId }, orderBy: [{ homeClass: 'asc' }, { name: 'asc' }] }),
    prisma.signInRecord.findMany({ where: { classId } }),
  ])

  const recordMap = new Map(records.map((r) => [r.studentName, r]))
  const signedCount = records.length
  const totalCount = students.length

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Lab Attendance'
  const ws = workbook.addWorksheet('签到记录', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
  })

  ws.columns = [
    { key: 'homeClass', width: 16 },
    { key: 'name', width: 12 },
    { key: 'status', width: 10 },
    { key: 'ip', width: 22 },
    { key: 'time', width: 22 },
  ]

  // 标题行
  ws.mergeCells('A1:E1')
  const titleCell = ws.getCell('A1')
  titleCell.value = `${cls.name}  签到记录`
  titleCell.font = { name: '微软雅黑', bold: true, size: 14, color: { argb: 'FF1E293B' } }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
  ws.getRow(1).height = 36

  // 统计行
  ws.mergeCells('A2:E2')
  const statCell = ws.getCell('A2')
  statCell.value = `共 ${totalCount} 人 · 已签到 ${signedCount} 人 · 未签到 ${totalCount - signedCount} 人    导出时间：${fmtSecond(new Date())}`
  statCell.font = { name: '微软雅黑', size: 9, color: { argb: 'FF64748B' } }
  statCell.alignment = { horizontal: 'center', vertical: 'middle' }
  statCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } }
  ws.getRow(2).height = 20

  // 表头
  const headerRow = ws.addRow(['行政班级', '姓名', '签到状态', '计算机 IP', '签到时间'])
  headerRow.height = 24
  headerRow.eachCell((cell) => {
    cell.font = { name: '微软雅黑', bold: true, size: 10, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF475569' } } }
  })

  // 数据行
  let rowIdx = 0
  for (const student of students) {
    const rec = recordMap.get(student.name)
    const signed = !!rec
    const dataRow = ws.addRow([
      fmtHomeClass(student.homeClass),
      student.name,
      signed ? '✓ 已签到' : '✗ 未签到',
      rec ? rec.computerName : '',
      rec ? fmtSecond(new Date(rec.signedAt)) : '',
    ])
    dataRow.height = 20
    const isEven = rowIdx % 2 === 0
    dataRow.eachCell((cell, colNumber) => {
      cell.font = { name: '微软雅黑', size: 10, color: { argb: signed ? 'FF1E293B' : 'FF94A3B8' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? 'FFFFFFFF' : 'FFF8FAFC' } }
      cell.alignment = { horizontal: colNumber <= 2 ? 'left' : 'center', vertical: 'middle' }
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } }
    })
    if (signed) {
      dataRow.getCell(2).font = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FF059669' } }
    }
    rowIdx++
  }

  return workbook.xlsx.writeBuffer()
}

/**
 * 导出教学班座位表 — 按实际座位网格排列，可直接打印
 * 教师视角（行列均反转），讲台在下方
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

  // 构建 seatNo → {name, homeClass} 映射
  const seatMap = new Map()
  for (const rec of records) {
    const parts = (rec.computerName || '').split('.')
    if (parts.length !== 4) continue
    const n = Number(parts[parts.length - 1])
    if (!Number.isInteger(n) || n < 1 || n > 60) continue
    if (!seatMap.has(n)) seatMap.set(n, [])
    let homeClass = rec.student?.homeClass ?? ''
    if (!homeClass && !rec.student) {
      const stu = await prisma.student.findFirst({ where: { classId, name: rec.studentName } })
      homeClass = stu?.homeClass ?? ''
    }
    seatMap.get(n).push({ name: rec.studentName, homeClass })
  }

  // 教师视角：行列均反转
  const teacherLayout = [...SEAT_LAYOUT].reverse().map((row) => [...row].reverse())

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Lab Attendance'
  const ws = workbook.addWorksheet('座位表', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  })

  // 布局：[col0,col1] | [col2,col3] | [col4,col5] | [col6,col7]
  // 过道在座位列索引 1,3,5 之后
  // Excel 列映射：座位0→1, 座位1→2, 过道→3, 座位2→4, 座位3→5, 过道→6, 座位4→7, 座位5→8, 过道→9, 座位6→10, 座位7→11
  const COL_MAP = [1, 2, 4, 5, 7, 8, 10, 11]
  const TOTAL_COLS = 11

  for (let col = 1; col <= TOTAL_COLS; col++) {
    ws.getColumn(col).width = [3, 6, 9].includes(col) ? 2 : 11
  }

  // 标题行
  ws.mergeCells(1, 1, 1, TOTAL_COLS)
  const t1Cell = ws.getCell(1, 1)
  t1Cell.value = `${cls.name}  座位表（教师视角）`
  t1Cell.font = { name: '微软雅黑', bold: true, size: 14, color: { argb: 'FF1E293B' } }
  t1Cell.alignment = { horizontal: 'center', vertical: 'middle' }
  t1Cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
  ws.getRow(1).height = 34

  // 统计行
  ws.mergeCells(2, 1, 2, TOTAL_COLS)
  const s2Cell = ws.getCell(2, 1)
  s2Cell.value = `已签到 ${records.length} 人    导出时间：${fmtSecond(new Date())}`
  s2Cell.font = { name: '微软雅黑', size: 9, color: { argb: 'FF64748B' } }
  s2Cell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(2).height = 18

  // 座位行（从第3行开始）
  teacherLayout.forEach((row, rowIdx) => {
    const excelRow = rowIdx + 3
    ws.getRow(excelRow).height = 42

    row.forEach((seatNo, colIdx) => {
      const excelCol = COL_MAP[colIdx]
      const cell = ws.getCell(excelRow, excelCol)

      if (seatNo === null) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
        return
      }

      const students = seatMap.get(seatNo) ?? []
      const signed = students.length > 0
      const dupIp = students.length > 1

      if (dupIp) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }
      } else if (signed) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
      }

      cell.border = {
        top: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
      }

      if (signed) {
        const stu = students[0]
        const displayName = dupIp ? students.map((s) => s.name).join('/') : stu.name
        const hc = dupIp ? '' : fmtHomeClass(stu.homeClass)
        cell.value = hc ? `${displayName}\n${hc}` : displayName
        cell.font = {
          name: '微软雅黑',
          size: dupIp ? 8 : 10,
          bold: !dupIp,
          color: { argb: dupIp ? 'FFDC2626' : 'FF065F46' },
        }
      } else {
        cell.value = `${seatNo}`
        cell.font = { name: '微软雅黑', size: 9, color: { argb: 'FFCBD5E1' } }
      }

      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    })
  })

  // 讲台行（教师视角：讲台在下）
  const podiumRow = teacherLayout.length + 3
  ws.getRow(podiumRow).height = 24
  ws.mergeCells(podiumRow, 1, podiumRow, TOTAL_COLS)
  const podiumCell = ws.getCell(podiumRow, 1)
  podiumCell.value = '▲  讲  台  ▲'
  podiumCell.font = { name: '微软雅黑', bold: true, size: 11, color: { argb: 'FF475569' } }
  podiumCell.alignment = { horizontal: 'center', vertical: 'middle' }
  podiumCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

  // ── 学生视角工作表 ──────────────────────────────────────────────
  // 学生视角：原始布局，讲台在下，过道在列索引 1,3,5 之后
  // Excel 列映射同教师视角（两者过道位置相同）
  const ws2 = workbook.addWorksheet('座位表（学生视角）', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  })

  for (let col = 1; col <= TOTAL_COLS; col++) {
    ws2.getColumn(col).width = [3, 6, 9].includes(col) ? 2 : 11
  }

  // 标题行
  ws2.mergeCells(1, 1, 1, TOTAL_COLS)
  const ws2Title = ws2.getCell(1, 1)
  ws2Title.value = `${cls.name}  座位表（学生视角）`
  ws2Title.font = { name: '微软雅黑', bold: true, size: 14, color: { argb: 'FF1E293B' } }
  ws2Title.alignment = { horizontal: 'center', vertical: 'middle' }
  ws2Title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
  ws2.getRow(1).height = 34

  // 统计行
  ws2.mergeCells(2, 1, 2, TOTAL_COLS)
  const ws2Stat = ws2.getCell(2, 1)
  ws2Stat.value = `已签到 ${records.length} 人    导出时间：${fmtSecond(new Date())}`
  ws2Stat.font = { name: '微软雅黑', size: 9, color: { argb: 'FF64748B' } }
  ws2Stat.alignment = { horizontal: 'center', vertical: 'middle' }
  ws2.getRow(2).height = 18

  // 讲台行（学生视角：讲台在上，第3行）
  ws2.getRow(3).height = 24
  ws2.mergeCells(3, 1, 3, TOTAL_COLS)
  const ws2Podium = ws2.getCell(3, 1)
  ws2Podium.value = '▼  讲  台  ▼'
  ws2Podium.font = { name: '微软雅黑', bold: true, size: 11, color: { argb: 'FF475569' } }
  ws2Podium.alignment = { horizontal: 'center', vertical: 'middle' }
  ws2Podium.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

  // 座位行（从第4行开始，原始布局）
  SEAT_LAYOUT.forEach((row, rowIdx) => {
    const excelRow = rowIdx + 4
    ws2.getRow(excelRow).height = 42

    row.forEach((seatNo, colIdx) => {
      const excelCol = COL_MAP[colIdx]
      const cell = ws2.getCell(excelRow, excelCol)

      if (seatNo === null) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
        return
      }

      const students = seatMap.get(seatNo) ?? []
      const signed = students.length > 0
      const dupIp = students.length > 1

      if (dupIp) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }
      } else if (signed) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
      }

      cell.border = {
        top: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
      }

      if (signed) {
        const stu = students[0]
        const displayName = dupIp ? students.map((s) => s.name).join('/') : stu.name
        const hc = dupIp ? '' : fmtHomeClass(stu.homeClass)
        cell.value = hc ? `${displayName}\n${hc}` : displayName
        cell.font = {
          name: '微软雅黑',
          size: dupIp ? 8 : 10,
          bold: !dupIp,
          color: { argb: dupIp ? 'FFDC2626' : 'FF065F46' },
        }
      } else {
        cell.value = `${seatNo}`
        cell.font = { name: '微软雅黑', size: 9, color: { argb: 'FFCBD5E1' } }
      }

      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    })
  })

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

/**
 * 导出历史批次签到记录为 Excel
 * @param {import('@prisma/client').SignInSession & { records: ArchivedRecord[], class: { name: string } }} session
 * @returns {Promise<Buffer>}
 */
export async function exportSessionToExcel(session) {
  const records = session.records ?? []
  const className = session.class?.name ?? ''

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Lab Attendance'
  const ws = workbook.addWorksheet('签到记录', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
  })

  ws.columns = [
    { key: 'homeClass', width: 16 },
    { key: 'name', width: 12 },
    { key: 'signedAt', width: 22 },
    { key: 'computerName', width: 22 },
  ]

  // 第1行：标题行，合并 A1:D1
  ws.mergeCells('A1:D1')
  const titleCell = ws.getCell('A1')
  titleCell.value = `${className}  ${session.label}`
  titleCell.font = { name: '微软雅黑', bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
  ws.getRow(1).height = 36

  // 第2行：统计行，合并 A2:D2
  ws.mergeCells('A2:D2')
  const statCell = ws.getCell('A2')
  statCell.value = `共签到 ${records.length} 人    归档时间：${fmtSecond(new Date(session.archivedAt))}`
  statCell.font = { name: '微软雅黑', size: 9, color: { argb: 'FF64748B' } }
  statCell.alignment = { horizontal: 'center', vertical: 'middle' }
  statCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } }
  ws.getRow(2).height = 20

  // 第3行：表头
  const headerRow = ws.addRow(['行政班级', '姓名', '签到时间', '计算机 IP'])
  headerRow.height = 24
  headerRow.eachCell((cell) => {
    cell.font = { name: '微软雅黑', bold: true, size: 10, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF475569' } } }
  })

  // 第4行起：数据行
  records.forEach((rec, idx) => {
    const isEven = idx % 2 === 0
    const dataRow = ws.addRow([
      fmtHomeClass(rec.homeClass),
      rec.studentName,
      rec.signedAt ? fmtSecond(new Date(rec.signedAt)) : '',
      rec.computerName ?? '',
    ])
    dataRow.height = 20
    dataRow.eachCell((cell, colNumber) => {
      cell.font = { name: '微软雅黑', size: 10, color: { argb: 'FF1E293B' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? 'FFFFFFFF' : 'FFF8FAFC' } }
      cell.alignment = { horizontal: colNumber <= 2 ? 'left' : 'center', vertical: 'middle' }
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } }
    })
    // 姓名列绿色加粗
    dataRow.getCell(2).font = { name: '微软雅黑', size: 10, bold: true, color: { argb: 'FF059669' } }
  })

  return workbook.xlsx.writeBuffer()
}

/**
 * 导出出勤率统计为 Excel
 * @param {{ totalSessions: number, students: Array }} stats
 * @param {{ name: string }} cls
 * @returns {Promise<Buffer>}
 */
export async function exportStatsToExcel(stats, cls) {
  const { totalSessions, students } = stats

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Lab Attendance'
  const ws = workbook.addWorksheet('出勤统计', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 },
  })

  ws.columns = [
    { key: 'name', width: 14 },
    { key: 'homeClass', width: 16 },
    { key: 'signedCount', width: 12 },
    { key: 'absentCount', width: 12 },
    { key: 'rate', width: 14 },
  ]

  // 标题行
  ws.mergeCells('A1:E1')
  const titleCell = ws.getCell('A1')
  titleCell.value = `${cls.name}  出勤统计（共 ${totalSessions} 个批次）`
  titleCell.font = { name: '微软雅黑', bold: true, size: 14, color: { argb: 'FFFFFFFF' } }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
  ws.getRow(1).height = 36

  // 统计行
  ws.mergeCells('A2:E2')
  const statCell = ws.getCell('A2')
  statCell.value = `共 ${students.length} 名学生    导出时间：${fmtSecond(new Date())}`
  statCell.font = { name: '微软雅黑', size: 9, color: { argb: 'FF64748B' } }
  statCell.alignment = { horizontal: 'center', vertical: 'middle' }
  statCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAFA' } }
  ws.getRow(2).height = 20

  // 表头
  const headerRow = ws.addRow(['姓名', '行政班级', '签到次数', '缺勤次数', '出勤率 (%)'])
  headerRow.height = 24
  headerRow.eachCell((cell) => {
    cell.font = { name: '微软雅黑', bold: true, size: 10, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF475569' } } }
  })

  // 数据行
  students.forEach((s, idx) => {
    const isEven = idx % 2 === 0
    const rate = parseFloat(s.rate)
    const rateColor = rate >= 80 ? 'FF059669' : rate >= 60 ? 'FFD97706' : 'FFDC2626'
    const dataRow = ws.addRow([s.name, fmtHomeClass(s.homeClass), s.signedCount, s.absentCount, `${s.rate}%`])
    dataRow.height = 20
    dataRow.eachCell((cell, colNumber) => {
      cell.font = { name: '微软雅黑', size: 10, bold: colNumber === 5, color: { argb: colNumber === 5 ? rateColor : 'FF1E293B' } }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isEven ? 'FFFFFFFF' : 'FFF8FAFC' } }
      cell.alignment = { horizontal: colNumber <= 2 ? 'left' : 'center', vertical: 'middle' }
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } }
    })
  })

  return workbook.xlsx.writeBuffer()
}
