# Morpheus

一个面向长篇小说创作的多智能体系统：从一句话梗概出发，完成章节规划、正文生成、记忆检索、一致性审查、轨迹回放与导出。

- 前端：React + TypeScript + Vite + Zustand
- 后端：FastAPI + Pydantic + SQLite/LanceDB
- 核心能力：多层记忆、SSE 流式生成、冲突检查、评测看板

## 产品介绍

Morpheus 是一个 AI 小说生产工作台，目标是把“灵感 - 结构 - 成稿”这条链路打通，降低长篇创作的门槛和心智负担。它不只是生成文本，而是把创作过程拆成可管理、可追踪、可校验的步骤：先建立项目设定，再分章节规划，再逐章写作与审阅，同时把人物、事件和世界规则沉淀到记忆层，保证前后文一致。

相比只给你一段回答的普通对话工具，Morpheus 更强调“连续创作能力”：它可以在多章节范围内保持上下文，给出可回放的决策轨迹，并提供一致性检查与导出能力，适合中长篇连载、系列故事和世界观驱动型写作。

## 为什么叫 Morpheus

`Morpheus` 的命名来自“梦境塑形者（shaper of dreams）”的意象：小说创作通常从一个模糊念头开始，像梦一样抽象，而系统的职责是把这个念头逐步塑造成有结构、有节奏、有因果的作品。这个名字也对应产品的核心价值：把灵感从“不可控的瞬间”转化为“可持续生产的流程”。

## 1. 功能概览

- 项目管理：创建/查看/删除项目，维护类型、风格、目标字数
- 章节工作台：章节计划、草稿生成、审阅提交、冲突检测
- 一句话整卷/整本：按配置批量生成多章节（支持流式）
- 记忆系统：写作记忆提交与检索（Identity / Entities / Events）
- 知识图谱与轨迹回放：追踪决策链路与实体事件关系
- 导出能力：章节导出、整书导出（Markdown/TXT）
- 质量看板：统计指标、项目概览、健康检查

## 2. 系统架构

```
Browser (React)
  -> /api (Vite Proxy)
FastAPI Backend
  -> Agent Studio / LLM Client
  -> Consistency Engine
  -> Memory Store (SQLite + Vector)
  -> Data files in ../data
```

运行时特点：
- 支持 `minimax`、`openai`、`deepseek` 三种 LLM provider
- 支持远程/离线回退策略（缺少 API Key 时可降级）
- 流式生成通过 SSE 返回事件（`outline_ready`、`chapter_chunk`、`done` 等）

## 3. 目录结构

```
Morpheus/
  backend/                 # FastAPI 服务与智能体逻辑
    api/main.py            # 主 API 入口
    agents/                # Agent Studio 与角色提示词
    memory/                # 多层记忆与检索
    services/              # 一致性校验等服务
    core/llm_client.py     # LLM / Embedding 调用与回退
  frontend/                # React 应用
    src/pages/             # 核心页面（项目、写作、工作台、图谱等）
    src/components/        # UI 组件
    src/stores/            # Zustand 状态管理
    src/services/          # 前端业务服务（导出等）
  data/                    # 运行时数据（数据库、向量、日志、项目产物）
  docs/                    # 文档与问题审计
```

## 4. 环境要求

- Python `>=3.11`
- Node.js `>=18`
- npm `>=9`

## 5. 快速启动

### 5.1 后端

先配置环境变量：

```bash
cp /Volumes/Work/Projects/Morpheus/backend/.env.example /Volumes/Work/Projects/Morpheus/backend/.env
```

在 `/Volumes/Work/Projects/Morpheus/backend/.env` 中至少配置：

```env
LLM_PROVIDER=minimax
REMOTE_LLM_ENABLED=true
MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_MODEL=MiniMax-M2.5

# 若使用 DeepSeek：
# LLM_PROVIDER=deepseek
# DEEPSEEK_API_KEY=your-deepseek-api-key
# DEEPSEEK_BASE_URL=https://api.deepseek.com
# DEEPSEEK_MODEL=deepseek-chat

EMBEDDING_MODEL=embo-01
EMBEDDING_DIMENSION=1024
REMOTE_EMBEDDING_ENABLED=false
```

启动后端：

```bash
cd /Volumes/Work/Projects/Morpheus/backend
# 推荐多 worker（避免长时间生文阻塞读取接口）
API_WORKERS=2 ./scripts/run_api.sh
```

如未使用项目内 `venv`，可选使用 Poetry：

```bash
cd /Volumes/Work/Projects/Morpheus/backend
poetry install
API_WORKERS=2 poetry run uvicorn api.main:app --host 127.0.0.1 --port 8000 --workers 2
```

### 5.2 前端

```bash
cd /Volumes/Work/Projects/Morpheus/frontend
npm install
npm run dev
```

默认访问：
- 前端：[http://localhost:3000](http://localhost:3000)
- 后端健康检查：[http://127.0.0.1:8000/api/health](http://127.0.0.1:8000/api/health)

说明：前端通过 Vite Proxy 将 `/api` 代理到 `http://localhost:8000`。

## 6. 常用开发命令

### 前端

```bash
cd /Volumes/Work/Projects/Morpheus/frontend
npm run dev
npm run build
npm run test
npm run test:e2e
```

E2E 说明：
- 用例目录：`/Volumes/Work/Projects/Morpheus/frontend/e2e`
- Playwright 配置：`/Volumes/Work/Projects/Morpheus/frontend/playwright.config.ts`
- 默认要求前后端已启动（`3002` 与 `8000`）；可通过环境变量覆盖：
  - `E2E_APP_BASE_URL`
  - `E2E_API_BASE_URL`

### 后端

```bash
cd /Volumes/Work/Projects/Morpheus/backend
venv/bin/python -m pytest -q
venv/bin/python -m ruff check .
```

## 7. 关键 API（节选）

项目与运行时：
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/{project_id}`
- `GET /api/projects/health`
- `POST /api/projects/health/repair`
- `GET /api/runtime/llm`

章节与生成：
- `POST /api/chapters`
- `GET /api/chapters/{chapter_id}`
- `POST /api/chapters/{chapter_id}/plan`
- `POST /api/chapters/{chapter_id}/draft`
- `GET /api/chapters/{chapter_id}/draft/stream`
- `POST /api/chapters/{chapter_id}/one-shot`
- `POST /api/projects/{project_id}/one-shot-book`
- `POST /api/projects/{project_id}/one-shot-book/stream`

记忆与一致性：
- `POST /api/memory/commit`
- `GET /api/memory/query`
- `POST /api/consistency/check`
- `POST /api/review`

可视化与分析：
- `GET /api/trace/{chapter_id}`
- `GET /api/entities/{project_id}`
- `GET /api/events/{project_id}`
- `GET /api/metrics`

## 8. 前端页面路由

- `/`：项目列表
- `/project/:projectId`：项目详情
- `/project/:projectId/write`：创作控制台
- `/project/:projectId/chapter/:chapterId`：章节工作台
- `/project/:projectId/memory`：记忆浏览器
- `/project/:projectId/graph`：知识图谱
- `/project/:projectId/trace/:chapterId`：决策轨迹回放
- `/dashboard`：评测看板

## 9. 常见问题

1. 前端请求 404/连接失败
- 确保后端运行在 `127.0.0.1:8000`
- 确保前端运行在 `3000`，且 `vite.config.ts` 代理未改坏

2. 生成结果一直是降级文本
- 检查 `/api/runtime/llm` 的 `remote_effective` 与 `remote_ready`
- 核对 `.env` 中 provider 与 API Key 是否匹配

3. Embedding 相关报错
- MiniMax 建议使用 `EMBEDDING_MODEL=embo-01`
- 确保 `EMBEDDING_DIMENSION` 与模型一致（MiniMax 为 1024）

4. 日志排查
- 可在 `.env` 开启：`ENABLE_HTTP_LOGGING=true`
- 可设置：`LOG_FILE=../data/logs/app.log`

## 10. 相关文档

- 快速启动：`/Volumes/Work/Projects/Morpheus/docs/QUICKSTART.md`
- 需求文档：`/Volumes/Work/Projects/Morpheus/docs/novelist-agent-requirements.md`
- 深度除虫报告：`/Volumes/Work/Projects/Morpheus/docs/问题文档/深度除虫报告-2026-02-15.md`
- UI/UX 审计：`/Volumes/Work/Projects/Morpheus/docs/问题文档/UIUX全面翻新审计-2026-02-15.md`

---

如果你希望，我可以再补一版「面向产品/运营」的 README（非技术版），把功能和使用流程写成更易读的用户手册。
