# 阅读 · Mobile Reader

一个移动端阅读友好的 Next.js Web App：上传 HTML 文件 → 加入阅读列表 → 点击进入沉浸阅读。

## 运行

```bash
npm run dev     # 开发，http://localhost:3000
npm run build   # 生产构建
npm start       # 运行生产版本
```

## 功能

- **添加文档**：点击「＋ 添加」选择来源——
  - **上传文件**：选择本地 `.html`（支持多选），也可直接拖拽到页面。
  - **从网址导入**：输入链接，由服务端抓取该页面 HTML 加入列表（自动补全 `https://`，并注入 `<base>` 让相对资源在阅读时正常加载）。
- **阅读列表**：自动从 `<title>`（或首个 `<h1>`）提取标题，按添加时间倒序显示。
- **阅读**：点击列表项进入 `/read/[id]`，原始 HTML 在隔离的 `<iframe>` 中渲染，完整保留其自带样式与脚本，并带返回栏。
- **管理**：每项的 `⋯` 菜单支持打开 / 重命名 / 删除。
- **离线持久化**：文档存在浏览器本地 **IndexedDB**，无需后端，刷新与离线均可访问。
- 自适应浅色 / 深色，适配刘海屏安全区。

## 结构

| 文件 | 作用 |
| --- | --- |
| `app/page.tsx` | 阅读列表 + 上传交互 |
| `app/read/[id]/page.tsx` | 阅读页（iframe 隔离渲染） |
| `app/api/fetch-url/route.ts` | 服务端抓取网址的接口（绕过 CORS，含 SSRF 防护） |
| `lib/storage.ts` | IndexedDB 存储层（元数据与正文分库）+ 标题提取 |
| `app/globals.css` | 全局主题与移动端样式 |

> 网址导入走服务端是因为浏览器直接 `fetch` 跨域页面会被 CORS 拦截。接口限制 http/https、屏蔽内网与云元数据地址（SSRF）、限制 12MB 与 15s 超时。

## 扩展其他导入方式

新增导入方式（粘贴、URL 抓取、云端同步等）只需拿到 HTML 字符串后调用：

```ts
import { addDoc } from "@/lib/storage";
await addDoc(htmlString, "来源标签");
```

`addDoc` 与来源无关，会自动生成 id、提取标题、计算大小并写入列表。
