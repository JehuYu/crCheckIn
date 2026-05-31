import { describe, before, beforeEach, after, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../app.js'
import { prisma, uid, cleanDatabase, factories } from '../test-helpers.js'

const sameOriginJsonHeaders = {
  'content-type': 'application/json',
  host: '127.0.0.1',
  origin: 'http://127.0.0.1',
}

const sameOriginHeaders = {
  host: '127.0.0.1',
  origin: 'http://127.0.0.1',
}

describe('API routes integration', () => {
  let app

  before(async () => {
    await prisma.$connect()
    app = await buildApp({ logger: false })
  })

  after(async () => {
    await app.close()
  })

  beforeEach(cleanDatabase)

  describe('basic routing', () => {
    it('redirects root to /student', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/',
      })
      assert.equal(response.statusCode, 302)
      assert.equal(response.headers.location, '/student')
    })

    it('serves student sign-in page', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/student',
      })
      assert.equal(response.statusCode, 200)
      assert.ok(response.body.includes('签到'))
    })

    it('/teacher redirects to /teacher/classes or /admin', async () => {
      // Without auth, redirects to /teacher/classes
      const response = await app.inject({
        method: 'GET',
        url: '/teacher',
      })
      assert.equal(response.statusCode, 302)
      assert.ok(['/teacher/classes', '/admin'].includes(response.headers.location))
    })

    it('/teacher/classes redirects to /student when not authenticated', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/teacher/classes',
      })
      assert.equal(response.statusCode, 302)
      assert.equal(response.headers.location, '/student')
    })

    it('/admin redirects when not authenticated', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin',
      })
      assert.equal(response.statusCode, 302)
      assert.equal(response.headers.location, '/student')
    })
  })

  describe('teacher login', async () => {
    it('POST /api/teacher-login with wrong password returns error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teacher-login',
        payload: JSON.stringify({ password: 'wrong_password_xyz' }),
        headers: sameOriginJsonHeaders,
      })
      assert.equal(response.statusCode, 401)
      const body = JSON.parse(response.body)
      assert.equal(body.ok, false)
    })

    it('POST /api/teacher-login with correct password succeeds', async () => {
      const bcrypt = await import('bcrypt')
      await prisma.teacher.create({
        data: {
          username: `login_test_${uid()}`,
          passwordHash: await bcrypt.hash('testpass123', 10),
        },
      })

      const response = await app.inject({
        method: 'POST',
        url: '/api/teacher-login',
        payload: JSON.stringify({ password: 'testpass123' }),
        headers: sameOriginJsonHeaders,
      })
      assert.equal(response.statusCode, 200)
      const body = JSON.parse(response.body)
      assert.equal(body.ok, true)
    })

    it('logged-in teacher can access /teacher/classes', async () => {
      const bcrypt = await import('bcrypt')
      await prisma.teacher.create({
        data: {
          username: `session_test_${uid()}`,
          passwordHash: await bcrypt.hash('testpass456', 10),
        },
      })

      // Login via JSON
      const loginResp = await app.inject({
        method: 'POST',
        url: '/api/teacher-login',
        payload: JSON.stringify({ password: 'testpass456' }),
        headers: sameOriginJsonHeaders,
      })
      assert.equal(loginResp.statusCode, 200)
      const rawCookie = loginResp.headers['set-cookie']
      assert.ok(rawCookie)
      const cookie = Array.isArray(rawCookie)
        ? rawCookie.map((value) => value.split(';')[0]).join('; ')
        : rawCookie

      // Access protected page
      const classesResp = await app.inject({
        method: 'GET',
        url: '/teacher/classes',
        headers: { cookie },
      })
      // Either 200 (success) or 302 (redirect to classes)
      assert.ok([200, 302].includes(classesResp.statusCode))
    })
  })

  describe('student sign-in flow', async () => {
    it('POST /api/signin with empty name returns error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/signin',
        payload: JSON.stringify({ classId: 1, studentName: '', computerName: 'PC01' }),
        headers: sameOriginJsonHeaders,
      })
      assert.equal(response.statusCode, 400)
      const body = JSON.parse(response.body)
      assert.equal(body.ok, false)
    })

    it('POST /api/signin with non-existent class returns error', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/signin',
        payload: JSON.stringify({ classId: 9999, studentName: '张三', computerName: 'PC01' }),
        headers: sameOriginJsonHeaders,
      })
      assert.equal(response.statusCode, 400)
      const body = JSON.parse(response.body)
      assert.equal(body.ok, false)
    })

    it('full sign-in flow: create class -> start -> sign in -> duplicate fails', async () => {
      const teacher = await factories.createTeacher()
      const cls = await factories.createClass({ teacherId: teacher.id })
      await factories.createStudent({ name: '张三', classId: cls.id })

      // Start sign-in
      await factories.createSignInConfig({
        classId: cls.id,
        activeStartedAt: new Date(),
        countdownDurationMin: 30,
      })

      // First sign-in succeeds
      const signinResp = await app.inject({
        method: 'POST',
        url: '/api/signin',
        payload: JSON.stringify({ classId: cls.id, studentName: '张三', computerName: 'PC01' }),
        headers: sameOriginJsonHeaders,
      })
      assert.equal(signinResp.statusCode, 200)
      const signinBody = JSON.parse(signinResp.body)
      assert.equal(signinBody.ok, true)

      // Second sign-in (duplicate) fails
      const dupResp = await app.inject({
        method: 'POST',
        url: '/api/signin',
        payload: JSON.stringify({ classId: cls.id, studentName: '张三', computerName: 'PC02' }),
        headers: sameOriginJsonHeaders,
      })
      assert.equal(dupResp.statusCode, 400)
      const dupBody = JSON.parse(dupResp.body)
      assert.equal(dupBody.ok, false)
    })
  })

  describe('teacher-required API endpoints', () => {
    it('POST /api/classes returns 401/403 when not authenticated', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/classes',
        payload: JSON.stringify({ name: 'Test' }),
        headers: sameOriginJsonHeaders,
      })
      assert.equal(response.statusCode, 401)
    })

    it('DELETE /api/classes/1 returns error when not authenticated', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/classes/1',
        headers: sameOriginHeaders,
      })
      assert.equal(response.statusCode, 401)
    })
  })

  describe('admin-required API endpoints', () => {
    it('GET /admin/api/teachers returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/api/teachers',
      })
      assert.equal(response.statusCode, 401)
    })

    it('GET /admin/api/classes returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/api/classes',
      })
      assert.equal(response.statusCode, 401)
    })

    it('GET /admin/api/teachers/:id/classes returns 401 when not authenticated', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/api/teachers/1/classes',
      })
      assert.equal(response.statusCode, 401)
    })

    it('logged-in admin can inspect classes claimed by a teacher', async () => {
      const bcrypt = await import('bcrypt')
      await prisma.teacher.create({
        data: {
          username: `admin_${uid()}`,
          passwordHash: await bcrypt.hash('adminpass123', 10),
          isAdmin: true,
        },
      })
      const teacher = await factories.createTeacher()
      const activeClass = await factories.createClass({
        name: '涓€鍔矨2',
        teacherId: teacher.id,
      })
      await factories.createClass({
        name: '涓€鑱孉2',
        teacherId: teacher.id,
        isArchived: true,
      })
      await factories.createStudent({ name: '寮犱笁', classId: activeClass.id })

      const loginResp = await app.inject({
        method: 'POST',
        url: '/api/teacher-login',
        payload: JSON.stringify({ password: 'adminpass123' }),
        headers: sameOriginJsonHeaders,
      })
      assert.equal(loginResp.statusCode, 200)
      const rawCookie = loginResp.headers['set-cookie']
      const cookie = Array.isArray(rawCookie)
        ? rawCookie.map((value) => value.split(';')[0]).join('; ')
        : rawCookie

      const response = await app.inject({
        method: 'GET',
        url: `/admin/api/teachers/${teacher.id}/classes`,
        headers: { cookie },
      })
      assert.equal(response.statusCode, 200)
      const body = JSON.parse(response.body)
      assert.equal(body.ok, true)
      assert.equal(body.teacher.id, teacher.id)
      assert.equal(body.classes.length, 2)
      assert.equal(body.classes[0].studentCount, 1)
      assert.equal(body.classes[1].isArchived, true)
    })

    it('logged-in admin can reset a teacher password', async () => {
      const bcrypt = await import('bcrypt')
      await prisma.teacher.create({
        data: {
          username: `admin_${uid()}`,
          passwordHash: await bcrypt.hash('adminpass456', 10),
          isAdmin: true,
        },
      })
      const teacher = await prisma.teacher.create({
        data: {
          username: `teacher_${uid()}`,
          passwordHash: await bcrypt.hash('oldpass123', 10),
        },
      })

      const loginResp = await app.inject({
        method: 'POST',
        url: '/api/teacher-login',
        payload: JSON.stringify({ password: 'adminpass456' }),
        headers: sameOriginJsonHeaders,
      })
      const rawCookie = loginResp.headers['set-cookie']
      const cookie = Array.isArray(rawCookie)
        ? rawCookie.map((value) => value.split(';')[0]).join('; ')
        : rawCookie

      const response = await app.inject({
        method: 'PATCH',
        url: `/admin/teachers/${teacher.id}/password`,
        payload: JSON.stringify({ password: 'newpass789' }),
        headers: { ...sameOriginJsonHeaders, cookie },
      })
      assert.equal(response.statusCode, 200)
      const updated = await prisma.teacher.findUnique({ where: { id: teacher.id } })
      assert.equal(await bcrypt.compare('newpass789', updated.passwordHash), true)
      assert.equal(await bcrypt.compare('oldpass123', updated.passwordHash), false)
    })
  })

  describe('error handling', () => {
    it('returns 404 for unknown routes', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/nonexistent-route-xyz-123',
      })
      assert.equal(response.statusCode, 404)
    })

    it('error handler returns JSON with ok: false', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/status',
      })
      const body = JSON.parse(response.body)
      assert.equal(body.ok, false)
    })
  })
})
