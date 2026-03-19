import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { STUDENT_SEAT_LAYOUT, TEACHER_SEAT_LAYOUT } from './seat.js'

describe('TEACHER_SEAT_LAYOUT', () => {
  it('matches the expected top row for teacher view', () => {
    assert.deepEqual(TEACHER_SEAT_LAYOUT[0], [60, 59, 44, 43, 30, 29, 16, 15])
  })

  it('matches the expected bottom row for teacher view', () => {
    assert.deepEqual(TEACHER_SEAT_LAYOUT[TEACHER_SEAT_LAYOUT.length - 1], [46, 45, null, null, null, null, 2, 1])
  })
})

describe('STUDENT_SEAT_LAYOUT', () => {
  it('matches the expected top row for student view', () => {
    assert.deepEqual(STUDENT_SEAT_LAYOUT[0], [1, 2, null, null, null, null, 45, 46])
  })

  it('matches the expected bottom row for student view', () => {
    assert.deepEqual(STUDENT_SEAT_LAYOUT[STUDENT_SEAT_LAYOUT.length - 1], [15, 16, 29, 30, 43, 44, 59, 60])
  })
})
