const FULLWIDTH_DIGIT_OFFSET = '０'.charCodeAt(0) - '0'.charCodeAt(0)
const CHINESE_DIGITS = new Map([
  ['零', 0],
  ['〇', 0],
  ['一', 1],
  ['二', 2],
  ['两', 2],
  ['三', 3],
  ['四', 4],
  ['五', 5],
  ['六', 6],
  ['七', 7],
  ['八', 8],
  ['九', 9],
])

const CHINESE_NUMBER_PATTERN = '[零〇一二两三四五六七八九十百点]+'
const ARABIC_NUMBER_PATTERN = '[-+]?\\d+(?:\\.\\d+)?'

export function normalizeVoiceText(text) {
  return String(text || '')
    .replace(/[０-９]/g, ch => String(ch.charCodeAt(0) - FULLWIDTH_DIGIT_OFFSET))
    .replace(/[．]/g, '.')
    .replace(/[。]/g, ' ')
    .replace(/[，,、；;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseChineseInteger(raw) {
  if (!raw) return null
  if ([...raw].every(ch => CHINESE_DIGITS.has(ch))) {
    return Number([...raw].map(ch => CHINESE_DIGITS.get(ch)).join(''))
  }

  let total = 0
  let current = 0
  for (const ch of raw) {
    if (CHINESE_DIGITS.has(ch)) {
      current = CHINESE_DIGITS.get(ch)
      continue
    }
    if (ch === '十') {
      total += (current || 1) * 10
      current = 0
      continue
    }
    if (ch === '百') {
      total += (current || 1) * 100
      current = 0
      continue
    }
    return null
  }
  return total + current
}

export function parseSpokenNumber(raw) {
  const text = normalizeVoiceText(raw)
  if (!text) return null

  if (/^[-+]?\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text)
    return Number.isFinite(number) && number >= 0 ? number : null
  }

  if (!new RegExp(`^${CHINESE_NUMBER_PATTERN}$`).test(text)) return null
  const [integerPart, decimalPart = ''] = text.split('点')
  const integer = parseChineseInteger(integerPart)
  if (integer === null) return null
  if (!decimalPart) return integer
  if (![...decimalPart].every(ch => CHINESE_DIGITS.has(ch))) return null
  return Number(`${integer}.${[...decimalPart].map(ch => CHINESE_DIGITS.get(ch)).join('')}`)
}

export function parseScoreFromText(text) {
  const normalized = normalizeVoiceText(text)
  const arabicMatch = normalized.match(new RegExp(ARABIC_NUMBER_PATTERN))
  if (arabicMatch) {
    const value = parseSpokenNumber(arabicMatch[0])
    if (value !== null) {
      return { value, raw: arabicMatch[0], index: arabicMatch.index ?? 0 }
    }
  }

  const chineseMatch = normalized.match(new RegExp(CHINESE_NUMBER_PATTERN))
  if (!chineseMatch) return null
  const value = parseSpokenNumber(chineseMatch[0])
  if (value === null) return null
  return { value, raw: chineseMatch[0], index: chineseMatch.index ?? 0 }
}

function findKnownMentions(text, students) {
  const mentions = []
  for (const student of students) {
    const name = String(student.name || '').trim()
    if (!name) continue
    let index = text.indexOf(name)
    while (index >= 0) {
      mentions.push({
        index,
        end: index + name.length,
        name,
        students: [student],
      })
      index = text.indexOf(name, index + name.length)
    }
  }

  mentions.sort((a, b) => a.index - b.index || b.name.length - a.name.length)
  const selected = []
  for (const mention of mentions) {
    const last = selected[selected.length - 1]
    if (!last || mention.index >= last.end) selected.push(mention)
  }
  return selected
}

function resolveSpokenName(name, students) {
  const spokenName = String(name || '').trim()
  if (!spokenName) {
    return { status: 'missing-name', candidates: [] }
  }

  const exact = students.filter(student => student.name === spokenName)
  if (exact.length === 1) return { status: 'ok', student: exact[0], candidates: exact }
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact }

  const q = spokenName.toLowerCase()
  const candidates = students.filter(student =>
    String(student.name || '').includes(spokenName) ||
    String(student.pinyin?.initials || '').toLowerCase() === q ||
    String(student.pinyin?.full || '').toLowerCase() === q
  )
  if (candidates.length === 1) return { status: 'ok', student: candidates[0], candidates }
  if (candidates.length > 1) return { status: 'ambiguous', candidates }
  return { status: 'not-found', candidates: [] }
}

function seenValueFor(seenStudentValues, studentId) {
  if (!seenStudentValues) return undefined
  if (seenStudentValues instanceof Map) {
    return seenStudentValues.get(studentId) ?? seenStudentValues.get(String(studentId))
  }
  return seenStudentValues[studentId] ?? seenStudentValues[String(studentId)]
}

function pushResolvedEntry({ accepted, pending, seen, student, value, rawScore, phrase }) {
  const studentId = student.id
  if (seen.has(studentId)) {
    const previousValue = seen.get(studentId)
    pending.push({
      reason: previousValue === value ? 'duplicate' : 'conflict',
      name: student.name,
      studentId,
      value,
      rawScore,
      phrase,
      message: previousValue === value
        ? `${student.name} 已经识别过 ${value}`
        : `${student.name} 本轮已识别 ${previousValue}，新的 ${value} 需要确认`,
    })
    return
  }
  seen.set(studentId, value)
  accepted.push({
    studentId,
    studentName: student.name,
    value,
    rawScore,
    phrase,
  })
}

function pushPendingForName({ pending, name, value = null, rawScore = '', phrase, reason, candidates = [] }) {
  const messages = {
    'not-found': `未找到学生：${name}`,
    ambiguous: `${name} 匹配到多名学生，需要手动确认`,
    'missing-score': `${name} 后面没有识别到成绩`,
    'missing-name': `成绩 ${value ?? rawScore} 前面没有识别到学生`,
  }
  pending.push({
    reason,
    name,
    value,
    rawScore,
    phrase,
    candidates: candidates.map(student => ({
      id: student.id,
      name: student.name,
      homeClass: student.homeClass || '',
    })),
    message: messages[reason] || '需要手动确认',
  })
}

function parseKnownNameText(text, students, seenStudentValues) {
  const accepted = []
  const pending = []
  const seen = new Map()
  for (const student of students) {
    const value = seenValueFor(seenStudentValues, student.id)
    if (value !== undefined) seen.set(student.id, Number(value))
  }

  const mentions = findKnownMentions(text, students)
  for (let index = 0; index < mentions.length; index += 1) {
    const mention = mentions[index]
    const next = mentions[index + 1]
    const phrase = text.slice(mention.index, next ? next.index : text.length).trim()
    const tail = text.slice(mention.end, next ? next.index : text.length)
    const score = parseScoreFromText(tail)
    if (!score) {
      pushPendingForName({
        pending,
        name: mention.name,
        phrase,
        reason: 'missing-score',
        candidates: mention.students,
      })
      continue
    }

    pushResolvedEntry({
      accepted,
      pending,
      seen,
      student: mention.students[0],
      value: score.value,
      rawScore: score.raw,
      phrase,
    })
  }

  return { accepted, pending, mentionCount: mentions.length }
}

function parseLoosePairs(text, students, seenStudentValues) {
  const accepted = []
  const pending = []
  const seen = new Map()
  for (const student of students) {
    const value = seenValueFor(seenStudentValues, student.id)
    if (value !== undefined) seen.set(student.id, Number(value))
  }

  const patterns = [
    new RegExp(`([\\u4e00-\\u9fa5·]{1,8})\\s*(${ARABIC_NUMBER_PATTERN})`, 'g'),
    new RegExp(`([\\u4e00-\\u9fa5·]{1,8})\\s+(${CHINESE_NUMBER_PATTERN})`, 'g'),
  ]
  const matches = []
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      matches.push({
        index: match.index ?? 0,
        phrase: match[0],
        name: match[1],
        rawScore: match[2],
      })
    }
  }
  matches.sort((a, b) => a.index - b.index || b.phrase.length - a.phrase.length)

  const used = []
  for (const match of matches) {
    const end = match.index + match.phrase.length
    if (used.some(range => match.index < range.end && end > range.start)) continue
    used.push({ start: match.index, end })

    const value = parseSpokenNumber(match.rawScore)
    const resolved = resolveSpokenName(match.name, students)
    if (value === null) {
      pushPendingForName({
        pending,
        name: match.name,
        rawScore: match.rawScore,
        phrase: match.phrase,
        reason: 'missing-score',
        candidates: resolved.candidates,
      })
      continue
    }
    if (resolved.status !== 'ok') {
      pushPendingForName({
        pending,
        name: match.name,
        value,
        rawScore: match.rawScore,
        phrase: match.phrase,
        reason: resolved.status === 'ambiguous' ? 'ambiguous' : 'not-found',
        candidates: resolved.candidates,
      })
      continue
    }
    pushResolvedEntry({
      accepted,
      pending,
      seen,
      student: resolved.student,
      value,
      rawScore: match.rawScore,
      phrase: match.phrase,
    })
  }

  return { accepted, pending }
}

export function parseVoiceScoreTranscript(transcript, students, options = {}) {
  const normalizedText = normalizeVoiceText(transcript)
  const roster = Array.isArray(students) ? students : []
  if (!normalizedText || roster.length === 0) {
    return { normalizedText, accepted: [], pending: [] }
  }

  const known = parseKnownNameText(normalizedText, roster, options.seenStudentValues)
  if (known.mentionCount > 0) {
    return {
      normalizedText,
      accepted: known.accepted,
      pending: known.pending,
    }
  }

  const loose = parseLoosePairs(normalizedText, roster, options.seenStudentValues)
  return {
    normalizedText,
    accepted: loose.accepted,
    pending: loose.pending,
  }
}
