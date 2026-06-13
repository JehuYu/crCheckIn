import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma as defaultPrisma } from '../plugins/db.js'
import {
  AUTO_BACKUP_HOUR,
  AUTO_BACKUP_KEEP_DAYS,
  AUTO_BACKUP_MINUTE,
  DATABASE_URL,
} from '../config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_DAILY_BACKUP_DIR = path.resolve(__dirname, '../../backups/daily')
export const DAILY_BACKUP_PREFIX = 'crcheckin-auto-'
export const DAILY_BACKUP_EXT = '.json'

const BACKUP_MODELS = [
  ['teachers', 'teacher'],
  ['classes', 'class'],
  ['students', 'student'],
  ['signInConfigs', 'signInConfig'],
  ['signInRecords', 'signInRecord'],
  ['signInSessions', 'signInSession'],
  ['archivedRecords', 'archivedRecord'],
  ['infoCollections', 'infoCollection'],
  ['infoFields', 'infoField'],
  ['infoSubmissions', 'infoSubmission'],
  ['infoResponses', 'infoResponse'],
  ['presetTags', 'presetTag'],
  ['auditLogs', 'auditLog'],
  ['loginLogs', 'loginLog'],
  ['studentTags', 'studentTag'],
  ['scoreProjects', 'scoreProject'],
  ['studentScores', 'studentScore'],
  ['scoreEntryLogs', 'scoreEntryLog'],
  ['memoryPkRooms', 'memoryPkRoom'],
  ['memoryPkParticipants', 'memoryPkParticipant'],
  ['memoryPkQuestions', 'memoryPkQuestion'],
]

function numberOrDefault(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function formatBackupDate(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function dailyBackupFilename(date = new Date()) {
  return `${DAILY_BACKUP_PREFIX}${formatBackupDate(date)}${DAILY_BACKUP_EXT}`
}

export function dailyBackupPath(date = new Date(), backupDir = DEFAULT_DAILY_BACKUP_DIR) {
  return path.join(backupDir, dailyBackupFilename(date))
}

export function isDailyBackupFile(filename) {
  return new RegExp(`^${DAILY_BACKUP_PREFIX}\\d{4}-\\d{2}-\\d{2}\\${DAILY_BACKUP_EXT}$`).test(filename)
}

export function msUntilNextDailyBackup(now = new Date(), hour = AUTO_BACKUP_HOUR, minute = AUTO_BACKUP_MINUTE) {
  const targetHour = Math.min(Math.max(numberOrDefault(hour, 2), 0), 23)
  const targetMinute = Math.min(Math.max(numberOrDefault(minute, 0), 0), 59)
  const next = new Date(now)
  next.setHours(targetHour, targetMinute, 0, 0)
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }
  return next.getTime() - now.getTime()
}

function databaseName(databaseUrl = DATABASE_URL) {
  try {
    const url = new URL(databaseUrl)
    return url.pathname.replace(/^\//, '')
  } catch {
    return ''
  }
}

export async function exportDatabaseSnapshot({ prisma = defaultPrisma, now = new Date() } = {}) {
  const data = {}
  const counts = {}
  for (const [backupKey, modelName] of BACKUP_MODELS) {
    const rows = await prisma[modelName].findMany({ orderBy: { id: 'asc' } })
    data[backupKey] = rows
    counts[backupKey] = rows.length
  }

  return {
    exportedAt: now.toISOString(),
    backupType: 'daily-json',
    database: databaseName(),
    counts,
    data,
  }
}

export async function createDailyBackup({
  prisma = defaultPrisma,
  backupDir = DEFAULT_DAILY_BACKUP_DIR,
  now = new Date(),
} = {}) {
  await fs.mkdir(backupDir, { recursive: true })
  const outputPath = dailyBackupPath(now, backupDir)
  const snapshot = await exportDatabaseSnapshot({ prisma, now })
  await fs.writeFile(outputPath, JSON.stringify(snapshot, null, 2), 'utf8')
  const stat = await fs.stat(outputPath)
  return {
    ok: true,
    path: outputPath,
    filename: path.basename(outputPath),
    size: stat.size,
    counts: snapshot.counts,
  }
}

export async function hasDailyBackupForDate(date = new Date(), backupDir = DEFAULT_DAILY_BACKUP_DIR) {
  try {
    await fs.access(dailyBackupPath(date, backupDir))
    return true
  } catch {
    return false
  }
}

export async function cleanupDailyBackups({
  backupDir = DEFAULT_DAILY_BACKUP_DIR,
  keepDays = AUTO_BACKUP_KEEP_DAYS,
} = {}) {
  await fs.mkdir(backupDir, { recursive: true })
  const keep = Math.max(1, Math.floor(numberOrDefault(keepDays, 7)))
  const files = (await fs.readdir(backupDir))
    .filter(isDailyBackupFile)
    .sort()
  const toDelete = files.slice(0, Math.max(0, files.length - keep))
  for (const filename of toDelete) {
    await fs.unlink(path.join(backupDir, filename))
  }
  return {
    kept: files.slice(Math.max(0, files.length - keep)),
    deleted: toDelete,
  }
}

export async function ensureDailyBackup({
  prisma = defaultPrisma,
  backupDir = DEFAULT_DAILY_BACKUP_DIR,
  now = new Date(),
  keepDays = AUTO_BACKUP_KEEP_DAYS,
  logger = console,
} = {}) {
  if (await hasDailyBackupForDate(now, backupDir)) {
    const cleanup = await cleanupDailyBackups({ backupDir, keepDays })
    logger.info?.(`[backup] Daily backup already exists: ${dailyBackupFilename(now)}`)
    return { ok: true, skipped: true, cleanup }
  }

  const backup = await createDailyBackup({ prisma, backupDir, now })
  const cleanup = await cleanupDailyBackups({ backupDir, keepDays })
  logger.info?.(`[backup] Daily backup saved: ${backup.path}`)
  return { ...backup, cleanup }
}

export function startDailyBackupScheduler({
  prisma = defaultPrisma,
  backupDir = DEFAULT_DAILY_BACKUP_DIR,
  keepDays = AUTO_BACKUP_KEEP_DAYS,
  hour = AUTO_BACKUP_HOUR,
  minute = AUTO_BACKUP_MINUTE,
  logger = console,
} = {}) {
  let timer = null
  let stopped = false

  async function run() {
    try {
      await ensureDailyBackup({ prisma, backupDir, keepDays, logger })
    } catch (error) {
      logger.error?.(`[backup] Daily backup failed: ${error.message}`)
    }
  }

  function scheduleNext() {
    if (stopped) return
    const delay = msUntilNextDailyBackup(new Date(), hour, minute)
    timer = setTimeout(async () => {
      await run()
      scheduleNext()
    }, delay)
    timer.unref?.()
  }

  run()
  scheduleNext()

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
