# 项目导览（crCheckIn）

本文档用于帮助新同学快速理解项目的结构与主要业务流程。

## 1. 项目定位

crCheckIn 是一个机房签到系统，面向三类角色：

- 学生：按姓名检索并签到。
- 教师：管理班级、查看/导出签到与座位数据、维护学生。
- 管理员：在教师能力之上管理教师账号。

## 2. 技术栈与运行方式

- 运行时：Node.js（ESM）
- Web 框架：Fastify
- 模板引擎：Nunjucks
- 数据层：Prisma + SQLite
- 进程托管：PM2

应用启动时会按顺序：

1. 自动部署数据库结构（可通过 `AUTO_DB_DEPLOY` 控制）
2. 创建 Fastify 应用并注册插件/路由
3. 执行 seed（确保默认 admin 账号存在）
4. 监听 `HOST:PORT`

## 3. 目录分层

- `src/routes/`：HTTP 路由与接口入口（页面路由 + API 路由）
- `src/services/`：业务逻辑（签到、班级、学生、座位、Excel）
- `src/plugins/`：Fastify 插件注册（静态资源、session、view、db）
- `src/utils/`：工具函数（鉴权、时间解析、IP 提取、数据库部署）
- `prisma/`：数据模型与种子脚本
- `views/`：教师/学生/管理员页面模板

整体采用「路由薄、服务厚」的组织方式：路由只做参数解析与响应，核心规则尽量沉到 service。

## 4. 核心业务流

### 4.1 学生签到

1. 学生访问 `/student`。
2. 前端调用 `/api/students/match` 进行姓名检索。
3. 提交到 `/api/signin` 完成签到。
4. 服务端会结合机器名/IP、时间窗、重复签到约束进行校验后写入记录。

### 4.2 教师管理班级

1. 教师通过学生端口令入口调用 `/api/teacher-login`。
2. 登录后进入 `/teacher/classes` 查看名下班级。
3. 在班级页面进行：
   - 签到窗口设置 `/api/window`
   - 当前记录清空 `/api/clear-roster`
   - 批次归档与重置 `/api/reset`
   - 学生管理（增删改转）

### 4.3 历史批次与导出

- 当前签到可导出 `/api/export`
- 历史批次列表 `/api/sessions`
- 历史详情 `/api/sessions/:sessionId`
- 历史批次导出 `/api/sessions/:sessionId/export`
- 座位表导出 `/api/export-seats`
- 出勤统计导出 `/api/stats/export`

## 5. 数据模型速览

关键实体：

- `Teacher`：教师账号（含 `isAdmin`）
- `Class`：教学班（归属教师）
- `Student`：学生（归属班级）
- `SignInRecord`：当前批次签到记录（可撤销）
- `SignInSession`：历史批次
- `ArchivedRecord`：归档后的历史签到记录
- `SignInConfig`：班级签到时间窗口

其中：

- `Class` 在 `(teacherId, name)` 上唯一，避免同教师重名班级。
- `SignInRecord` 在 `(classId, studentName)` 上唯一，限制同批次重复签到。

## 6. 安全与运维注意点

- 默认会创建 `admin / abc123`，上线后必须立即修改。
- `SECRET_KEY` 必须在生产环境替换。
- 当前 session cookie 配置为 `secure: false`，若部署 HTTPS 应改为 `true`。
- 若反向代理转发，建议确认 `x-forwarded-for` 来源可信。

## 7. 建议的阅读顺序

1. `README.md`（快速了解功能与部署）
2. `prisma/schema.prisma`（先看数据结构）
3. `src/routes/api.js`（看能力边界）
4. `src/services/attendance.js`、`src/services/roster.js`（核心业务）
5. `views/teacher/*.html`（理解交互页面）

