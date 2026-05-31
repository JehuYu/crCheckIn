import { describe, before, beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma, cleanDatabase, factories } from '../test-helpers.js'
import {
  backfillSharedStudentPhotos,
  batchUploadPoolPhotos,
  bulkUploadPhotos,
  compareClassNames,
  createPoolClass,
  getPoolClassAssessmentType,
  restorePoolClass,
  returnTeacherClassToPool,
  syncPoolPhotosToTeacherClasses,
  uploadStudentPhoto,
} from './pool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const PHOTO_ROOT = path.join(PROJECT_ROOT, 'uploads', 'photos')

let createdPhotoUrls = []

async function removeUploadedPhoto(url) {
  if (!url) return
  const filePath = path.resolve(PROJECT_ROOT, url.replace(/^\//, ''))
  if (!filePath.startsWith(PHOTO_ROOT + path.sep)) return
  await fs.unlink(filePath).catch(() => {})
}

async function trackPhotoUrl(url) {
  if (url) createdPhotoUrls.push(url)
}

describe('pool photo service', () => {
  before(async () => {
    await prisma.$connect()
  })

  beforeEach(async () => {
    await cleanDatabase()
    createdPhotoUrls = []
  })

  afterEach(async () => {
    for (const url of createdPhotoUrls) {
      await removeUploadedPhoto(url)
    }
    await cleanDatabase()
  })

  it('batchUploadPoolPhotos makes photos available to teacher memory before resolving', async () => {
    const teacher = await factories.createTeacher()
    const teacherClass = await factories.createClass({ name: 'Class A', teacherId: teacher.id })
    const poolClass = await factories.createClass({ name: 'Class A', teacherId: null })
    await factories.createStudent({ name: 'Alice', classId: teacherClass.id })
    const poolStudent = await factories.createStudent({ name: 'Alice', classId: poolClass.id })

    const result = await batchUploadPoolPhotos([
      { filename: 'Alice.jpg', buffer: Buffer.from('fake-image') },
    ])

    assert.equal(result.ok, true)
    assert.equal(result.matched, 1)
    assert.equal(result.synced, 2)

    const updatedPoolStudent = await prisma.student.findUnique({ where: { id: poolStudent.id } })
    const updatedTeacherStudent = await prisma.student.findFirst({
      where: { classId: teacherClass.id, name: 'Alice' },
    })
    await trackPhotoUrl(updatedPoolStudent.photoUrl)

    assert.match(updatedPoolStudent.photoUrl, /\/uploads\/photos\/\d{4}\/\d{2}\/student_\d+_[a-f0-9]+\.jpg/)
    assert.equal(updatedTeacherStudent.photoUrl, updatedPoolStudent.photoUrl)
  })

  it('bulkUploadPhotos syncs a selected pool class to matching teacher classes immediately', async () => {
    const teacher = await factories.createTeacher()
    const teacherClass = await factories.createClass({ name: 'Class B', teacherId: teacher.id })
    const poolClass = await factories.createClass({ name: 'Class B', teacherId: null })
    await factories.createStudent({ name: 'Bob', classId: teacherClass.id })
    const poolStudent = await factories.createStudent({ name: 'Bob', classId: poolClass.id })

    const result = await bulkUploadPhotos(poolClass.id, [
      { filename: 'Bob.png', buffer: Buffer.from('fake-image') },
    ])

    assert.equal(result.ok, true)
    assert.equal(result.matched, 1)
    assert.equal(result.synced, 2)

    const updatedPoolStudent = await prisma.student.findUnique({ where: { id: poolStudent.id } })
    const updatedTeacherStudent = await prisma.student.findFirst({
      where: { classId: teacherClass.id, name: 'Bob' },
    })
    await trackPhotoUrl(updatedPoolStudent.photoUrl)

    assert.equal(updatedTeacherStudent.photoUrl, updatedPoolStudent.photoUrl)
  })

  it('batchUploadPoolPhotos shares one real student photo across multiple course classes', async () => {
    const classOne = await factories.createClass({ name: 'Course One', teacherId: null })
    const classTwo = await factories.createClass({ name: 'Course Two', teacherId: null })
    await factories.createStudent({ name: 'Evan', homeClass: '5', classId: classOne.id })
    await factories.createStudent({ name: 'Evan', homeClass: '5', classId: classTwo.id })

    const result = await batchUploadPoolPhotos([
      { filename: 'Evan.jpg', buffer: Buffer.from('fake-image') },
    ])

    assert.equal(result.ok, true)
    assert.equal(result.matched, 1)
    assert.equal(result.synced, 2)

    const students = await prisma.student.findMany({
      where: { name: 'Evan' },
      orderBy: { classId: 'asc' },
    })
    await trackPhotoUrl(students[0].photoUrl)

    assert.equal(students.length, 2)
    assert.ok(students[0].photoUrl)
    assert.equal(students[1].photoUrl, students[0].photoUrl)
  })

  it('backfillSharedStudentPhotos repairs existing duplicated course records', async () => {
    const classOne = await factories.createClass({ name: 'Course Three', teacherId: null })
    const classTwo = await factories.createClass({ name: 'Course Four', teacherId: null })
    await factories.createStudent({
      name: 'Faye',
      homeClass: '6',
      classId: classOne.id,
      photoUrl: '/uploads/photos/existing/faye.jpg',
    })
    const missing = await factories.createStudent({ name: 'Faye', homeClass: '6', classId: classTwo.id })

    const result = await backfillSharedStudentPhotos()
    const repaired = await prisma.student.findUnique({ where: { id: missing.id } })

    assert.equal(result.synced, 1)
    assert.equal(result.conflictCount, 0)
    assert.equal(repaired.photoUrl, '/uploads/photos/existing/faye.jpg')
  })

  it('syncPoolPhotosToTeacherClasses replaces stale teacher photos', async () => {
    const teacher = await factories.createTeacher()
    const teacherClass = await factories.createClass({ name: 'Class C', teacherId: teacher.id })
    const poolClass = await factories.createClass({ name: 'Class C', teacherId: null })
    await factories.createStudent({
      name: 'Carol',
      classId: teacherClass.id,
      photoUrl: '/uploads/photos/old/carol.jpg',
    })
    await factories.createStudent({
      name: 'Carol',
      classId: poolClass.id,
      photoUrl: '/uploads/photos/new/carol.jpg',
    })

    const result = await syncPoolPhotosToTeacherClasses(poolClass.id)
    const updatedTeacherStudent = await prisma.student.findFirst({
      where: { classId: teacherClass.id, name: 'Carol' },
    })

    assert.equal(result.synced, 1)
    assert.equal(updatedTeacherStudent.photoUrl, '/uploads/photos/new/carol.jpg')
  })

  it('uploadStudentPhoto stores with a safe filename even when the original name has path-forbidden characters', async () => {
    const teacher = await factories.createTeacher()
    const cls = await factories.createClass({ name: 'Class D', teacherId: teacher.id })
    const student = await factories.createStudent({ name: 'Dana', classId: cls.id })

    const result = await uploadStudentPhoto(cls.id, student.id, Buffer.from('fake-image'), 'Dana?.jpg')
    await trackPhotoUrl(result.url)

    assert.equal(result.ok, true)
    assert.match(result.url, /\/uploads\/photos\/\d{4}\/\d{2}\/student_\d+_[a-f0-9]+\.jpg/)
    const updatedStudent = await prisma.student.findUnique({ where: { id: student.id } })
    assert.equal(updatedStudent.photoUrl, result.url)
  })
})

describe('pool class lifecycle', () => {
  before(async () => {
    await prisma.$connect()
  })

  beforeEach(cleanDatabase)
  afterEach(cleanDatabase)

  it('createPoolClass rejects a duplicate active pool class', async () => {
    await createPoolClass('一劳A4')

    await assert.rejects(
      () => createPoolClass('一劳A4'),
      err => err.statusCode === 409 && err.message.includes('已存在')
    )
  })

  it('sorts class names by their numeric portions', () => {
    const names = ['二通B12', '二通B2', '二通B10', '二通B1', '二通B3']

    assert.deepEqual(
      names.sort(compareClassNames),
      ['二通B1', '二通B2', '二通B3', '二通B10', '二通B12']
    )
  })

  it('classifies A classes as elective and B classes as academic', () => {
    assert.equal(getPoolClassAssessmentType('一劳A4'), 'elective')
    assert.equal(getPoolClassAssessmentType('二通B12'), 'academic')
    assert.equal(getPoolClassAssessmentType('临时班'), '')
  })

  it('returnTeacherClassToPool removes the teacher copy when the pool class already exists', async () => {
    const teacher = await factories.createTeacher()
    const poolClass = await factories.createClass({ name: '一劳A4', teacherId: null })
    const teacherClass = await factories.createClass({ name: '一劳A4', teacherId: teacher.id })
    await factories.createStudent({ name: '张三', classId: poolClass.id, photoUrl: '/uploads/photos/pool.jpg' })
    await factories.createStudent({ name: '张三', classId: teacherClass.id, photoUrl: '/uploads/photos/teacher.jpg' })

    const result = await returnTeacherClassToPool(teacherClass.id)

    assert.equal(result.ok, true)
    assert.equal(result.reusedExistingPoolClass, true)
    assert.equal(await prisma.class.count({ where: { id: teacherClass.id } }), 0)
    assert.equal(await prisma.class.count({ where: { name: '一劳A4', teacherId: null, deletedAt: null } }), 1)
    assert.equal(await prisma.student.count({ where: { classId: poolClass.id } }), 1)
  })

  it('returnTeacherClassToPool preserves students when creating the pool record', async () => {
    const teacher = await factories.createTeacher()
    const teacherClass = await factories.createClass({ name: '二信B3', teacherId: teacher.id })
    await factories.createStudent({
      name: '李四',
      classId: teacherClass.id,
      photoUrl: '/uploads/photos/student.jpg',
    })

    const result = await returnTeacherClassToPool(teacherClass.id)
    const returnedClass = await prisma.class.findUnique({
      where: { id: teacherClass.id },
      include: { students: true },
    })

    assert.equal(result.ok, true)
    assert.equal(result.reusedExistingPoolClass, false)
    assert.equal(returnedClass.teacherId, null)
    assert.equal(returnedClass.students.length, 1)
    assert.equal(returnedClass.students[0].photoUrl, '/uploads/photos/student.jpg')
  })

  it('restorePoolClass refuses to restore a duplicate active pool class', async () => {
    await factories.createClass({ name: '三职A1', teacherId: null })
    const deletedClass = await factories.createClass({ name: '三职A1', teacherId: null })
    await prisma.class.update({ where: { id: deletedClass.id }, data: { deletedAt: new Date() } })

    const result = await restorePoolClass(deletedClass.id)

    assert.equal(result.ok, false)
    assert.match(result.message, /请勿重复恢复/)
  })
})
