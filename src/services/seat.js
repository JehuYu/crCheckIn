import { prisma } from '../plugins/db.js'

export const TEACHER_SEAT_LAYOUT = [
  [60, 59, 44, 43, 30, 29, 16, 15],
  [58, 57, 42, 41, 28, 27, 14, 13],
  [56, 55, 40, 39, 26, 25, 12, 11],
  [54, 53, 38, 37, 24, 23, 10, 9],
  [52, 51, 36, 35, 22, 21, 8, 7],
  [50, 49, 34, 33, 20, 19, 6, 5],
  [48, 47, 32, 31, 18, 17, 4, 3],
  [46, 45, null, null, null, null, 2, 1],
]

export const STUDENT_SEAT_LAYOUT = [
  [1, 2, null, null, null, null, 45, 46],
  [3, 4, 17, 18, 31, 32, 47, 48],
  [5, 6, 19, 20, 33, 34, 49, 50],
  [7, 8, 21, 22, 35, 36, 51, 52],
  [9, 10, 23, 24, 37, 38, 53, 54],
  [11, 12, 25, 26, 39, 40, 55, 56],
  [13, 14, 27, 28, 41, 42, 57, 58],
  [15, 16, 29, 30, 43, 44, 59, 60],
]

// 学生视角：过道在列索引 1, 3, 5 右侧
export const AISLE_AFTER_COLS_STUDENT = new Set([1, 3, 5])
// 教师视角：同样在列索引 1, 3, 5 右侧留过道
export const AISLE_AFTER_COLS_TEACHER = new Set([1, 3, 5])

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
    // studentId 可能为 null（旧记录），fallback 到按姓名查
    let homeClass = rec.student?.homeClass ?? ''
    if (!homeClass && !rec.student) {
      const stu = await prisma.student.findFirst({ where: { classId, name: rec.studentName } })
      homeClass = stu?.homeClass ?? ''
    }
    seatToStudents.get(n).push({
      name: rec.studentName,
      homeClass,
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
 * 学生视角网格（讲台在上方，按学生查看习惯排列）
 */
export async function getSeatGrid(classId) {
  const seatToStudents = await buildSeatMap(classId)
  return STUDENT_SEAT_LAYOUT.map((row) => row.map((seatNo) => buildCell(seatNo, seatToStudents)))
}

/**
 * 教师视角网格（讲台在下方，按教师查看习惯排列）
 */
export async function getSeatGridTeacher(classId) {
  const seatToStudents = await buildSeatMap(classId)
  return TEACHER_SEAT_LAYOUT.map((row) => row.map((seatNo) => buildCell(seatNo, seatToStudents)))
}
