export function getDatabaseName(databaseUrl = '') {
  try {
    if (databaseUrl.startsWith('file:')) {
      return databaseUrl.slice('file:'.length).split(/[\\/]/).pop() || ''
    }
    const url = new URL(databaseUrl)
    return url.pathname.split('/').filter(Boolean).pop() || ''
  } catch {
    return ''
  }
}

export function isLikelyTestDatabaseName(databaseName = '') {
  return /(^|[_-])test($|[_-])/.test(databaseName) || databaseName.endsWith('_test')
}

export function assertSafeTestDatabase({
  databaseUrl = process.env.DATABASE_URL || '',
  nodeEnv = process.env.NODE_ENV || '',
} = {}) {
  const databaseName = getDatabaseName(databaseUrl)
  const isTestEnv = nodeEnv === 'test'
  const isTestDatabase = isLikelyTestDatabaseName(databaseName)
  if (!isTestEnv || !isTestDatabase) {
    throw new Error(
      `Refusing to clean database "${databaseName || 'unknown'}". ` +
      'Tests must run with NODE_ENV=test and a dedicated *_test database. Use npm.cmd test.'
    )
  }
}

export function assertSafeRuntimeDatabase({
  databaseUrl = process.env.DATABASE_URL || '',
  nodeEnv = process.env.NODE_ENV || '',
  allowTestDatabaseRuntime = process.env.ALLOW_TEST_DATABASE_RUNTIME === 'true',
} = {}) {
  const databaseName = getDatabaseName(databaseUrl)
  const isTestEnv = nodeEnv === 'test'
  const isTestDatabase = isLikelyTestDatabaseName(databaseName)

  if (isTestEnv && !isTestDatabase) {
    throw new Error(
      `Refusing to run NODE_ENV=test against database "${databaseName || 'unknown'}". ` +
      'Use a dedicated *_test database.'
    )
  }

  if (!isTestEnv && isTestDatabase && !allowTestDatabaseRuntime) {
    throw new Error(
      `Refusing to start non-test runtime against test database "${databaseName}". ` +
      'Set ALLOW_TEST_DATABASE_RUNTIME=true only for temporary local debugging.'
    )
  }
}
