import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const TOOL_DIR = path.join(PROJECT_ROOT, 'tools', 'exam-analysis')
const RUNNER = path.join(TOOL_DIR, 'run_analysis.py')
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'uploads', 'exam-analysis')
const MAX_EXAM_FILE_SIZE = 32 * 1024 * 1024
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function timestamp() {
  const d = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function sanitizeFilename(filename) {
  const ext = path.extname(filename || '').toLowerCase()
  const stem = path.basename(filename || 'exam', ext).replace(/[^\p{L}\p{N}._-]+/gu, '_')
  return `${stem || 'exam'}${ext}`
}

export function isAllowedExamWorkbook(filename) {
  return ['.xls', '.xlsx'].includes(path.extname(filename || '').toLowerCase())
}

export function assertSafeAnalysisFilename(filename) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(filename || '')) {
    throw new Error('文件名无效')
  }
  return filename
}

function getPythonExecutable() {
  return process.env.EXAM_ANALYSIS_PYTHON || process.env.PYTHON || 'python'
}

export function formatAnalysisErrorMessage(error) {
  const text = `${error?.message || ''}\n${error?.detail || ''}`

  if (/ModuleNotFoundError: No module named ['"]pandas['"]/.test(text)) {
    return {
      message: '服务器缺少小题成绩处理依赖，请先为 Python 环境安装表格处理依赖。',
      statusCode: 500,
    }
  }

  if (/缺少读取 Excel 所需依赖|No module named ['"](openpyxl|xlrd)['"]/.test(text)) {
    return {
      message: '服务器缺少读取 Excel 所需依赖，请先为 Python 环境安装表格处理依赖。',
      statusCode: 500,
    }
  }

  if (/成绩表列数不足|未找到完整的学生基础字段/.test(text)) {
    return {
      message: '这不像原始小题分成绩文件。请上传从成绩平台导出的学生小题分原始表，不要上传分班表或汇总表。',
      statusCode: 400,
    }
  }

  if (/Excel file format cannot be determined|Unsupported format|not supported/.test(text)) {
    return {
      message: '文件内容无法识别为 Excel 成绩表，请重新导出 .xls 或 .xlsx 文件后再上传。',
      statusCode: 400,
    }
  }

  return {
    message: error?.message || '小题成绩处理失败',
    statusCode: error?.statusCode || 500,
  }
}

function toScore(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function roundScore(value) {
  const number = toScore(value)
  return number === null ? null : Number(number.toFixed(2))
}

function formatScore(value) {
  const rounded = roundScore(value)
  return rounded === null ? '-' : String(rounded)
}

function getTableRows(table) {
  return Array.isArray(table?.data) ? table.data : []
}

function getTableColumns(table) {
  return Array.isArray(table?.columns) ? table.columns : []
}

function getRowName(table, row) {
  const firstColumn = getTableColumns(table)[0]
  return firstColumn ? String(row?.[firstColumn] ?? '') : ''
}

function getOverallRow(table) {
  return getTableRows(table).find((row) => getRowName(table, row) === '总平均值') || null
}

function buildLowQuestions(table, subject, subjectTotalColumn) {
  const columns = getTableColumns(table)
  const firstColumn = columns[0]
  const overall = getOverallRow(table)
  if (!overall) return []

  const excluded = new Set([firstColumn, subjectTotalColumn])
  return columns
    .filter((column) => column && !excluded.has(column))
    .map((column) => ({
      subject,
      question: column,
      average: roundScore(overall[column]),
    }))
    .filter((item) => item.average !== null)
    .sort((a, b) => a.average - b.average)
}

function buildWeakClasses(table) {
  const firstColumn = getTableColumns(table)[0]
  if (!firstColumn) return []

  return getTableRows(table)
    .filter((row) => getRowName(table, row) && getRowName(table, row) !== '总平均值')
    .map((row) => ({
      className: getRowName(table, row),
      fullScore: roundScore(row['全卷']),
      infoScore: roundScore(row['信息']),
      generalScore: roundScore(row['通用']),
    }))
    .filter((item) => item.fullScore !== null)
    .sort((a, b) => a.fullScore - b.fullScore)
}

function buildSubjectFocus(table) {
  const overall = getOverallRow(table)
  if (!overall) return null

  const infoScore = roundScore(overall['信息'])
  const generalScore = roundScore(overall['通用'])
  if (infoScore === null || generalScore === null) return null

  if (infoScore <= generalScore) {
    return {
      subject: '信息',
      score: infoScore,
      comparedWith: '通用',
      comparedScore: generalScore,
      gap: roundScore(generalScore - infoScore),
    }
  }

  return {
    subject: '通用',
    score: generalScore,
    comparedWith: '信息',
    comparedScore: infoScore,
    gap: roundScore(infoScore - generalScore),
  }
}

export function buildTeachingAdvice(payload) {
  const lowQuestions = [
    ...buildLowQuestions(payload?.info_analysis, '信息', '信息'),
    ...buildLowQuestions(payload?.general_analysis, '通用', '通用'),
  ].sort((a, b) => a.average - b.average).slice(0, 8)

  const weakClasses = buildWeakClasses(payload?.class_averages).slice(0, 3)
  const subjectFocus = buildSubjectFocus(payload?.class_averages)

  const summaryCards = []
  if (lowQuestions[0]) {
    summaryCards.push({
      label: '优先讲评',
      value: lowQuestions[0].question,
      note: `${lowQuestions[0].subject}均分 ${formatScore(lowQuestions[0].average)}`,
    })
  }
  if (subjectFocus) {
    summaryCards.push({
      label: '学科侧重',
      value: subjectFocus.subject,
      note: `比${subjectFocus.comparedWith}低 ${formatScore(subjectFocus.gap)} 分`,
    })
  }
  if (weakClasses[0]) {
    summaryCards.push({
      label: '关注班级',
      value: weakClasses[0].className,
      note: `全卷均分 ${formatScore(weakClasses[0].fullScore)}`,
    })
  }

  return {
    summaryCards,
    lowQuestions,
    weakClasses,
    subjectFocus,
  }
}

function runPythonAnalysis(inputPath, outputPath, mappingPath = null) {
  return new Promise((resolve, reject) => {
    const args = [RUNNER, '--input', inputPath, '--output', outputPath]
    if (mappingPath) args.push('--mapping', mappingPath)

    const child = spawn(getPythonExecutable(), args, {
      cwd: TOOL_DIR,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('处理超时，请稍后重试或换一个更小的文件'))
    }, 120000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      if (error.code === 'ENOENT') {
        error.message = '未找到 Python，请配置 EXAM_ANALYSIS_PYTHON 或安装 Python。'
      }
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let parsed = null
      try {
        parsed = JSON.parse(stdout.trim())
      } catch {
        parsed = null
      }

      if (code !== 0 || !parsed?.ok) {
        const message = parsed?.error || stderr.trim() || '小题成绩处理失败'
        const error = new Error(message)
        error.detail = parsed?.traceback || stderr
        reject(error)
        return
      }
      resolve(parsed)
    })
  })
}

export async function analyzeExamWorkbook(fileBuffer, originalFilename, options = {}) {
  if (!isAllowedExamWorkbook(originalFilename)) {
    const error = new Error('请上传 .xls 或 .xlsx 格式的成绩文件')
    error.statusCode = 400
    throw error
  }
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) {
    const error = new Error('上传文件为空')
    error.statusCode = 400
    throw error
  }
  if (fileBuffer.length > MAX_EXAM_FILE_SIZE) {
    const error = new Error('文件过大，请控制在 32MB 以内')
    error.statusCode = 413
    throw error
  }

  const mappingBuffer = options.classMappingBuffer
  const mappingFilename = options.classMappingFilename
  if (mappingBuffer) {
    if (!isAllowedExamWorkbook(mappingFilename)) {
      const error = new Error('分班表请上传 .xls 或 .xlsx 格式文件')
      error.statusCode = 400
      throw error
    }
    if (!Buffer.isBuffer(mappingBuffer) || mappingBuffer.length === 0) {
      const error = new Error('分班表文件为空')
      error.statusCode = 400
      throw error
    }
    if (mappingBuffer.length > MAX_EXAM_FILE_SIZE) {
      const error = new Error('分班表文件过大，请控制在 32MB 以内')
      error.statusCode = 413
      throw error
    }
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true })
  const safeName = sanitizeFilename(originalFilename)
  const jobId = `${timestamp()}_${randomUUID().slice(0, 8)}`
  const inputPath = path.join(OUTPUT_DIR, `${jobId}_${safeName}`)
  const mappingPath = mappingBuffer
    ? path.join(OUTPUT_DIR, `${jobId}_mapping_${sanitizeFilename(mappingFilename)}`)
    : null
  const outputFilename = `${jobId}_exam_analysis.xlsx`
  const outputPath = path.join(OUTPUT_DIR, outputFilename)

  await fs.writeFile(inputPath, fileBuffer)
  if (mappingPath) {
    await fs.writeFile(mappingPath, mappingBuffer)
  }
  let payload
  try {
    payload = await runPythonAnalysis(inputPath, outputPath, mappingPath)
  } catch (err) {
    const formatted = formatAnalysisErrorMessage(err)
    err.message = formatted.message
    err.statusCode = formatted.statusCode
    throw err
  }
  const teachingAdvice = buildTeachingAdvice(payload)

  return {
    ...payload,
    teachingAdvice,
    outputFilename,
    outputPath,
    downloadUrl: `/api/exam-analysis/download/${outputFilename}`,
  }
}

export async function readAnalysisWorkbook(filename) {
  const safeName = assertSafeAnalysisFilename(filename)
  const filePath = path.join(OUTPUT_DIR, safeName)
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(path.resolve(OUTPUT_DIR) + path.sep)) {
    throw new Error('文件路径无效')
  }
  return {
    buffer: await fs.readFile(resolved),
    filename: safeName,
    mime: EXCEL_MIME,
  }
}
