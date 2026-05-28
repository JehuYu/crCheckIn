import fp from 'fastify-plugin'
import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({
  log: [
    { level: 'warn', emit: 'event' },
    { level: 'error', emit: 'event' },
  ],
})

// 监听 Prisma 查询警告和错误
prisma.$on('warn', (e) => {
  console.warn('[Prisma warn]', e.message)
})

prisma.$on('error', (e) => {
  console.error('[Prisma error]', e.message)
})

async function dbPlugin(app) {
  app.decorate('prisma', prisma)

  // 启用 WAL 模式提升并发读写性能
  await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL')
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000')

  app.addHook('onClose', async () => {
    await prisma.$disconnect()
  })
}

export default fp(dbPlugin)
