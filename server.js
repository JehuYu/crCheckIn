import { buildApp } from './src/app.js'
import { PORT, HOST } from './src/config.js'
import { prisma } from './src/plugins/db.js'
import { seed } from './prisma/seed.js'

try {
  const app = await buildApp()
  await seed(prisma)
  await app.listen({ port: PORT, host: HOST })
} catch (err) {
  console.error(err)
  process.exit(1)
}
