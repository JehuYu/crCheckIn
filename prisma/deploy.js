import { deployDatabase } from '../src/utils/database.js'

try {
  await deployDatabase()
} catch (error) {
  console.error(error)
  process.exit(1)
}
