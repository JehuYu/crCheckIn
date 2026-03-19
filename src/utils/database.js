import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { AUTO_DB_DEPLOY, DATABASE_URL } from '../config.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const prismaDir = path.join(projectRoot, 'prisma')
const prismaCliPath = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js')

function logInfo(logger, message) {
  if (typeof logger?.info === 'function') {
    logger.info(message)
    return
  }
  console.log(message)
}

async function fileExists(filePath) {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function resolveSqlitePath(databaseUrl = DATABASE_URL) {
  if (!databaseUrl.startsWith('file:')) return null
  const rawPath = databaseUrl.slice('file:'.length)
  if (!rawPath) return null
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(prismaDir, rawPath)
}

async function runPrismaDbPush(logger) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prismaCliPath, 'db', 'push', '--skip-generate'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Prisma db push failed with exit code ${code ?? 'unknown'}`))
    })
  })

  logInfo(logger, '[db] Database schema is ready.')
}

export async function deployDatabase({ logger = console } = {}) {
  if (!AUTO_DB_DEPLOY) {
    logInfo(logger, '[db] AUTO_DB_DEPLOY=false, skipping automatic database deployment.')
    return
  }

  if (!(await fileExists(prismaCliPath))) {
    throw new Error(`Prisma CLI not found: ${prismaCliPath}`)
  }

  const sqlitePath = resolveSqlitePath()
  const dbExists = sqlitePath ? await fileExists(sqlitePath) : null

  if (dbExists === false) {
    logInfo(logger, `[db] Local database not found at ${sqlitePath}, creating it now...`)
  } else {
    logInfo(logger, '[db] Synchronizing database schema...')
  }

  await runPrismaDbPush(logger)
}
