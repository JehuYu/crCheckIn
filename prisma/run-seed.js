import { PrismaClient } from '@prisma/client'
import { seed } from './seed.js'

const prisma = new PrismaClient()
await seed(prisma)
await prisma.$disconnect()
console.log('Seed 完成：admin 账号已创建（用户名: admin，密码: abc123）')
