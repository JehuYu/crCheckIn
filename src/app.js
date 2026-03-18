import Fastify from 'fastify'
import formbody from '@fastify/formbody'
import multipart from '@fastify/multipart'
import { registerPlugins } from './plugins/index.js'
import { registerRoutes } from './routes/index.js'

export async function buildApp(opts = {}) {
  const app = Fastify({ logger: true, ...opts })

  await registerPlugins(app)
  await app.register(formbody)
  await app.register(multipart)
  await registerRoutes(app)

  app.setErrorHandler((error, request, reply) => {
    reply.code(500).send({ ok: false, message: error.message })
  })

  return app
}
