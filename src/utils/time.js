const DEFAULT_TZ_OFFSET_MINUTES = 8 * 60

function pad(n) {
  return String(n).padStart(2, '0')
}

function asNumber(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * 业务时间偏移（分钟），默认东八区。
 * 可通过 TIMEZONE_OFFSET_MINUTES 覆盖（例如 0 表示 UTC）。
 */
export const TIMEZONE_OFFSET_MINUTES = asNumber(process.env.TIMEZONE_OFFSET_MINUTES, DEFAULT_TZ_OFFSET_MINUTES)

/**
 * 将 Date 按指定时区偏移转换为可读时间部件。
 * 通过 getUTC* 读取，规避运行机器本地时区差异。
 * @param {Date} date
 * @param {number} [offsetMinutes]
 */
function toOffsetParts(date, offsetMinutes = TIMEZONE_OFFSET_MINUTES) {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekDay: shifted.getUTCDay(),
  }
}

/**
 * 格式化为 YYYY-MM-DD HH:mm
 * @param {Date|null} date
 * @param {number} [offsetMinutes]
 * @returns {string|null}
 */
export function formatMinute(date, offsetMinutes = TIMEZONE_OFFSET_MINUTES) {
  if (!date) return null
  const p = toOffsetParts(date, offsetMinutes)
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

/**
 * 格式化为 YYYY-MM-DD HH:mm:ss
 * @param {Date|null} date
 * @param {number} [offsetMinutes]
 * @returns {string|null}
 */
export function formatSecond(date, offsetMinutes = TIMEZONE_OFFSET_MINUTES) {
  if (!date) return null
  const p = toOffsetParts(date, offsetMinutes)
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
}

/**
 * 获取当前时间在业务时区下的日期语义。
 * @param {number} [offsetMinutes]
 */
export function nowParts(offsetMinutes = TIMEZONE_OFFSET_MINUTES) {
  return toOffsetParts(new Date(), offsetMinutes)
}

/**
 * 将 datetime-local（无时区）按业务时区解析为 Date（UTC 时间点）。
 * @param {string|null|undefined} value
 * @param {number} [offsetMinutes]
 * @returns {Date|null}
 */
export function parseDt(value, offsetMinutes = TIMEZONE_OFFSET_MINUTES) {
  if (value == null || value === '') return null
  const s = String(value).trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!m) {
    const fallback = new Date(s)
    return Number.isNaN(fallback.getTime()) ? null : fallback
  }
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const utcTs = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000
  return new Date(utcTs)
}
