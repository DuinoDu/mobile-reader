# SOP：部署到 Volc 生产环境

本文档描述如何把 **mobile-reader**（Next.js 应用，SQLite 后端）部署 / 更新到火山引擎（Volcengine）生产服务器，并把本地数据 / 环境变量同步上去。

> 适用对象：有服务器 SSH 私钥的维护者。**本文档不含真实私钥**。连接信息统一从 conductor 的 Makefile 获取（见 [1.1](#11-获取连接信息必做)），命令里用 `SSH()` 包装函数。

---

## 0. 架构与关键事实

**设计要点**
- 纯 **SQLite** 后端，单文件库，部署自包含，无需数据库服务器；数据迁移 = 拷文件。
- `better-sqlite3` 是原生模块，**必须在服务器上按其 node 版本编译**（`npm ci` / `npm install` 会自动编译，无需额外配置）。
- **包管理器是 npm**（仓库里是 `package-lock.json`）。
- **数据库 schema 自动迁移**：`lib/db.ts` 的 `migrate()` 用 `CREATE TABLE IF NOT EXISTS` + 幂等 `ALTER TABLE` 守卫，首次访问 DB 时自动建表 / 加列（`docs.html_zh`、`docs.translation_status`、`translation_jobs` 表等）。**没有单独的 migrate 命令**，重启后第一次请求即完成。
- **翻译是后台任务**：URL 导入会下载原文并入队，由进程内 worker（`lib/translation-worker.ts`）翻译成中文。任务持久化在 `translation_jobs` 表，失败按退避重试，**进程重启时自动回收卡住的 `running` 任务**。worker 在进程启动后第一次相关请求时拉起——所以**每次发布必须 `restart` 服务**才会生效。
- **翻译依赖 DeepSeek**：`.env` 必须有 `DEEPSEEK_API_KEY`（和以 `/v1` 结尾的 `DEEPSEEK_BASE_URL`），否则每次导入都会落到 `failed`。见 [§4](#4-env-同步含-deepseek-翻译变量)。

**线上现状（写本文时）**
- 目录 `/opt/mobile-reader`，服务 `mobile-reader.service`，本地端口 `6170`（`127.0.0.1`）。
- 域名 `mobile-reader.conductor-ai.top`，nginx 站点 `mobile-reader`，已由 certbot 配好 443 + HTTP→HTTPS 跳转。
- 服务器：`root@<VOLC IP>`，node v20、npm 10。

**发布铁律（必须遵守）**
> **部署前一定先把本地改动 `commit` + `push` 到远程 `main`；服务器只通过 `git fetch` + `git reset --hard origin/main` 同步代码，再构建、重启。绝不绕过 git 直接传代码、也不在服务器上手改代码。** 数据库文件不在 git 里，单独走 [§3](#3-数据库同步local--remote)（用 `scp`）；`.env` 同理走 [§4](#4-env-同步含-deepseek-翻译变量)。

---

## 1. 首次部署（全新机器）

> 已经部署过、只是更新代码 → 跳到 [第 2 节](#2-日常更新redeploy)。线上已部署，本节作为重建参考。

### 1.1 获取连接信息（必做）
连接信息（私钥路径 + 服务器地址）从 Makefile 输出，**不要写死到别处**：
```sh
make -f ~/ws/conductor/Makefile info-volc
```
据此设置（端口默认 22）：
```sh
export SSH_KEY=path-to-ssh-key-file  # 以 info-volc 实际输出为准
export SERVER=root@volc-ip
SSH() { ssh -i "$SSH_KEY" "$SERVER" "$@"; }
SCP() { scp -i "$SSH_KEY" "$@"; }
```
> 注意：连续多次失败鉴权会触发服务器 fail2ban，导致后续连接在 KEX 阶段被 `Connection closed`。一旦被挡，**停手等约 10 分钟**再连，别反复重试加重封禁。

### 1.2 确认服务器前置条件
```sh
SSH 'node -v; npm -v;
  for t in gcc g++ make python3 nginx certbot git; do printf "%s: " $t; command -v $t || echo MISSING; done'
```
缺 `gcc/g++/make/python3` 会导致 `better-sqlite3` 编译失败。

### 1.3 拉取代码（git clone）
> **代码一律走 git**，不绕过 git 传代码。`GIT_REPO` = 仓库地址（如 `git@github.com:DuinoDu/mobile-reader.git`）。
```sh
SSH 'git clone <GIT_REPO> /opt/mobile-reader && cd /opt/mobile-reader && git rev-parse --short HEAD'
```
> 目录已存在但不是 git 工作副本时，一次性转成 git：
> ```sh
> SSH 'cd /opt/mobile-reader && git init -q && git remote add origin <GIT_REPO> \
>   && git fetch origin && git reset --hard origin/main'   # .env / data 是 gitignored，不受影响
> ```

### 1.4 配置生产 `.env`
`.env` 不进 git（gitignored），需单独落地。先把本地 `.env` 拷过去，再补差异项：
```sh
SCP .env "$SERVER:/opt/mobile-reader/.env"
SSH '
  cd /opt/mobile-reader
  sed -i "s|^MOBILE_READER_BASE_URL=.*|MOBILE_READER_BASE_URL=https://mobile-reader.conductor-ai.top|" .env
  grep -q "^MOBILE_READER_DB_PATH=" .env || printf "MOBILE_READER_DB_PATH=./data/mobile-reader.sqlite\n" >> .env
'
```
关键变量：`NODE_ENV`、`MOBILE_READER_BASE_URL`、`CONDUCTOR_BASE_URL`、`CONDUCTOR_CLIENT_ID`、`CONDUCTOR_CLIENT_SECRET`、`MOBILE_READER_SECRET`、`MOBILE_READER_DB_PATH`，以及翻译用的 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`（`/v1` 结尾）/ `DEEPSEEK_MODEL`（见 [§4](#4-env-同步含-deepseek-翻译变量)）。

### 1.5 安装依赖（编译 better-sqlite3）+ 构建
```sh
SSH '
  cd /opt/mobile-reader
  npm ci                  # 按 package-lock 安装并编译 better-sqlite3
  node -e "new (require(\"better-sqlite3\"))(\"data/mobile-reader.sqlite\"); console.log(\"sqlite ok\")"
  npm run build
'
```
> 库文件不存在也没关系：应用首次访问 DB 会自动建表（见 §0）。要导入已有数据见 [§3](#3-数据库同步local--remote)。

### 1.6 systemd 服务
`next start` 的真实入口是 `node_modules/next/dist/bin/next`（`.bin/next` 是 shell shim，不能 `node` 它）。
```sh
SSH 'cat > /etc/systemd/system/mobile-reader.service <<"UNIT"
[Unit]
Description=mobile-reader Next.js app
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/mobile-reader
Environment=NODE_ENV=production
Environment=PATH=/usr/bin:/bin
ExecStart=/usr/bin/node /opt/mobile-reader/node_modules/next/dist/bin/next start -p 6170 -H 127.0.0.1
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now mobile-reader.service
sleep 4; systemctl is-active mobile-reader.service
curl -s -o /dev/null -w "local 6170 -> %{http_code}\n" http://127.0.0.1:6170/'
```

### 1.7 nginx 反向代理
```sh
SSH 'cat > /etc/nginx/sites-available/mobile-reader <<"NGINX"
map $http_upgrade $mr_connection_upgrade { default upgrade; "" close; }

server {
  listen 80;
  server_name mobile-reader.conductor-ai.top;
  client_max_body_size 20m;

  location /_next/static/ {
    alias /opt/mobile-reader/.next/static/;
    expires 1y; access_log off;
    add_header Cache-Control "public, immutable";
  }
  location / {
    proxy_pass http://127.0.0.1:6170;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $mr_connection_upgrade;
    proxy_read_timeout 86400;
  }
}
NGINX
ln -sf /etc/nginx/sites-available/mobile-reader /etc/nginx/sites-enabled/mobile-reader
nginx -t && systemctl reload nginx'
```

### 1.8 DNS（Volcengine 控制台 / 手动）
本地无 Volcengine API 凭证，**A 记录需在控制台改**：把 `mobile-reader.conductor-ai.top` 的 **A 记录指向 `<volc ip>`**。校验：
```sh
dig +short @223.5.5.5 mobile-reader.conductor-ai.top
```

### 1.9 TLS 证书
DNS 指向服务器后：
```sh
SSH 'certbot --nginx -d mobile-reader.conductor-ai.top --non-interactive --redirect --keep-until-expiring'
```
> 自动加 443 server 块 + HTTP→HTTPS 跳转 + 自动续期 timer。

### 1.10 验收
```sh
H=mobile-reader.conductor-ai.top; IP=<volc ip>
curl -s -o /dev/null -w "https -> %{http_code}\n" --resolve $H:443:$IP https://$H/
curl -s --resolve $H:443:$IP https://$H/ | grep -oiE "<title>[^<]*</title>"
```

---

## 2. 日常更新（redeploy）

**发布铁律：先 `commit` + `push` 到 `main`，服务器只 `git` 拉取，绝不绕过 git 传代码。** 数据库 / `.env` 另走 §3 / §4。顺序固定：自检 → 提交推送 → 服务器拉取 → 构建 → 重启 → 验收。

```sh
# 连接变量（见 1.1）
make -f ~/ws/conductor/Makefile info-volc
export SSH_KEY=path-to-ssh-key-file
export SERVER=server-name
SSH() { ssh -i "$SSH_KEY" "$SERVER" "$@"; }

# 0) 本地：自检（不过不部署）
npx tsc --noEmit && npm run build

# 1) 本地：提交并推送（部署前必做，否则服务器拉不到改动）
git add -A
git commit -m "feat: ..."
git push origin main

# 2) 服务器：拉取到与远程完全一致
#    用 reset --hard 而非 pull：以远程为准，避免服务器上意外改动导致冲突；
#    .env、data/（gitignored）不受影响。
SSH 'cd /opt/mobile-reader && git fetch origin && git reset --hard origin/main && echo "HEAD -> $(git rev-parse --short HEAD)"'

# 3) 服务器：装依赖（有依赖变化时）+ detached 构建（detached 防 SSH 掉线打断）
SSH 'cd /opt/mobile-reader && nohup sh -c "npm ci >/tmp/mr_build.log 2>&1 && npm run build >>/tmp/mr_build.log 2>&1 && echo BUILD_OK >>/tmp/mr_build.log || echo BUILD_FAIL >>/tmp/mr_build.log" >/dev/null 2>&1 & echo started'

# 4) 等构建完成
until SSH 'grep -qE "BUILD_OK|BUILD_FAIL" /tmp/mr_build.log'; do sleep 20; done
SSH 'tail -3 /tmp/mr_build.log'

# 5) 构建 OK 才重启（重启必做：翻译 worker 只在新进程拉起，并会回收卡住的任务）
SSH 'grep -q BUILD_OK /tmp/mr_build.log && systemctl restart mobile-reader.service && sleep 4 && systemctl is-active mobile-reader.service'

# 6) 验收：HTTP 200 + 线上 commit == 刚推的 commit
curl -s -o /dev/null -w "https -> %{http_code}\n" --resolve mobile-reader.conductor-ai.top:443:<VOLC_IP> https://mobile-reader.conductor-ai.top/
echo "local  HEAD: $(git rev-parse --short HEAD)"
SSH 'echo "server HEAD: $(git -C /opt/mobile-reader rev-parse --short HEAD)"'
```

> - schema 无需手动迁移：重启后首次访问 DB 自动建表 / 加列（幂等）。
> - 没改依赖时第 3 步可省 `npm ci`，只 `npm run build`，更快。
> - **首发翻译功能时**：确保服务器 `.env` 已含 `DEEPSEEK_*`（见 §4），否则导入会 `failed`。

---

## 3. 数据库同步（local ↔ remote）

SQLite 单文件库，路径由 `.env` 的 `MOBILE_READER_DB_PATH` 决定（默认 `./data/mobile-reader.sqlite`，线上即 `/opt/mobile-reader/data/mobile-reader.sqlite`）。**务必先停服务 + 备份**，避免覆盖期写冲突。

```sh
# local → remote（把本地库覆盖到生产）
# 1) 本地：WAL 落盘
node -e "const D=require('better-sqlite3');const db=new D('data/mobile-reader.sqlite');db.pragma('wal_checkpoint(TRUNCATE)');db.close()"
# 2) 远端：停服务 + 备份 + 清 wal/shm
SSH 'cd /opt/mobile-reader && systemctl stop mobile-reader.service \
  && cp data/mobile-reader.sqlite data/mobile-reader.sqlite.bak-$(date +%Y%m%d-%H%M%S) \
  && rm -f data/mobile-reader.sqlite-wal data/mobile-reader.sqlite-shm'
# 3) 覆盖
SCP data/mobile-reader.sqlite "$SERVER:/opt/mobile-reader/data/mobile-reader.sqlite"
# 4) 启服务
SSH 'cd /opt/mobile-reader && systemctl start mobile-reader.service && sleep 4 && systemctl is-active mobile-reader.service'
```
> 反向（remote → local 拉生产数据）：把 scp 源 / 目标对调，本地先备份。库表结构由应用首次访问自动建立，空库可直接启动。

---

## 4. `.env` 同步（含 DeepSeek 翻译变量）

翻译功能要求服务器 `.env` 配好 DeepSeek。**只补缺失键、不覆盖已有值**，且不在命令行回显密钥：
```sh
# 本地 .env / .env.local 里取 DeepSeek 三个变量
grep -E '^DEEPSEEK_(API_KEY|BASE_URL|MODEL)=' .env.local > /tmp/ds.env   # 或本地 .env
SCP /tmp/ds.env "$SERVER:/opt/mobile-reader/.deepseek.env"
SSH 'cd /opt/mobile-reader && while IFS= read -r l; do k=${l%%=*}; grep -q "^$k=" .env || echo "$l" >> .env; done < .deepseek.env && rm -f .deepseek.env && grep -c "^DEEPSEEK_" .env'
rm -f /tmp/ds.env
# 改了 .env 后必须重启
SSH 'systemctl restart mobile-reader.service && sleep 4 && systemctl is-active mobile-reader.service'
```
- `DEEPSEEK_BASE_URL` 必须以 `/v1` 结尾（代码会拼 `/chat/completions`）。
- 校验：导入一个英文网页，列表出现「翻译中…」→「中文」徽章即正常；若秒变「翻译失败」，多半是 key 缺失 / BASE_URL 不对。

---

## 5. 运维速查

**日志 / 状态**
```sh
SSH 'systemctl status mobile-reader --no-pager'
SSH 'journalctl -u mobile-reader -n 80 --no-pager'   # 应用 / 翻译报错
```

**翻译队列排查**（SQLite 直查）
```sh
SSH 'cd /opt/mobile-reader && node -e "const D=require(\"better-sqlite3\");const db=new D(process.env.MOBILE_READER_DB_PATH||\"data/mobile-reader.sqlite\",{readonly:true});console.log(db.prepare(\"select status,count(*) c from translation_jobs group by status\").all())"'
```
- 卡在 `running` 的任务会在**下次重启**自动回收为 `queued`；`failed` 的可在前端用「重试翻译」重新入队。

**回滚**
- 代码：服务器 `git reset --hard <旧commit>` → 重新构建（§2 第 3-5 步）→ 重启。或本地 revert 后 commit + push + 拉取。
- 数据：用 `data/mobile-reader.sqlite.bak-<ts>` 覆盖回去（停服务 → 拷贝 → 启服务）。

**证书续期**：certbot timer 自动续；手动 `SSH 'certbot renew --dry-run'`。

---

## 6. 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| `kex_exchange_identification: Connection closed`（连不上 SSH） | 之前多次失败鉴权触发 fail2ban。**停手等约 10 分钟**再连，别反复重试。 |
| `SyntaxError: missing ) after argument list`（service 起不来） | ExecStart 错指了 `.bin/next`（shell shim）。必须用 `node_modules/next/dist/bin/next`。 |
| `Could not locate the bindings file`（better-sqlite3） | 原生模块没编译 / node 版本变了。`cd /opt/mobile-reader && npm rebuild better-sqlite3`。 |
| 导入后徽章秒变「翻译失败」 | `.env` 缺 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_BASE_URL` 没以 `/v1` 结尾。补上并重启（§4）。 |
| 文档一直「翻译中…」不结束 | 翻译 worker 没拉起，或任务卡住。`systemctl restart mobile-reader`（重启会回收卡住任务）；再查 §5 队列。 |
| 部署后线上还是旧代码 | 本地改动没 `commit`/`push` 就部署。**铁律：先 commit + push**；§2 第 6 步用 `git rev-parse HEAD` 核对 local==server。 |
| 服务器 `git pull` 冲突 / 拉不动 | 服务器上别手改 tracked 文件。用 `git fetch && git reset --hard origin/main`（`.env` / `data/` 是 gitignored，不受影响）。 |
| SSH 长会话中途断开 | 构建 / 长任务一律 `nohup` detached 跑再轮询日志，别放在交互式 SSH 里。 |

---

## 7. 涉及文件 / 命令索引

- 连接信息：`make -f ~/ws/conductor/Makefile info-volc`
- 应用 DB 层 / 自动迁移：`lib/db.ts`（`migrate()`，含 `translation_jobs` 表）
- 翻译：`lib/translate.ts`（DeepSeek 调用 + HTML 保结构分词）、`lib/translation-worker.ts`（持久化队列 worker，启动回收）
- 翻译 API：`app/api/docs/route.ts`（导入入队）、`app/api/docs/[id]/translate/route.ts`（按文档翻译 / 重试）
- nginx 站点：`/etc/nginx/sites-available/mobile-reader`
- systemd：`/etc/systemd/system/mobile-reader.service`（端口 6170）
- 数据库文件：`/opt/mobile-reader/data/mobile-reader.sqlite`
