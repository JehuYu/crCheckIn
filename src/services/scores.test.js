import { describe, before, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { prisma, cleanDatabase, factories } from '../test-helpers.js'
import {
  createScoreProject,
  exportScoresToExcel,
  getScoreAnalytics,
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

  it('builds score analytics for projects, students, and home classes', async () => {
    const teacher = await factories.createTeacher()
    const cls = await factories.createClass({ teacherId: teacher.id })
    const zhangSan = await factories.createStudent({ classId: cls.id, name: '张三', homeClass: '1' })
    const liSi = await factories.createStudent({ classId: cls.id, name: '李四', homeClass: '1' })
    const wangWu = await factories.createStudent({ classId: cls.id, name: '王五', homeClass: '2' })
    const first = await createScoreProject(cls.id, '第一次')
    const second = await createScoreProject(cls.id, '第二次')
    const third = await createScoreProject(cls.id, '第三次')

    await saveStudentScore({ classId: cls.id, studentId: zhangSan.id, projectId: first.id, value: 90, teacherId: teacher.id })
    await saveStudentScore({ classId: cls.id, studentId: liSi.id, projectId: first.id, value: 80, teacherId: teacher.id })
    await saveStudentScore({ classId: cls.id, studentId: wangWu.id, projectId: first.id, value: 70, teacherId: teacher.id })
    await saveStudentScore({ classId: cls.id, studentId: zhangSan.id, projectId: second.id, value: 95, teacherId: teacher.id })
    await saveStudentScore({ classId: cls.id, studentId: liSi.id, projectId: second.id, value: 85, teacherId: teacher.id })
    await saveStudentScore({ classId: cls.id, studentId: zhangSan.id, projectId: third.id, value: 100, teacherId: teacher.id })
    await saveStudentScore({ classId: cls.id, studentId: liSi.id, projectId: third.id, value: 70, teacherId: teacher.id })
    await saveStudentScore({ classId: cls.id, studentId: wangWu.id, projectId: third.id, value: 65, teacherId: teacher.id })

    const analytics = await getScoreAnalytics(cls.id)
    assert.equal(analytics.hasScoreData, true)
    assert.equal(analytics.summary.totalProjects, 3)
    assert.equal(analytics.summary.totalScores, 8)
    assert.equal(analytics.summary.fillRate, 88.9)
    assert.equal(analytics.summary.classAverage, 81.9)
    assert.equal(analytics.summary.median, 82.5)
    assert.equal(analytics.summary.standardDeviation, 12)
    assert.equal(analytics.latestProject.name, '第三次')
    assert.equal(analytics.latestProject.average, 78.3)
    assert.equal(analytics.latestProject.median, 70)
    assert.equal(analytics.latestProject.distribution.find(band => band.key === 'excellent').count, 1)
    assert.equal(analytics.latestProject.distribution.find(band => band.key === 'pass').count, 1)
    assert.equal(analytics.latestProject.missingStudents.length, 0)

    const zhangSummary = analytics.students.find(student => student.name === '张三')
    assert.equal(zhangSummary.average, 95)
    assert.equal(zhangSummary.trend, 5)
    assert.equal(zhangSummary.firstLastDelta, 10)
    assert.equal(zhangSummary.volatility, 4.1)
    assert.equal(zhangSummary.history.length, 3)
    assert.equal(zhangSummary.history[2].projectAverage, 78.3)
    assert.equal(zhangSummary.history[2].deltaFromAverage, 21.7)
    assert.equal(zhangSummary.history[2].rank, 1)

    const liSummary = analytics.students.find(student => student.name === '李四')
    assert.equal(liSummary.firstLastDelta, -10)

    const classOne = analytics.homeClasses.find(group => group.name === '1')
    assert.equal(classOne.average, 86.7)
    assert.equal(classOne.fillRate, 100)

    assert.equal(analytics.overallDistribution.find(band => band.key === 'excellent').count, 3)
    assert.equal(analytics.needsAttention[0].name, '王五')
    assert.equal(analytics.needsAttention[0].attentionReason, '平均分偏低')
    assert.equal(analytics.classTrend.length, 3)
    assert.equal(analytics.classTrend[1].averageChange, 10)
    assert.equal(analytics.classTrend[2].averageChange, -11.7)
    assert.equal(analytics.classTrend[2].under70Rate, 33.3)
    assert.equal(analytics.trendSummary.latestAverageChange, -11.7)
    assert.equal(analytics.trendSummary.biggestImprovement.name, '第二次')
    assert.equal(analytics.trendSummary.biggestDrop.name, '第三次')
    assert.equal(analytics.movement.improvers[0].name, '张三')
    assert.equal(analytics.movement.decliners[0].name, '李四')
    assert.equal(analytics.movement.missingHeavy[0].name, '王五')
    assert.ok(analytics.insights.some(insight => insight.title === '最近项目均分变化'))
    assert.ok(analytics.insights.some(insight => insight.title === '进步信号'))
    assert.ok(analytics.insights.some(insight => insight.title === '需要回看过程'))
  })
})
