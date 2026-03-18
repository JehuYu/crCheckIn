import { prisma } from '../plugins/db.js'

/**
 * 格式化 Date 为 "YYYY-MM-DD HH:mm"
 * @param {Date|null} date
 * @returns {string|null}
 */
function fmtMinute(date) {
  if (!date) return null
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/**
 * 格式化 Date 为 "YYYY-MM-DD HH:mm:ss"
 * @param {Date} date
 * @returns {string}
 */
function fmtSecond(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 学生签到
 * @param {number} classId
 * @param {string} studentName
 * @param {string} computerName
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function signIn(classId, studentName, computerName) {
  // 1. 姓名为空
  if (!studentName || studentName.trim() === '') {
    return { ok: false, message: '请输入姓名。' }
  }

  // 2. 姓名不在该班级名单中
  const student = await prisma.student.findFirst({
    where: { classId, name: studentName },
  })
  if (!student) {
    return { ok: false, message: '该姓名不在名单中，请联系老师。' }
  }

  // 3 & 4. 检查签到时间窗口
  const config = await prisma.signInConfig.findUnique({ where: { classId } })
  const now = new Date()
  if (config) {
    if (config.startTime && now < config.startTime) {
      return { ok: false, message: '签到未开始，请在规定时间内签到。' }
    }
    if (config.endTime && now > config.endTime) {
      return { ok: false, message: '签到时间已结束。' }
    }
  }

  // 5. 已签到
  const existing = await prisma.signInRecord.findUnique({
    where: { classId_studentName: { classId, studentName: student.name } },
  })
  if (existing) {
    return { ok: false, message: '你已签到，无需重复提交。' }
  }

  // 6. 创建签到记录，捕获唯一约束冲突
  try {
    await prisma.signInRecord.create({
      data: {
        classId,
        studentName: student.name,
        computerName: computerName || '',
      },
    })
  } catch (err) {
    if (err.code === 'P2002') {
      return { ok: false, message: '你已签到，无需重复提交。' }
    }
    throw err
  }

  // 7. 成功
  return { ok: true, message: `${student.name} 签到成功！` }
}

/**
 * 获取班级签到状态数据（用于教师端展示）
 * @param {number} classId
 * @returns {Promise<object>}
 */
export async function getClassStatus(classId) {
  const [students, records, config] = await Promise.all([
    prisma.student.findMany({ where: { classId }, orderBy: { name: 'asc' } }),
    prisma.signInRecord.findMany({ where: { classId }, orderBy: { signedAt: 'desc' } }),
    prisma.signInConfig.findUnique({ where: { classId } }),
  ])

  // 建立签到记录索引
  const recordMap = new Map(records.map((r) => [r.studentName, r]))

  // 构建 roster
  const signed = []
  const unsigned = []
  for (const s of students) {
    const rec = recordMap.get(s.name)
    if (rec) {
      signed.push({
        studentName: s.name,
        homeClass: s.homeClass || '',
        status: '已签到',
        computerName: rec.computerName,
        signedAt: fmtSecond(new Date(rec.signedAt)),
      })
    } else {
      unsigned.push({
        studentName: s.name,
        homeClass: s.homeClass || '',
        status: '未签到',
        computerName: '-',
        signedAt: '-',
      })
    }
  }

  // 已签到按 signedAt 升序
  signed.sort((a, b) => (a.signedAt > b.signedAt ? 1 : -1))
  const roster = [...signed, ...unsigned]

  const signedCount = signed.length
  const totalCount = students.length
  const absentCount = totalCount - signedCount

  return {
    roster,
    signedCount,
    totalCount,
    absentCount,
    window: {
      start: config ? fmtMinute(config.startTime ? new Date(config.startTime) : null) : null,
      end: config ? fmtMinute(config.endTime ? new Date(config.endTime) : null) : null,
    },
  }
}

/**
 * 生成批次标签，格式：2025-03-18 周二 上午 · 班级名
 */
function makeSessionLabel(className) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const day = days[now.getDay()]
  const hour = now.getHours()
  const period = hour < 12 ? '上午' : hour < 18 ? '下午' : '晚上'
  return `${date} ${day} ${period} · ${className}`
}

/**
 * 归档当前签到记录为一个批次，然后清空当前记录
 * @param {number} classId
 * @returns {Promise<{ ok: boolean, label: string }>}
 */
export async function archiveAndReset(classId) {
  const [cls, records] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId } }),
    prisma.signInRecord.findMany({
      where: { classId },
      include: { student: true },
    }),
  ])

  if (records.length === 0) {
    // 没有记录，直接重置（清空时间窗口）
    await prisma.signInConfig.updateMany({
      where: { classId },
      data: { startTime: null, endTime: null },
    })
    return { ok: true, label: null }
  }

  const label = makeSessionLabel(cls.name)

  await prisma.$transaction(async (tx) => {
    const session = await tx.signInSession.create({
      data: {
        classId,
        label,
        records: {
          create: records.map((r) => ({
            studentName: r.studentName,
            homeClass: r.student?.homeClass ?? '',
            computerName: r.computerName,
            signedAt: r.signedAt,
          })),
        },
      },
    })
    await tx.signInRecord.deleteMany({ where: { classId } })
    await tx.signInConfig.updateMany({
      where: { classId },
      data: { startTime: null, endTime: null },
    })
    return session
  })

  return { ok: true, label }
}

/**
 * 获取班级所有历史批次（不含当前）
 * @param {number} classId
 */
export async function getSessions(classId) {
  return prisma.signInSession.findMany({
    where: { classId },
    orderBy: { archivedAt: 'desc' },
    include: { _count: { select: { records: true } } },
  })
}

/**
 * 获取某个历史批次的详细记录
 * @param {number} sessionId
 */
export async function getSessionDetail(sessionId) {
  return prisma.signInSession.findUnique({
    where: { id: sessionId },
    include: {
      records: { orderBy: { signedAt: 'asc' } },
      class: true,
    },
  })
}

/**
 * 删除该班级的所有签到记录和所有学生
 * @param {number} classId
 */
export async function clearRoster(classId) {
  await prisma.signInRecord.deleteMany({ where: { classId } })
  await prisma.student.deleteMany({ where: { classId } })
}

/**
 * 设置班级签到时间窗口
 * @param {number} classId
 * @param {Date|null} startTime
 * @param {Date|null} endTime
 */
export async function setSignInWindow(classId, startTime, endTime) {
  await prisma.signInConfig.upsert({
    where: { classId },
    update: { startTime, endTime },
    create: { classId, startTime, endTime },
  })
}
