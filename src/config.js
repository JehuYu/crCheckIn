export const SECRET_KEY = process.env.SECRET_KEY ?? 'lab-attendance-secret-key-32chars!!'
export const DATABASE_URL = process.env.DATABASE_URL ?? 'file:./attendance.db'
export const PORT = Number(process.env.PORT ?? 5000)
export const HOST = process.env.HOST ?? '0.0.0.0'
