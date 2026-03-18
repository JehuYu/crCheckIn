import bcrypt from 'bcrypt'

export async function seed(prisma) {
  const passwordHash = await bcrypt.hash('abc123', 10)
  await prisma.teacher.upsert({
    where: { username: 'admin' },
    update: {},
    create: { username: 'admin', passwordHash, isAdmin: true },
  })
}
