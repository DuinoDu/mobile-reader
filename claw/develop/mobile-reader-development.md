# Mobile Reader 开发说明

## 运行

```bash
npm run dev     # 开发，http://localhost:3000
npm run build   # 生产构建
npm start       # 运行生产版本
```

## Conductor SSO 与 SQLite

应用作为 Conductor SSO 第三方客户端接入，后端提供：

- `GET /api/auth/login`：生成 OAuth state cookie 并跳转到 Conductor `/oauth/authorize`
- `GET /api/auth/callback`：校验 state，向 Conductor `/api/oauth/token` 交换 code，写入本地用户与会话
- `GET|POST /api/auth/logout`：删除本地会话
- `GET /api/auth/me`：返回当前登录用户

需要在 Conductor 的 `CONDUCTOR_SSO_CLIENTS_JSON` 中注册同一个 `client_id`、`client_secret` 和回调地址：

```json
[
  {
    "client_id": "mobile-reader",
    "display_name": "Mobile Reader",
    "client_secret": "<a long random string>",
    "redirect_uris": ["http://localhost:3000/api/auth/callback"]
  }
]
```

本应用侧环境变量：

```bash
CONDUCTOR_BASE_URL=http://localhost:6152
CONDUCTOR_CLIENT_ID=mobile-reader
CONDUCTOR_CLIENT_SECRET=<same secret registered in Conductor>
MOBILE_READER_BASE_URL=http://localhost:3000
MOBILE_READER_SECRET=<random secret for encrypting stored Conductor tokens>
MOBILE_READER_DB_PATH=./data/mobile-reader.sqlite
```

`MOBILE_READER_DB_PATH` 可省略，默认写入 `./data/mobile-reader.sqlite`。数据库包含 `users`、`sessions`、`docs` 三张表，文档按本地用户隔离。

## 功能与结构

- **登录**：`app/page.tsx` 作为服务端入口，未登录时重定向到 `/login`。
- **登录页**：`app/login/page.tsx` 复用 arxiv-radar 风格，并使用 `app/animated-graph-background.tsx` 提供背景动画。
- **阅读列表**：`app/reader-home.tsx` 负责客户端上传、URL 导入、重命名和删除交互。
- **阅读页**：`app/read/[id]/page.tsx` 使用 iframe 隔离渲染原始 HTML，并保留本地评论能力。
- **文档 API**：`app/api/docs/*` 提供已登录用户的文档列表、创建、重命名、读取和删除。
- **网址导入**：`app/api/fetch-url/route.ts` 在服务端抓取页面，绕过浏览器 CORS 限制。
- **存储层**：`lib/db.ts` 管理 SQLite 用户、会话和文档；`lib/storage.ts` 是浏览器侧文档 API 与本地评论存储封装。
- **认证层**：`lib/auth.ts`、`lib/conductor-sso.ts`、`lib/crypto.ts` 负责 SSO、会话 cookie 和 token 加密。

## URL 导入限制

网址导入接口只允许 `http` 和 `https`，并屏蔽内网地址、loopback 地址和云元数据地址，避免 SSRF。抓取内容限制为 12MB，超时时间为 15s；导入时会注入 `<base>`，让相对资源在阅读 iframe 中正常加载。

## 扩展导入方式

新增导入方式只需要拿到 HTML 字符串后调用：

```ts
import { addDoc } from "@/lib/storage";

await addDoc(htmlString, "来源标签");
```

`addDoc` 会调用服务端 API，由服务端生成 id、提取标题、计算大小并写入当前用户的文档列表。

## 验证

合并后已在本地执行：

```bash
npm install
npm run build
git diff --check
```
