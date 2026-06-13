import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSafeRuntimeDatabase,
  assertSafeTestDatabase,
} from './databaseSafety.js'

describe('test database safety guard', () => {
  it('allows a dedicated test database in test mode', () => {
    assert.doesNotThrow(() => assertSafeTestDatabase({
      nodeEnv: 'test',
      databaseUrl: 'postgresql://user:pass@127.0.0.1:5432/crcheckin_test?schema=public',
    }))
  })

  it('rejects the production database even when a test is run directly', () => {
    assert.throws(
      () => assertSafeTestDatabase({
        nodeEnv: '',
        databaseUrl: 'postgresql://user:pass@127.0.0.1:5432/crcheckin?schema=public',
      }),
      /Refusing to clean database "crcheckin"/
    )
  })

  it('rejects a production database name even if NODE_ENV is test', () => {
    assert.throws(
      () => assertSafeTestDatabase({
        nodeEnv: 'test',
        databaseUrl: 'postgresql://user:pass@127.0.0.1:5432/crcheckin?schema=public',
      }),
      /dedicated \*_test database/
    )
  })

  it('rejects starting the app runtime against a test database by default', () => {
    assert.throws(
      () => assertSafeRuntimeDatabase({
        nodeEnv: 'production',
        databaseUrl: 'postgresql://user:pass@127.0.0.1:5432/crcheckin_test?schema=public',
      }),
      /Refusing to start non-test runtime against test database "crcheckin_test"/
    )
  })

  it('allows explicit temporary runtime access to a test database', () => {
    assert.doesNotThrow(() => assertSafeRuntimeDatabase({
      nodeEnv: 'development',
      databaseUrl: 'postgresql://user:pass@127.0.0.1:5432/crcheckin_test?schema=public',
      allowTestDatabaseRuntime: true,
    }))
  })

  it('rejects NODE_ENV=test runtime against a production database', () => {
    assert.throws(
      () => assertSafeRuntimeDatabase({
        nodeEnv: 'test',
        databaseUrl: 'postgresql://user:pass@127.0.0.1:5432/crcheckin?schema=public',
      }),
      /Refusing to run NODE_ENV=test against database "crcheckin"/
    )
  })
})
