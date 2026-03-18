/**
 * 将 datetime-local 格式字符串解析为 Date 对象。
 * @param {string|null|undefined} value
 * @returns {Date|null}
 */
export function parseDt(value) {
  if (value == null || value === '') return null
  return new Date(value)
}
