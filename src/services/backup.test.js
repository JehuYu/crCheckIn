import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupDailyBackups,
  createDailyBackup,
  dailyBackupFilename,
  ensureDailyBackup,
  formatBackupDate,
  isDailyBackupFile,
  msUntilNextDailyBackup,
} from './backup.js'

function model(rows) {
  return {
    async findMany() {
      return rows
    },
  }
}

function fakePrisma() {
  return {
    teacher: model([{ id: 1, username: 'admin', isAdmin: true }]),
    class: model([{ id: 1, name: '一劳A3', teacherId: 1 }]),
    student: model([{ id: 1, name: '张三', classId: 1 }]),
    signInConfig: model([]),
    signInRecord: model([]),
    signInSession: model([]),
    archivedRecord: model([]),
    infoCollection: model([]),
    infoField: model([]),
    infoSubmission: model([]),
    infoResponse: model([]),
    presetTag: model([]),
    auditLog: model([]),
    loginLog: model([]),
    studentTag: model([]),
    scoreProject: model([]),
    studentScore: model([]),
    scoreEntryLog: model([]),
    memoryPkRoom: model([]),
    memoryPkParticipant: model([]),
    memoryPkQuestion: model([]),
  }
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'crcheckin-backup-test-'))
}

describe('daily backup service', () => {
  it('formats daily backup filenames by local date', () => {
    const date = new Date(2026, 5, 11, 9, 30, 0)
    assert.equal(formatBackupDate(date), '2026-06-11')
    assert.equal(dailyBackupFilename(date), 'crcheckin-auto-2026-06-11.json')
    assert.equal(isDailyBackupFile('crcheckin-auto-2026-06-11.json'), true)
    assert.equal(isDailyBackupFile('crcheckin.system.dump'), false)
  })

  it('calculates the next backup delay', () => {
    const before = new Date(2026, 5, 11, 1, 30, 0)
    const after = new Date(2026, 5, 11, 2, 30, 0)
    assert.equal(msUntilNextDailyBackup(before, 2, 0), 30 * 60 * 1000)
    assert.equal(msUntilNextDailyBackup(after, 2, 0), 23.5 * 60 * 60 * 1000)
  })

  it('creates a JSON backup with table counts', async () => {
    const dir = await tempDir()
    const now = new Date(2026, 5, 11, 8, 0, 0)
    const result = await createDailyBackup({ prisma: fakePrisma(), backupDir: dir, now })

    assert.equal(result.filename, 'crcheckin-auto-2026-06-11.json')
    assert.equal(result.counts.teachers, 1)
    assert.equal(result.counts.classes, 1)
    assert.equal(result.counts.students, 1)

    const saved = JSON.parse(await fs.readFile(path.join(dir, result.filename), 'utf8'))
    assert.equal(saved.backupType, 'daily-json')
    assert.equal(saved.data.teachers[0].username, 'admin')
    assert.equal(saved.data.classes[0].name, '一劳A3')
  })

  it('keeps only the latest seven automatic daily backups', async () => {
    const dir = await tempDir()
    for (let day = 1; day <= 9; day++) {
      await fs.writeFile(path.join(dir, `crcheckin-auto-2026-06-${String(day).padStart(2, '0')}.json`), '{}')
    }
    await fs.writeFile(path.join(dir, 'crcheckin.system.dump'), 'manual')

    const cleanup = await cleanupDailyBackups({ backupDir: dir, keepDays: 7 })
    const files = (await fs.readdir(dir)).sort()

    assert.deepEqual(cleanup.deleted, ['crcheckin-auto-2026-06-01.json', 'crcheckin-auto-2026-06-02.json'])
    assert.equal(files.includes('crcheckin.system.dump'), true)
    assert.equal(files.filter(isDailyBackupFile).length, 7)
    assert.equal(files.includes('crcheckin-auto-2026-06-09.json'), true)
  })

  it('skips creating a second backup for the same day', async () => {
    const dir = await tempDir()
    const now = new Date(2026, 5, 11, 8, 0, 0)
    await createDailyBackup({ prisma: fakePrisma(), backupDir: dir, now })
    const result = await ensureDailyBackup({
      prisma: fakePrisma(),
      backupDir: dir,
      now,
      logger: { info() {}, error() {} },
    })

    assert.equal(result.skipped, true)
    assert.equal((await fs.readdir(dir)).filter(isDailyBackupFile).length, 1)
  })
})
