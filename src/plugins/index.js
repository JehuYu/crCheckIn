import dbPlugin from './db.js'
import sessionPlugin from './session.js'
import viewPlugin from './view.js'

export async function registerPlugins(app) {
  await app.register(dbPlugin)
  await app.register(sessionPlugin)
  await app.register(viewPlugin)
}
