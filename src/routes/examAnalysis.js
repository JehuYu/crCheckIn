import { teacherRequired } from '../utils/auth.js'
import { prisma } from '../plugins/db.js'
import { analyzeExamWorkbook, readAnalysisWorkbook } from '../services/examAnalysis.js'

function noCache(reply) {
  reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
  reply.header('Pragma', 'no-cache')
  reply.header('Expires', '0')
}

export default async function examAnalysisRoutes(app) {
  app.get('/teacher/exam-analysis', { preHandler: teacherRequired }, async (request, reply) => {
    const teacher = await prisma.teacher.findUnique({ where: { id: request.session.teacherId } })
    if (!teacher) {
      request.session = null
      return reply.redirect('/student')
    }
    noCache(reply)
    return reply.view('teacher/exam-analysis.html', {
      teacher: { id: teacher.id, username: teacher.username, isAdmin: teacher.isAdmin },
    })
  })

  app.post('/api/exam-analysis', { preHandler: teacherRequired }, async (request, reply) => {
    try {
      let upload = null
      let classMapping = null
      for await (const part of request.parts()) {
        if (part.type === 'file' && part.fieldname === 'file') {
          upload = {
            buffer: await part.toBuffer(),
            filename: part.filename || 'exam.xlsx',
          }
        } else if (part.type === 'file' && part.fieldname === 'classMapping') {
          classMapping = {
            buffer: await part.toBuffer(),
            filename: part.filename || 'class-mapping.xlsx',
          }
        }
      }

      if (!upload) {
        return reply.code(400).send({ ok: false, message: '请上传成绩文件' })
      }

      const result = await analyzeExamWorkbook(upload.buffer, upload.filename, classMapping
        ? {
            classMappingBuffer: classMapping.buffer,
            classMappingFilename: classMapping.filename,
          }
        : {})
      return reply.send(result)
    } catch (err) {
      request.log.error({ err, detail: err.detail }, 'exam analysis failed')
      return reply.code(err.statusCode || 500).send({
        ok: false,
        message: err.statusCode ? err.message : `处理失败：${err.message}`,
      })
    }
  })

  app.get('/api/exam-analysis/download/:filename', { preHandler: teacherRequired }, async (request, reply) => {
    try {
      const file = await readAnalysisWorkbook(request.params.filename)
      reply
        .header('Content-Type', file.mime)
        .header('Content-Disposition', `attachment; filename="${file.filename}"`)
      return reply.send(file.buffer)
    } catch {
      return reply.code(404).send({ ok: false, message: '文件不存在或已被清理' })
    }
  })
}
