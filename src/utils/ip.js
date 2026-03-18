/**
 * 从请求头解析客户端 IP/主机名。
 * 优先读取 X-Forwarded-For 头（取第一段），回退到 request.ip，无法解析时返回 "unknown"。
 * @param {import('fastify').FastifyRequest} request
 * @returns {string}
 */
export function resolveClientName(request) {
  const forwarded = request.headers?.['x-forwarded-for']
  if (forwarded) {
    const first = forwarded.split(',')[0].trim()
    if (first) return first
  }

  if (request.ip) return request.ip

  return 'unknown'
}
