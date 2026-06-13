import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const envFilePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env')

try {
  process.loadEnvFile?.(envFilePath)
} catch {
  // 本地未提供 .env 时回退到下面的默认值。
}

const rawSecret = process.env.SECRET_KEY
if (!rawSecret) {
  throw new Error('环境变量 SECRET_KEY 未设置，请通过 .env 或系统环境配置。')
}
export const SECRET_KEY = rawSecret
const rawDatabaseUrl = process.env.DATABASE_URL
if (!rawDatabaseUrl) {
  throw new Error('DATABASE_URL is not configured. Set it in .env before starting the server.')
}
export const DATABASE_URL = rawDatabaseUrl
export const AUTO_DB_DEPLOY = process.env.AUTO_DB_DEPLOY !== 'false'
export const PORT = Number(process.env.PORT ?? 5000)
export const HOST = process.env.HOST ?? '0.0.0.0'
export const AUTO_BACKUP_ENABLED = process.env.AUTO_BACKUP_ENABLED !== 'false'
export const AUTO_BACKUP_KEEP_DAYS = Number(process.env.AUTO_BACKUP_KEEP_DAYS ?? 7)
export const AUTO_BACKUP_HOUR = Number(process.env.AUTO_BACKUP_HOUR ?? 2)
export const AUTO_BACKUP_MINUTE = Number(process.env.AUTO_BACKUP_MINUTE ?? 0)
