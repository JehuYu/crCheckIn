import fp from 'fastify-plugin'
import view from '@fastify/view'
import nunjucks from 'nunjucks'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function viewPlugin(app) {
  await app.register(view, {
    engine: { nunjucks },
    root: join(__dirname, '../../views'),
  })
}

export default fp(viewPlugin)
