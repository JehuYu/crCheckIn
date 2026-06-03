import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const sqlitePath = path.resolve(process.argv[2] ?? 'prisma/attendance.db')
const shouldClear = process.argv.includes('--clear')

const tables = [
  ['Teacher', 'teacher'],
  ['PresetTag', 'presetTag'],
  ['Class', 'class'],
  ['LoginLog', 'loginLog'],
  ['Student', 'student'],
  ['StudentTag', 'studentTag'],
  ['SignInConfig', 'signInConfig'],
  ['SignInSession', 'signInSession'],
  ['ArchivedRecord', 'archivedRecord'],
  ['SignInRecord', 'signInRecord'],
  ['InfoCollection', 'infoCollection'],
  ['InfoField', 'infoField'],
  ['InfoSubmission', 'infoSubmission'],
  ['InfoResponse', 'infoResponse'],
  ['AuditLog', 'auditLog'],
]

const booleanFields = {
  Teacher: ['isAdmin'],
  Class: ['isArchived'],
  InfoCollection: ['enabled'],
  InfoField: ['required'],
  LoginLog: ['success'],
}

const dateFields = {
  Teacher: ['createdAt'],
  Class: ['deletedAt', 'createdAt'],
  SignInSession: ['archivedAt'],
  ArchivedRecord: ['signedAt'],
  SignInRecord: ['signedAt'],
  SignInConfig: ['activeStartedAt'],
  InfoCollection: ['createdAt', 'updatedAt'],
  InfoSubmission: ['submittedAt'],
  InfoResponse: ['createdAt'],
  AuditLog: ['createdAt'],
  LoginLog: ['createdAt'],
}

function runSqliteJson(query) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['-json', sqlitePath, query], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `sqlite3 exited with code ${code}`))
        return
      }
      resolve(stdout.trim() ? JSON.parse(stdout) : [])
    })
  })
}

function normalizeRow(table, row) {
  const normalized = { ...row }

  for (const field of booleanFields[table] ?? []) {
    if (normalized[field] !== null && normalized[field] !== undefined) {
      normalized[field] = Boolean(normalized[field])
    }
  }

  for (const field of dateFields[table] ?? []) {
    if (normalized[field] !== null && normalized[field] !== undefined && normalized[field] !== '') {
      normalized[field] = new Date(normalized[field])
    }
  }

  return normalized
}

async function createMany(modelName, rows) {
  const model = prisma[modelName]
  if (!model) throw new Error(`Prisma model not found: ${modelName}`)

  const chunkSize = 500
  for (let index = 0; index < rows.length; index += chunkSize) {
    await model.createMany({
      data: rows.slice(index, index + chunkSize),
      skipDuplicates: true,
    })
  }
}

async function resetSequences() {
  for (const [table] of tables) {
    await prisma.$executeRawUnsafe(`
      SELECT setval(
        pg_get_serial_sequence('"${table}"', 'id'),
        COALESCE((SELECT MAX(id) FROM "${table}"), 1),
        (SELECT COUNT(*) > 0 FROM "${table}")
      )
    `)
  }
}

async function clearTarget() {
  const tableNames = tables.map(([table]) => `"${table}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`)
}

try {
  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found: ${sqlitePath}`)
  }

  if (shouldClear) {
    console.log('[migrate] Clearing PostgreSQL target tables...')
    await clearTarget()
  }

  for (const [table, modelName] of tables) {
    const rows = await runSqliteJson(`SELECT * FROM "${table}"`)
    const normalizedRows = rows.map((row) => normalizeRow(table, row))
    await createMany(modelName, normalizedRows)
    console.log(`[migrate] ${table}: ${normalizedRows.length} rows`)
  }

  await resetSequences()
  console.log('[migrate] Done.')
} finally {
  await prisma.$disconnect()
}
