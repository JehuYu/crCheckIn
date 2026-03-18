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
  const ws = workbook.addWorksheet('签到记录', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 } })

  // 列宽
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
    cell.border = {
      bottom: { style: 'thin', color: { argb: 'FF475569' } },
    }
  })

  // 数据行
  let rowIdx = 0
  for (const student of students) {
    const rec = recordMap.get(student.name)
    const signed = !!rec
    const dataRow = ws.addRow([
      student.homeClass || '',
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
    // 已签到行姓名列加绿色
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
    seatMap.get(n).push({ name: rec.studentName, homeClass: rec.student?.homeClass ?? '' })
  }

  // 教师视角：行列均反转
  const teacherLayout = [...SEAT_LAYOUT].reverse().map((row) => [...row].reverse())

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Lab Attendance'
  const ws = workbook.addWorksheet('座位表', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  })

  // 过道在教师视角列索引 2,4,6 右侧 → Excel 列号 3,5,7（1-based）
  // 每个座位占 1 列，过道后插入空列 → 实际列数 = 8座位 + 3过道 = 11列
  // 列映射：座位列索引 0→1, 1→2, 2→3, [aisle]→4(空), 3→5, 4→6, [aisle]→7(空), 5→8, 6→9, [aisle]→10(空), 7→11
  const COL_MAP = [1, 2, 3, 5, 6, 8, 9, 11] // 座位列索引 → Excel 列号（1-based）
  const TOTAL_COLS = 11

  // 列宽
  for (let c = 1; c <= TOTAL_COLS; c++) {
    ws.getColumn(c).width = [4, 6].includes(c) ? 2.5 : 11 // 过道列窄
  }

  // 标题行（跨全列）
  ws.mergeCells(1, 1, 1, TOTAL_COLS)
  const titleCell = ws.getCell(1, 1)
  titleCell.value = `${cls.name}  座位表（教师视角）`
  titleCell.font = { name: '微软雅黑', bold: true, size: 14, color: { argb: 'FF1E293B' } }
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' }
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
  ws.getRow(1).height = 34

  // 统计行
  ws.mergeCells(2, 1, 2, TOTAL_COLS)
  const statCell = ws.getCell(2, 1)
  statCell.value = `已签到 ${records.length} 人    导出时间：${fmtSecond(new Date())}`
  statCell.font = { name: '微软雅黑', size: 9, color: { argb: 'FF64748B' } }
  statCell.alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(2).height = 18

  // 座位行（从第3行开始）
  teacherLayout.forEach((row, rowIdx) => {
    const excelRow = rowIdx + 3
    ws.getRow(excelRow).height = 38

    row.forEach((seatNo, colIdx) => {
      const excelCol = COL_MAP[colIdx]
      const cell = ws.getCell(excelRow, excelCol)

      if (seatNo === null) {
        // 无座位格
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } }
        return
      }

      const students = seatMap.get(seatNo) ?? []
      const signed = students.length > 0
      const dupIp = students.length > 1

      // 背景色
      if (dupIp) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } }
      } else if (signed) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } }
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } }
      }

      // 边框
      cell.border = {
        top: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: signed ? 'FF6EE7B7' : 'FFE2E8F0' } },
      }

      if (signed) {
        const stu = students[0]
        const displayName = dupIp ? students.map((s) => s.name).join('/') : stu.name
        const homeClass = dupIp ? '' : stu.homeClass
        cell.value = homeClass ? `${homeClass}\n${displayName}` : displayName
        cell.font = {
          name: '微软雅黑',
          size: dupIp ? 8 : 10,
          bold: !dupIp,
          color: { argb: dupIp ? 'FFDC2626' : 'FF065F46' },
        }
      } else {
        // 空座位只显示编号
        cell.value = `${seatNo}`
        cell.font = { name: '微软雅黑', size: 9, color: { argb: 'FFCBD5E1' } }
      }

      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    })
  })

  // 讲台行（最后一行）
  const podiumRow = teacherLayout.length + 3
  ws.getRow(podiumRow).height = 24
  ws.mergeCells(podiumRow, 1, podiumRow, TOTAL_COLS)
  const podiumCell = ws.getCell(podiumRow, 1)
  podiumCell.value = '▲  讲  台  ▲'
  podiumCell.font = { name: '微软雅黑', bold: true, size: 11, color: { argb: 'FF475569' } }
  podiumCell.alignment = { horizontal: 'center', vertical: 'middle' }
  podiumCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }

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
