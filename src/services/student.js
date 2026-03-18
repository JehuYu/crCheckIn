import { prisma } from '../plugins/db.js'

/**
 * 校验 studentId 归属 teacherId 管辖的班级
 */
async function assertStudentOwner(studentId, teacherId, isAdmin = false) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: { class: true },
  })
  if (!student) return { ok: false, message: '学生不存在', status: 404 }
  if (!isAdmin && student.class.teacherId !== teacherId) {
    return { ok: false, message: '无权限', status: 403 }
  }
  return { ok: true, student }
}

/**
 * 更新学生信息（姓名 / 行政班级）
 * @param {number} studentId
 * @param {{ name?: string, homeClass?: string }} data
 * @param {number} teacherId
 * @param {boolean} isAdmin
 */
export async function updateStudent(studentId, data, teacherId, isAdmin = false) {
  const check = await assertStudentOwner(studentId, teacherId, isAdmin)
  if (!check.ok) return check

  const { student } = check
  const newName = data.name?.trim() ?? student.name
  const newHomeClass = data.homeClass !== undefined ? data.homeClass.trim() : student.homeClass

  // 同班姓名唯一性校验
  if (newName !== student.name) {
    const dup = await prisma.student.findFirst({
      where: { classId: student.classId, name: newName },
    })
    if (dup) return { ok: false, message: '该姓名在本班已存在', status: 409 }
  }

  const updated = await prisma.student.update({
    where: { id: studentId },
    data: { name: newName, homeClass: newHomeClass },
  })
  return { ok: true, student: updated }
}

/**
 * 删除学生（级联删除当前批次签到记录）
 * @param {number} studentId
 * @param {number} teacherId
 * @param {boolean} isAdmin
 */
export async function deleteStudent(studentId, teacherId, isAdmin = false) {
  const check = await assertStudentOwner(studentId, teacherId, isAdmin)
  if (!check.ok) return check

  const { student } = check
  await prisma.$transaction([
    prisma.signInRecord.deleteMany({ where: { classId: student.classId, studentName: student.name } }),
    prisma.student.delete({ where: { id: studentId } }),
  ])
  return { ok: true }
}

/**
 * 将学生转移到另一个教学班
 * @param {number} studentId
 * @param {number} targetClassId
 * @param {number} teacherId
 * @param {boolean} isAdmin
 */
export async function transferStudent(studentId, targetClassId, teacherId, isAdmin = false) {
  const check = await assertStudentOwner(studentId, teacherId, isAdmin)
  if (!check.ok) return check

  const { student } = check

  // 校验目标班级归属
  const targetClass = await prisma.class.findUnique({ where: { id: targetClassId } })
  if (!targetClass) return { ok: false, message: '目标班级不存在', status: 403 }
  if (!isAdmin && targetClass.teacherId !== teacherId) {
    return { ok: false, message: '无权限操作目标班级', status: 403 }
  }

  // 目标班级同名校验
  const dup = await prisma.student.findFirst({ where: { classId: targetClassId, name: student.name } })
  if (dup) return { ok: false, message: '目标班级中已存在同名学生', status: 409 }

  await prisma.$transaction([
    prisma.signInRecord.deleteMany({ where: { classId: student.classId, studentName: student.name } }),
    prisma.student.update({ where: { id: studentId }, data: { classId: targetClassId } }),
  ])
  return { ok: true }
}
