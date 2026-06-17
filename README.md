# 阅读 · Mobile Reader

一个移动端友好的 HTML 阅读器：使用 Conductor SSO 登录后，上传文件或导入网址，加入个人阅读列表，点击即可沉浸阅读。

![预览](docs/screenshot.png)

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

## 功能

- **添加文档**：点击「＋ 添加」选择来源：
  - **上传文件**：选择本地 `.html`（支持多选），也可直接拖拽到页面。
  - **从网址导入**：输入链接，由服务端抓取该页面 HTML 加入列表（自动补全 `https://`，并注入 `<base>` 让相对资源在阅读时正常加载）。
- **阅读列表**：自动从 `<title>`（或首个 `<h1>`）提取标题，按添加时间倒序显示。
- **阅读**：点击列表项进入 `/read/[id]`，原始 HTML 在隔离的 `<iframe>` 中渲染，完整保留其自带样式与脚本，并带返回栏。
- **评论**：阅读时选中文本可添加评论，评论定位保存在浏览器本地。
- **管理**：每项的 `⋯` 菜单支持打开 / 重命名 / 删除。
- **多用户持久化**：文档存在服务端 **SQLite**，每个 Conductor 用户只看到自己的阅读列表。
- 自适应浅色 / 深色，适配刘海屏安全区。

## 结构

| 文件 | 作用 |
| --- | --- |
| `app/page.tsx` | 登录校验 + 阅读列表入口 |
| `app/reader-home.tsx` | 阅读列表 + 上传交互 |
| `app/login/page.tsx` | Conductor SSO 登录入口 |
| `app/read/[id]/page.tsx` | 阅读页（iframe 隔离渲染 + 评论） |
| `app/api/auth/*` | Conductor SSO 登录、回调、退出、当前用户 |
| `app/api/docs/*` | 已登录用户的文档列表、创建、重命名、删除 |
| `app/api/fetch-url/route.ts` | 服务端抓取网址的接口（绕过 CORS，含 SSRF 防护） |
| `lib/db.ts` | SQLite 存储层（用户、会话、文档） |
| `lib/storage.ts` | 浏览器侧文档 API 调用封装 + 本地评论存储 |
| `app/globals.css` | 全局主题与移动端样式 |

> 网址导入走服务端是因为浏览器直接 `fetch` 跨域页面会被 CORS 拦截。接口限制 http/https、屏蔽内网与云元数据地址（SSRF）、限制 12MB 与 15s 超时。

## 扩展其他导入方式

新增导入方式（粘贴、URL 抓取、云端同步等）只需拿到 HTML 字符串后调用：

```ts
import { addDoc } from "@/lib/storage";
await addDoc(htmlString, "来源标签");
```

`addDoc` 与来源无关，会自动生成 id、提取标题、计算大小并写入列表。
