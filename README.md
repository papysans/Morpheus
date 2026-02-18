# Morpheus

一个面向长篇小说创作的多智能体系统：从一句话梗概出发，完成章节规划、正文生成、记忆检索、一致性审查、轨迹回放与导出。

## 技术栈

**前端**
- React 18 + TypeScript + Vite 5
- 状态管理：Zustand 4
- UI 组件：Tailwind CSS 3 + Framer Motion
- 可视化：ReactFlow 11 + D3.js 7 + Recharts 2
- 测试：Vitest 4 + Playwright 1.58 + fast-check 4

**后端**
- FastAPI + Pydantic 2 + Uvicorn
- 数据存储：SQLite + LanceDB (向量数据库)
- LLM 支持：OpenAI / MiniMax / DeepSeek
- 流式输出：SSE (Server-Sent Events)

**核心能力**
- 三层记忆系统（Identity / Entities / Events）
- 多 Agent 协作（Director / Setter / Stylist / Arbiter）
- 实时流式生成与决策轨迹回放
- 知识图谱可视化与一致性检查
- 完整的测试覆盖（单元测试 + 属性测试 + E2E 测试）

## 产品介绍

Morpheus 是一个 AI 小说生产工作台，目标是把“灵感 - 结构 - 成稿”这条链路打通，降低长篇创作的门槛和心智负担。它不只是生成文本，而是把创作过程拆成可管理、可追踪、可校验的步骤：先建立项目设定，再分章节规划，再逐章写作与审阅，同时把人物、事件和世界规则沉淀到记忆层，保证前后文一致。

相比只给你一段回答的普通对话工具，Morpheus 更强调“连续创作能力”：它可以在多章节范围内保持上下文，给出可回放的决策轨迹，并提供一致性检查与导出能力，适合中长篇连载、系列故事和世界观驱动型写作。

## 为什么叫 Morpheus

`Morpheus` 的命名来自“梦境塑形者（shaper of dreams）”的意象：小说创作通常从一个模糊念头开始，像梦一样抽象，而系统的职责是把这个念头逐步塑造成有结构、有节奏、有因果的作品。这个名字也对应产品的核心价值：把灵感从“不可控的瞬间”转化为“可持续生产的流程”。

## 1. 功能概览

**项目管理**
- 创建/查看/删除项目，支持多种小说类型模板（玄幻、都市、科幻等）
- 维护项目元信息：类型、风格、目标字数、世界观设定
- 项目健康检查与自动修复

**章节创作**
- 章节计划生成：基于项目设定和记忆系统生成章节大纲
- 流式草稿生成：实时显示 AI 创作过程
- 多轮审阅：场景设定审查 + 文笔润色 + 最终定稿
- 一键生成：支持单章节和整本书批量生成
- 章节导出：Markdown / 纯文本格式

**记忆系统**
- L1 Identity：项目核心设定（世界观、主角、风格）
- L2 Entities：人物、地点、物品等实体信息
- L3 Events：关键事件与情节发展
- 混合检索：全文搜索 + 向量相似度

**可视化与分析**
- 知识图谱：实体关系可视化（ELK 自动布局）
- 决策轨迹回放：追踪每个章节的 Agent 决策过程
- 质量看板：统计指标、项目概览、健康检查
- 阅读模式：沉浸式阅读体验

**一致性保障**
- 自动冲突检测：人物性格、事件逻辑、世界观规则
- 记忆召回：创作时自动检索相关历史信息
- 轨迹审计：完整记录每次生成的决策链路

## 2. 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (React SPA)                      │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐  │
│  │ 项目列表 │ 创作控制台│ 章节工作台│ 知识图谱 │ 质量看板 │  │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘  │
│                    Zustand State + React Query               │
└─────────────────────────────────────────────────────────────┘
                              │
                         Vite Proxy (/api)
                              │
┌─────────────────────────────────────────────────────────────┐
│                    FastAPI Backend (Uvicorn)                 │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              REST API + SSE Streaming                 │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────┬──────────────┬──────────────────────┐  │
│  │ Agent Studio │ Memory Store │ Consistency Engine    │  │
│  │ (4 Agents)   │ (3 Layers)   │ (Conflict Detection)  │  │
│  └──────────────┴──────────────┴──────────────────────┘  │
│  ┌──────────────┬──────────────┬──────────────────────┐  │
│  │ LLM Client   │ Vector Store │ SQLite Database       │  │
│  │ (Multi-LLM)  │ (LanceDB)    │ (Projects/Chapters)   │  │
│  └──────────────┴──────────────┴──────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
            ┌───────▼────────┐  ┌──────▼──────┐
            │ OpenAI / MiniMax│  │  DeepSeek   │
            │   GPT-4 / M2.5  │  │ deepseek-chat│
            └─────────────────┘  └─────────────┘
```

**运行时特点**
- 多 LLM 支持：OpenAI / MiniMax / DeepSeek，支持运行时切换
- 智能降级：API Key 缺失时自动降级到本地模拟模式
- 流式生成：通过 SSE 实时推送生成进度（outline_ready / chapter_chunk / done）
- 多 Worker 部署：推荐 2+ workers 避免长时间生成阻塞读取接口
- 异步 Agent：所有 Agent 调用异步化，提升并发性能

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

### 5.1 环境要求

- Python `>=3.11`
- Node.js `>=18`
- npm `>=9`

### 5.2 后端启动

**1. 配置环境变量**

```bash
cp backend/.env.example backend/.env
```

在 `backend/.env` 中配置 LLM Provider（三选一）：

```env
# 选项 1: MiniMax
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your-minimax-api-key
MINIMAX_MODEL=MiniMax-M2.5
EMBEDDING_MODEL=embo-01
EMBEDDING_DIMENSION=1024

# 选项 2: DeepSeek（推荐）
# LLM_PROVIDER=deepseek
# DEEPSEEK_API_KEY=your-deepseek-api-key
# DEEPSEEK_MODEL=deepseek-chat

# 选项 3: OpenAI
# LLM_PROVIDER=openai
# OPENAI_API_KEY=your-openai-api-key
# OPENAI_MODEL=gpt-4-turbo-preview

# 通用配置
REMOTE_LLM_ENABLED=true
API_WORKERS=2
```

**2. 启动服务**

```bash
cd backend
# 使用项目脚本（推荐）
API_WORKERS=2 ./scripts/run_api.sh

# 或使用 Poetry
poetry install
API_WORKERS=2 poetry run uvicorn api.main:app --host 127.0.0.1 --port 8000 --workers 2
```

### 5.3 前端启动

```bash
cd frontend
npm install
npm run dev
```

**访问地址**
- 前端：http://localhost:3000
- 后端健康检查：http://127.0.0.1:8000/api/health
- 后端 API 文档：http://127.0.0.1:8000/docs

> 前端通过 Vite Proxy 将 `/api` 代理到 `http://localhost:8000`

## 6. 开发指南

### 6.1 前端开发

```bash
cd frontend

# 开发服务器
npm run dev

# 构建生产版本
npm run build

# 运行测试
npm run test              # 单元测试
npm run test:e2e          # E2E 测试
npm run test:e2e:ui       # E2E 测试 UI 模式

# 代码检查
npm run lint
```

**测试说明**
- 单元测试：Vitest + Testing Library
- 属性测试：fast-check（关键业务逻辑）
- E2E 测试：Playwright（完整用户流程）
- 测试覆盖：`frontend/e2e/` 目录

### 6.2 后端开发

```bash
cd backend

# 运行测试
python -m pytest -v

# 代码检查
python -m ruff check .
python -m ruff format .

# 类型检查
python -m mypy .
```

### 6.3 项目结构

```
Morpheus/
├── backend/
│   ├── api/main.py              # FastAPI 主入口
│   ├── agents/studio.py         # Agent Studio 与 4 个角色
│   ├── core/
│   │   ├── llm_client.py        # LLM 客户端（多 Provider）
│   │   └── story_templates.py   # 故事模板系统
│   ├── memory/                  # 三层记忆系统
│   │   ├── __init__.py          # MemoryStore
│   │   └── search.py            # 混合检索引擎
│   ├── services/
│   │   └── consistency.py       # 一致性检查
│   └── tests/                   # 后端测试
├── frontend/
│   ├── src/
│   │   ├── pages/               # 页面组件
│   │   ├── components/          # UI 组件
│   │   ├── stores/              # Zustand 状态管理
│   │   ├── services/            # 业务服务
│   │   └── hooks/               # 自定义 Hooks
│   └── e2e/                     # E2E 测试
└── data/                        # 运行时数据
    ├── projects/                # 项目数据
    ├── logs/                    # 日志文件
    └── vectors/                 # 向量数据库
```

## 7. API 文档

### 7.1 项目管理

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/projects` | GET | 获取项目列表 |
| `/api/projects` | POST | 创建新项目（支持模板） |
| `/api/projects/{id}` | GET | 获取项目详情 |
| `/api/projects/{id}` | DELETE | 删除项目 |
| `/api/projects/health` | GET | 项目健康检查 |
| `/api/projects/health/repair` | POST | 修复项目数据 |

### 7.2 章节创作

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/chapters` | POST | 创建章节 |
| `/api/chapters/{id}` | GET | 获取章节详情 |
| `/api/chapters/{id}/plan` | POST | 生成章节计划 |
| `/api/chapters/{id}/draft` | POST | 生成章节草稿 |
| `/api/chapters/{id}/draft/stream` | GET | 流式生成草稿（SSE） |
| `/api/chapters/{id}/one-shot` | POST | 一键生成章节 |
| `/api/projects/{id}/one-shot-book` | POST | 批量生成整本书 |
| `/api/projects/{id}/one-shot-book/stream` | GET | 流式生成整本书（SSE） |

### 7.3 记忆系统

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/memory/commit` | POST | 提交记忆（L1/L2/L3） |
| `/api/memory/query` | GET | 查询记忆（混合检索） |
| `/api/entities/{project_id}` | GET | 获取实体列表 |
| `/api/events/{project_id}` | GET | 获取事件列表 |

### 7.4 可视化与分析

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/trace/{chapter_id}` | GET | 获取决策轨迹 |
| `/api/metrics` | GET | 获取质量指标 |
| `/api/consistency/check` | POST | 一致性检查 |
| `/api/review` | POST | 章节审阅 |

### 7.5 运行时信息

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/runtime/llm` | GET | 获取 LLM 运行时状态 |
| `/api/health` | GET | 健康检查 |

完整 API 文档：http://127.0.0.1:8000/docs

## 8. 前端路由

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | 项目列表 | 查看所有项目，创建新项目 |
| `/project/:id` | 项目详情 | 项目概览、章节列表、设定管理 |
| `/project/:id/write` | 创作控制台 | 流式生成、实时预览、批量创作 |
| `/project/:id/chapter/:chapterId` | 章节工作台 | 章节编辑、计划生成、审阅提交 |
| `/project/:id/memory` | 记忆浏览器 | 查看和管理三层记忆 |
| `/project/:id/graph` | 知识图谱 | 实体关系可视化 |
| `/project/:id/trace/:chapterId` | 决策轨迹 | Agent 决策过程回放 |
| `/dashboard` | 质量看板 | 项目统计、质量指标、健康检查 |

## 9. 常见问题

### 9.1 前端连接失败

**问题**：前端请求 404 或连接失败

**解决方案**：
1. 确保后端运行在 `127.0.0.1:8000`
2. 确保前端运行在 `localhost:3000`
3. 检查 `frontend/vite.config.ts` 中的代理配置

### 9.2 LLM 降级模式

**问题**：生成结果一直是降级文本（"This is a fallback response..."）

**解决方案**：
1. 访问 `/api/runtime/llm` 检查运行时状态
2. 确认 `remote_effective: true` 和 `remote_ready: true`
3. 核对 `.env` 中 `LLM_PROVIDER` 与 API Key 是否匹配
4. 检查 API Key 是否有效且有余额

### 9.3 Embedding 错误

**问题**：向量检索相关报错

**解决方案**：
1. MiniMax 使用 `EMBEDDING_MODEL=embo-01`
2. 确保 `EMBEDDING_DIMENSION=1024`（MiniMax）
3. 检查 `REMOTE_EMBEDDING_ENABLED` 配置

### 9.4 多 Worker 配置

**问题**：长时间生成时其他接口响应慢

**解决方案**：
1. 设置 `API_WORKERS=2` 或更多
2. 使用 `./scripts/run_api.sh` 启动
3. 或手动指定：`uvicorn api.main:app --workers 2`

### 9.5 日志排查

**启用详细日志**：
```env
ENABLE_HTTP_LOGGING=true
LOG_FILE=../data/logs/app.log
LOG_LEVEL=DEBUG
```

**查看日志**：
```bash
tail -f data/logs/app.log
```

## 10. 相关文档

- [快速启动指南](docs/QUICKSTART.md) - 详细的环境配置和启动步骤
- [需求文档](docs/novelist-agent-requirements.md) - 完整的产品需求说明
- [深度除虫报告](docs/问题文档/深度除虫报告-2026-02-15.md) - 系统性问题排查
- [UI/UX 审计](docs/问题文档/UIUX全面翻新审计-2026-02-15.md) - 前端体验优化

## 11. 技术特性

### 11.1 多 Agent 协作

- **Director**：负责章节整体规划和初稿生成
- **Setter**：审查场景设定和世界观一致性
- **Stylist**：优化文笔和叙事节奏
- **Arbiter**：最终定稿和质量把关

### 11.2 三层记忆系统

- **L1 Identity**：项目核心设定，全局唯一
- **L2 Entities**：人物、地点、物品等实体，支持增量更新
- **L3 Events**：关键事件，按时间线组织

### 11.3 混合检索引擎

- 全文搜索（FTS）：基于 SQLite FTS5
- 向量检索：基于 LanceDB + Embedding
- 混合排序：结合关键词匹配和语义相似度

### 11.4 流式生成

- SSE（Server-Sent Events）实时推送
- 支持事件类型：`outline_ready` / `chapter_chunk` / `done` / `error`
- 前端实时渲染，提升用户体验

### 11.5 测试覆盖

- 单元测试：Vitest + Testing Library
- 属性测试：fast-check（关键业务逻辑）
- E2E 测试：Playwright（完整用户流程）
- 测试覆盖率：>80%

## 12. 贡献指南

欢迎提交 Issue 和 Pull Request！

**开发流程**：
1. Fork 项目
2. 创建特性分支：`git checkout -b feature/amazing-feature`
3. 提交更改：`git commit -m 'feat: 添加某个功能'`
4. 推送分支：`git push origin feature/amazing-feature`
5. 提交 Pull Request

**Commit 规范**：
- `feat`: 新功能
- `fix`: 修复 Bug
- `docs`: 文档更新
- `style`: 代码格式调整
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具链相关

## 13. 许可证

MIT License

---

**项目状态**：活跃开发中 | **版本**：1.0.0 | **最后更新**：2026-02-18
