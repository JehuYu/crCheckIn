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

function assertSqliteCliAvailable() {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['--version'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })

    child.on('error', () => {
      reject(new Error('sqlite3 command not found. Install it with "sudo apt install sqlite3" before migrating.'))
    })
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`sqlite3 command failed with exit code ${code ?? 'unknown'}`))
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

function hasId(importedIds, table, id) {
  return id === null || id === undefined || importedIds.get(table)?.has(id)
}

function filterValidRows(table, rows, importedIds) {
  const before = rows.length
  let filteredRows = rows

  switch (table) {
    case 'Class':
      filteredRows = rows.map((row) => (hasId(importedIds, 'Teacher', row.teacherId) ? row : { ...row, teacherId: null }))
      break
    case 'LoginLog':
      filteredRows = rows.filter((row) => hasId(importedIds, 'Teacher', row.teacherId))
      break
    case 'Student':
      filteredRows = rows.filter((row) => hasId(importedIds, 'Class', row.classId))
      break
    case 'StudentTag':
      filteredRows = rows.filter(
        (row) => hasId(importedIds, 'Class', row.classId) && hasId(importedIds, 'Student', row.studentId),
      )
      break
    case 'SignInConfig':
    case 'SignInSession':
    case 'InfoCollection':
      filteredRows = rows.filter((row) => hasId(importedIds, 'Class', row.classId))
      break
    case 'ArchivedRecord':
      filteredRows = rows.filter((row) => hasId(importedIds, 'SignInSession', row.sessionId))
      break
    case 'SignInRecord':
      filteredRows = rows.filter(
        (row) => hasId(importedIds, 'Class', row.classId) && hasId(importedIds, 'Student', row.studentId),
      )
      break
    case 'InfoField':
      filteredRows = rows.filter((row) => hasId(importedIds, 'InfoCollection', row.collectionId))
      break
    case 'InfoSubmission':
      filteredRows = rows.filter(
        (row) => hasId(importedIds, 'Class', row.classId) && hasId(importedIds, 'Student', row.studentId),
      )
      break
    case 'InfoResponse':
      filteredRows = rows.filter(
        (row) => hasId(importedIds, 'InfoSubmission', row.submissionId) && hasId(importedIds, 'InfoField', row.fieldId),
      )
      break
    default:
      break
  }

  const skipped = before - filteredRows.length
  if (skipped > 0) {
    console.log(`[migrate] ${table}: skipped ${skipped} orphan rows`)
  }

  return filteredRows
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

async function assertTargetSchemaReady() {
  const tableNames = tables.map(([table]) => table)
  const existingTables = await prisma.$queryRaw`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = ANY(${tableNames})
  `
  const existingTableNames = new Set(existingTables.map((row) => row.tablename))
  const missingTables = tableNames.filter((table) => !existingTableNames.has(table))

  if (missingTables.length > 0) {
    throw new Error(
      `PostgreSQL schema is not ready. Missing tables: ${missingTables.join(', ')}. Run "npx prisma generate && npm run db:deploy" before migrating.`,
    )
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

  await assertSqliteCliAvailable()
  await assertTargetSchemaReady()

  if (shouldClear) {
    console.log('[migrate] Clearing PostgreSQL target tables...')
    await clearTarget()
  }

  const importedIds = new Map()

  for (const [table, modelName] of tables) {
    const rows = await runSqliteJson(`SELECT * FROM "${table}"`)
    const normalizedRows = filterValidRows(
      table,
      rows.map((row) => normalizeRow(table, row)),
      importedIds,
    )
    await createMany(modelName, normalizedRows)
    importedIds.set(table, new Set(normalizedRows.map((row) => row.id)))
    console.log(`[migrate] ${table}: ${normalizedRows.length} rows`)
  }

  await resetSequences()
  console.log('[migrate] Done.')
} finally {
  await prisma.$disconnect()
}
