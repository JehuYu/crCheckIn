import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeExamWorkbook,
  assertSafeAnalysisFilename,
  buildTeachingAdvice,
  formatAnalysisErrorMessage,
  isAllowedExamWorkbook,
} from './examAnalysis.js'

describe('examAnalysis service helpers', () => {
  describe('isAllowedExamWorkbook', () => {
    it('allows xls and xlsx files', () => {
      assert.equal(isAllowedExamWorkbook('小题分.xls'), true)
      assert.equal(isAllowedExamWorkbook('小题分.xlsx'), true)
    })

    it('rejects non-excel files', () => {
      assert.equal(isAllowedExamWorkbook('小题分.csv'), false)
      assert.equal(isAllowedExamWorkbook('小题分.txt'), false)
    })
  })

  describe('assertSafeAnalysisFilename', () => {
    it('allows generated output filenames', () => {
      assert.equal(assertSafeAnalysisFilename('20260529_104814_a64dff42_exam_analysis.xlsx'), '20260529_104814_a64dff42_exam_analysis.xlsx')
    })

    it('rejects path traversal and non-ascii names', () => {
      assert.throws(() => assertSafeAnalysisFilename('../secret.xlsx'), /文件名无效/)
      assert.throws(() => assertSafeAnalysisFilename('结果.xlsx'), /文件名无效/)
    })
  })

  describe('formatAnalysisErrorMessage', () => {
    it('explains missing python dependencies', () => {
      const result = formatAnalysisErrorMessage({
        message: "ModuleNotFoundError: No module named 'pandas'",
      })
      assert.equal(result.statusCode, 500)
      assert.match(result.message, /缺少小题成绩处理依赖/)
    })

    it('explains missing excel reader dependencies', () => {
      const result = formatAnalysisErrorMessage({
        message: "ValueError: 缺少读取 Excel 所需依赖，请安装 pandas、openpyxl 和 xlrd 后重试。",
      })
      assert.equal(result.statusCode, 500)
      assert.match(result.message, /缺少读取 Excel 所需依赖/)
    })

    it('explains likely wrong workbook uploads', () => {
      const result = formatAnalysisErrorMessage({
        message: '成绩表列数不足，未找到完整的学生基础字段。',
      })
      assert.equal(result.statusCode, 400)
      assert.match(result.message, /不像原始小题分成绩文件/)
    })
  })

  describe('analyzeExamWorkbook option validation', () => {
    it('rejects unsupported class mapping file extensions before running python', async () => {
      await assert.rejects(
        () => analyzeExamWorkbook(Buffer.from('placeholder'), 'score.xls', {
          classMappingBuffer: Buffer.from('placeholder'),
          classMappingFilename: 'mapping.csv',
        }),
        /分班表请上传 \.xls 或 \.xlsx 格式文件/
      )
    })
  })

  describe('buildTeachingAdvice', () => {
    it('summarizes weak questions, weak classes, and subject focus', () => {
      const advice = buildTeachingAdvice({
        class_averages: {
          columns: ['班级', '全卷', '信息', '通用'],
          data: [
            { 班级: '1', 全卷: 70, 信息: 31, 通用: 39 },
            { 班级: '2', 全卷: 62, 信息: 29, 通用: 33 },
            { 班级: '总平均值', 全卷: 66, 信息: 31, 通用: 35 },
          ],
        },
        info_analysis: {
          columns: ['班级', '信息', '信1', '信2'],
          data: [
            { 班级: '总平均值', 信息: 31, 信1: 0.8, 信2: 0.2 },
          ],
        },
        general_analysis: {
          columns: ['班级', '通用', '通3', '通4'],
          data: [
            { 班级: '总平均值', 通用: 35, 通3: 0.1, 通4: 0.3 },
          ],
        },
      })

      assert.deepEqual(
        advice.lowQuestions.slice(0, 4).map((item) => item.question),
        ['通3', '信2', '通4', '信1']
      )
      assert.deepEqual(advice.weakClasses.map((item) => item.className), ['2', '1'])
      assert.equal(advice.subjectFocus.subject, '信息')
      assert.equal(advice.subjectFocus.gap, 4)
      assert.deepEqual(
        advice.summaryCards.map((item) => item.label),
        ['优先讲评', '学科侧重', '关注班级']
      )
    })

    it('returns empty advice when result tables are missing', () => {
      const advice = buildTeachingAdvice({})
      assert.deepEqual(advice.summaryCards, [])
      assert.deepEqual(advice.lowQuestions, [])
      assert.deepEqual(advice.weakClasses, [])
      assert.equal(advice.subjectFocus, null)
    })
  })
})
