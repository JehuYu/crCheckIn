import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveClientName } from './ip.js'

function makeRequest({ xForwardedFor, ip } = {}) {
  return {
    headers: xForwardedFor ? { 'x-forwarded-for': xForwardedFor } : {},
    ip,
  }
}

describe('resolveClientName', () => {
  it('returns the first IP from X-Forwarded-For when single value', () => {
    assert.equal(resolveClientName(makeRequest({ xForwardedFor: '192.168.1.1' })), '192.168.1.1')
  })

  it('returns the first IP from X-Forwarded-For when comma-separated', () => {
    assert.equal(resolveClientName(makeRequest({ xForwardedFor: '10.0.0.1, 172.16.0.1, 8.8.8.8' })), '10.0.0.1')
  })

  it('trims whitespace from the first IP', () => {
    assert.equal(resolveClientName(makeRequest({ xForwardedFor: '  10.0.0.2 , 10.0.0.3' })), '10.0.0.2')
  })

  it('falls back to request.ip when no X-Forwarded-For header', () => {
    assert.equal(resolveClientName(makeRequest({ ip: '127.0.0.1' })), '127.0.0.1')
  })

  it('returns "unknown" when neither header nor ip is available', () => {
    assert.equal(resolveClientName(makeRequest()), 'unknown')
  })

  it('returns "unknown" when request.ip is undefined and no header', () => {
    assert.equal(resolveClientName({ headers: {}, ip: undefined }), 'unknown')
  })
})
