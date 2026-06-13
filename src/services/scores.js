import ExcelJS from 'exceljs'
import path from 'node:path'
import { prisma } from '../plugins/db.js'
import { nameToPinyin } from '../utils/pinyin.js'
import { formatSecond } from '../utils/time.js'

const SCORE_IMPORT_EXTS = new Set(['.xlsx'])
const NAME_HEADERS = new Set(['姓名', '学生姓名', '名字', '学生', 'name', 'student'])
const IGNORED_HEADERS = new Set([
  '班级',
  '行政班',
  '行政班级',
  '教学班',
  '拼音',
  '拼音缩写',
  '缩写',
  '备注',
  'class',
  'homeclass',
  'pinyin',
])

const SCORE_BANDS = [
  { key: 'excellent', label: '90+', min: 90, color: '#047857' },
  { key: 'good', label: '80-89', min: 80, color: '#5db872' },
  { key: 'fair', label: '70-79', min: 70, color: '#d4a017' },
  { key: 'pass', label: '60-69', min: 60, color: '#e88c60' },
  { key: 'needsWork', label: '<60', min: -Infinity, color: '#c64545' },
]

function serviceError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function normalizeProjectName(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) throw serviceError('成绩项目名称不能为空')
  if (trimmed.length > 60) throw serviceError('成绩项目名称不能超过 60 个字符')
  return trimmed
}

function parseScoreValue(value) {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null
  const number = Number(raw)
  if (!Number.isFinite(number)) throw serviceError('成绩必须是有效数字')
  return number
}

function cellText(cell) {
  const value = cell?.value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('').trim()
    if (value.text !== undefined) return String(value.text).trim()
    if (value.result !== undefined) return String(value.result).trim()
    if (value.hyperlink !== undefined && value.text !== undefined) return String(value.text).trim()
    return String(value.toString?.() ?? '').trim()
  }
  return String(value).trim()
}

function cellScoreValue(cell) {
  const value = cell?.value
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'object' && value.result !== undefined) return parseScoreValue(value.result)
  return parseScoreValue(cellText(cell))
}

function sanitizeExcelValue(value) {
  const text = String(value ?? '')
  return /^[=+\-@]/.test(text) ? `'${text}` : text
}

function formatHomeClass(homeClass) {
  const value = String(homeClass || '').trim()
  if (!value) return ''
  return value.includes('班') ? value : `${value}班`
}

export function isAllowedScoreWorkbook(filename) {
  return SCORE_IMPORT_EXTS.has(path.extname(filename || '').toLowerCase())
}

export async function getScorebook(classId, { includeLogs = true } = {}) {
  const [cls, students, projects, scores, logs] = await Promise.all([
    prisma.class.findUnique({ where: { id: classId }, select: { id: true, name: true } }),
    prisma.student.findMany({
      where: { classId },
      orderBy: [{ homeClass: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, homeClass: true, remark: true },
    }),
    prisma.scoreProject.findMany({
      where: { classId },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, sortOrder: true, createdAt: true, updatedAt: true },
    }),
    prisma.studentScore.findMany({
      where: { project: { classId }, student: { classId } },
      select: { id: true, studentId: true, projectId: true, value: true, updatedAt: true },
    }),
    includeLogs
      ? prisma.scoreEntryLog.findMany({
          where: { project: { classId } },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            student: { select: { name: true, homeClass: true } },
            project: { select: { name: true } },
            teacher: { select: { username: true } },
          },
        })
      : Promise.resolve([]),
  ])

  if (!cls) throw serviceError('班级不存在', 404)

  const scoreMap = new Map(scores.map(score => [`${score.studentId}:${score.projectId}`, score]))

  return {
    class: cls,
    projects,
    students: students.map((student) => {
      const pinyin = nameToPinyin(student.name)
      const scoreValues = {}
      for (const project of projects) {
        const score = scoreMap.get(`${student.id}:${project.id}`)
        if (score) {
          scoreValues[project.id] = {
            id: score.id,
            value: score.value,
            updatedAt: score.updatedAt,
          }
        }
      }
      return {
        ...student,
        pinyin: {
          full: pinyin.full,
          initials: pinyin.initials,
          toned: pinyin.toned,
        },
        scores: scoreValues,
      }
    }),
    logs: logs.map(log => ({
      id: log.id,
      studentId: log.studentId,
      studentName: log.student?.name || '',
      homeClass: log.student?.homeClass || '',
      projectId: log.projectId,
      projectName: log.project?.name || '',
      teacherName: log.teacher?.username || '',
      oldValue: log.oldValue,
      newValue: log.newValue,
      createdAt: log.createdAt,
    })),
  }
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null
  return Number(value.toFixed(digits))
}

function average(values) {
  const valid = values.filter(value => Number.isFinite(value))
  if (!valid.length) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function median(values) {
  const valid = values.filter(value => Number.isFinite(value)).toSorted((a, b) => a - b)
  if (!valid.length) return null
  const mid = Math.floor(valid.length / 2)
  if (valid.length % 2 === 1) return valid[mid]
  return (valid[mid - 1] + valid[mid]) / 2
}

function standardDeviation(values) {
  const avg = average(values)
  if (avg === null) return null
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function scoreBandFor(value) {
  return SCORE_BANDS.find(band => value >= band.min) || SCORE_BANDS[SCORE_BANDS.length - 1]
}

function distributionFor(values) {
  const counts = new Map(SCORE_BANDS.map(band => [band.key, 0]))
  for (const value of values) {
    const band = scoreBandFor(value)
    counts.set(band.key, (counts.get(band.key) || 0) + 1)
  }
  return SCORE_BANDS.map(band => ({
    ...band,
    count: counts.get(band.key) || 0,
    rate: values.length ? round(((counts.get(band.key) || 0) / values.length) * 100) : 0,
  }))
}

function scoreValue(student, projectId) {
  const value = student.scores?.[projectId]?.value
  return Number.isFinite(value) ? value : null
}

function buildRankMap(scoredStudents) {
  const sorted = scoredStudents.toSorted((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const ranks = new Map()
  let previousValue = null
  let currentRank = 0
  sorted.forEach((student, index) => {
    if (previousValue === null || student.value !== previousValue) {
      currentRank = index + 1
      previousValue = student.value
    }
    ranks.set(student.id, currentRank)
  })
  return ranks
}

function attentionReason(student) {
  if (student.latestValue !== null && student.latestValue < 60) return '最新项目低于 60'
  if (student.average !== null && student.average < 70) return '平均分偏低'
  if (student.trend !== null && student.trend <= -10) return '最近一次下降明显'
  if (student.fillRate < 70) return '成绩项目缺录较多'
  if (student.deltaFromClassAverage !== null && student.deltaFromClassAverage <= -10) return '低于班级均分较多'
  return '建议持续关注'
}

function publicStudentMovement(student) {
  return {
    id: student.id,
    name: student.name,
    homeClass: student.homeClass,
    average: student.average,
    latestValue: student.latestValue,
    trend: student.trend,
    firstScore: student.firstScore,
    lastScore: student.lastScore,
    firstLastDelta: student.firstLastDelta,
    volatility: student.volatility,
    fillRate: student.fillRate,
    filledCount: student.filledCount,
    missingCount: student.missingCount,
    attentionReason: student.attentionReason,
  }
}

function buildClassTrend(projectSummaries) {
  let previousAverage = null
  return projectSummaries.map((project) => {
    const passBand = project.distribution.find(band => band.key === 'pass')
    const needsWorkBand = project.distribution.find(band => band.key === 'needsWork')
    const excellentBand = project.distribution.find(band => band.key === 'excellent')
    const averageChange = project.average !== null && previousAverage !== null
      ? round(project.average - previousAverage)
      : null
    if (project.average !== null) previousAverage = project.average

    return {
      id: project.id,
      name: project.name,
      average: project.average,
      median: project.median,
      standardDeviation: project.standardDeviation,
      fillRate: project.fillRate,
      filledCount: project.filledCount,
      missingCount: project.missingCount,
      averageChange,
      excellentRate: excellentBand?.rate ?? 0,
      under70Rate: round((passBand?.rate ?? 0) + (needsWorkBand?.rate ?? 0)),
    }
  })
}

function buildTrendSummary(classTrend) {
  const scored = classTrend.filter(project => project.average !== null)
  const latest = scored[scored.length - 1] || null
  const previous = scored[scored.length - 2] || null
  const changed = scored.filter(project => project.averageChange !== null)
  const biggestImprovement = changed.length
    ? changed.toSorted((a, b) => b.averageChange - a.averageChange)[0]
    : null
  const biggestDrop = changed.length
    ? changed.toSorted((a, b) => a.averageChange - b.averageChange)[0]
    : null

  return {
    scoredProjectCount: scored.length,
    latestProjectName: latest?.name || '',
    previousProjectName: previous?.name || '',
    latestAverageChange: latest?.averageChange ?? null,
    biggestImprovement: biggestImprovement
      ? { name: biggestImprovement.name, averageChange: biggestImprovement.averageChange }
      : null,
    biggestDrop: biggestDrop
      ? { name: biggestDrop.name, averageChange: biggestDrop.averageChange }
      : null,
  }
}

function buildStudentMovement(students) {
  const withMovement = students.filter(student => student.filledCount >= 2)
  return {
    improvers: withMovement
      .filter(student => student.firstLastDelta >= 5)
      .toSorted((a, b) => b.firstLastDelta - a.firstLastDelta || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, 8)
      .map(publicStudentMovement),
    decliners: withMovement
      .filter(student => student.firstLastDelta <= -5)
      .toSorted((a, b) => a.firstLastDelta - b.firstLastDelta || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, 8)
      .map(publicStudentMovement),
    volatile: students
      .filter(student => student.filledCount >= 3 && student.volatility >= 10)
      .toSorted((a, b) => b.volatility - a.volatility || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, 8)
      .map(publicStudentMovement),
    missingHeavy: students
      .filter(student => student.missingCount > 0)
      .toSorted((a, b) => b.missingCount - a.missingCount || a.fillRate - b.fillRate || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, 8)
      .map(publicStudentMovement),
  }
}

function buildScoreInsights({ summary, trendSummary, movement, latestProject, homeClasses, overallDistribution }) {
  if (!summary.totalScores) return []
  const insights = []
  const latestChange = trendSummary.latestAverageChange
  if (latestChange !== null) {
    const direction = latestChange > 0 ? '提升' : latestChange < 0 ? '下降' : '持平'
    insights.push({
      type: latestChange < 0 ? 'warning' : 'good',
      title: '最近项目均分变化',
      body: `${trendSummary.previousProjectName} 到 ${trendSummary.latestProjectName}：班级均分${direction} ${formatScoreText(Math.abs(latestChange))} 分。`,
    })
  }

  if (latestProject?.missingCount > 0 || summary.fillRate < 95) {
    insights.push({
      type: 'warning',
      title: '先确认录入完整性',
      body: `当前成绩录入完成率 ${formatScoreText(summary.fillRate)}%，最新项目缺录 ${latestProject?.missingCount ?? 0} 人。分析前建议先补齐缺录。`,
    })
  }

  if (movement.improvers.length) {
    const names = movement.improvers.slice(0, 3).map(student => `${student.name}+${formatScoreText(student.firstLastDelta)}`).join('、')
    insights.push({
      type: 'good',
      title: '进步信号',
      body: `${names} 等学生从首个已录项目到最近项目提升明显，适合复盘有效做法。`,
    })
  }

  if (movement.decliners.length) {
    const names = movement.decliners.slice(0, 3).map(student => `${student.name}${formatScoreText(student.firstLastDelta)}`).join('、')
    insights.push({
      type: 'warning',
      title: '需要回看过程',
      body: `${names} 等学生近期轨迹下滑，建议结合课堂表现、缺交和题型变化一起看。`,
    })
  }

  if (movement.volatile.length) {
    const names = movement.volatile.slice(0, 3).map(student => `${student.name} 波动${formatScoreText(student.volatility)}`).join('、')
    insights.push({
      type: 'info',
      title: '波动较大的学生',
      body: `${names}，单次成绩可能不足以说明问题，适合继续观察稳定性。`,
    })
  }

  const homeClassRows = homeClasses.filter(group => group.average !== null)
  if (homeClassRows.length >= 2) {
    const top = homeClassRows[0]
    const bottom = homeClassRows[homeClassRows.length - 1]
    const gap = round(top.average - bottom.average)
    if (gap >= 5) {
      insights.push({
        type: 'info',
        title: '行政班差异',
        body: `${top.name} 与 ${bottom.name} 的平均分相差 ${formatScoreText(gap)} 分，需同时参考两边录入完成率。`,
      })
    }
  }

  const under70 = overallDistribution
    .filter(band => band.key === 'pass' || band.key === 'needsWork')
    .reduce((sum, band) => sum + band.count, 0)
  if (under70 > 0) {
    insights.push({
      type: 'warning',
      title: '低分段结构',
      body: `当前低于 70 分的成绩记录有 ${under70} 条，建议结合项目明细查看是否集中在某次考试。`,
    })
  }

  return insights.slice(0, 6)
}

function formatScoreText(value) {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export async function getScoreAnalytics(classId) {
  const scorebook = await getScorebook(classId, { includeLogs: false })
  const { projects, students } = scorebook
  const totalPossible = projects.length * students.length
  const allValues = []
  const projectRankMaps = new Map()

  const projectSummaries = projects.map((project) => {
    const scoredStudents = []
    const missingStudents = []
    const values = []

    for (const student of students) {
      const value = scoreValue(student, project.id)
      if (value === null) {
        missingStudents.push({
          id: student.id,
          name: student.name,
          homeClass: student.homeClass || '',
        })
        continue
      }
      values.push(value)
      allValues.push(value)
      scoredStudents.push({
        id: student.id,
        name: student.name,
        homeClass: student.homeClass || '',
        value,
      })
    }
    const rankMap = buildRankMap(scoredStudents)
    projectRankMaps.set(project.id, rankMap)

    return {
      id: project.id,
      name: project.name,
      sortOrder: project.sortOrder,
      createdAt: project.createdAt,
      filledCount: values.length,
      missingCount: missingStudents.length,
      fillRate: students.length ? round((values.length / students.length) * 100) : 0,
      average: round(average(values)),
      median: round(median(values)),
      standardDeviation: round(standardDeviation(values)),
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      range: values.length ? round(Math.max(...values) - Math.min(...values)) : null,
      distribution: distributionFor(values),
      missingStudents,
      topStudents: scoredStudents
        .toSorted((a, b) => b.value - a.value || a.name.localeCompare(b.name, 'zh-Hans-CN'))
        .slice(0, 5),
      lowStudents: scoredStudents
        .toSorted((a, b) => a.value - b.value || a.name.localeCompare(b.name, 'zh-Hans-CN'))
        .slice(0, 5),
    }
  })

  const latestProject =
    [...projectSummaries].reverse().find(project => project.filledCount > 0) ||
    projectSummaries[projectSummaries.length - 1] ||
    null

  const studentSummaries = students.map((student) => {
    const filled = []
    for (const project of projects) {
      const value = scoreValue(student, project.id)
      if (value !== null) {
        filled.push({
          projectId: project.id,
          projectName: project.name,
          value,
          projectAverage: projectSummaries.find(item => item.id === project.id)?.average ?? null,
          deltaFromAverage: round(value - (projectSummaries.find(item => item.id === project.id)?.average ?? value)),
          rank: projectRankMaps.get(project.id)?.get(student.id) ?? null,
        })
      }
    }
    const latestValue = latestProject ? scoreValue(student, latestProject.id) : null
    const previous = filled.length >= 2 ? filled[filled.length - 2].value : null
    const current = filled.length >= 1 ? filled[filled.length - 1].value : null
    const avg = round(average(filled.map(item => item.value)))
    const firstScore = filled[0]?.value ?? null
    const lastScore = filled[filled.length - 1]?.value ?? null
    return {
      id: student.id,
      name: student.name,
      homeClass: student.homeClass || '',
      filledCount: filled.length,
      missingCount: Math.max(projects.length - filled.length, 0),
      fillRate: projects.length ? round((filled.length / projects.length) * 100) : 0,
      average: avg,
      latestValue,
      trend: previous !== null && current !== null ? round(current - previous) : null,
      deltaFromClassAverage: avg !== null && allValues.length ? round(avg - average(allValues)) : null,
      firstScore,
      lastScore,
      firstLastDelta: firstScore !== null && lastScore !== null && filled.length >= 2 ? round(lastScore - firstScore) : null,
      volatility: filled.length ? round(standardDeviation(filled.map(item => item.value))) : null,
      bestScore: filled.length ? Math.max(...filled.map(item => item.value)) : null,
      lowestScore: filled.length ? Math.min(...filled.map(item => item.value)) : null,
      history: filled,
    }
  })

  const studentsWithScores = studentSummaries.filter(student => student.filledCount > 0)
  const homeClassMap = new Map()
  for (const student of studentSummaries) {
    const key = student.homeClass || '未分行政班'
    if (!homeClassMap.has(key)) {
      homeClassMap.set(key, { name: key, studentCount: 0, filledScores: 0, averages: [] })
    }
    const group = homeClassMap.get(key)
    group.studentCount += 1
    group.filledScores += student.filledCount
    if (student.average !== null) group.averages.push(student.average)
  }

  const homeClasses = [...homeClassMap.values()].map(group => ({
    name: group.name,
    studentCount: group.studentCount,
    filledScores: group.filledScores,
    average: round(average(group.averages)),
    fillRate: projects.length && group.studentCount
      ? round((group.filledScores / (projects.length * group.studentCount)) * 100)
      : 0,
  })).sort((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity))

  const totalScores = allValues.length
  const classAverage = average(allValues)
  const studentsWithAttention = studentsWithScores.map(student => ({
    ...student,
    attentionReason: attentionReason(student),
  }))
  const classTrend = buildClassTrend(projectSummaries)
  const trendSummary = buildTrendSummary(classTrend)
  const movement = buildStudentMovement(studentsWithAttention)
  const overallDistribution = distributionFor(allValues)
  const insights = buildScoreInsights({
    summary: {
      totalScores,
      fillRate: totalPossible ? round((totalScores / totalPossible) * 100) : 0,
    },
    trendSummary,
    movement,
    latestProject,
    homeClasses,
    overallDistribution,
  })

  return {
    class: scorebook.class,
    hasScoreData: totalScores > 0,
    scoreBands: SCORE_BANDS,
    summary: {
      totalProjects: projects.length,
      totalStudents: students.length,
      totalScores,
      totalPossible,
      fillRate: totalPossible ? round((totalScores / totalPossible) * 100) : 0,
      classAverage: round(classAverage),
      median: round(median(allValues)),
      standardDeviation: round(standardDeviation(allValues)),
      latestProjectName: latestProject?.name || '',
      latestProjectAverage: latestProject?.average ?? null,
      latestProjectMissingCount: latestProject?.missingCount ?? 0,
    },
    overallDistribution,
    projects: projectSummaries,
    latestProject,
    students: studentsWithAttention
      .toSorted((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity) || a.name.localeCompare(b.name, 'zh-Hans-CN')),
    needsAttention: studentsWithAttention
      .toSorted((a, b) => (a.average ?? Infinity) - (b.average ?? Infinity) || a.name.localeCompare(b.name, 'zh-Hans-CN'))
      .slice(0, 8),
    homeClasses,
    classTrend,
    trendSummary,
    movement,
    insights,
  }
}

export async function createScoreProject(classId, name) {
  const projectName = normalizeProjectName(name)
  const maxSort = await prisma.scoreProject.aggregate({
    where: { classId },
    _max: { sortOrder: true },
  })

  try {
    return await prisma.scoreProject.create({
      data: {
        classId,
        name: projectName,
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
    })
  } catch (error) {
    if (error.code === 'P2002') throw serviceError('该成绩项目已存在', 409)
    throw error
  }
}

export async function saveStudentScore({ classId, studentId, projectId, value, teacherId = null }) {
  const parsedValue = parseScoreValue(value)

  return prisma.$transaction(async (tx) => {
    const [student, project] = await Promise.all([
      tx.student.findFirst({ where: { id: studentId, classId }, select: { id: true } }),
      tx.scoreProject.findFirst({ where: { id: projectId, classId }, select: { id: true } }),
    ])
    if (!student) throw serviceError('学生不属于当前班级', 404)
    if (!project) throw serviceError('成绩项目不存在', 404)

    const existing = await tx.studentScore.findUnique({
      where: { studentId_projectId: { studentId, projectId } },
    })
    const oldValue = existing?.value ?? null

    if (parsedValue === null) {
      if (existing) {
        await tx.studentScore.delete({ where: { id: existing.id } })
        await tx.scoreEntryLog.create({
          data: { projectId, studentId, teacherId, oldValue, newValue: null },
        })
      }
      return { ok: true, score: null }
    }

    if (existing && oldValue === parsedValue) {
      return { ok: true, score: existing }
    }

    const score = existing
      ? await tx.studentScore.update({
          where: { id: existing.id },
          data: { value: parsedValue },
        })
      : await tx.studentScore.create({
          data: { studentId, projectId, value: parsedValue },
        })

    await tx.scoreEntryLog.create({
      data: {
        projectId,
        studentId,
        scoreId: score.id,
        teacherId,
        oldValue,
        newValue: parsedValue,
      },
    })

    return { ok: true, score }
  })
}

export async function saveStudentScoresBatch({ classId, projectId, entries, teacherId = null }) {
  const scoreProjectId = parseInt(projectId, 10)
  if (Number.isNaN(scoreProjectId)) throw serviceError('成绩项目无效')
  if (!Array.isArray(entries) || entries.length === 0) {
    throw serviceError('请提供要保存的成绩')
  }
  if (entries.length > 100) {
    throw serviceError('一次最多保存 100 条成绩')
  }

  const saved = []
  const failed = []
  const seenStudents = new Set()

  for (const [index, entry] of entries.entries()) {
    const studentId = parseInt(entry?.studentId, 10)
    if (Number.isNaN(studentId)) {
      failed.push({
        index,
        studentId: entry?.studentId ?? null,
        value: entry?.value ?? null,
        phrase: entry?.phrase || '',
        message: '学生无效',
      })
      continue
    }
    if (seenStudents.has(studentId)) {
      failed.push({
        index,
        studentId,
        value: entry?.value ?? null,
        phrase: entry?.phrase || '',
        message: '同一次批量保存中学生重复',
      })
      continue
    }
    seenStudents.add(studentId)

    try {
      const result = await saveStudentScore({
        classId,
        studentId,
        projectId: scoreProjectId,
        value: entry?.value,
        teacherId,
      })
      saved.push({
        index,
        studentId,
        projectId: scoreProjectId,
        value: result.score?.value ?? null,
        phrase: entry?.phrase || '',
        score: result.score,
      })
    } catch (error) {
      failed.push({
        index,
        studentId,
        value: entry?.value ?? null,
        phrase: entry?.phrase || '',
        message: error.message || '保存失败',
      })
    }
  }

  return { ok: true, saved, failed }
}

async function findOrCreateProjects(classId, names) {
  const existing = await prisma.scoreProject.findMany({ where: { classId } })
  const byName = new Map(existing.map(project => [project.name, project]))
  const created = []

  for (const name of names) {
    if (byName.has(name)) continue
    const project = await createScoreProject(classId, name)
    byName.set(project.name, project)
    created.push(project.name)
  }

  return { byName, created }
}

function readImportShape(worksheet) {
  let headerRowNumber = 0
  let headers = []
  const maxProbeRows = Math.min(worksheet.rowCount, 10)

  for (let rowNumber = 1; rowNumber <= maxProbeRows; rowNumber++) {
    const row = worksheet.getRow(rowNumber)
    const values = []
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      values[colNumber] = cellText(cell)
    })
    const normalized = values.map(value => String(value || '').trim())
    if (normalized.some(value => NAME_HEADERS.has(value.toLowerCase()) || NAME_HEADERS.has(value))) {
      headerRowNumber = rowNumber
      headers = normalized
      break
    }
  }

  if (!headerRowNumber) {
    const row = worksheet.getRow(1)
    headerRowNumber = 1
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      headers[colNumber] = cellText(cell)
    })
  }

  let nameCol = -1
  const scoreColumns = []
  headers.forEach((header, colNumber) => {
    const label = String(header || '').trim()
    if (!label) return
    const normalized = label.toLowerCase().replace(/\s+/g, '')
    if (nameCol < 0 && (NAME_HEADERS.has(label) || NAME_HEADERS.has(normalized))) {
      nameCol = colNumber
      return
    }
    if (IGNORED_HEADERS.has(label) || IGNORED_HEADERS.has(normalized)) return
    scoreColumns.push({ colNumber, name: label })
  })

  if (nameCol < 0) throw serviceError('导入表必须包含“姓名”列')
  if (scoreColumns.length === 0) throw serviceError('导入表至少需要一个成绩列')
  return { headerRowNumber, nameCol, scoreColumns }
}

export async function importScoresFromExcel(classId, buffer, filename, teacherId = null) {
  if (!isAllowedScoreWorkbook(filename)) {
    throw serviceError('请上传 .xlsx 格式的成绩文件')
  }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const worksheet = workbook.worksheets[0]
  if (!worksheet) throw serviceError('Excel 中没有可读取的工作表')

  const { headerRowNumber, nameCol, scoreColumns } = readImportShape(worksheet)
  const projectNames = [...new Set(scoreColumns.map(column => normalizeProjectName(column.name)))]
  const { byName: projectsByName, created } = await findOrCreateProjects(classId, projectNames)
  const students = await prisma.student.findMany({
    where: { classId },
    select: { id: true, name: true },
  })
  const studentsByName = new Map(students.map(student => [student.name, student]))
  const unmatchedStudents = new Set()
  let importedScores = 0
  let matchedRows = 0
  let invalidCells = 0

  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber)
    const studentName = cellText(row.getCell(nameCol))
    if (!studentName) continue
    const student = studentsByName.get(studentName)
    if (!student) {
      unmatchedStudents.add(studentName)
      continue
    }
    let rowTouched = false
    for (const column of scoreColumns) {
      const raw = row.getCell(column.colNumber)
      const text = cellText(raw)
      if (!text && raw.value !== 0) continue
      let scoreValue
      try {
        scoreValue = cellScoreValue(raw)
      } catch {
        invalidCells += 1
        continue
      }
      if (scoreValue === null) continue
      const project = projectsByName.get(column.name)
      await saveStudentScore({
        classId,
        studentId: student.id,
        projectId: project.id,
        value: scoreValue,
        teacherId,
      })
      rowTouched = true
      importedScores += 1
    }
    if (rowTouched) matchedRows += 1
  }

  return {
    ok: true,
    importedScores,
    matchedRows,
    createdProjects: created,
    unmatchedStudents: [...unmatchedStudents],
    invalidCells,
  }
}

export async function exportScoresToExcel(classId) {
  const scorebook = await getScorebook(classId, { includeLogs: false })
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'crCheckIn'
  const worksheet = workbook.addWorksheet('成绩表', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 },
  })

  const headers = ['行政班', '姓名', '拼音缩写', ...scorebook.projects.map(project => project.name)]
  worksheet.columns = headers.map((header, index) => ({
    header,
    key: `c${index}`,
    width: index <= 1 ? 14 : 12,
  }))

  worksheet.spliceRows(1, 0, [`${scorebook.class.name} 成绩表`])
  worksheet.mergeCells(1, 1, 1, headers.length)
  worksheet.getCell(1, 1).font = { bold: true, size: 14 }
  worksheet.getCell(1, 1).alignment = { horizontal: 'center' }
  worksheet.spliceRows(2, 0, [`导出时间：${formatSecond(new Date())}；学生 ${scorebook.students.length} 人；项目 ${scorebook.projects.length} 个`])
  worksheet.mergeCells(2, 1, 2, headers.length)
  worksheet.getCell(2, 1).font = { size: 10, color: { argb: 'FF64748B' } }
  worksheet.getCell(2, 1).alignment = { horizontal: 'center' }

  const headerRow = worksheet.getRow(3)
  headerRow.values = headers
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } }
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' }

  for (const student of scorebook.students) {
    const rowValues = [
      sanitizeExcelValue(formatHomeClass(student.homeClass)),
      sanitizeExcelValue(student.name),
      sanitizeExcelValue(student.pinyin.initials),
      ...scorebook.projects.map((project) => {
        const score = student.scores[project.id]
        return score?.value ?? ''
      }),
    ]
    worksheet.addRow(rowValues)
  }

  worksheet.views = [{ state: 'frozen', ySplit: 3 }]
  return workbook.xlsx.writeBuffer()
}
