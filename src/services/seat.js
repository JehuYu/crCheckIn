import { prisma } from '../plugins/db.js'

export const SEAT_LAYOUT = [
  [60, 59, null, null, null, null, 16, 15],
  [58, 57, 44, 43, 30, 29, 14, 13],
  [56, 55, 42, 41, 28, 27, 12, 11],
  [54, 53, 40, 39, 26, 25, 10, 9],
  [52, 51, 38, 37, 24, 23, 8, 7],
  [50, 49, 36, 35, 22, 21, 6, 5],
  [48, 47, 34, 33, 20, 19, 4, 3],
  [46, 45, 32, 31, 18, 17, 2, 1],
]

// 学生视角：过道在列索引 1, 3, 5 右侧
export const AISLE_AFTER_COLS_STUDENT = new Set([1, 3, 5])
// 教师视角（行列均反转后）：过道在列索引 2, 4, 6 右侧
export const AISLE_AFTER_COLS_TEACHER = new Set([2, 4, 6])

/**
 * 从签到记录构建 seatToStudents Map
 */
async function buildSeatMap(classId) {
  const records = await prisma.signInRecord.findMany({
    where: { classId },
    include: { student: true },
    orderBy: { signedAt: 'asc' },
  })

  const seatToStudents = new Map()
  for (const rec of records) {
    const parts = (rec.computerName || '').split('.')
    if (parts.length !== 4) continue
    const n = Number(parts[parts.length - 1])
    if (!Number.isInteger(n) || n < 1 || n > 60) continue
    if (!seatToStudents.has(n)) seatToStudents.set(n, [])
    seatToStudents.get(n).push({
      name: rec.studentName,
      homeClass: rec.student?.homeClass ?? '',
    })
  }
  return seatToStudents
}

function buildCell(seatNo, seatToStudents) {
  if (seatNo === null) return { seatNo: null, label: '', students: [], dupIp: false }
  const students = seatToStudents.get(seatNo) ?? []
  return { seatNo, label: String(seatNo), students, dupIp: students.length > 1 }
}

/**
 * 学生视角网格（背对讲台，讲台在下方）
 */
export async function getSeatGrid(classId) {
  const seatToStudents = await buildSeatMap(classId)
  return SEAT_LAYOUT.map((row) => row.map((seatNo) => buildCell(seatNo, seatToStudents)))
}

/**
 * 教师视角网格（面对学生，讲台在上方，行列均反转）
 */
export async function getSeatGridTeacher(classId) {
  const seatToStudents = await buildSeatMap(classId)
  // 行反转（最近讲台的行在最上），列反转（左右镜像）
  return [...SEAT_LAYOUT].reverse().map((row) =>
    [...row].reverse().map((seatNo) => buildCell(seatNo, seatToStudents))
  )
}
