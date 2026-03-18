import { prisma } from '../plugins/db.js'

/**
 * 获取教师的所有班级（按 createdAt 升序）。
 * @param {number} teacherId
 * @returns {Promise<object[]>}
 */
export async function getClasses(teacherId) {
  return prisma.class.findMany({
    where: { teacherId },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * 创建班级，同时创建对应的 SignInConfig（startTime/endTime 为 null）。
 * 同一教师下班级名唯一（@@unique([teacherId, name])）。
 * @param {number} teacherId
 * @param {string} name
 * @returns {Promise<object>} 创建的 Class 记录
 */
export async function createClass(teacherId, name) {
  const existing = await prisma.class.findUnique({
    where: { teacherId_name: { teacherId, name } },
  })
  if (existing) {
    const err = new Error('该班级名称已存在')
    err.statusCode = 409
    throw err
  }

  return prisma.class.create({
    data: {
      name,
      teacherId,
      signInConfig: {
        create: { startTime: null, endTime: null },
      },
    },
    include: { signInConfig: true },
  })
}

/**
 * 验证班级归属（防越权）。
 * isAdmin=true 时跳过检查直接返回班级；否则验证 teacherId，不匹配则抛出 403。
 * @param {number} classId
 * @param {number} teacherId
 * @param {boolean} [isAdmin=false]
 * @returns {Promise<object>} Class 记录
 */
export async function assertClassOwner(classId, teacherId, isAdmin = false) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })

  if (isAdmin) return cls

  if (!cls || cls.teacherId !== teacherId) {
    const err = new Error('无权访问该班级')
    err.statusCode = 403
    throw err
  }

  return cls
}

/**
 * 删除班级，级联删除 SignInConfig → SignInRecord → Student → Class。
 * @param {number} classId
 * @param {number} teacherId
 * @param {boolean} [isAdmin=false]
 * @returns {Promise<void>}
 */
export async function deleteClass(classId, teacherId, isAdmin = false) {
  await assertClassOwner(classId, teacherId, isAdmin)

  await prisma.signInConfig.deleteMany({ where: { classId } })
  await prisma.signInRecord.deleteMany({ where: { classId } })
  await prisma.student.deleteMany({ where: { classId } })
  await prisma.class.delete({ where: { id: classId } })
}
