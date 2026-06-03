import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

process.loadEnvFile?.(path.join(projectRoot, '.env'))

process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.SECRET_KEY =
  process.env.SECRET_KEY && process.env.SECRET_KEY.length >= 32
    ? process.env.SECRET_KEY
    : 'test-secret-key-for-crcheckin-32-chars'

function deriveTestDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return null
  const url = new URL(databaseUrl)
  const baseName = url.pathname.split('/').filter(Boolean).pop() || 'crcheckin'
  url.pathname = `/${baseName}_test`
  return url.toString()
}

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  deriveTestDatabaseUrl(process.env.DATABASE_URL)

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL or TEST_DATABASE_URL is required to run tests.')
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
      ...options,
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

async function listTestFiles() {
  const dirs = ['src/services', 'src/utils', 'src/routes']
  const files = []
  for (const dir of dirs) {
    const absoluteDir = path.join(projectRoot, dir)
    const entries = await readdir(absoluteDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.test.js')) {
        files.push(path.join(dir, entry.name).replaceAll(path.sep, '/'))
      }
    }
  }
  return files.sort()
}

const prismaCli = path.join(projectRoot, 'node_modules', 'prisma', 'build', 'index.js')
const schemaPath = path.join(projectRoot, 'prisma', 'schema.prisma')
const dbCode = await run(process.execPath, [prismaCli, 'db', 'push', '--skip-generate', '--schema', schemaPath])
if (dbCode !== 0) process.exit(dbCode)

const testFiles = await listTestFiles()
const testCode = await run(process.execPath, ['--test', '--test-concurrency=1', ...testFiles])
process.exit(testCode)
