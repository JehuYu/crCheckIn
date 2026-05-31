import { prisma } from '../plugins/db.js'
import ExcelJS from 'exceljs'
import path from 'path'
import fs from 'fs/promises'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.resolve(__dirname, '../../uploads/photos')
const PHOTO_MAX_SIZE = 5 * 1024 * 1024
const ALLOWED_PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])
const CLASS_NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

export function compareClassNames(a, b) {
  const nameA = String(a || '')
  const nameB = String(b || '')
  const result = CLASS_NAME_COLLATOR.compare(nameA, nameB)
  return result !== 0 ? result : nameA.localeCompare(nameB, 'zh-CN')
}

export function getPoolClassAssessmentType(name) {
  const match = String(name || '').match(/[AB](?=\d)/i)
  if (!match) return ''
  return match[0].toUpperCase() === 'A' ? 'elective' : 'academic'
}

// 数据库写入队列：序列化并发写入，避免 SQLite 锁竞争导致超时
const _writeQueue = []
let _writeProcessing = false

async function _enqueueWrite(fn) {
  return new Promise((resolve, reject) => {
    _writeQueue.push({ fn, resolve, reject })
    _processWriteQueue()
  })
}

async function _processWriteQueue() {
  if (_writeProcessing) return
  _writeProcessing = true
  while (_writeQueue.length > 0) {
    const { fn, resolve, reject } = _writeQueue.shift()
    try {
      resolve(await fn())
    } catch (err) {
      reject(err)
    }
  }
  _writeProcessing = false
}

/**
 * 标准化姓名用于匹配：去除空白、全角转半角、去除标点等
 */
function normalizeName(name) {
  return String(name || '')
    .replace(/[﻿​‌‍ ]/g, '')   // BOM、零宽空格、不间断空格
    .trim()
    .replace(/\s+/g, '')                                   // 去除所有空白
    .replace(/[（）()【】\[\]《》<>「」『』""''、，。：:；;！!？?～~·]/g, '') // 去除中英文标点
    .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角字母→半角
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角数字→半角
    .replace(/^[.\-_\s]+|[.\-_\s]+$/g, '')                 // 去除首尾标点
    .toLowerCase()
}

function getAllowedPhotoExt(filename) {
  const ext = path.extname(filename || '').toLowerCase()
  return ALLOWED_PHOTO_EXTS.has(ext) ? ext : null
}

function makeStoredPhotoFilename(studentId, ext, existingFiles = new Set()) {
  const baseName = `student_${studentId}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  let safeFilename = `${baseName}${ext}`
  let counter = 1
  while (existingFiles.has(safeFilename)) {
    safeFilename = `${baseName}_${counter}${ext}`
    counter++
  }
  existingFiles.add(safeFilename)
  return safeFilename
}

function getStudentIdentityKey(student) {
  const nameKey = normalizeName(student?.name)
  if (!nameKey) return ''
  const homeClassKey = normalizeName(student?.homeClass || '')
  return `${nameKey}::${homeClassKey}`
}

async function updateStudentPhotos(updates) {
  let count = 0
  for (const update of updates) {
    await prisma.student.update({
      where: { id: update.studentId },
      data: { photoUrl: update.photoUrl },
    })
    count++
  }
  return count
}

export async function syncPhotosAcrossSharedStudents(sourceStudents) {
  const keyToPhoto = new Map()
  const conflictKeys = new Set()

  for (const student of sourceStudents) {
    if (!student?.photoUrl) continue
    const key = getStudentIdentityKey(student)
    if (!key) continue
    const previousPhoto = keyToPhoto.get(key)
    if (previousPhoto && previousPhoto !== student.photoUrl) {
      conflictKeys.add(key)
      continue
    }
    keyToPhoto.set(key, student.photoUrl)
  }

  if (keyToPhoto.size === 0) return { synced: 0, conflictCount: conflictKeys.size }

  const students = await prisma.student.findMany({
    where: { class: { deletedAt: null } },
    select: { id: true, name: true, homeClass: true, photoUrl: true },
  })

  const updates = []
  for (const student of students) {
    const key = getStudentIdentityKey(student)
    if (!key || conflictKeys.has(key)) continue
    const photoUrl = keyToPhoto.get(key)
    if (photoUrl && student.photoUrl !== photoUrl) {
      updates.push({ studentId: student.id, photoUrl })
    }
  }

  return {
    synced: await updateStudentPhotos(updates),
    conflictCount: conflictKeys.size,
  }
}

export async function backfillSharedStudentPhotos() {
  const students = await prisma.student.findMany({
    where: { class: { deletedAt: null } },
    select: { id: true, name: true, homeClass: true, photoUrl: true },
  })

  const groups = new Map()
  for (const student of students) {
    const key = getStudentIdentityKey(student)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(student)
  }

  const updates = []
  let conflictCount = 0
  for (const group of groups.values()) {
    const photoUrls = [...new Set(group.map((student) => student.photoUrl).filter(Boolean))]
    if (photoUrls.length === 0) continue
    if (photoUrls.length > 1) {
      conflictCount++
      continue
    }
    const [photoUrl] = photoUrls
    for (const student of group) {
      if (student.photoUrl !== photoUrl) {
        updates.push({ studentId: student.id, photoUrl })
      }
    }
  }

  return {
    synced: await updateStudentPhotos(updates),
    conflictCount,
  }
}

/**
 * 获取班级池中的所有班级（teacherId IS NULL，未删除）
 * @param {object} [opts]
 * @param {string} [opts.semester] - 按学期筛选，空字符串=当前未归档
 * @param {number} [opts.teacherId] - 当前教师ID，用于判断认领状态
 */
export async function getPoolClasses(opts = {}) {
  const where = { teacherId: null, deletedAt: null }
  if (opts.semester !== undefined) {
    where.semester = opts.semester
  } else {
    where.isArchived = false
  }
  const classes = await prisma.class.findMany({
    where,
    orderBy: { id: 'asc' },
    include: {
      _count: { select: { students: true } },
    },
  })

  // 获取所有教师班级的名称，用于判断认领状态
  const teacherClassNames = await prisma.class.findMany({
    where: { teacherId: { not: null }, deletedAt: null },
    select: { name: true, teacherId: true },
  })
  const nameToTeachers = new Map()
  for (const tc of teacherClassNames) {
    if (!nameToTeachers.has(tc.name)) nameToTeachers.set(tc.name, new Set())
    nameToTeachers.get(tc.name).add(tc.teacherId)
  }

  return classes.map(c => {
    const teachers = nameToTeachers.get(c.name)
    return {
      id: c.id,
      name: c.name,
      studentCount: c._count.students,
      semester: c.semester,
      isArchived: c.isArchived,
      createdAt: c.createdAt,
      assessmentType: getPoolClassAssessmentType(c.name),
      claimedByAnyTeacher: !!teachers && teachers.size > 0,
      claimedByCurrentTeacher: !!teachers && opts.teacherId != null && teachers.has(opts.teacherId),
    }
  }).sort((a, b) => compareClassNames(a.name, b.name))
}

/**
 * 获取回收站中的班级（已软删除）
 */
export async function getRecycleBinClasses() {
  const classes = await prisma.class.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
    include: {
      _count: { select: { students: true } },
    },
  })
  return classes.map(c => ({
    id: c.id,
    name: c.name,
    studentCount: c._count.students,
    deletedAt: c.deletedAt ? new Date(c.deletedAt).toLocaleDateString('zh-CN') : '',
    assessmentType: getPoolClassAssessmentType(c.name),
  }))
}

/**
 * 软删除班级池班级（移入回收站）
 */
export async function softDeletePoolClass(classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls || cls.teacherId !== null) return { ok: false, message: '班级不存在或不属于班级池' }
  await prisma.class.update({
    where: { id: classId },
    data: { deletedAt: new Date() },
  })
  return { ok: true, message: `「${cls.name}」已移入回收站` }
}

/**
 * 恢复回收站中的班级
 */
export async function restorePoolClass(classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls || cls.deletedAt === null) return { ok: false, message: '班级不在回收站中' }
  const existing = await prisma.class.findFirst({
    where: {
      id: { not: classId },
      name: cls.name,
      teacherId: null,
      deletedAt: null,
      isArchived: false,
    },
    select: { id: true },
  })
  if (existing) return { ok: false, message: `当前班级池中已存在「${cls.name}」，请勿重复恢复` }
  await prisma.class.update({
    where: { id: classId },
    data: { deletedAt: null },
  })
  return { ok: true, message: `「${cls.name}」已恢复` }
}

/**
 * 彻底删除回收站中的班级（连同学生数据）
 */
export async function hardDeletePoolClass(classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls || cls.deletedAt === null) return { ok: false, message: '班级不在回收站中' }
  const { deleteClassesCascadeWithTx } = await import('./class.js')
  await prisma.$transaction(async (tx) => {
    await deleteClassesCascadeWithTx(tx, [classId])
  })
  return { ok: true, message: `「${cls.name}」已彻底删除` }
}

/**
 * 将班级池中的照片同步到同名教师班级
 * @param {number} poolClassId - 班级池班级 ID
 * @returns {{ ok: boolean, synced: number }}
 */
export async function syncPoolPhotosToTeacherClasses(poolClassId) {
  const poolClass = await prisma.class.findUnique({ where: { id: poolClassId } })
  if (!poolClass || poolClass.teacherId !== null) return { ok: false, synced: 0 }

  // 查找所有同名的教师班级
  const teacherClasses = await prisma.class.findMany({
    where: { name: poolClass.name, teacherId: { not: null }, deletedAt: null },
    select: { id: true },
  })
  if (teacherClasses.length === 0) return { ok: true, synced: 0 }

  // 获取班级池中所有学生（含照片和无照片）
  const poolStudents = await prisma.student.findMany({
    where: { classId: poolClassId },
    select: { name: true, photoUrl: true, homeClass: true },
  })
  // 班级池中有照片的学生
  const poolPhotoMap = new Map(
    poolStudents
      .filter(s => s.photoUrl)
      .map(s => [normalizeName(s.name), s])
  )
  // 班级池中无照片的学生姓名集合
  const poolNoPhotoSet = new Set(
    poolStudents
      .filter(s => !s.photoUrl)
      .map(s => normalizeName(s.name))
  )

  let totalSynced = 0

  for (const tc of teacherClasses) {
    const teacherStudents = await prisma.student.findMany({
      where: { classId: tc.id },
      select: { id: true, name: true, photoUrl: true },
    })

    const updatePhotoIds = []
    const clearPhotoIds = []
    const insertData = []

    for (const ts of teacherStudents) {
      const normName = normalizeName(ts.name)
      const poolPhoto = poolPhotoMap.get(normName)
      if (poolPhoto) {
        // 班级池照片是记忆页的来源之一；同步时也替换旧照片，避免学生卡仍指向过期图片。
        if (ts.photoUrl !== poolPhoto.photoUrl) {
          updatePhotoIds.push({ id: ts.id, photoUrl: poolPhoto.photoUrl })
          totalSynced++
        }
      } else if (ts.photoUrl && poolNoPhotoSet.has(normName)) {
        // 班级池无照片，教师有 → 清除
        clearPhotoIds.push(ts.id)
        totalSynced++
      } else if (ts.photoUrl && !poolPhotoMap.has(normName) && !poolNoPhotoSet.has(normName)) {
        // 班级池中不存在该学生，但教师有照片 → 保留（不做处理）
      }
    }

    // 班级池有但教师没有的学生：复制过去
    const teacherNameSet = new Set(teacherStudents.map(s => normalizeName(s.name)))
    for (const [normName, ps] of poolPhotoMap) {
      if (!teacherNameSet.has(normName)) {
        insertData.push({
          name: ps.name,
          homeClass: ps.homeClass,
          photoUrl: ps.photoUrl,
          classId: tc.id,
        })
        totalSynced++
      }
    }

    // 批量更新照片（使用 Prisma transaction 批量执行）
    if (updatePhotoIds.length > 0) {
      await prisma.$transaction(
        updatePhotoIds.map(u =>
          prisma.student.update({ where: { id: u.id }, data: { photoUrl: u.photoUrl } })
        )
      )
    }

    // 批量清除照片
    if (clearPhotoIds.length > 0) {
      await prisma.$transaction(
        clearPhotoIds.map(id =>
          prisma.student.update({ where: { id }, data: { photoUrl: '' } })
        )
      )
    }

    // 批量插入
    if (insertData.length > 0) {
      await prisma.student.createMany({ data: insertData })
    }
  }

  return { ok: true, synced: totalSynced }
}

/**
 * 教师端上传照片后，同步到同名班级池班级
 * @param {number} teacherClassId - 教师班级 ID
 */
export async function syncTeacherPhotoToPool(teacherClassId) {
  const teacherClass = await prisma.class.findUnique({ where: { id: teacherClassId } })
  if (!teacherClass || teacherClass.teacherId === null) return { ok: false, synced: 0 }

  // 查找同名的班级池班级
  const poolClass = await prisma.class.findFirst({
    where: { name: teacherClass.name, teacherId: null, deletedAt: null },
    select: { id: true },
  })
  if (!poolClass) return { ok: true, synced: 0 }

  // 获取教师班级中有照片的学生
  const teacherStudents = await prisma.student.findMany({
    where: { classId: teacherClassId, photoUrl: { not: '' } },
    select: { name: true, photoUrl: true },
  })
  if (teacherStudents.length === 0) return { ok: true, synced: 0 }

  const teacherPhotoMap = new Map(teacherStudents.map(s => [normalizeName(s.name), s]))

  // 获取班级池中没有照片的学生
  const poolStudents = await prisma.student.findMany({
    where: { classId: poolClass.id },
    select: { id: true, name: true, photoUrl: true },
  })

  const updates = []
  for (const ps of poolStudents) {
    if (ps.photoUrl) continue
    const tp = teacherPhotoMap.get(normalizeName(ps.name))
    if (tp) {
      updates.push({ id: ps.id, photoUrl: tp.photoUrl })
    }
  }

  if (updates.length > 0) {
    await prisma.$transaction(
      updates.map(u =>
        prisma.student.update({ where: { id: u.id }, data: { photoUrl: u.photoUrl } })
      )
    )
  }

  return { ok: true, synced: updates.length }
}

/**
 * 获取班级池中所有学期列表
 */
export async function getPoolSemesters() {
  const result = await prisma.class.findMany({
    where: { teacherId: null, isArchived: true, semester: { not: '' } },
    select: { semester: true },
    distinct: ['semester'],
    orderBy: { semester: 'desc' },
  })
  return result.map(r => r.semester)
}

/**
 * 归档班级池中的当前学期班级
 * @param {string} semester - 学期名称，如 "2025秋"
 */
export async function archivePoolSemester(semester) {
  if (!semester || !semester.trim()) return { ok: false, message: '学期名不能为空' }
  const result = await prisma.class.updateMany({
    where: { teacherId: null, isArchived: false, semester: '' },
    data: { isArchived: true, semester: semester.trim() },
  })
  return { ok: true, count: result.count, message: `已归档 ${result.count} 个班级` }
}

/**
 * 撤销班级池学期归档
 * @param {string} semester - 学期名称
 */
export async function unarchivePoolSemester(semester) {
  if (!semester || !semester.trim()) return { ok: false, message: '学期名不能为空' }
  const result = await prisma.class.updateMany({
    where: { teacherId: null, isArchived: true, semester: semester.trim() },
    data: { isArchived: false, semester: '' },
  })
  return { ok: true, count: result.count, message: `已撤销归档 ${result.count} 个班级` }
}

/**
 * 在班级池中创建班级（teacherId = null）
 */
export async function createPoolClass(name) {
  const trimmedName = name.trim()
  const existing = await prisma.class.findFirst({
    where: {
      name: trimmedName,
      teacherId: null,
      deletedAt: null,
      isArchived: false,
    },
    select: { id: true },
  })
  if (existing) {
    const err = new Error(`班级池中已存在「${trimmedName}」`)
    err.statusCode = 409
    throw err
  }
  return prisma.class.create({
    data: {
      name: trimmedName,
      teacherId: null,
      signInConfig: { create: {} },
    },
  })
}

/**
 * 教师删除课程时归还班级池。
 * 池中已有同名班级时仅删除教师侧副本；否则将课程转为池班级并保留学生照片。
 */
export async function returnTeacherClassToPool(classId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls) return { ok: false, message: '班级不存在', status: 404 }
  if (cls.teacherId === null) return { ok: false, message: '该班级已在班级池中', status: 409 }

  let reusedExistingPoolClass = false
  await prisma.$transaction(async (tx) => {
    const existingPoolClass = await tx.class.findFirst({
      where: {
        name: cls.name,
        teacherId: null,
        deletedAt: null,
        isArchived: false,
      },
      select: { id: true },
    })

    if (existingPoolClass) {
      const { deleteClassesCascadeWithTx } = await import('./class.js')
      await deleteClassesCascadeWithTx(tx, [classId])
      reusedExistingPoolClass = true
      return
    }

    const sessions = await tx.signInSession.findMany({
      where: { classId },
      select: { id: true },
    })
    const sessionIds = sessions.map(session => session.id)
    if (sessionIds.length > 0) {
      await tx.archivedRecord.deleteMany({ where: { sessionId: { in: sessionIds } } })
    }

    const collection = await tx.infoCollection.findUnique({
      where: { classId },
      select: { id: true },
    })
    await tx.infoSubmission.deleteMany({ where: { classId } })
    if (collection) {
      await tx.infoResponse.deleteMany({ where: { field: { collectionId: collection.id } } })
      await tx.infoField.deleteMany({ where: { collectionId: collection.id } })
      await tx.infoCollection.delete({ where: { id: collection.id } })
    }

    await tx.signInSession.deleteMany({ where: { classId } })
    await tx.signInConfig.deleteMany({ where: { classId } })
    await tx.signInRecord.deleteMany({ where: { classId } })
    await tx.studentTag.deleteMany({ where: { classId } })
    await tx.class.update({
      where: { id: classId },
      data: { teacherId: null, sortOrder: 0 },
    })
  })

  return {
    ok: true,
    reusedExistingPoolClass,
    message: reusedExistingPoolClass
      ? `「${cls.name}」已从教师课程中删除，班级池保留原班级`
      : `「${cls.name}」已归还班级池`,
  }
}

/**
 * 教师认领班级池中的班级
 * 班级池中的班级始终保留（teacherId 保持 null），认领后仅同步照片到教师的同名班级
 */
export async function claimPoolClass(classId, teacherId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls) return { ok: false, message: '班级不存在', status: 404 }
  if (cls.teacherId !== null) return { ok: false, message: '该班级不属于班级池', status: 409 }

  // 检查教师是否已有同名班级
  const existing = await prisma.class.findFirst({
    where: { teacherId, name: cls.name, isArchived: false },
  })

  if (existing) {
    // 合并：将班级池中有照片的学生同步到教师已有班级
    const poolStudents = await prisma.student.findMany({
      where: { classId },
      select: { id: true, name: true, homeClass: true, photoUrl: true },
    })
    const existingStudents = await prisma.student.findMany({
      where: { classId: existing.id },
      select: { id: true, name: true, photoUrl: true },
    })
    const existingMap = new Map(existingStudents.map(s => [normalizeName(s.name), s]))

    let mergedCount = 0
    const claimUpdates = []
    const claimInserts = []
    for (const ps of poolStudents) {
      if (!ps.photoUrl) continue
      const es = existingMap.get(normalizeName(ps.name))
      if (es) {
        if (es.photoUrl !== ps.photoUrl) {
          claimUpdates.push(prisma.student.update({ where: { id: es.id }, data: { photoUrl: ps.photoUrl } }))
          mergedCount++
        }
      } else {
        claimInserts.push({ name: ps.name, homeClass: ps.homeClass, photoUrl: ps.photoUrl, classId: existing.id })
        mergedCount++
      }
    }
    // 批量执行更新和插入
    if (claimUpdates.length > 0) {
      const BATCH = 100
      for (let i = 0; i < claimUpdates.length; i += BATCH) {
        await prisma.$transaction(claimUpdates.slice(i, i + BATCH))
      }
    }
    if (claimInserts.length > 0) {
      await prisma.student.createMany({ data: claimInserts })
    }

    return { ok: true, message: `已将 ${mergedCount} 名学生的照片同步到「${cls.name}」` }
  }

  // 教师没有同名班级：创建新班级并复制所有学生
  const { createClass } = await import('./class.js')
  const newClass = await createClass(teacherId, cls.name)

  const poolStudents = await prisma.student.findMany({
    where: { classId },
    select: { name: true, homeClass: true, remark: true, photoUrl: true },
  })

  if (poolStudents.length > 0) {
    await prisma.student.createMany({
      data: poolStudents.map(s => ({
        name: s.name,
        homeClass: s.homeClass,
        remark: s.remark,
        photoUrl: s.photoUrl,
        classId: newClass.id,
      })),
    })
  }

  return { ok: true, message: `已认领班级「${cls.name}」，${poolStudents.length} 名学生已同步` }
}

/**
 * 从 Excel 导入学生到班级池指定班级
 * 支持有表头和无表头两种格式
 * 列：A=行政班(可选), B=学生姓名(必需), C=备注(可选)
 */
export async function importPoolStudentsFromExcel(classId, buffer) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls || cls.teacherId !== null) return { ok: false, message: '班级不存在或不属于班级池', status: 404 }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const worksheet = workbook.worksheets[0]

  const HEADER_KEYWORDS = new Set(['行政班', '行政班级', '姓名', '学生姓名', '备注', '教学班'])
  const rows = []
  worksheet.eachRow((row) => {
    const c1 = row.getCell(1).value
    const c2 = row.getCell(2).value
    const c3 = row.getCell(3).value
    if (c1 == null || String(c1).trim() === '') return
    if (HEADER_KEYWORDS.has(String(c1).trim())) return

    rows.push({
      homeClass: String(c1).trim(),
      name: String(c2).trim(),
      remark: c3 != null ? String(c3).trim() : '',
    })
  })

  // 过滤掉姓名为空的行
  const validRows = rows.filter(r => r.name && r.name !== '')

  if (validRows.length === 0) return { ok: false, message: '未找到有效学生数据' }

  // 获取已有学生
  const existing = await prisma.student.findMany({
    where: { classId },
    select: { name: true },
  })
  const existingSet = new Set(existing.map(s => s.name))

  const toInsert = []
  const seen = new Set()
  for (const r of validRows) {
    if (existingSet.has(r.name) || seen.has(r.name)) continue
    seen.add(r.name)
    toInsert.push({
      name: r.name,
      homeClass: r.homeClass,
      remark: r.remark,
      classId,
    })
  }

  if (toInsert.length === 0) return { ok: true, count: 0, message: '所有学生已存在' }

  const res = await prisma.student.createMany({ data: toInsert })
  return { ok: true, count: res.count, message: `导入 ${res.count} 名学生` }
}

/**
 * 上传学生照片
 * @param {number} classId - 班级 ID
 * @param {number} studentId - 学生 ID
 * @param {Buffer} fileBuffer - 图片数据
 * @param {string} filename - 原始文件名
 * @returns {{ ok: boolean, url: string, message?: string }}
 */
export async function uploadStudentPhoto(classId, studentId, fileBuffer, filename) {
  const ext = getAllowedPhotoExt(filename)
  if (!ext) {
    return { ok: false, message: '仅支持 JPG、PNG、WebP 格式图片' }
  }

  if (fileBuffer.length > PHOTO_MAX_SIZE) {
    return { ok: false, message: '图片大小不能超过 5MB' }
  }

  // 验证学生归属
  const student = await prisma.student.findUnique({ where: { id: studentId } })
  if (!student || student.classId !== classId) {
    return { ok: false, message: '学生不存在或不属于该班级' }
  }

  // 保存到 uploads/photos/{YYYY}/{MM}/{safe_filename}，避免中文文件名转码或特殊字符导致 Windows 保存失败。
  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const yearDir = path.join(UPLOAD_DIR, year)
  const monthDir = path.join(yearDir, month)
  await fs.mkdir(monthDir, { recursive: true })

  const existingFiles = new Set(await fs.readdir(monthDir).catch(() => []))
  const safeFilename = makeStoredPhotoFilename(student.id, ext, existingFiles)

  const filePath = path.join(monthDir, safeFilename)
  await fs.writeFile(filePath, fileBuffer)

  const url = `/uploads/photos/${year}/${month}/${safeFilename}`

  // 删除旧照片（如果有）
  if (student.photoUrl) {
    try {
      const oldPath = path.resolve(__dirname, '../../', student.photoUrl.replace(/^\//, ''))
      await fs.unlink(oldPath)
    } catch {
      // 旧文件不存在，忽略
    }
  }

  // 使用写入队列序列化数据库更新，避免并发写入导致锁竞争
  await _enqueueWrite(() =>
    prisma.student.update({
      where: { id: studentId },
      data: { photoUrl: url },
    })
  )

  // 同一个真实学生可能出现在多个课程班，照片要跟着学生身份同步，而不是只属于当前班级记录。
  const sharedSync = await syncPhotosAcrossSharedStudents([{ ...student, photoUrl: url }])
  const synced = sharedSync.synced

  return { ok: true, url, synced, message: '照片已上传' }
}

/**
 * 批量上传照片 — 按文件名匹配学生姓名
 * @param {number} classId - 班级 ID
 * @param {{ filename: string, buffer: Buffer }[]} files - 照片文件列表
 * @returns {{ ok: boolean, matched: number, unmatched: string[] }}
 */
export async function bulkUploadPhotos(classId, files) {
  const students = await prisma.student.findMany({
    where: { classId },
    select: { id: true, name: true, homeClass: true, photoUrl: true },
  })
  const studentMap = new Map()
  for (const s of students) {
    studentMap.set(normalizeName(s.name), s)
  }

  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const yearDir = path.join(UPLOAD_DIR, year)
  const monthDir = path.join(yearDir, month)
  await fs.mkdir(monthDir, { recursive: true })

  const existingFiles = new Set()
  try {
    const entries = await fs.readdir(monthDir)
    for (const entry of entries) existingFiles.add(entry)
  } catch { /* 空 */ }

  const matched = []
  const unmatched = []
  const writeTasks = []
  const sourceStudents = []

  for (const file of files) {
    const nameKey = path.basename(file.filename, path.extname(file.filename))
    const student = studentMap.get(normalizeName(nameKey))
    if (!student) {
      unmatched.push(file.filename)
      continue
    }

    const ext = getAllowedPhotoExt(file.filename)
    if (!ext || file.buffer.length > PHOTO_MAX_SIZE) {
      unmatched.push(file.filename)
      continue
    }

    // 确定不冲突的文件名
    const safeFilename = makeStoredPhotoFilename(student.id, ext, existingFiles)

    const url = `/uploads/photos/${year}/${month}/${safeFilename}`
    const filePath = path.join(monthDir, safeFilename)

    matched.push({ name: nameKey, url })
    writeTasks.push({ buffer: file.buffer, filePath, student })
    sourceStudents.push({ ...student, photoUrl: url })
  }

  // 分批写文件（增大批次提升并行度，ext4/NTFS 可承受 50 并发写入）
  const BATCH_SIZE = 50
  if (writeTasks.length > 0) {
    for (let i = 0; i < writeTasks.length; i += BATCH_SIZE) {
      const batch = writeTasks.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(t => fs.writeFile(t.filePath, t.buffer)))
    }
  }

  const sharedSync = await syncPhotosAcrossSharedStudents(sourceStudents)

  // 获取班级中没有照片的学生
  const studentsWithoutPhotos = await prisma.student.findMany({
    where: { classId, photoUrl: '' },
    select: { id: true, name: true, classId: true },
  })

  const synced = sharedSync.synced

  return { ok: true, matched: matched.length, unmatched, unmatchedStudents: studentsWithoutPhotos, synced, conflictCount: sharedSync.conflictCount }
}

/**
 * 删除学生照片
 */
export async function deleteStudentPhoto(studentId, classId) {
  const student = await prisma.student.findUnique({ where: { id: studentId } })
  if (!student || student.classId !== classId) {
    return { ok: false, message: '学生不存在或不属于该班级' }
  }

  if (student.photoUrl) {
    try {
      const oldPath = path.resolve(__dirname, '../../', student.photoUrl.replace(/^\//, ''))
      await fs.unlink(oldPath)
    } catch {
      // 忽略
    }
  }

  await _enqueueWrite(() =>
    prisma.student.update({
      where: { id: studentId },
      data: { photoUrl: '' },
    })
  )

  // 同步删除
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (cls && cls.teacherId !== null) {
    // 教师班级 → 班级池
    const poolClass = await prisma.class.findFirst({
      where: { name: cls.name, teacherId: null, deletedAt: null },
      select: { id: true },
    })
    if (poolClass) {
      const poolStudent = await prisma.student.findFirst({
        where: { classId: poolClass.id, name: student.name },
        select: { id: true },
      })
      if (poolStudent) {
        await _enqueueWrite(() =>
          prisma.student.update({ where: { id: poolStudent.id }, data: { photoUrl: '' } })
        )
      }
    }
  } else if (cls && cls.teacherId === null) {
    // 班级池 → 所有同名教师班级
    const teacherClasses = await prisma.class.findMany({
      where: { name: cls.name, teacherId: { not: null }, deletedAt: null },
      select: { id: true },
    })
    for (const tc of teacherClasses) {
      const ts = await prisma.student.findFirst({
        where: { classId: tc.id, name: student.name },
        select: { id: true },
      })
      if (ts) {
        await _enqueueWrite(() =>
          prisma.student.update({ where: { id: ts.id }, data: { photoUrl: '' } })
        )
      }
    }
  }

  return { ok: true, message: '照片已删除' }
}

/**
 * 批量从 Excel 导入学生到班级池（按 A 列班级名自动匹配）
 * Excel 格式：A=班级名称，B=行政班，C=学生姓名
 */
export async function batchImportPoolStudentsFromExcel(buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const worksheet = workbook.worksheets[0]

  const HEADER_KEYWORDS = new Set(['班级', '名称', '行政班', '行政班级', '姓名', '学生姓名', '备注', '教学班', '教学班名'])
  const rows = []
  worksheet.eachRow((row) => {
    const c1 = row.getCell(1).value
    const c2 = row.getCell(2).value
    const c3 = row.getCell(3).value
    if (c1 == null || String(c1).trim() === '') return
    if (HEADER_KEYWORDS.has(String(c1).trim())) return

    rows.push({
      className: String(c1).trim(),
      homeClass: c2 != null ? String(c2).trim() : '',
      name: c3 != null ? String(c3).trim() : '',
    })
  })

  // 过滤掉姓名为空的行
  const validRows = rows.filter(r => r.name && r.name !== '')
  if (validRows.length === 0) return { ok: false, message: '未找到有效学生数据' }

  // 获取所有班级池班级
  const poolClasses = await prisma.class.findMany({
    where: { teacherId: null, deletedAt: null, isArchived: false },
    select: { id: true, name: true },
  })
  const classMap = new Map()
  for (const cls of poolClasses) {
    classMap.set(cls.name, cls)
  }

  let totalCount = 0
  const newClasses = []

  // 按班级名分组
  const grouped = new Map()
  for (const r of validRows) {
    if (!grouped.has(r.className)) grouped.set(r.className, [])
    grouped.get(r.className).push(r)
  }

  for (const [className, students] of grouped) {
    let cls = classMap.get(className)
    if (!cls) {
      // 自动创建班级池班级
      cls = await prisma.class.create({
        data: { name: className, teacherId: null, signInConfig: { create: {} } },
      })
      classMap.set(className, cls)
      newClasses.push(className)
    }

    const existing = await prisma.student.findMany({
      where: { classId: cls.id },
      select: { name: true },
    })
    const existingSet = new Set(existing.map(s => s.name))
    const toInsert = []
    const seen = new Set()
    for (const r of students) {
      if (existingSet.has(r.name) || seen.has(r.name)) continue
      seen.add(r.name)
      toInsert.push({ name: r.name, homeClass: r.homeClass, classId: cls.id })
    }

    if (toInsert.length > 0) {
      const res = await prisma.student.createMany({ data: toInsert })
      totalCount += res.count
    }
  }

  let msg = `导入 ${totalCount} 名学生`
  if (newClasses.length) msg += `，新建 ${newClasses.length} 个班级（${newClasses.join('、')}）`
  return { ok: true, count: totalCount, newClasses, message: msg }
}

/**
 * 获取班级池中所有没有照片的学生
 */
export async function getStudentsWithoutPhotos() {
  const students = await prisma.student.findMany({
    where: {
      class: { teacherId: null },
      photoUrl: '',
    },
    select: {
      id: true,
      name: true,
      classId: true,
      class: { select: { name: true } },
    },
    orderBy: [{ class: { name: 'asc' } }, { name: 'asc' }],
  })
  return students
    .map(s => ({ id: s.id, name: s.name, classId: s.classId, className: s.class.name }))
    .sort((a, b) => compareClassNames(a.className, b.className) || a.name.localeCompare(b.name, 'zh-CN'))
}

/**
 * 批量上传照片到班级池 — 文件名直接匹配学生姓名（跨所有班级池班级）
 * 优化：批量 DB 操作，避免 800+ 张照片产生 1600+ 次查询
 */
export async function batchUploadPoolPhotos(files) {
  // 加载所有班级池班级和学生
  const poolClasses = await prisma.class.findMany({
    where: { teacherId: null },
    include: { students: true },
  })

  // 同名学生可能是同一个人所选的多个课程班，也可能确实是不同人。
  const studentMap = new Map()
  for (const cls of poolClasses) {
    for (const s of cls.students) {
      const key = normalizeName(s.name)
      if (!studentMap.has(key)) studentMap.set(key, [])
      studentMap.get(key).push({ classId: cls.id, className: cls.name, student: s })
    }
  }

  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const yearDir = path.join(UPLOAD_DIR, year)
  const monthDir = path.join(yearDir, month)
  await fs.mkdir(monthDir, { recursive: true })

  // 扫描已有文件，用于冲突检测
  const existingFiles = new Set()
  try {
    const entries = await fs.readdir(monthDir)
    for (const entry of entries) existingFiles.add(entry)
  } catch { /* 目录不存在或为空 */ }

  // 第 1 步：匹配 + 分类（自动匹配 / 冲突 / 未匹配）
  const matched = []
  const unmatched = []
  const conflicts = []
  const writeTasks = [] // { buffer, filePath }
  const sourceStudents = []

  for (const file of files) {
    const nameKey = path.basename(file.filename, path.extname(file.filename))
    const matches = studentMap.get(normalizeName(nameKey)) || []
    if (matches.length === 0) {
      unmatched.push(file.filename)
      continue
    }

    const identityKeys = [...new Set(matches.map(({ student }) => getStudentIdentityKey(student)))]
    if (identityKeys.length !== 1) {
      conflicts.push({
        filename: file.filename,
        buffer: file.buffer,
        candidates: matches.map(({ classId, className, student }) => ({
          studentId: student.id,
          studentName: student.name,
          className,
          classId,
        })),
      })
      continue
    }
    const match = matches[0]

    const ext = getAllowedPhotoExt(file.filename)
    if (!ext || file.buffer.length > PHOTO_MAX_SIZE) {
      unmatched.push(file.filename)
      continue
    }

    // 确定不冲突的文件名
    const safeFilename = makeStoredPhotoFilename(match.student.id, ext, existingFiles)

    const url = `/uploads/photos/${year}/${month}/${safeFilename}`
    const filePath = path.join(monthDir, safeFilename)

    matched.push({ name: nameKey, url })
    writeTasks.push({ buffer: file.buffer, filePath })
    sourceStudents.push({ ...match.student, photoUrl: url })
  }

  // 第 2 步：分批并行写文件（避免 EMFILE）
  const BATCH_SIZE = 50
  if (writeTasks.length > 0) {
    for (let i = 0; i < writeTasks.length; i += BATCH_SIZE) {
      const batch = writeTasks.slice(i, i + BATCH_SIZE)
      await Promise.all(batch.map(t => fs.writeFile(t.filePath, t.buffer)))
    }
  }

  // 第 3 步：按真实学生身份同步到所有课程班
  const sharedSync = await syncPhotosAcrossSharedStudents(sourceStudents)

  // 获取班级池中所有没有照片的学生
  const unmatchedStudents = await getStudentsWithoutPhotos()

  return {
    ok: true,
    matched: matched.length,
    unmatched,
    conflicts,
    unmatchedStudents,
    synced: sharedSync.synced,
    conflictCount: sharedSync.conflictCount,
  }
}

/**
 * 解决照片冲突：将照片匹配到指定的学生
 * @param {object} params
 * @param {number} params.studentId - 目标学生ID
 * @param {number} params.classId - 学生所在班级ID
 * @param {Buffer} params.buffer - 照片文件缓冲
 * @param {string} params.filename - 原始文件名
 */
export async function resolvePhotoConflict({ studentId, classId, buffer, filename }) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, classId },
    include: { class: true },
  })
  if (!student) {
    return { ok: false, message: '学生不存在或不属于该班级' }
  }

  // 验证学生属于班级池
  if (student.class.teacherId !== null) {
    return { ok: false, message: '只能匹配班级池中的学生' }
  }

  // 验证文件
  const ext = getAllowedPhotoExt(filename)
  if (!ext || buffer.length > PHOTO_MAX_SIZE) {
    return { ok: false, message: '不支持的图片格式' }
  }

  const now = new Date()
  const year = String(now.getFullYear())
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const monthDir = path.join(UPLOAD_DIR, year, month)
  await fs.mkdir(monthDir, { recursive: true })

  // 处理文件名冲突
  const existingFiles = new Set()
  try {
    const entries = await fs.readdir(monthDir)
    for (const entry of entries) existingFiles.add(entry)
  } catch { /* 目录不存在 */ }
  const safeFilename = makeStoredPhotoFilename(student.id, ext, existingFiles)

  const filePath = path.join(monthDir, safeFilename)
  const url = `/uploads/photos/${year}/${month}/${safeFilename}`

  // 删除旧照片文件
  if (student.photoUrl) {
    const oldPath = path.resolve(__dirname, '../../' + student.photoUrl.replace(/^\//, ''))
    try { await fs.unlink(oldPath) } catch { /* 旧文件可能已被删除 */ }
  }

  // 写文件
  await fs.writeFile(filePath, buffer)

  // 更新数据库
  await _enqueueWrite(async () => {
    return prisma.student.update({
      where: { id: studentId },
      data: { photoUrl: url },
    })
  })

  // 同步到这个真实学生所选的其他课程班
  const sharedSync = await syncPhotosAcrossSharedStudents([{ ...student, photoUrl: url }])

  return {
    ok: true,
    studentName: student.name,
    className: student.class.name,
    url,
    synced: sharedSync.synced,
    conflictCount: sharedSync.conflictCount,
  }
}
