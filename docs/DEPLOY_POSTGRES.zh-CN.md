# PostgreSQL 部署与升级说明

crCheckIn 当前使用 PostgreSQL 作为生产数据库。旧版本 SQLite 数据迁移完成后，后续升级不需要重新迁移旧 `.db` 文件，只需要继续使用原来的 PostgreSQL `DATABASE_URL`。

## 首次部署

1. 安装依赖：

```bash
npm install
```

2. 配置 `.env`：

```env
SECRET_KEY=请换成至少32位强随机字符串
DATABASE_URL="postgresql://crcheckin_user:你的密码@127.0.0.1:5432/crcheckin?schema=public"
PORT=5000
HOST=0.0.0.0
AUTO_DB_DEPLOY=true
```

3. 生成 Prisma Client 并同步数据库结构：

```bash
npx prisma generate
npm run db:deploy
```

4. 启动服务：

```bash
npm start
```

## 从 SQLite 迁移到 PostgreSQL

只在从旧 SQLite 版本升级到 PostgreSQL 时执行一次。执行前务必停止服务并备份 SQLite 文件。

```bash
npm run pm2:stop
cp prisma/attendance.db ~/attendance.db.backup

set -a
. ./.env
set +a

npx prisma generate
npm run db:migrate:sqlite -- prisma/attendance.db --clear
npm start
```

`--clear` 会清空当前 PostgreSQL 表后导入 SQLite 数据。只有确认 PostgreSQL 目标库是空库或可以覆盖时才使用。

## 日常升级

后续更新代码时，不需要重新迁移 SQLite，也不要再执行 `db:migrate:sqlite`。推荐流程：

```bash
npm run pm2:stop
pg_dump "$DATABASE_URL" > ~/crcheckin-$(date +%F-%H%M).sql

git pull
npm install
npx prisma generate
npm run db:deploy
npm start
```

如果只是改页面、样式、普通业务逻辑，通常数据库不会变化，但执行 `npm run db:deploy` 是安全的同步步骤。

如果修改了 `prisma/schema.prisma`，必须执行：

```bash
npx prisma generate
npm run db:deploy
npm run pm2:restart
```

## 什么时候需要动数据库

- 不需要：改 HTML/CSS/前端 JS、普通路由逻辑、服务逻辑、文案。
- 需要同步结构：新增表、新增字段、修改索引、修改 Prisma model。
- 需要谨慎备份：删除字段、改字段类型、重命名字段、清理历史数据。
- 不要重复执行 SQLite 迁移：旧 SQLite 到 PostgreSQL 的迁移只做一次。
