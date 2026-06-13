import { access, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import {
  assertSafeRuntimeDatabase,
  getDatabaseName,
  isLikelyTestDatabaseName,
} from '../src/utils/databaseSafety.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const envPath = path.join(projectRoot, '.env')

process.loadEnvFile?.(envPath)

const checks = []

function addCheck(status, name, detail = '') {
  checks.push({ status, name, detail })
}

function ok(name, detail = '') {
  addCheck('ok', name, detail)
}

function warn(name, detail = '') {
  addCheck('warn', name, detail)
}

function fail(name, detail = '') {
  addCheck('fail', name, detail)
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function normalizeSchema(text) {
  return text.replace(/\r\n/g, '\n').trim()
}

function safeUrlSummary(databaseUrl) {
  try {
    const url = new URL(databaseUrl)
    const databaseName = getDatabaseName(databaseUrl)
    return `${url.protocol}//${url.hostname}:${url.port || '5432'}/${databaseName}`
  } catch {
    return 'invalid DATABASE_URL'
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'unknown'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

async function checkEnv() {
  if (await exists(envPath)) {
    ok('.env file', envPath)
  } else {
    fail('.env file', `${envPath} not found`)
  }

  const secret = process.env.SECRET_KEY || ''
  if (secret.length >= 32) {
    ok('SECRET_KEY', 'configured')
  } else if (secret) {
    fail('SECRET_KEY', 'configured but shorter than 32 characters')
  } else {
    fail('SECRET_KEY', 'missing')
  }

  const databaseUrl = process.env.DATABASE_URL || ''
  if (!databaseUrl) {
    fail('DATABASE_URL', 'missing')
    return false
  }

  const databaseName = getDatabaseName(databaseUrl)
  if (!databaseName) {
    fail('DATABASE_URL', 'cannot parse database name')
    return false
  }

  const isTestDatabase = isLikelyTestDatabaseName(databaseName)
  ok('DATABASE_URL', `${safeUrlSummary(databaseUrl)}${isTestDatabase ? ' (test-like)' : ''}`)

  try {
    assertSafeRuntimeDatabase({
      databaseUrl,
      nodeEnv: process.env.NODE_ENV || '',
    })
    ok('runtime database guard', 'current NODE_ENV/DATABASE_URL combination is allowed')
  } catch (error) {
    fail('runtime database guard', error.message)
  }

  return true
}

async function checkPrismaClient() {
  const schemaPath = path.join(projectRoot, 'prisma', 'schema.prisma')
  const generatedSchemaPath = path.join(projectRoot, 'node_modules', '.prisma', 'client', 'schema.prisma')
  try {
    const [schema, generatedSchema] = await Promise.all([
      readFile(schemaPath, 'utf8'),
      readFile(generatedSchemaPath, 'utf8'),
    ])
    if (normalizeSchema(schema) === normalizeSchema(generatedSchema)) {
      ok('Prisma Client', 'matches prisma/schema.prisma')
    } else {
      fail('Prisma Client', 'out of date; run npm run test or npx prisma generate after stopping the service if Windows locks the engine file')
    }
  } catch (error) {
    fail('Prisma Client', error.message)
  }
}

async function checkDatabase() {
  if (!process.env.DATABASE_URL) return

  const prisma = new PrismaClient()
  try {
    await prisma.$queryRaw`SELECT 1`
    ok('database connection', 'query SELECT 1 succeeded')

    const counts = {
      teachers: await prisma.teacher.count(),
      classes: await prisma.class.count(),
      students: await prisma.student.count(),
      signInSessions: await prisma.signInSession.count(),
      archivedRecords: await prisma.archivedRecord.count(),
      scoreProjects: await prisma.scoreProject.count(),
      studentScores: await prisma.studentScore.count(),
    }
    ok('database counts', JSON.stringify(counts))
  } catch (error) {
    fail('database connection', error.message)
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

async function checkBackups() {
  const backupDir = path.join(projectRoot, 'backups', 'daily')
  if (!(await exists(backupDir))) {
    warn('daily backups', `${backupDir} not found yet`)
    return
  }

  const files = (await readdir(backupDir))
    .filter((filename) => /^crcheckin-auto-\d{4}-\d{2}-\d{2}\.json$/.test(filename))
    .sort()

  if (files.length === 0) {
    warn('daily backups', 'directory exists but no automatic JSON backups were found')
    return
  }

  const latest = files.at(-1)
  const latestStat = await stat(path.join(backupDir, latest))
  ok('daily backups', `${files.length} file(s), latest ${latest} (${formatBytes(latestStat.size)})`)

  if (files.length > 7) {
    warn('daily backup retention', `${files.length} automatic backups found; expected at most 7 after scheduler cleanup`)
  } else {
    ok('daily backup retention', `${files.length}/7 automatic backups`)
  }
}

async function checkHttpHealth() {
  const port = Number(process.env.PORT || 5000)
  const url = `http://127.0.0.1:${port}/health`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (response.ok) {
      ok('HTTP health', `${url} responded ${response.status}`)
    } else {
      warn('HTTP health', `${url} responded ${response.status}`)
    }
  } catch (error) {
    warn('HTTP health', `${url} not reachable: ${error.message}`)
  }
}

await checkEnv()
await checkPrismaClient()
await checkDatabase()
await checkBackups()
await checkHttpHealth()

const order = { fail: 0, warn: 1, ok: 2 }
for (const check of checks.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name))) {
  const label = check.status.padEnd(4)
  console.log(`[${label}] ${check.name}${check.detail ? ` - ${check.detail}` : ''}`)
}

const failed = checks.filter((check) => check.status === 'fail').length
const warned = checks.filter((check) => check.status === 'warn').length
const passed = checks.filter((check) => check.status === 'ok').length
console.log(`\nSummary: ${passed} ok, ${warned} warn, ${failed} fail`)

if (failed > 0) {
  process.exitCode = 1
}
