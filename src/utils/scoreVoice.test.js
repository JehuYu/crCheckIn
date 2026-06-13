import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseScoreFromText,
  parseSpokenNumber,
  parseVoiceScoreTranscript,
} from '../../public/score-voice.js'

const students = [
  { id: 1, name: '周之健', homeClass: '1', pinyin: { initials: 'zzj', full: 'zhouzhijian' } },
  { id: 2, name: '郑俊杰', homeClass: '1', pinyin: { initials: 'zjj', full: 'zhengjunjie' } },
  { id: 3, name: '张三', homeClass: '2', pinyin: { initials: 'zs', full: 'zhangsan' } },
  { id: 4, name: '张四', homeClass: '2', pinyin: { initials: 'zs', full: 'zhangsi' } },
]

describe('score voice parser', () => {
  it('parses Arabic scores for multiple students in one sentence', () => {
    const result = parseVoiceScoreTranscript('周之健 13，郑俊杰 23', students)

    assert.deepEqual(result.accepted.map(item => [item.studentName, item.value]), [
      ['周之健', 13],
      ['郑俊杰', 23],
    ])
    assert.equal(result.pending.length, 0)
  })

  it('parses common Chinese spoken numbers and decimals', () => {
    assert.equal(parseSpokenNumber('十三'), 13)
    assert.equal(parseSpokenNumber('二十三'), 23)
    assert.equal(parseSpokenNumber('九十八点五'), 98.5)
    assert.deepEqual(parseScoreFromText('成绩 九十八点五'), {
      value: 98.5,
      raw: '九十八点五',
      index: 3,
    })
  })

  it('reports unmatched and ambiguous names as pending', () => {
    const unmatched = parseVoiceScoreTranscript('王五 20', students)
    assert.equal(unmatched.accepted.length, 0)
    assert.equal(unmatched.pending[0].reason, 'not-found')

    const ambiguous = parseVoiceScoreTranscript('张 20', students)
    assert.equal(ambiguous.accepted.length, 0)
    assert.equal(ambiguous.pending[0].reason, 'ambiguous')
    assert.equal(ambiguous.pending[0].candidates.length, 2)
  })

  it('keeps repeated or conflicting entries out of automatic saves', () => {
    const sameText = parseVoiceScoreTranscript('周之健 13 周之健 13', students)
    assert.equal(sameText.accepted.length, 1)
    assert.equal(sameText.pending[0].reason, 'duplicate')

    const conflict = parseVoiceScoreTranscript('周之健 13 周之健 14', students)
    assert.equal(conflict.accepted.length, 1)
    assert.equal(conflict.pending[0].reason, 'conflict')

    const seen = parseVoiceScoreTranscript('郑俊杰 23', students, {
      seenStudentValues: new Map([[2, 23]]),
    })
    assert.equal(seen.accepted.length, 0)
    assert.equal(seen.pending[0].reason, 'duplicate')
  })
})
