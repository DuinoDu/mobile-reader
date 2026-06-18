# SOP：部署到 Volc 生产环境

本文档描述如何把 **mobile-reader**（Next.js 应用，better-sqlite3 后端 + Conductor SSO 登录）部署 / 更新到火山引擎（Volcengine）生产服务器。

线上地址：**https://mobile-reader.conductor-ai.top**

> 适用对象：有服务器 SSH 私钥的维护者。**本文档不含真实服务器地址 / 私钥**；命令里统一用占位变量 `$SERVER_IP` / `$SSH_KEY` / `$SERVER`，执行前先按 [1.1](#11-设置连接占位变量必做) 设置。

---

## 0. 架构与关键事实

**设计要点**
- 多用户，登录走 **Conductor SSO**（OAuth code 流）。用户文档存服务端 **SQLite**（`better-sqlite3`）；划词评论存浏览器端 IndexedDB（不上服务端）。
- `better-sqlite3` 是原生模块，**必须在服务器上按 service 所用的 node 版本编译**。service 用 `/usr/bin/node`（当前 v20.19.6），非交互 ssh 默认 node 也是 v20，`npm ci` 编出来的 ABI 与 service 一致——若哪天两者漂移会 `Could not locate the bindings file`（见 [§6](#6-常见坑)）。
- 数据库是单个 SQLite 文件（`data/mobile-reader.sqlite`），表结构由 `lib/db.ts` 启动时 `CREATE TABLE IF NOT EXISTS` 自动建，无独立 migrate 步骤。数据迁移 = 拷文件。
- 端口分配（同机已有别的应用）：`6152` conductor、`6160` arxiv-radar、**`6170` mobile-reader**。

**发布铁律（必须遵守）**
> **部署前先 `commit`；服务器代码只通过 `git push volc main` 同步（见下），绝不在服务器上手改 tracked 文件。** `.env`、`data/`（SQLite）、`node_modules`、`.next` 都是 gitignored / 未跟踪，不受 git 同步影响，单独维护。

**代码同步机制（与 arxiv-radar 不同）**
> mobile-reader 没有 GitHub 远端。服务器 `/opt/mobile-reader` 本身是一个**可直接 push 的 git 工作副本**（`receive.denyCurrentBranch=updateInstead`）。本地有名为 `volc` 的 remote 指向它，`git push volc main` 即把工作树更新到最新（见 [1.3](#13-代码落地git-remote-volc) / [§2](#2-日常更新redeploy)）。

---

## 1. 首次部署（全新机器）

> 已经部署过、只是更新代码 → 跳到 [第 2 节](#2-日常更新redeploy)。

### 1.1 设置连接占位变量（必做）
真实 IP / 私钥从 conductor 运维 Makefile 获取（不要写回本文档）：
```sh
make info-volc

export SERVER_IP=<服务器IP>
export SSH_KEY=<path to ssh key>
export SERVER="root@$SERVER_IP"
```

> **SSH 偶发断连 / 限速**：本机 sshd 长命令或频繁建连会 `Connection reset/closed`。强烈建议开连接复用（multiplexing），后续所有命令复用一条连接：
> ```sh
> CM=~/.ssh/cm-mr-%r@%h:%p
> ssh -i $SSH_KEY -o ControlMaster=auto -o ControlPath="$CM" -o ControlPersist=600 $SERVER 'echo up'
> s() { ssh -i $SSH_KEY -o ControlPath="$CM" $SERVER "$1"; }   # 之后用 s '<cmd>'
> ```

### 1.2 确认服务器前置条件
```sh
s 'node -v; npm -v; for t in gcc g++ make python3 nginx certbot git; do printf "%s: " $t; command -v $t || echo MISSING; done'
```
缺 `gcc/g++/make/python3` 会导致 `better-sqlite3` 编译失败。

### 1.3 代码落地（git remote `volc`）
**服务器侧**：把 `/opt/mobile-reader` 建成可直接 push 的 git 工作副本（一次性）：
```sh
s '
  mkdir -p /opt/mobile-reader && cd /opt/mobile-reader
  git init -q
  git symbolic-ref HEAD refs/heads/main
  git config receive.denyCurrentBranch updateInstead
'
```
**本地侧**：加 remote 并推送（用 pem key 走 SSH；可复用 ControlPath）：
```sh
git remote add volc ssh://$SERVER_IP/opt/mobile-reader   # 已存在则 set-url
export GIT_SSH_COMMAND="ssh -i $SSH_KEY -o ControlPath=$CM"
git push volc main:main
s 'cd /opt/mobile-reader && git rev-parse --short HEAD'   # 应与本地 HEAD 一致
```

### 1.4 配置生产 `.env`
`.env` 不进 git（`.gitignore` 含 `.env*`），需单独落地。**`CONDUCTOR_CLIENT_SECRET` 必须与 [1.11](#111-注册-conductor-sso-client) 里 conductor 端登记的同一个 client 的 secret 完全一致。**
```sh
s 'cat > /opt/mobile-reader/.env <<ENV
NODE_ENV=production
MOBILE_READER_BASE_URL=https://mobile-reader.conductor-ai.top
CONDUCTOR_BASE_URL=https://conductor-ai.top
CONDUCTOR_CLIENT_ID=mobile-reader
CONDUCTOR_CLIENT_SECRET=<与 conductor 端一致的 secret>
MOBILE_READER_SECRET=<openssl rand 生成，用于加密存储的 conductor token>
MOBILE_READER_DB_PATH=/opt/mobile-reader/data/mobile-reader.sqlite
ENV
chmod 600 /opt/mobile-reader/.env'
```
关键变量：
| 变量 | 作用 |
|---|---|
| `MOBILE_READER_BASE_URL` | 应用公网地址。**登录/回调/登出跳转都用它**（而非 `request.url`，否则会跳到内网 `127.0.0.1:6170`）。 |
| `CONDUCTOR_BASE_URL` | SSO provider（默认 `https://conductor-ai.top`）。 |
| `CONDUCTOR_CLIENT_ID` | OAuth client（默认 `mobile-reader`）。 |
| `CONDUCTOR_CLIENT_SECRET` | OAuth client secret，**必须与 conductor 端登记一致**。 |
| `MOBILE_READER_SECRET` | AES-GCM 密钥（派生），加密落库的 conductor access_token；**生产必填**，丢失/更换会使已存 token 无法解密。 |
| `MOBILE_READER_DB_PATH` | SQLite 路径；缺省 `./data/mobile-reader.sqlite`（相对 WorkingDirectory）。 |

> `.env` 由 `next start` 自动加载（Next.js 的 `loadEnvConfig`）。`MOBILE_READER_SECRET` 也接受别名 `AUTH_SECRET` / `SESSION_SECRET`。

### 1.5 安装依赖（编译 better-sqlite3）
```sh
s 'cd /opt/mobile-reader && npm config set registry https://registry.npmjs.org && npm ci'
# 用 service 的 node 验证原生模块可加载：
s '/usr/bin/node -e "const D=require(\"/opt/mobile-reader/node_modules/better-sqlite3\");new D(\":memory:\").exec(\"create table t(x)\");console.log(\"better-sqlite3 OK\",process.version)"'
```

### 1.6 构建
**构建在服务器上跑，detached**，避免 SSH 掉线打断：
```sh
s 'cd /opt/mobile-reader && nohup sh -c "npm run build >/tmp/mr_build.log 2>&1 && echo BUILD_OK >>/tmp/mr_build.log || echo BUILD_FAIL >>/tmp/mr_build.log" >/dev/null 2>&1 & echo started'
until s 'grep -qE "BUILD_OK|BUILD_FAIL" /tmp/mr_build.log'; do sleep 15; done
s 'tail -5 /tmp/mr_build.log'
```

### 1.7 systemd 服务
`next start` 的真实入口是 `node_modules/next/dist/bin/next`（`.bin/next` 是 shell shim，不能 `node` 它）。
```sh
s 'cat > /etc/systemd/system/mobile-reader.service <<"UNIT"
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
> 未登录访问 `/` 返回 **307 → /login**，属正常。

### 1.8 nginx 反向代理
```sh
s 'cat > /etc/nginx/sites-available/mobile-reader <<"NGINX"
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

### 1.9 DNS（Volcengine 控制台 / 手动）
本地无 Volcengine DNS API 凭证，**A 记录需在控制台改**：
- 进 Volcengine DNS 控制台 → `conductor-ai.top` → 添加 A 记录：主机记录 `mobile-reader`，记录值 `$SERVER_IP`。
- 校验（注意：直接查权威 `vip1/vip2.volcengine-dns.com` 可能因 GeoDNS 分区视图返回空，**以公共解析为准**）：
```sh
dig +short @223.5.5.5 mobile-reader.conductor-ai.top   # 期望 $SERVER_IP
dig +short @8.8.8.8   mobile-reader.conductor-ai.top
```

### 1.10 TLS 证书
DNS 公共解析生效后（certbot HTTP-01 需公网能解析到本机）：
```sh
s 'certbot --nginx -d mobile-reader.conductor-ai.top --non-interactive --redirect --keep-until-expiring'
```
> 自动加 443 server 块 + HTTP→HTTPS 跳转 + 自动续期 timer。

### 1.11 注册 Conductor SSO client
见 [§3](#3-conductor-sso-client-管理)。首次部署必须先注册，否则登录会被 conductor 拒（`invalid_client`）。

### 1.12 验收
```sh
H=mobile-reader.conductor-ai.top
curl -s -o /dev/null -w "/        -> %{http_code} (%{redirect_url})\n" https://$H/                 # 期望 307 -> /login
curl -s -o /dev/null -w "/login   -> %{http_code}\n"                   https://$H/login            # 200
curl -s -o /dev/null -w "fetchurl -> %{http_code}\n" "https://$H/api/fetch-url?url=https://example.com"  # 401（已 SSO 门禁）
curl -s -o /dev/null -w "authz    -> %{redirect_url}\n" https://$H/api/auth/login
#   期望 -> https://conductor-ai.top/oauth/authorize?client_id=mobile-reader&redirect_uri=https%3A%2F%2Fmobile-reader.conductor-ai.top%2Fapi%2Fauth%2Fcallback...
```
最终需人工在浏览器走一遍真实登录（需 conductor 账号），确认回调后落在 `https://mobile-reader.conductor-ai.top/`（**不是** `localhost:6170`）。SQLite 文件在首次登录时于 `data/` 懒创建。

---

## 2. 日常更新（redeploy）

**铁律：先 commit，再 `git push volc`，服务器只 git 同步。** 顺序固定：本地自检 → 提交 → push → 构建 → 重启 → 验收。
```sh
# 0) 本地自检
npm run build

# 1) 本地提交并推送到服务器工作副本
git add -A && git commit -m "..."
export GIT_SSH_COMMAND="ssh -i $SSH_KEY -o ControlPath=$CM"
git push volc main

# 2) 服务器：装依赖（仅依赖变化时）+ detached 构建
s 'cd /opt/mobile-reader && nohup sh -c "npm ci >/tmp/mr_build.log 2>&1 && npm run build >>/tmp/mr_build.log 2>&1 && echo BUILD_OK >>/tmp/mr_build.log || echo BUILD_FAIL >>/tmp/mr_build.log" >/dev/null 2>&1 & echo started'
until s 'grep -qE "BUILD_OK|BUILD_FAIL" /tmp/mr_build.log'; do sleep 15; done
s 'tail -5 /tmp/mr_build.log'

# 3) 构建 OK 才重启 + 验收
s 'grep -q BUILD_OK /tmp/mr_build.log && systemctl restart mobile-reader.service && sleep 4 && systemctl is-active mobile-reader.service'
echo "local  HEAD: $(git rev-parse --short HEAD)"
s 'echo "server HEAD: $(git -C /opt/mobile-reader rev-parse --short HEAD)"'   # 应一致
curl -s -o /dev/null -w "https -> %{http_code}\n" https://mobile-reader.conductor-ai.top/login
```
> - 没改 `package.json`/lockfile 时第 2 步可省 `npm ci`，只 `npm run build`，更快。
> - 本地历史若与服务器分叉（少见），用 `git push -f volc main`（`updateInstead` 仍会更新工作树；`.env`/`data/` 不受影响）。

---

## 3. Conductor SSO client 管理

mobile-reader 作为 OAuth client 接入 conductor。**client 注册表在 conductor 端的环境变量 `CONDUCTOR_SSO_CLIENTS_JSON` 里**（文件：`/opt/conductor/conductor/web/.env.production.local`，一个 JSON 数组）。改动需重启 conductor 才生效。

> ⚠️ **影响共享服务**：重启 conductor 会让 `conductor-ai.top` 抖动数秒，期间 arxiv-radar / operator 等其它 client 的**新登录**会短暂失败（已登录会话不受影响）。

**新增 / 更新 mobile-reader client：**
```sh
# 1) 先看现状（含 arxiv-radar / operator，勿动它们）
s 'grep "^CONDUCTOR_SSO_CLIENTS_JSON=" /opt/conductor/conductor/web/.env.production.local | head -c 200; echo'

# 2) 用 python3 安全地往数组里加/更新本 client（自动备份、幂等：已存在则复用其 secret）
s 'python3 - <<PY
import json,secrets,shutil,time
F="/opt/conductor/conductor/web/.env.production.local"
KEY="CONDUCTOR_SSO_CLIENTS_JSON="
CB="https://mobile-reader.conductor-ai.top/api/auth/callback"
lines=open(F).read().splitlines(keepends=True)
i=next(k for k,l in enumerate(lines) if l.startswith(KEY))
arr=json.loads(lines[i][len(KEY):].strip())
c=next((x for x in arr if x.get("client_id")=="mobile-reader"),None)
sec=(c or {}).get("client_secret") or secrets.token_urlsafe(32)
if c:
    c["client_secret"]=sec; c.setdefault("display_name","Mobile Reader")
    c.setdefault("redirect_uris",[]); 
    (CB in c["redirect_uris"]) or c["redirect_uris"].append(CB)
else:
    arr.append({"client_id":"mobile-reader","display_name":"Mobile Reader","client_secret":sec,"redirect_uris":[CB]})
shutil.copy2(F,F+".bak-mr-"+time.strftime("%Y%m%d-%H%M%S"))
lines[i]=KEY+json.dumps(arr,ensure_ascii=False,separators=(",",":"))+"\n"
open(F,"w").writelines(lines)
print("clients:",[x["client_id"] for x in arr]); print("secret:",sec)
PY'
#   把打印出的 secret 同步写进 mobile-reader 的 /opt/mobile-reader/.env 的 CONDUCTOR_CLIENT_SECRET

# 3) 重启 conductor（scoped pkill —— 只杀 conductor 自己的 server.ts，勿伤 operator）
s '. /root/.nvm/nvm.sh                         # 用 conductor 自己的 node（别硬编码版本）
   cd /opt/conductor/conductor
   pkill -f "/opt/conductor/conductor/.*server\.ts" || true
   sleep 1
   nohup npm --prefix web run start > /opt/conductor/conductor.log 2>&1 &'
for i in $(seq 1 20); do s 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:6152/api/health' | grep -q 200 && break; sleep 2; done

# 4) 验证 conductor 认得本 client（用真 secret + 假 code；期望 invalid_grant，而非 invalid_client）
s 'sec=$(grep "^CONDUCTOR_CLIENT_SECRET=" /opt/mobile-reader/.env | cut -d= -f2-)
   curl -s -X POST http://127.0.0.1:6152/api/oauth/token -H "Content-Type: application/json" \
     -d "{\"grant_type\":\"authorization_code\",\"client_id\":\"mobile-reader\",\"client_secret\":\"$sec\",\"code\":\"x\",\"redirect_uri\":\"https://mobile-reader.conductor-ai.top/api/auth/callback\"}"; echo'
```
> client 字段：`client_id`、`display_name`、`client_secret`、`redirect_uris`（精确匹配白名单，无前缀匹配）。conductor 重启的权威方式见 conductor 仓库 `scripts/deploy-prod.sh`；这里只做最小化「改 env + 重启」，不重新构建 conductor。

---

## 4. 数据库同步（SQLite 文件）

库是单文件 `data/mobile-reader.sqlite`。**务必先停服务 + 备份**，避免覆盖期写冲突。
```sh
# 本地 → 生产（覆盖）
node -e "const D=require('better-sqlite3');const db=new D('data/mobile-reader.sqlite');db.pragma('wal_checkpoint(TRUNCATE)');db.close()"
s 'systemctl stop mobile-reader.service
   cd /opt/mobile-reader && cp data/mobile-reader.sqlite data/mobile-reader.sqlite.bak-$(date +%Y%m%d-%H%M%S)
   rm -f data/mobile-reader.sqlite-wal data/mobile-reader.sqlite-shm'
scp -i $SSH_KEY data/mobile-reader.sqlite $SERVER:/opt/mobile-reader/data/mobile-reader.sqlite
s 'systemctl start mobile-reader.service; sleep 3; systemctl is-active mobile-reader.service'
```
> 反向（生产 → 本地）：先停服务 + 备份本地，再把 scp 源/目标对调。

---

## 5. 运维速查
```sh
s 'systemctl status mobile-reader --no-pager'
s 'journalctl -u mobile-reader -n 50 --no-pager'              # 应用报错
s 'ls -la /opt/mobile-reader/data/'                           # 库文件 / 备份
s 'sqlite3 /opt/mobile-reader/data/mobile-reader.sqlite "select count(*) users, (select count(*) from docs) docs from users"'  # 若装了 sqlite3
```
**回滚**
- 代码：`s 'cd /opt/mobile-reader && git reset --hard <旧commit>'` → 重新构建（§2 第 2-3 步）。或本地 revert 后 push。
- 数据：用 `data/mobile-reader.sqlite.bak-<ts>` 覆盖回去（停服务→拷贝→启服务）。

**证书续期**：certbot timer 自动续；手动 `s 'certbot renew --dry-run'`。

---

## 6. 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| 登录后跳到 `localhost:6170` / `127.0.0.1:6170` | 回调里用了 `request.url`（nginx 后是内网地址）。必须用 `getAppBaseUrl()`（读 `MOBILE_READER_BASE_URL`）。login/callback/logout 三处都要。 |
| 登录被 conductor 拒 `invalid_client` | conductor 端 `CONDUCTOR_SSO_CLIENTS_JSON` 没有 `mobile-reader` 或没重启。见 [§3](#3-conductor-sso-client-管理)。 |
| token 交换 `invalid_client`（secret 不符） | `/opt/mobile-reader/.env` 的 `CONDUCTOR_CLIENT_SECRET` 与 conductor 端登记的不一致。 |
| 回调 redirect_uri 不匹配 | conductor client 的 `redirect_uris` 必须**精确**含 `https://mobile-reader.conductor-ai.top/api/auth/callback`。 |
| `Could not locate the bindings file`（better-sqlite3） | 原生模块 ABI 与 service node 不符。用 service 的 `/usr/bin/node` 重新 `npm rebuild better-sqlite3`，确认编译用的 node 版本 == service node 版本。 |
| `SyntaxError: missing ) after argument list`（service 起不来） | ExecStart 错指了 `.bin/next`（shell shim）。必须用 `node_modules/next/dist/bin/next`。 |
| SSH 长会话中途 `Connection closed/reset` | 本机偶发。开 ControlMaster 复用连接；构建/长任务一律 detached（`nohup`）再轮询日志。 |
| 公网仍解析到旧 IP / 权威查为空 | 公共缓存未过期，或 GeoDNS 分区视图（直接查 vip1/vip2 可能空）。以 `223.5.5.5`/`8.8.8.8` 为准；certbot 走公共解析。 |
| 重启 conductor 误伤 operator | `pkill` 必须 scoped：`pkill -f "/opt/conductor/conductor/.*server\.ts"`，不要全局 `pkill -f server.ts`。 |
| `MOBILE_READER_SECRET is required in production` | 生产 `.env` 缺该变量（或别名 `AUTH_SECRET`/`SESSION_SECRET`）。 |

---

## 7. 涉及文件 / 命令索引

- 应用 DB 层：`lib/db.ts`（better-sqlite3，`users`/`sessions`/`docs` 表，启动自动建表）
- 鉴权：`lib/auth.ts`（session cookie）、`lib/conductor-sso.ts`（OAuth + `getAppBaseUrl`）、`lib/crypto.ts`（token 加密）
- 鉴权路由：`app/api/auth/{login,callback,logout,me}/route.ts`
- 文档 API：`app/api/docs/route.ts`、`app/api/docs/[id]/route.ts`；网页抓取：`app/api/fetch-url/route.ts`（SSO 门禁）
- 生产环境：`/opt/mobile-reader/.env`（gitignored）
- systemd：`/etc/systemd/system/mobile-reader.service`（端口 6170）
- nginx 站点：`/etc/nginx/sites-available/mobile-reader`
- SQLite：`/opt/mobile-reader/data/mobile-reader.sqlite`
- Conductor client 注册表：`/opt/conductor/conductor/web/.env.production.local` 的 `CONDUCTOR_SSO_CLIENTS_JSON`
- 连接信息：`make -f ~/code/scripts/makefile/Makefile.conductor info-volc`
