import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('开始检查是否需要迁移旧数据...')

  // 检查旧表是否存在
  const oldTables = await prisma.$queryRaw`
    SELECT name FROM sqlite_master WHERE type='table' AND name='TeacherAccount'
  `

  if (!oldTables || oldTables.length === 0) {
    console.log('无需迁移旧数据')
    return
  }

  console.log('检测到旧表，开始迁移...')

  // 1. 读取旧 TeacherAccount 的 passwordHash
  const oldTeachers = await prisma.$queryRaw`
    SELECT passwordHash FROM TeacherAccount WHERE id=1
  `
  const passwordHash = oldTeachers[0]?.passwordHash

  if (!passwordHash) {
    console.log('未找到旧教师账号，跳过迁移')
    return
  }

  // 2. 创建 admin 教师账号（如果不存在）
  let teacher = await prisma.teacher.findUnique({ where: { username: 'admin' } })
  if (!teacher) {
    teacher = await prisma.teacher.create({
      data: { username: 'admin', isAdmin: true, passwordHash },
    })
    console.log('已创建 admin 教师账号')
  } else {
    console.log('admin 教师账号已存在，跳过创建')
  }

  // 3. 创建默认班级（如果不存在），同时创建 SignInConfig
  let defaultClass = await prisma.class.findFirst({
    where: { teacherId: teacher.id, name: '默认班级' },
  })
  if (!defaultClass) {
    defaultClass = await prisma.class.create({
      data: {
        name: '默认班级',
        teacherId: teacher.id,
        signInConfig: { create: { startTime: null, endTime: null } },
      },
    })
    console.log('已创建默认班级及 SignInConfig')
  } else {
    console.log('默认班级已存在，跳过创建')
  }

  const classId = defaultClass.id

  // 4. 读取旧 Student 表所有记录
  const oldStudents = await prisma.$queryRaw`
    SELECT id, name FROM Student WHERE classId IS NULL OR classId = 0
  `

  // 5. 将每个旧学生迁移到默认班级
  let studentCount = 0
  for (const s of oldStudents) {
    await prisma.student.upsert({
      where: { classId_name: { classId, name: s.name } },
      update: {},
      create: { name: s.name, classId },
    })
    studentCount++
  }
  console.log(`已迁移 ${studentCount} 名学生到默认班级`)

  // 6. 读取旧 SignInRecord 表
  const oldRecords = await prisma.$queryRaw`
    SELECT studentName, computerName, signedAt FROM SignInRecord WHERE classId IS NULL OR classId = 0
  `

  // 7. 将每条旧记录迁移到默认班级
  let recordCount = 0
  for (const r of oldRecords) {
    await prisma.signInRecord.upsert({
      where: { classId_studentName: { classId, studentName: r.studentName } },
      update: {},
      create: {
        classId,
        studentName: r.studentName,
        computerName: r.computerName,
        signedAt: r.signedAt ? new Date(r.signedAt) : new Date(),
      },
    })
    recordCount++
  }
  console.log(`已迁移 ${recordCount} 条签到记录到默认班级`)

  // 8. 读取旧 SignInConfig
  const oldConfigs = await prisma.$queryRaw`
    SELECT startTime, endTime FROM SignInConfig WHERE id=1
  `
  const oldConfig = oldConfigs[0]

  // 9. 更新默认班级的 SignInConfig
  if (oldConfig) {
    await prisma.signInConfig.update({
      where: { classId },
      data: {
        startTime: oldConfig.startTime ? new Date(oldConfig.startTime) : null,
        endTime: oldConfig.endTime ? new Date(oldConfig.endTime) : null,
      },
    })
    console.log('已迁移 SignInConfig 到默认班级')
  }

  console.log('\n迁移完成摘要：')
  console.log(`  - 教师账号：admin (isAdmin=true)`)
  console.log(`  - 默认班级 ID：${classId}`)
  console.log(`  - 迁移学生数：${studentCount}`)
  console.log(`  - 迁移签到记录数：${recordCount}`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
