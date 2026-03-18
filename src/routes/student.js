import { resolveClientName } from '../utils/ip.js'

export default async function studentRoutes(app) {
  app.get('/', async (request, reply) => {
    return reply.redirect('/student')
  })

  app.get('/student', async (request, reply) => {
    return reply.view('student/index.html', { computer_name: resolveClientName(request) })
  })
}
