import { prisma } from '../plugins/db.js'

export async function migrateTeacherClassesToPool() {
  const existingPoolCount = await prisma.class.count({ where: { teacherId: null } })
  if (existingPoolCount > 0) {
    console.log('[migrate] Pool classes already exist, skipping.')
    return
  }

  const teacherClasses = await prisma.class.findMany({
    where: { teacherId: { not: null }, isArchived: false },
    include: { students: { select: { name: true, homeClass: true, remark: true } } },
  })

  if (teacherClasses.length === 0) {
    console.log('[migrate] No teacher-owned classes to migrate.')
    return
  }

  console.log(`[migrate] Copying ${teacherClasses.length} class(es) to pool...`)

  for (const cls of teacherClasses) {
    const poolClass = await prisma.class.create({
      data: { name: cls.name, teacherId: null, signInConfig: { create: {} } },
    })

    if (cls.students.length > 0) {
      await prisma.student.createMany({
        data: cls.students.map(s => ({
          name: s.name,
          homeClass: s.homeClass,
          remark: s.remark,
          classId: poolClass.id,
        })),
      })
    }

    console.log(`[migrate] Copied「${cls.name}」(${cls.students.length} students) to pool (id: ${poolClass.id})`)
  }
}
