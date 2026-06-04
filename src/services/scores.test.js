import { describe, before, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { prisma, cleanDatabase, factories } from '../test-helpers.js'
import {
  createScoreProject,
  exportScoresToExcel,
  getScorebook,
  importScoresFromExcel,
  saveStudentScore,
} from './scores.js'

describe('score service', () => {
  before(async () => {
    await prisma.$connect()
  })

  beforeEach(cleanDatabase)

  it('creates score projects and saves scores with pinyin data', async () => {
    const teacher = await factories.createTeacher()
    const cls = await factories.createClass({ teacherId: teacher.id })
    const student = await factories.createStudent({ classId: cls.id, name: '张三', homeClass: '1' })
    const project = await createScoreProject(cls.id, '第一次默写')

    const saved = await saveStudentScore({
      classId: cls.id,
      studentId: student.id,
      projectId: project.id,
      value: 98.5,
      teacherId: teacher.id,
    })

    assert.equal(saved.ok, true)
    assert.equal(saved.score.value, 98.5)

    const scorebook = await getScorebook(cls.id)
    assert.equal(scorebook.projects.length, 1)
    assert.equal(scorebook.students[0].pinyin.initials, 'zs')
    assert.equal(scorebook.students[0].scores[project.id].value, 98.5)
    assert.equal(scorebook.logs.length, 1)
    assert.equal(scorebook.logs[0].newValue, 98.5)
  })

  it('updates and clears a student score', async () => {
    const teacher = await factories.createTeacher()
    const cls = await factories.createClass({ teacherId: teacher.id })
    const student = await factories.createStudent({ classId: cls.id, name: '李四' })
    const project = await createScoreProject(cls.id, '课堂练习')

    await saveStudentScore({ classId: cls.id, studentId: student.id, projectId: project.id, value: 70, teacherId: teacher.id })
    await saveStudentScore({ classId: cls.id, studentId: student.id, projectId: project.id, value: 80, teacherId: teacher.id })
    await saveStudentScore({ classId: cls.id, studentId: student.id, projectId: project.id, value: '', teacherId: teacher.id })

    const scorebook = await getScorebook(cls.id)
    assert.equal(scorebook.students[0].scores[project.id], undefined)
    assert.equal(await prisma.studentScore.count(), 0)
    assert.equal(await prisma.scoreEntryLog.count(), 3)
  })

  it('imports and exports score workbooks', async () => {
    const teacher = await factories.createTeacher()
    const cls = await factories.createClass({ teacherId: teacher.id })
    await factories.createStudent({ classId: cls.id, name: '张三', homeClass: '1' })
    await factories.createStudent({ classId: cls.id, name: '李四', homeClass: '2' })

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('成绩')
    sheet.addRow(['行政班', '姓名', '第一次', '第二次'])
    sheet.addRow(['1', '张三', 88, 91])
    sheet.addRow(['2', '李四', 76, ''])
    sheet.addRow(['3', '王五', 60, 61])
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer())

    const result = await importScoresFromExcel(cls.id, buffer, 'scores.xlsx', teacher.id)
    assert.equal(result.importedScores, 3)
    assert.equal(result.matchedRows, 2)
    assert.deepEqual(result.createdProjects.sort(), ['第一次', '第二次'])
    assert.deepEqual(result.unmatchedStudents, ['王五'])

    const scorebook = await getScorebook(cls.id)
    assert.equal(scorebook.projects.length, 2)
    const firstProject = scorebook.projects.find(project => project.name === '第一次')
    const zhangSan = scorebook.students.find(student => student.name === '张三')
    assert.equal(zhangSan.scores[firstProject.id].value, 88)

    const exported = Buffer.from(await exportScoresToExcel(cls.id))
    const exportedWorkbook = new ExcelJS.Workbook()
    await exportedWorkbook.xlsx.load(exported)
    const exportedSheet = exportedWorkbook.getWorksheet('成绩表')
    assert.equal(exportedSheet.getRow(3).getCell(2).value, '姓名')
    assert.equal(exportedSheet.getRow(4).getCell(2).value, '张三')
  })
})
