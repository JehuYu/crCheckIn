import { describe, it, expect } from 'vitest'
import { resolveClientName } from './ip.js'

function makeRequest({ xForwardedFor, ip } = {}) {
  return {
    headers: xForwardedFor ? { 'x-forwarded-for': xForwardedFor } : {},
    ip,
  }
}

describe('resolveClientName', () => {
  it('returns the first IP from X-Forwarded-For when single value', () => {
    expect(resolveClientName(makeRequest({ xForwardedFor: '192.168.1.1' }))).toBe('192.168.1.1')
  })

  it('returns the first IP from X-Forwarded-For when comma-separated', () => {
    expect(resolveClientName(makeRequest({ xForwardedFor: '10.0.0.1, 172.16.0.1, 8.8.8.8' }))).toBe('10.0.0.1')
  })

  it('trims whitespace from the first IP', () => {
    expect(resolveClientName(makeRequest({ xForwardedFor: '  10.0.0.2 , 10.0.0.3' }))).toBe('10.0.0.2')
  })

  it('falls back to request.ip when no X-Forwarded-For header', () => {
    expect(resolveClientName(makeRequest({ ip: '127.0.0.1' }))).toBe('127.0.0.1')
  })

  it('returns "unknown" when neither header nor ip is available', () => {
    expect(resolveClientName(makeRequest())).toBe('unknown')
  })

  it('returns "unknown" when request.ip is undefined and no header', () => {
    expect(resolveClientName({ headers: {}, ip: undefined })).toBe('unknown')
  })
})
