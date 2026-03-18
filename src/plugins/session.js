import fp from 'fastify-plugin'
import cookie from '@fastify/cookie'
import session from '@fastify/session'
import { SECRET_KEY } from '../config.js'

async function sessionPlugin(app) {
  await app.register(cookie)
  await app.register(session, {
    secret: SECRET_KEY,
    cookie: { secure: false },
  })
}

export default fp(sessionPlugin)
