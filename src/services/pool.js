import { prisma } from '../plugins/db.js'
import ExcelJS from 'exceljs'
import path from 'path'
import fs from 'fs/promises'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_DIR = path.resolve(__dirname, '../../uploads/photos')

/**
 * 获取班级池中的所有班级（teacherId IS NULL）
 */
export async function getPoolClasses() {
  const classes = await prisma.class.findMany({
    where: { teacherId: null, isArchived: false },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { students: true } },
    },
  })
  return classes.map(c => ({
    id: c.id,
    name: c.name,
    studentCount: c._count.students,
    createdAt: c.createdAt,
  }))
}

/**
 * 在班级池中创建班级（teacherId = null）
 */
export async function createPoolClass(name) {
  return prisma.class.create({
    data: {
      name,
      teacherId: null,
      signInConfig: { create: {} },
    },
  })
}

/**
 * 教师认领班级池中的班级
 */
export async function claimPoolClass(classId, teacherId) {
  const cls = await prisma.class.findUnique({ where: { id: classId } })
  if (!cls) return { ok: false, message: '班级不存在', status: 404 }
  if (cls.teacherId !== null) return { ok: false, message: '该班级已被其他教师认领', status: 409 }

  // 检查教师是否已有同名班级
  const existing = await prisma.class.findFirst({
    where: { teacherId, name: cls.name, isArchived: false },
  })
  if (existing) return { ok: false, message: `你已有同名班级「${cls.name}」，请先删除或归档后再认领`, status: 409 }

  await prisma.class.update({
    where: { id: classId },
    data: { teacherId },
  })

  return { ok: true, message: `已认领班级「${cls.name}」` }
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
  const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
  const ext = path.extname(filename).toLowerCase()
  const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

  if (!ALLOWED_EXTS.has(ext)) {
    return { ok: false, message: '仅支持 JPG、PNG、WebP 格式图片' }
  }

  const MAX_SIZE = 5 * 1024 * 1024 // 5MB
  if (fileBuffer.length > MAX_SIZE) {
    return { ok: false, message: '图片大小不能超过 5MB' }
  }

  // 验证学生归属
  const student = await prisma.student.findUnique({ where: { id: studentId } })
  if (!student || student.classId !== classId) {
    return { ok: false, message: '学生不存在或不属于该班级' }
  }

  // 保存到 uploads/photos/{classId}/{random}_{studentId}{ext}
  const classDir = path.join(UPLOAD_DIR, String(classId))
  await fs.mkdir(classDir, { recursive: true })

  const randomHex = randomBytes(6).toString('hex')
  const safeFilename = `${randomHex}_${studentId}${ext}`
  const filePath = path.join(classDir, safeFilename)
  await fs.writeFile(filePath, fileBuffer)

  const url = `/uploads/photos/${classId}/${safeFilename}`

  // 更新学生 photoUrl
  // 删除旧照片（如果有）
  if (student.photoUrl) {
    try {
      const oldPath = path.resolve(__dirname, '../../', student.photoUrl.replace(/^\//, ''))
      await fs.unlink(oldPath)
    } catch {
      // 旧文件不存在，忽略
    }
  }

  await prisma.student.update({
    where: { id: studentId },
    data: { photoUrl: url },
  })

  return { ok: true, url, message: '照片已上传' }
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
    select: { id: true, name: true, photoUrl: true },
  })
  const studentMap = new Map()
  for (const s of students) {
    studentMap.set(s.name, s)
  }

  const matched = []
  const unmatched = []

  for (const file of files) {
    // 文件名去除扩展名后作为姓名匹配
    const nameKey = path.basename(file.filename, path.extname(file.filename)).trim()
    const student = studentMap.get(nameKey)
    if (!student) {
      unmatched.push(file.filename)
      continue
    }

    const result = await uploadStudentPhoto(classId, student.id, file.buffer, file.filename)
    if (result.ok) {
      matched.push({ name: nameKey, url: result.url })
    } else {
      unmatched.push(`${file.filename} (${result.message})`)
    }
  }

  return { ok: true, matched: matched.length, unmatched }
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

  await prisma.student.update({
    where: { id: studentId },
    data: { photoUrl: '' },
  })

  return { ok: true, message: '照片已删除' }
}
