import { prisma } from '../plugins/db.js'
import { nameToPinyin } from '../utils/pinyin.js'
import { assertClassOwner } from './class.js'
import { broadcastToAllTeachers, broadcastToTeacher } from './sse.js'

export const MEMORY_PK_STATUS = {
  waiting: 'waiting',
  active: 'active',
  finished: 'finished',
  abandoned: 'abandoned',
}

export const MEMORY_PK_PARTICIPANT_STATUS = {
  joined: 'joined',
  playing: 'playing',
  finished: 'finished',
  left: 'left',
}

export const MEMORY_PK_MODE = 'photoToName'
export const MEMORY_PK_QUESTION_LIMIT = 30
const OPTION_COUNT = 4

const TEACHER_SELECT = {
  id: true,
  username: true,
}

const CLASS_SELECT = {
  id: true,
  name: true,
}

const ROOM_INCLUDE = {
  creator: { select: TEACHER_SELECT },
  participants: {
    orderBy: [{ joinedAt: 'asc' }],
    include: {
      teacher: { select: TEACHER_SELECT },
      class: { select: CLASS_SELECT },
      questions: {
        orderBy: [{ position: 'asc' }],
      },
    },
  },
}

function serviceError(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

function parseRoomId(roomId) {
  const id = Number.parseInt(roomId, 10)
  if (!Number.isInteger(id) || id <= 0) {
    throw serviceError('房间不存在', 404)
  }
  return id
}

function parseStudentId(studentId) {
  const id = Number.parseInt(studentId, 10)
  if (!Number.isInteger(id) || id <= 0) {
    throw serviceError('请选择有效答案')
  }
  return id
}

function parseOptions(optionsJson) {
  try {
    const parsed = JSON.parse(optionsJson || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function serializeNameOption(student) {
  const pinyinData = nameToPinyin(student.name)
  return {
    id: String(student.id),
    name: student.name,
    pinyin: pinyinData.toned,
    pinyinParts: pinyinData.parts,
    homeClass: student.homeClass || '',
    photoUrl: student.photoUrl || '',
  }
}

function serializeQuestion(question, { reveal = false } = {}) {
  if (!question) return null
  const isAnswered = question.isCorrect !== null && question.isCorrect !== undefined
  const payload = {
    id: question.id,
    position: question.position,
    photoUrl: question.studentPhotoUrl,
    options: parseOptions(question.optionsJson),
    selectedStudentId: question.selectedStudentId == null ? null : String(question.selectedStudentId),
    isCorrect: question.isCorrect,
    answeredAt: question.answeredAt,
  }
  if (reveal || isAnswered) {
    payload.answer = {
      id: question.studentId == null ? null : String(question.studentId),
      name: question.studentName,
    }
  }
  return payload
}

function serializeParticipant(participant) {
  const answered = participant.correct + participant.wrong
  const accuracy = answered ? Math.round((participant.correct / answered) * 100) : 0
  return {
    id: participant.id,
    teacherId: participant.teacherId,
    teacherName: participant.teacherName || participant.teacher?.username || `Teacher ${participant.teacherId}`,
    classId: participant.classId,
    className: participant.className || participant.class?.name || '',
    status: participant.status,
    progress: participant.progress,
    total: participant.total,
    correct: participant.correct,
    wrong: participant.wrong,
    accuracy,
    durationMs: participant.durationMs,
    joinedAt: participant.joinedAt,
    finishedAt: participant.finishedAt,
  }
}

function serializeRoom(room, viewerTeacherId = null) {
  const participants = room.participants.map(serializeParticipant)
  const viewerParticipant = viewerTeacherId
    ? room.participants.find((participant) => participant.teacherId === viewerTeacherId)
    : null
  const viewerQuestions = viewerParticipant?.questions || []
  const currentQuestion = viewerQuestions.find(
    (question) => question.isCorrect === null || question.isCorrect === undefined
  )
  const canStart = room.status === MEMORY_PK_STATUS.waiting &&
    participants.length === 2 &&
    participants.every((participant) => Boolean(participant.classId))

  return {
    id: room.id,
    status: room.status,
    mode: room.mode,
    createdAt: room.createdAt,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
    createdById: room.createdById,
    creatorName: room.creator?.username || '',
    winnerParticipantId: room.winnerParticipantId,
    participants,
    viewerParticipantId: viewerParticipant?.id || null,
    isCreator: viewerTeacherId === room.createdById,
    canJoin: room.status === MEMORY_PK_STATUS.waiting &&
      participants.length < 2 &&
      !participants.some((participant) => participant.teacherId === viewerTeacherId),
    canStart,
    currentQuestion: viewerParticipant ? serializeQuestion(currentQuestion) : null,
    myQuestions: viewerParticipant
      ? viewerQuestions.map((question) => serializeQuestion(question, {
        reveal: room.status === MEMORY_PK_STATUS.finished,
      }))
      : [],
  }
}

async function loadRoom(roomId, db = prisma) {
  return db.memoryPkRoom.findUnique({
    where: { id: parseRoomId(roomId) },
    include: ROOM_INCLUDE,
  })
}

async function notifyMemoryPk(roomId) {
  broadcastToAllTeachers('memory-pk')
  if (!roomId) return
  const participants = await prisma.memoryPkParticipant.findMany({
    where: { roomId: parseRoomId(roomId) },
    select: { teacherId: true },
  })
  for (const participant of participants) {
    broadcastToTeacher(participant.teacherId, 'memory-pk')
  }
}

function shuffle(input) {
  const array = [...input]
  for (let index = array.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[array[index], array[swapIndex]] = [array[swapIndex], array[index]]
  }
  return array
}

function pickQuestionOptions(students, answer) {
  const distractors = shuffle(students.filter((student) => student.id !== answer.id)).slice(0, OPTION_COUNT - 1)
  return shuffle([answer, ...distractors]).map(serializeNameOption)
}

function buildQuestionRows(roomId, participantId, students) {
  return shuffle(students).slice(0, MEMORY_PK_QUESTION_LIMIT).map((answer, index) => ({
    roomId,
    participantId,
    position: index + 1,
    studentId: answer.id,
    studentName: answer.name,
    studentPhotoUrl: answer.photoUrl,
    optionsJson: JSON.stringify(pickQuestionOptions(students, answer)),
  }))
}

function determineWinner(participants) {
  const [first, second] = [...participants].sort((a, b) => {
    if (b.correct !== a.correct) return b.correct - a.correct
    return a.durationMs - b.durationMs
  })
  if (!first || !second) return first?.id || null
  if (first.correct === second.correct && first.durationMs === second.durationMs) return null
  return first.id
}

async function finishRoomIfNeeded(roomId) {
  const room = await loadRoom(roomId)
  if (!room || room.status !== MEMORY_PK_STATUS.active) return room
  if (!room.participants.every((participant) => participant.status === MEMORY_PK_PARTICIPANT_STATUS.finished)) {
    return room
  }
  const winnerParticipantId = determineWinner(room.participants)
  await prisma.memoryPkRoom.update({
    where: { id: room.id },
    data: {
      status: MEMORY_PK_STATUS.finished,
      endedAt: new Date(),
      winnerParticipantId,
    },
  })
  return loadRoom(room.id)
}

export async function listMemoryPkRooms(teacherId) {
  const rooms = await prisma.memoryPkRoom.findMany({
    where: {
      status: {
        in: [
          MEMORY_PK_STATUS.waiting,
          MEMORY_PK_STATUS.active,
          MEMORY_PK_STATUS.finished,
        ],
      },
    },
    orderBy: [{ createdAt: 'desc' }],
    take: 40,
    include: ROOM_INCLUDE,
  })
  return rooms.map((room) => serializeRoom(room, teacherId))
}

export async function createMemoryPkRoom(teacherId) {
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId }, select: TEACHER_SELECT })
  if (!teacher) throw serviceError('老师不存在', 404)

  const room = await prisma.memoryPkRoom.create({
    data: {
      createdById: teacherId,
      mode: MEMORY_PK_MODE,
      participants: {
        create: {
          teacherId,
          teacherName: teacher.username,
        },
      },
    },
    include: ROOM_INCLUDE,
  })

  await notifyMemoryPk(room.id)
  return serializeRoom(room, teacherId)
}

export async function joinMemoryPkRoom(roomId, teacherId) {
  const id = parseRoomId(roomId)
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId }, select: TEACHER_SELECT })
  if (!teacher) throw serviceError('老师不存在', 404)

  const room = await loadRoom(id)
  if (!room) throw serviceError('房间不存在', 404)
  const existing = room.participants.find((participant) => participant.teacherId === teacherId)
  if (existing) return serializeRoom(room, teacherId)
  if (room.status !== MEMORY_PK_STATUS.waiting) throw serviceError('房间已开始或已结束，不能加入', 409)
  if (room.participants.length >= 2) throw serviceError('房间已满', 409)

  await prisma.memoryPkParticipant.create({
    data: {
      roomId: id,
      teacherId,
      teacherName: teacher.username,
    },
  })

  await notifyMemoryPk(id)
  return serializeRoom(await loadRoom(id), teacherId)
}

export async function getMemoryPkRoom(roomId, teacherId) {
  const room = await loadRoom(roomId)
  if (!room) throw serviceError('房间不存在', 404)
  const participant = room.participants.find((entry) => entry.teacherId === teacherId)
  if (!participant) throw serviceError('请先加入房间', 403)
  return serializeRoom(room, teacherId)
}

export async function selectMemoryPkClass(roomId, teacherId, classId, isAdmin = false) {
  const id = parseRoomId(roomId)
  const selectedClassId = Number.parseInt(classId, 10)
  if (!Number.isInteger(selectedClassId) || selectedClassId <= 0) {
    throw serviceError('请选择有效班级')
  }

  const cls = await assertClassOwner(selectedClassId, teacherId, isAdmin)
  if (cls.deletedAt) throw serviceError('该班级已删除，不能用于 PK', 409)

  const room = await loadRoom(id)
  if (!room) throw serviceError('房间不存在', 404)
  if (room.status !== MEMORY_PK_STATUS.waiting) throw serviceError('比赛已经开始，不能更换班级', 409)
  const participant = room.participants.find((entry) => entry.teacherId === teacherId)
  if (!participant) throw serviceError('请先加入房间', 403)

  const playableCount = await prisma.student.count({
    where: {
      classId: selectedClassId,
      photoUrl: { not: '' },
    },
  })
  if (playableCount <= 0) throw serviceError('该班级没有可用于 PK 的学生照片', 400)

  await prisma.memoryPkParticipant.update({
    where: { id: participant.id },
    data: {
      classId: selectedClassId,
      className: cls.name,
      total: 0,
      progress: 0,
      correct: 0,
      wrong: 0,
      durationMs: 0,
      finishedAt: null,
      status: MEMORY_PK_PARTICIPANT_STATUS.joined,
    },
  })

  await notifyMemoryPk(id)
  return serializeRoom(await loadRoom(id), teacherId)
}

export async function startMemoryPkRoom(roomId, teacherId) {
  const id = parseRoomId(roomId)

  await prisma.$transaction(async (tx) => {
    const room = await tx.memoryPkRoom.findUnique({
      where: { id },
      include: {
        participants: {
          orderBy: [{ joinedAt: 'asc' }],
          include: { teacher: { select: TEACHER_SELECT }, class: { select: CLASS_SELECT } },
        },
      },
    })
    if (!room) throw serviceError('房间不存在', 404)
    if (!room.participants.some((participant) => participant.teacherId === teacherId)) {
      throw serviceError('请先加入房间', 403)
    }
    if (room.status !== MEMORY_PK_STATUS.waiting) throw serviceError('比赛已经开始或结束', 409)
    if (room.participants.length !== 2) throw serviceError('需要两名老师都加入后才能开始', 400)
    if (!room.participants.every((participant) => participant.classId)) {
      throw serviceError('双方都选择班级后才能开始', 400)
    }

    await tx.memoryPkQuestion.deleteMany({ where: { roomId: id } })

    for (const participant of room.participants) {
      const students = await tx.student.findMany({
        where: {
          classId: participant.classId,
          photoUrl: { not: '' },
        },
        orderBy: [{ homeClass: 'asc' }, { name: 'asc' }],
      })
      if (!students.length) {
        throw serviceError(`「${participant.className || participant.class?.name || '所选班级'}」没有可用于 PK 的学生照片`, 400)
      }

      const questionRows = buildQuestionRows(id, participant.id, students)
      await tx.memoryPkQuestion.createMany({ data: questionRows })
      await tx.memoryPkParticipant.update({
        where: { id: participant.id },
        data: {
          status: MEMORY_PK_PARTICIPANT_STATUS.playing,
          progress: 0,
          total: questionRows.length,
          correct: 0,
          wrong: 0,
          durationMs: 0,
          finishedAt: null,
        },
      })
    }

    await tx.memoryPkRoom.update({
      where: { id },
      data: {
        status: MEMORY_PK_STATUS.active,
        startedAt: new Date(),
        endedAt: null,
        winnerParticipantId: null,
      },
    })
  })

  await notifyMemoryPk(id)
  return serializeRoom(await loadRoom(id), teacherId)
}

export async function answerMemoryPkQuestion(roomId, teacherId, questionId, selectedStudentId) {
  const id = parseRoomId(roomId)
  const selectedId = parseStudentId(selectedStudentId)

  const room = await loadRoom(id)
  if (!room) throw serviceError('房间不存在', 404)
  if (room.status !== MEMORY_PK_STATUS.active) throw serviceError('比赛尚未开始或已结束', 409)
  const participant = room.participants.find((entry) => entry.teacherId === teacherId)
  if (!participant) throw serviceError('请先加入房间', 403)
  if (participant.status === MEMORY_PK_PARTICIPANT_STATUS.finished) {
    throw serviceError('你已经完成本场比赛', 409)
  }

  const question = participant.questions.find((entry) => entry.id === Number.parseInt(questionId, 10))
  if (!question) throw serviceError('题目不存在', 404)
  if (question.isCorrect !== null && question.isCorrect !== undefined) {
    throw serviceError('该题已经作答', 409)
  }

  const firstOpenQuestion = participant.questions.find(
    (entry) => entry.isCorrect === null || entry.isCorrect === undefined
  )
  if (firstOpenQuestion?.id !== question.id) throw serviceError('请按顺序作答', 409)

  const optionIds = new Set(parseOptions(question.optionsJson).map((option) => Number.parseInt(option.id, 10)))
  if (!optionIds.has(selectedId)) throw serviceError('请选择当前题目中的答案')

  const isCorrect = selectedId === question.studentId
  const now = new Date()
  const progress = participant.progress + 1
  const correct = participant.correct + (isCorrect ? 1 : 0)
  const wrong = participant.wrong + (isCorrect ? 0 : 1)
  const isDone = progress >= participant.total
  const durationMs = room.startedAt ? Math.max(0, now.getTime() - room.startedAt.getTime()) : participant.durationMs

  await prisma.$transaction([
    prisma.memoryPkQuestion.update({
      where: { id: question.id },
      data: {
        selectedStudentId: selectedId,
        isCorrect,
        answeredAt: now,
      },
    }),
    prisma.memoryPkParticipant.update({
      where: { id: participant.id },
      data: {
        progress,
        correct,
        wrong,
        durationMs,
        status: isDone ? MEMORY_PK_PARTICIPANT_STATUS.finished : MEMORY_PK_PARTICIPANT_STATUS.playing,
        finishedAt: isDone ? now : null,
      },
    }),
  ])

  await finishRoomIfNeeded(id)
  await notifyMemoryPk(id)
  return serializeRoom(await loadRoom(id), teacherId)
}

export async function leaveMemoryPkRoom(roomId, teacherId) {
  const id = parseRoomId(roomId)
  const room = await loadRoom(id)
  if (!room) throw serviceError('房间不存在', 404)
  const participant = room.participants.find((entry) => entry.teacherId === teacherId)
  if (!participant) throw serviceError('请先加入房间', 403)
  if ([MEMORY_PK_STATUS.finished, MEMORY_PK_STATUS.abandoned].includes(room.status)) {
    return serializeRoom(room, teacherId)
  }

  const now = new Date()
  const winner = room.participants.find((entry) => entry.id !== participant.id)
  await prisma.$transaction([
    prisma.memoryPkParticipant.update({
      where: { id: participant.id },
      data: {
        status: MEMORY_PK_PARTICIPANT_STATUS.left,
        finishedAt: now,
      },
    }),
    prisma.memoryPkRoom.update({
      where: { id },
      data: {
        status: MEMORY_PK_STATUS.abandoned,
        endedAt: now,
        winnerParticipantId: winner?.id || null,
      },
    }),
  ])

  await notifyMemoryPk(id)
  return serializeRoom(await loadRoom(id), teacherId)
}
