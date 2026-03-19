import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { STUDENT_SEAT_LAYOUT, TEACHER_SEAT_LAYOUT, getSeatGridsFromArchivedRecords } from './seat.js'

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

describe('getSeatGridsFromArchivedRecords', () => {
  it('maps archived seat records into both student and teacher grids', () => {
    const { studentGrid, teacherGrid } = getSeatGridsFromArchivedRecords([
      { studentName: '张三', homeClass: '高一1班', computerName: '192.168.0.1' },
      { studentName: '李四', homeClass: '高一2班', computerName: '192.168.0.60' },
    ])

    assert.equal(studentGrid[0][0].students[0].name, '张三')
    assert.equal(studentGrid[7][7].students[0].name, '李四')
    assert.equal(teacherGrid[0][0].students[0].name, '李四')
    assert.equal(teacherGrid[7][7].students[0].name, '张三')
  })
})
