# Fanqie Playwright 半自动发布（MVP）

这个目录用于番茄小说创作端的半自动化流程（含独立章节发布组件）。

目标：
- 先跑通“真实浏览器会话 + 人工确认节点”的创建书本流程。
- 同时抓取关键网络请求，方便后续稳定化与 MCP 封装。

## 目录结构

- `src/run.js`：主脚本（create-book / publish-chapter / detect-book-id / record / inspect）
- `src/publishChapterFlow.js`：章节发布独立组件
- `config/example.json`：默认配置模板
- `config/local.json`：你的本地覆盖配置（不入库）
- `state/`：浏览器登录态（不入库）
- `state/book-ids.json`：自动持久化的书本 ID 历史
- `output/network/`：抓包日志 jsonl（不入库）

## 安装

```bash
cd /Volumes/Work/Projects/Morpheus/automation/fanqie-playwright
npm install
npx playwright install chromium
```

## 首次运行建议

1. 复制配置：

```bash
cp config/example.json config/local.json
```

2. 先跑抓包模式（手动点）：

```bash
npm run record
```

3. 再跑半自动创建：

```bash
npm run create-book
```

4. 跑独立章节发布组件：

```bash
npm run publish-chapter
```

5. （可选）仅检测并持久化当前账号书本 ID：

```bash
npm run detect-book-id
```

## 三种模式

- `npm run create-book`
  - 自动尝试填写书名/简介/封面。
  - 提交前会停下来等你确认。
  - 等待并打印 `/api/author/book/create/` 响应。
  - 创建成功后自动提取并持久化 `bookId`（默认写入 `config/local.json -> chapter.bookId` 和 `state/book-ids.json`）。

- `npm run publish-chapter`
  - 进入指定 `bookId` 的章节发布页。
  - 自动尝试填入章节标题和正文（可从 `contentFile` 读入）。
  - 发布前可人工确认，发布后等待并打印 `/api/author/publish_article/v0/` 响应。

- `npm run record`
  - 默认打开作者主页（`recordEntry`），你手动操作并抓包。
  - 建议用于“创建章节 -> 发布章节”全链路抓取。
  - 会持续录制，直到你按 `Ctrl+C` 停止。
  - 已覆盖整个浏览器上下文，包含新开标签页/弹窗页请求。

- `npm run inspect`
  - 进入 `page.pause()`，用于定位选择器。

- `npm run detect-book-id`
  - 从作者后台页面链接与响应中提取账号可见的 `bookId` 列表。
  - 输出 `latestBookId`，并默认自动持久化到 `config/local.json`。

## 配置说明（local.json）

关键字段：

- `book.title` / `book.intro` / `book.coverPath`
- `chapter.bookId` / `chapter.number` / `chapter.title` / `chapter.content` / `chapter.contentFile`
- `book.autoSubmit`
  - `false`：你手动点击提交
  - `true`：脚本按 `selectors.submitButton` 自动点
- `chapter.autoPublish`
  - `false`：你手动点击发布
  - `true`：脚本按 `selectors.publishButton` 自动点
  - 自动发布时内置弹窗处理链：
    - 错别字提示：点“提交”
    - 内容风险检测：点“取消”
    - 发布设置“是否使用AI”：选“是”
    - 最终弹窗：点“确认发布”
- `chapter.collapseParagraphBlankLines`
  - `true`（默认）：将正文里的连续空行压成单换行，避免编辑器出现“段间多一空行”
  - `false`：保留原始换行
- `selectors.*`
  - 这是最常需要你辅助调整的部分
  - 本页重点：`selectors.chapterNumber`（第几章输入框）与 `selectors.chapterTitle`（标题输入框）要分开
- `capture.urlIncludes`
  - 过滤要记录的接口路径（当 `captureAll=false` 时生效）
- `capture.captureAll`
  - `true` 时记录所有 HTTP 请求（默认开启）
- `capture.includeResponseBody`
  - 默认 `false`，避免全量抓包导致日志过大

## 独立章节发布组件用法（推荐）

在 `config/local.json` 里至少填这几个字段：

```json
{
  "chapter": {
    "bookId": "7609643285363035198",
    "title": "第2章 你的标题",
    "contentFile": "./config/chapter-2.md",
    "autoPublish": false
  }
}
```

然后执行：

```bash
npm run publish-chapter
```

说明：
- `autoPublish=false` 时，你可在发布前人工复核，脚本会等待 `publish_article` 响应。
- `contentFile` 不为空时优先读取文件内容；否则使用 `chapter.content`。
- 当 `contentFile` 指向 Markdown 导出文件时：
  - 自动尝试从文件首个 `# 标题` 或 `第X章 ...` 行提取标题。
  - 若提取到 `第X章 标题`，会自动拆分：`X` 填入章节号输入框，`标题` 填入标题输入框。
  - 自动去掉开头重复标题行，只发布正文内容。
  - 若你在配置里显式设置了 `chapter.title`，则优先使用配置标题。
- 一键发布接口（后端 `/api/chapters/{id}/publish`）会优先复用持久化后的 `chapter.bookId`，
  因此建议先执行一次 `npm run create-book` 或 `npm run detect-book-id` 完成绑定。

## 抓“章节发布”推荐步骤

```bash
cd /Volumes/Work/Projects/Morpheus/automation/fanqie-playwright
rm -f output/network/*.jsonl
npm run record
```

然后在浏览器里手动执行：
1. 进入你已有作品
2. 点击“创建章节”或“继续创作”
3. 填写章节标题与正文
4. 点击“发布章节”
5. 流程完成后在终端按 `Ctrl+C` 结束录制

抓完后用这个命令快速看关键 POST：

```bash
node - <<'NODE'
const fs=require('fs');
const path=require('path');
const dir='/Volumes/Work/Projects/Morpheus/automation/fanqie-playwright/output/network';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl')).sort();
for(const f of files){
  const lines=fs.readFileSync(path.join(dir,f),'utf8').trim().split('\\n').filter(Boolean);
  console.log('\\n===',f,'===');
  for(const line of lines){
    const j=JSON.parse(line);
    if(j.request.method!=='POST') continue;
    console.log(j.request.method, new URL(j.request.url).pathname, 'status='+j.response.status);
  }
}
NODE
```

## 协作开发方式（你点，我固化）

每次你跑脚本后，把这三项给我：

1. `output/network/*.jsonl` 里对应接口记录（尤其 `upload_pic_v1`、`book/create`）
2. 页面上你点击的具体位置描述（例如“右上角蓝色创建按钮”）
3. 哪一步失败、报错文案是什么

我会根据这些信息持续收敛：
- 选择器
- 等待条件
- 错误处理和重试

## 安全注意

- 你的登录态保存在 `state/`，不要提交到仓库。
- 抓包日志默认会对 Cookie/Token 头做脱敏，但仍建议视为敏感文件。
- `book.persistBookId`
  - `true`（默认）：`create-book` 成功后自动持久化 `bookId`
  - `false`：只打印，不写配置
- `book.persistDetectedBookId`
  - `true`（默认）：`detect-book-id` 成功后自动持久化 `bookId`
  - `false`：只打印，不写配置
- `paths.persistConfigPath`
  - 默认 `./config/local.json`，用于持久化 `chapter.bookId`
- `paths.bookStateFile`
  - 默认 `./state/book-ids.json`，保存 `latestBookId` 与历史
