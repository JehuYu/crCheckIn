import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import fastifyStatic from '@fastify/static'
import dbPlugin from './db.js'
import sessionPlugin from './session.js'
import viewPlugin from './view.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function registerPlugins(app) {
  await app.register(fastifyStatic, {
    root: join(__dirname, '../../public'),
    prefix: '/public/',
  })
  await app.register(dbPlugin)
  await app.register(sessionPlugin)
  await app.register(viewPlugin)
}
