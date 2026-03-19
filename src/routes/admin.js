import { createTeacher } from '../services/auth.js'
import { deleteClassesCascadeWithTx } from '../services/class.js'
import { adminRequired } from '../utils/auth.js'
import { prisma } from '../plugins/db.js'

export default async function adminRoutes(app) {
  app.get('/admin', { preHandler: adminRequired }, async (request, reply) => {
    const teachers = await prisma.teacher.findMany({
      include: { _count: { select: { classes: true } } },
    })
    return reply.view('admin/index.html', {
      teachers: teachers.map(t => ({
        id: t.id,
        username: t.username,
        isAdmin: t.isAdmin,
        classCount: t._count.classes,
      })),
    })
  })

  app.post('/admin/teachers', { preHandler: adminRequired }, async (request, reply) => {
    const { username, password, isAdmin } = request.body ?? {}
    try {
      await createTeacher(username, password, isAdmin === true || isAdmin === 'true')
      return reply.send({ ok: true })
    } catch (err) {
      if (err.code === 'USERNAME_TAKEN') {
        return reply.send({ ok: false, message: '用户名已存在' })
      }
      throw err
    }
  })

  app.delete('/admin/teachers/:id', { preHandler: adminRequired }, async (request, reply) => {
    const id = parseInt(request.params.id, 10)
    const teacher = await prisma.teacher.findUnique({ where: { id } })
    if (!teacher) {
      return reply.code(404).send({ ok: false, message: '教师不存在' })
    }
    if (teacher.isAdmin) {
      return reply.code(403).send({ ok: false, message: '不允许删除管理员账号' })
    }

    // 级联删除班级下的归档/当前签到/学生数据，再删 Teacher
    const classes = await prisma.class.findMany({ where: { teacherId: id }, select: { id: true } })
    const classIds = classes.map(c => c.id)

    await prisma.$transaction(async (tx) => {
      await deleteClassesCascadeWithTx(tx, classIds)
      await tx.teacher.delete({ where: { id } })
    })

    return reply.send({ ok: true })
  })
}
