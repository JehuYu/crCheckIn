import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDt, formatSecond, formatMinute } from './time.js'

describe('parseDt', () => {
  it('returns null for null', () => {
    assert.equal(parseDt(null), null)
  })

  it('returns null for undefined', () => {
    assert.equal(parseDt(undefined), null)
  })

  it('returns null for empty string', () => {
    assert.equal(parseDt(''), null)
  })

  it('parses a valid datetime-local string', () => {
    const result = parseDt('2024-06-01T09:30')
    assert.ok(result instanceof Date)
    assert.ok(!isNaN(result.getTime()))
  })

  it('parsed date has correct year/month/day', () => {
    const result = parseDt('2024-06-01T09:30')
    assert.equal(result.getFullYear(), 2024)
    assert.equal(result.getMonth(), 5) // 0-indexed
    assert.equal(result.getDate(), 1)
  })

  it('parses datetime-local as UTC+8 by default', () => {
    const result = parseDt('2024-06-01T09:30')
    assert.equal(result.toISOString(), '2024-06-01T01:30:00.000Z')
  })
})

describe('timezone formatting helpers', () => {
  it('formats minute/second in UTC+8 regardless of runtime timezone', () => {
    const d = new Date('2024-06-01T01:30:45.000Z')
    assert.equal(formatMinute(d), '2024-06-01 09:30')
    assert.equal(formatSecond(d), '2024-06-01 09:30:45')
  })
})
