# Lab Attendance

> 面向机房 / 实验室场景的本地签到系统 — 学生扫码签到、教师实时看板、历史批次归档与数据分析。

[![Release](https://img.shields.io/github/v/release/JehuYu/crCheckIn?label=release&color=cc785c)](https://github.com/JehuYu/crCheckIn/releases)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)

## 预览

| 学生签到 | 教师看板 | 座位表 |
|---------|---------|--------|
| 学生端搜索签到 | 实时签到名单 | 可拖拽座位 |
| 拼音首字母搜索 | 一键撤销 | 历史对比 |

## 功能特性

### 签到核心
- **智能搜索** — 支持中文姓名、拼音首字母、全拼搜索（输入 `csy` 匹配 "陈思源"）
- **签到倒计时** — 30 分钟倒计时模式，到点自动归档
- **IP 限制** — 同一 IP 每节课程只能签到一次，归档后自动释放
- **自动去重** — 学生签到后本地去重，防止重复签到
- **回车快捷操作** — 匹配单条自动签到，已选学生回车直接签到

### 班级管理
- **教学班 / 行政班** — 支持多教学班与行政班级映射
- **Excel 批量导入** — 一键导入学生名单，自动创建不存在的班级
- **班级归档** — 按日期 + 上下午自动打标签归档
- **历史批次** — 分页浏览历史签到批次，支持查看、导出、删除

### 座位表
- **实时座位可视化** — 教师视角拖拽排座，学生视角查看自己的座位
- **历史对比** — 上节课座位对比，黄色标记变动、蓝色标记新增
- **签到高亮** — 新签到实时高亮显示

### 标签系统
- **预设标签** — 管理员统一管理预设标签（如 "缺勤"、"迟到"），级联更新学生标签
- **自定义标签** — 教师可自定义标签颜色，支持 SSE 实时推送
- **签到自动清除** — 签到成功后自动清除自定义标签，保留预设标签

### 数据分析
- **出勤统计** — 跨批次出勤率排名，支持 Excel 导出
- **数据看板** — 可视化出勤率图表，识别高频缺勤学生
- **跨班级分析** — 管理员可查看全局出勤数据

### 信息收集
- **自定义字段** — 支持文本和附件类型字段
- **学生提交** — 学生端在线填写，教师端查看提交记录
- **数据导出** — 一键导出收集到的信息

### 安全与管理
- **双角色体系** — 管理员（全局管理）+ 教师（班级管理）
- **数据备份 / 恢复** — 支持 PostgreSQL 备份，并提醒同步备份上传目录
- **审计日志** — 管理员操作全程记录
- **多端防护** — CSRF、XSS、Excel 注入防护，时序攻击防护，速率限制

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Node.js 18+ / ES Modules |
| Web 框架 | [Fastify](https://fastify.dev/) v4 |
| 数据库 | [Prisma](https://www.prisma.io/) v5 + PostgreSQL |
| 模板引擎 | [Nunjucks](https://mozilla.github.io/nunjucks/) |
| 样式 | [Tailwind CSS](https://tailwindcss.com/) v3 |
| 进程管理 | [PM2](https://pm2.keymetrics.io/) |
| Excel 处理 | [ExcelJS](https://github.com/exceljs/exceljs) |
| 拼音支持 | [pinyin-pro](https://github.com/niuhuan/pinyin-pro) |

## 快速开始

### 前置要求

- Node.js >= 18
- npm >= 9
- PostgreSQL >= 14
- 可选：Python 3.10+（小题成绩分析功能需要）

### 安装

```bash
git clone https://github.com/JehuYu/crCheckIn.git
cd crCheckIn
npm install
```

### 配置

复制环境变量模板：

```bash
cp .env.example .env
```

在 Windows PowerShell 中可以使用：

```powershell
Copy-Item .env.example .env
```

然后编辑 `.env`，至少填写 `SECRET_KEY` 和 `DATABASE_URL`：

```env
SECRET_KEY="please-change-this-secret-key-at-least-32-chars"
DATABASE_URL="postgresql://crcheckin_user:CHANGE_ME@127.0.0.1:5432/crcheckin?schema=public"
PORT=5000
HOST=0.0.0.0
AUTO_DB_DEPLOY=true
AUTO_BACKUP_ENABLED=true
AUTO_BACKUP_KEEP_DAYS=7
AUTO_BACKUP_HOUR=2
AUTO_BACKUP_MINUTE=0
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SECRET_KEY` | 无 | Session 密钥，必须配置，建议 32 位以上随机字符串 |
| `DATABASE_URL` | 无 | PostgreSQL 连接地址 |
| `PORT` | `5000` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `AUTO_DB_DEPLOY` | `true` | 启动时自动同步 Prisma 数据库结构 |
| `ALLOW_TEST_DATABASE_RUNTIME` | `false` | 仅临时本地调试用；默认禁止服务连接 `*_test` 测试库 |
| `AUTO_BACKUP_ENABLED` | `true` | 启动后开启每日自动 JSON 数据备份 |
| `AUTO_BACKUP_KEEP_DAYS` | `7` | 自动备份保留份数，默认保留最近 7 天 |
| `AUTO_BACKUP_HOUR` | `2` | 每日自动备份小时，24 小时制 |
| `AUTO_BACKUP_MINUTE` | `0` | 每日自动备份分钟 |
| `PG_DUMP_PATH` | 自动查找 | 可选，Windows 下可指定 `pg_dump.exe` 路径用于备份 |
| `EXAM_ANALYSIS_PYTHON` | 系统 Python | 可选，小题成绩分析使用的 Python 路径 |

### 运行

```bash
# 同步数据库结构
npm run db:deploy

# 开发模式（文件热重载）
npm run dev

# 直接启动
npm run start:direct

# PM2 后台运行（推荐生产环境）
npm start

# 只读体检：检查环境、数据库、Prisma、备份和 /health
npm run doctor
```

如果 `AUTO_DB_DEPLOY=true`，服务启动时也会自动同步数据库结构。启动前会检查数据库名：日常/生产服务默认不能连接 `*_test` 测试库，测试环境也不能连接正式库。首次启动会创建默认管理员账号，随机密码会打印在启动日志中。

### 默认账号

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | `admin` | 首次启动时随机生成，查看服务日志获取 |

> **重要：** 首次登录后请立即修改管理员密码，并妥善保存新密码。

## 路由一览

| 路径 | 角色 | 说明 |
|------|------|------|
| `/student` | 学生 | 签到入口（支持教师口令登录） |
| `/teacher/classes` | 教师 | 班级列表 |
| `/teacher/classes/:id` | 教师 | 班级签到看板 |
| `/teacher/classes/:id/seats` | 教师 | 座位表管理 |
| `/teacher/classes/:id/students` | 教师 | 学生名单管理 |
| `/teacher/memory` | 教师 | 学生照片记忆卡 |
| `/teacher/memory/pk` | 教师 | 照片记忆在线 PK 大厅 |
| `/teacher/classes/:id/info` | 教师 | 信息收集 |
| `/teacher/classes/:id/analytics` | 教师 | 出勤统计 |
| `/teacher/exam-analysis` | 教师 | 小题成绩处理 |
| `/teacher/sessions/:id/seats` | 教师 | 历史批次座位表 |
| `/admin` | 管理员 | 教师账号管理 |
| `/admin/pool` | 管理员 | 班级池和照片管理 |
| `/admin/dashboard` | 管理员 | 全局数据看板 |
| `/admin/analytics` | 管理员 | 跨班级分析 |
| `/admin/audit` | 管理员 | 审计日志 |

## 项目结构

```
crCheckIn/
├── prisma/
│   ├── schema.prisma          # 数据库模型定义
│   ├── deploy.js              # 数据库部署脚本
│   └── seed.js                # 初始数据填充
├── public/
│   ├── tailwind.min.css       # 编译后的样式
│   ├── admin.css              # 管理端公共样式
│   └── design-system.css      # 设计系统样式
├── src/
│   ├── app.js                 # Fastify 应用构建
│   ├── config.js              # 环境变量加载
│   ├── routes/                # 路由层
│   │   ├── index.js           # 路由注册入口
│   │   ├── api.js             # API 接口
│   │   ├── admin.js           # 管理员页面
│   │   ├── teacher.js         # 教师页面
│   │   └── student.js         # 学生页面
│   ├── services/              # 业务逻辑层
│   │   ├── auth.js            # 认证逻辑
│   │   ├── class.js           # 班级管理
│   │   ├── student.js         # 学生管理
│   │   ├── attendance.js      # 签到逻辑
│   │   ├── roster.js          # 名单管理
│   │   ├── seat.js            # 座位表
│   │   ├── sse.js             # 实时推送
│   │   ├── tag.js             # 标签管理
│   │   ├── infoCollection.js  # 信息收集
│   │   └── admin.js           # 管理员操作
│   ├── plugins/               # Fastify 插件
│   │   ├── db.js              # Prisma 数据库连接
│   │   ├── session.js         # Session 管理
│   │   └── view.js            # Nunjucks 模板引擎
│   └── utils/                 # 工具函数
│       ├── auth.js            # 认证中间件
│       ├── time.js            # 时间格式化
│       ├── pinyin.js          # 拼音工具
│       └── ip.js              # IP 处理
├── views/                     # Nunjucks 页面模板
│   ├── student/               # 学生端
│   ├── teacher/               # 教师端
│   └── admin/                 # 管理端
├── uploads/                   # 文件上传目录
├── ecosystem.config.cjs       # PM2 配置
├── server.js                  # 入口文件
└── tailwind.input.css         # Tailwind 源码
```

## 数据库模型

```
Teacher ──┬── Class ──┬── Student ── StudentTag
          │           ├── SignInConfig
          │           ├── SignInRecord
          │           ├── SignInSession ── ArchivedRecord
          │           └── InfoCollection ── InfoField ── InfoResponse
          └── AuditLog

PresetTag (全局预设标签)
```

## Excel 导入格式

导入学生名单时，Excel 文件需包含以下列：

| 列 | 内容 | 示例 |
|----|------|------|
| A | 教学班名 | 计算机科学1班 |
| B | 行政班级 | 计算机学院2024级1班 |
| C | 学生姓名 | 张三 |

系统会自动创建不存在的教学班。

## PM2 管理

```bash
npm run pm2:status    # 查看进程状态
npm run pm2:logs      # 查看实时日志
npm run pm2:restart   # 重启服务
npm run pm2:stop      # 停止服务
```

## 生产部署

下面以 PostgreSQL + PM2 为推荐方式。当前项目默认服务端口为 `5000`。

### 1. 准备 PostgreSQL

先创建数据库和专用账号。账号名和密码可自行调整，但要和 `.env` 中的 `DATABASE_URL` 保持一致。

```sql
CREATE DATABASE crcheckin;
CREATE USER crcheckin_user WITH PASSWORD 'CHANGE_ME';
GRANT ALL PRIVILEGES ON DATABASE crcheckin TO crcheckin_user;
```

如果 PostgreSQL 15+ 出现 schema 权限不足，可进入 `crcheckin` 数据库后补充：

```sql
GRANT ALL ON SCHEMA public TO crcheckin_user;
ALTER SCHEMA public OWNER TO crcheckin_user;
```

### 2. 部署代码

```bash
git clone https://github.com/JehuYu/crCheckIn.git
cd crCheckIn
npm install
cp .env.example .env
```

Windows PowerShell：

```powershell
git clone https://github.com/JehuYu/crCheckIn.git
cd crCheckIn
npm install
Copy-Item .env.example .env
```

### 3. 配置 `.env`

生产环境建议生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

示例：

```env
SECRET_KEY="把上一步生成的随机字符串填到这里"
DATABASE_URL="postgresql://crcheckin_user:CHANGE_ME@127.0.0.1:5432/crcheckin?schema=public"
PORT=5000
HOST=0.0.0.0
AUTO_DB_DEPLOY=true
```

Windows 如果需要使用管理端备份功能，可配置 PostgreSQL 备份工具路径：

```env
PG_DUMP_PATH="C:\Program Files\PostgreSQL\17\bin\pg_dump.exe"
```

### 4. 初始化数据库

```bash
npm run db:deploy
```

该命令会根据 `prisma/schema.prisma` 同步 PostgreSQL 表结构。正常输出中会看到 `Database schema is ready` 或 `database is now in sync`。

### 5. 启动服务

直接启动：

```bash
npm run start:direct
```

推荐使用 PM2 后台运行：

```bash
npm start
npm run pm2:status
```

启动成功后访问：

- 学生入口：`http://服务器地址:5000/student`
- 教师/管理员登录入口：学生页中的教师口令登录
- 管理端：`http://服务器地址:5000/admin`

首次部署时，管理员账号为 `admin`，随机密码会出现在启动日志中：

```bash
npm run pm2:logs
```

日志中会出现类似 `初始管理员已创建，密码: xxxxxxxx` 的提示。首次登录后请立即修改密码。

### 6. 反向代理（可选）

如果需要绑定域名，可以用 nginx 代理到本地 5000 端口：

```nginx
server {
  listen 80;
  server_name your-domain.com;

  location / {
    proxy_pass http://127.0.0.1:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### 7. 更新版本

更新前建议先备份数据库。

```bash
git pull
npm install
npm run db:deploy
npm run pm2:restart
```

如果使用 fork 或功能分支，请先确认当前分支和远程仓库，再执行更新。

### 8. 常用排查

```bash
npm run pm2:status      # 查看服务是否在线
npm run pm2:logs        # 查看实时日志
npm run pm2:restart     # 重启服务
npm run db:deploy       # 重新同步数据库结构
```

常见问题：

- `SECRET_KEY 未设置`：检查 `.env` 中是否填写了 `SECRET_KEY`。
- `DATABASE_URL is not configured`：检查 `.env` 中是否填写了 PostgreSQL 连接地址。
- 数据库连接失败：确认 PostgreSQL 已启动、账号密码正确、数据库名存在。
- 5000 端口被占用：修改 `.env` 中的 `PORT`，或停止占用端口的进程。
- Windows 下备份失败：配置 `PG_DUMP_PATH` 指向 PostgreSQL 安装目录中的 `pg_dump.exe`。

### 数据库备份

推荐在管理端使用“数据备份”功能导出 PostgreSQL 备份文件；也可以手动使用 `pg_dump`：

```bash
pg_dump "$DATABASE_URL" > crcheckin_backup.sql
```

Windows 可直接调用 `pg_dump.exe`，例如：

```powershell
& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" "postgresql://crcheckin_user:CHANGE_ME@127.0.0.1:5432/crcheckin?schema=public" > crcheckin_backup.sql
```

上传目录 `uploads/` 中保存了学生照片和附件，迁移服务器时也需要一并备份。

## 更新日志

详见 [CHANGELOG.zh.md](CHANGELOG.zh.md)（中文）或 [CHANGELOG.md](CHANGELOG.md)（English）。

## 自动备份

服务启动后会自动检查当天是否已有备份；如果没有，会立即生成一份。之后每天按配置时间自动备份一次。

- 自动备份目录：`backups/daily`
- 文件格式：`crcheckin-auto-YYYY-MM-DD.json`
- 默认保留：最近 7 天，共 7 份
- 超过保留数量的旧自动备份会自动删除
- 手动备份文件，例如 `backups/crcheckin.system.dump`，不会被这个清理逻辑删除

自动备份使用 JSON 格式导出应用数据表，不依赖 `pg_dump`。如需关闭，可在 `.env` 中设置：

```env
AUTO_BACKUP_ENABLED=false
```

## License

MIT
