import bcrypt from 'bcrypt'
import { prisma } from '../plugins/db.js'

/**
 * 通过口令验证教师/管理员登录凭据。
 * @param {string} password
 * @returns {Promise<{ok: boolean, teacher?: object}>}
 */
export async function verifyTeacherByPassword(password) {
  if (!password) return { ok: false }

  const teachers = await prisma.teacher.findMany({
    orderBy: [
      { isAdmin: 'desc' },
      { id: 'asc' },
    ],
  })

  for (const teacher of teachers) {
    const match = await bcrypt.compare(password, teacher.passwordHash)
    if (match) {
      return { ok: true, teacher }
    }
  }

  return { ok: false }
}

/**
 * 创建新教师账号（仅 admin 可调用）。
 * @param {string} username
 * @param {string} password
 * @param {boolean} isAdmin
 * @returns {Promise<object>} 创建的 Teacher 记录
 */
export async function createTeacher(username, password, isAdmin = false) {
  const existing = await prisma.teacher.findUnique({ where: { username } })
  if (existing) {
    const err = new Error('用户名已存在')
    err.code = 'USERNAME_TAKEN'
    throw err
  }

  const passwordHash = await bcrypt.hash(password, 10)
  return prisma.teacher.create({
    data: { username, passwordHash, isAdmin },
  })
}

/**
 * 修改教师密码。
 * @param {number} teacherId
 * @param {string} oldPassword
 * @param {string} newPassword
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function changePassword(teacherId, oldPassword, newPassword) {
  if (newPassword.length < 6) {
    return { ok: false, message: '新密码长度不能少于 6 位' }
  }

  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } })
  if (!teacher) return { ok: false, message: '教师不存在' }

  const match = await bcrypt.compare(oldPassword, teacher.passwordHash)
  if (!match) return { ok: false, message: '旧密码不正确' }

  const passwordHash = await bcrypt.hash(newPassword, 10)
  await prisma.teacher.update({
    where: { id: teacherId },
    data: { passwordHash },
  })

  return { ok: true, message: '密码修改成功' }
}
