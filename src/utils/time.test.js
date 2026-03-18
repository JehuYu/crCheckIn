import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDt } from './time.js'

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
})
