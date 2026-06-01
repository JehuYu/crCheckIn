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
  // 增大缓存至 64MB（负数=KB），减少磁盘 IO
  await prisma.$queryRawUnsafe('PRAGMA cache_size=-65536')
  // 启用 mmap，大库读取性能提升 2-5x（64MB 映射）
  await prisma.$queryRawUnsafe('PRAGMA mmap_size=67108864')

  // 定期 WAL checkpoint 防止 -wal 文件无限增长（每 5 分钟）
  const walCheckpointInterval = setInterval(async () => {
    try {
      await prisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // 静默忽略，下次再试
    }
  }, 5 * 60 * 1000)
  walCheckpointInterval.unref()

  app.addHook('onClose', async () => {
    clearInterval(walCheckpointInterval)
    await prisma.$disconnect()
  })
}

export default fp(dbPlugin)
