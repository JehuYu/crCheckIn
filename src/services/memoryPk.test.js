import { describe, before, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { prisma, cleanDatabase, factories, uid } from '../test-helpers.js'
import {
  answerMemoryPkQuestion,
  createMemoryPkRoom,
  getMemoryPkRoom,
  joinMemoryPkRoom,
  listMemoryPkRooms,
  selectMemoryPkClass,
  startMemoryPkRoom,
} from './memoryPk.js'

describe('memory PK service', () => {
  before(async () => {
    await prisma.$connect()
  })

  beforeEach(cleanDatabase)

  async function createClassWithPhotos(teacherId, count, name = `PK_${uid()}`) {
    const cls = await factories.createClass({ teacherId, name })
    for (let index = 1; index <= count; index += 1) {
      await factories.createStudent({
        classId: cls.id,
        name: `${name}_student_${index}`,
        photoUrl: `/uploads/photos/${name}_${index}.jpg`,
      })
    }
    return cls
  }

  async function answerAllQuestions(roomId, teacherId, { correct }) {
    let room = await getMemoryPkRoom(roomId, teacherId)
    while (room.currentQuestion) {
      const question = await prisma.memoryPkQuestion.findUnique({
        where: { id: room.currentQuestion.id },
      })
      const selected = correct
        ? String(question.studentId)
        : room.currentQuestion.options.find((option) => Number(option.id) !== question.studentId)?.id ||
          String(question.studentId)
      room = await answerMemoryPkQuestion(roomId, teacherId, room.currentQuestion.id, selected)
    }
    return room
  }

  it('creates a lobby room and allows a second teacher to join', async () => {
    const teacher1 = await factories.createTeacher()
    const teacher2 = await factories.createTeacher()

    const created = await createMemoryPkRoom(teacher1.id)
    assert.equal(created.status, 'waiting')
    assert.equal(created.participants.length, 1)
    assert.equal(created.participants[0].teacherId, teacher1.id)

    const lobbyForTeacher2 = await listMemoryPkRooms(teacher2.id)
    const lobbyRoom = lobbyForTeacher2.find((room) => room.id === created.id)
    assert.equal(lobbyRoom.canJoin, true)

    const joined = await joinMemoryPkRoom(created.id, teacher2.id)
    assert.equal(joined.participants.length, 2)
    assert.equal(joined.canJoin, false)
  })

  it('selects classes and starts with at most thirty photo questions per teacher', async () => {
    const teacher1 = await factories.createTeacher()
    const teacher2 = await factories.createTeacher()
    const class1 = await createClassWithPhotos(teacher1.id, 35, `A_${uid()}`)
    const class2 = await createClassWithPhotos(teacher2.id, 12, `B_${uid()}`)

    const room = await createMemoryPkRoom(teacher1.id)
    await joinMemoryPkRoom(room.id, teacher2.id)
    await selectMemoryPkClass(room.id, teacher1.id, class1.id)
    const ready = await selectMemoryPkClass(room.id, teacher2.id, class2.id)
    assert.equal(ready.canStart, true)

    const activeForTeacher1 = await startMemoryPkRoom(room.id, teacher1.id)
    assert.equal(activeForTeacher1.status, 'active')
    assert.equal(activeForTeacher1.currentQuestion.position, 1)

    const participant1 = activeForTeacher1.participants.find((participant) => participant.teacherId === teacher1.id)
    const participant2 = activeForTeacher1.participants.find((participant) => participant.teacherId === teacher2.id)
    assert.equal(participant1.total, 30)
    assert.equal(participant2.total, 12)

    const activeForTeacher2 = await getMemoryPkRoom(room.id, teacher2.id)
    assert.equal(activeForTeacher2.currentQuestion.position, 1)
    assert.ok(activeForTeacher2.currentQuestion.options.length >= 1)
    assert.ok(activeForTeacher2.currentQuestion.options.length <= 4)
  })

  it('records answers and computes the winner when both teachers finish', async () => {
    const teacher1 = await factories.createTeacher()
    const teacher2 = await factories.createTeacher()
    const class1 = await createClassWithPhotos(teacher1.id, 3, `Win_${uid()}`)
    const class2 = await createClassWithPhotos(teacher2.id, 3, `Lose_${uid()}`)

    const room = await createMemoryPkRoom(teacher1.id)
    await joinMemoryPkRoom(room.id, teacher2.id)
    await selectMemoryPkClass(room.id, teacher1.id, class1.id)
    await selectMemoryPkClass(room.id, teacher2.id, class2.id)
    await startMemoryPkRoom(room.id, teacher1.id)

    await answerAllQuestions(room.id, teacher1.id, { correct: true })
    const finished = await answerAllQuestions(room.id, teacher2.id, { correct: false })

    assert.equal(finished.status, 'finished')
    const winner = finished.participants.find((participant) => participant.id === finished.winnerParticipantId)
    const loser = finished.participants.find((participant) => participant.teacherId === teacher2.id)
    assert.equal(winner.teacherId, teacher1.id)
    assert.equal(winner.correct, 3)
    assert.ok(loser.wrong >= 1)
  })
})
