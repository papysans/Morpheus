# Morpheus

> 一个面向长篇小说创作的开源多智能体写作工作台：把 **项目设定、批量生成、逐章修改、连续性维护、轨迹回放与导出** 放进同一套工作流。

Morpheus 不只是“给你一段文本”的写作助手，而是一个适合中长篇小说、连载作品和世界观驱动型故事的 **AI-native writing studio**。它把创作拆成可管理的步骤：先定义项目，再批量生成，再逐章重写，再通过记忆、审阅和轨迹系统维持长期一致性。

![Morpheus Hero](docs/assets/readme/herocard.png)

## Why Morpheus

- **Multi-agent，而不是单提示词生成**：把规划、设定、连续性、文风和裁决拆到不同角色上协作完成。
- **Chapter-first workflow**：先批量推进，再回到章节工作台按“修改方向”重做单章，而不是一把梭整本重生。
- **Memory-aware writing**：不是只靠上下文窗口，而是通过 L1/L2/L3、运行态记忆、开放线程和摘要压缩维持连续性。
- **Reviewable and traceable**：可以看冲突、看轨迹、看指标，知道系统为什么这样写，而不是只能接受结果。
- **Open-source product surface**：项目创建、生成、修改、图谱、轨迹、导出都已经具备真实 UI 和 API，不只是一个 prompt demo。

## Quick Start

### 1. 启动后端

```bash
cp backend/.env.example backend/.env
cd backend
poetry install
API_WORKERS=2 ./scripts/run_api.sh
```

### 2. 启动前端

```bash
cd frontend
npm install
npm run dev
```

默认访问地址：
- 前端：`http://localhost:3000`
- 后端 API：`http://127.0.0.1:8000/docs`

> 注意：前端默认代理目标是 `http://localhost:8001`。如果你的后端跑在 `8000`，请显式启动：

```bash
VITE_API_PROXY_TARGET=http://localhost:8000 npm run dev
```


## Core Workflow

1. **定义项目**：填写项目名、题材、文风契约、禁忌约束、目标篇幅与故事梗概。  
2. **批量生成**：在创作控制台输入创作方向，按模式、章节数和字数启动批量生成。  
3. **逐章修改**：进入章节工作台，基于冲突、蓝图与正文流选择继续写、改写、重做。  
4. **维护连续性**：通过三层记忆、运行态、开放线程和一致性规则持续校准上下文。  
5. **审阅与导出**：查看轨迹、指标、图谱与章节导出结果，形成完整生产链路。  

## Use Cases

- **长篇网文 / 连载小说**：需要持续推进章节，同时维持人物关系、设定和伏笔不崩。
- **世界观密集型作品**：适合需要跨章节追踪规则、实体和事件链的故事。
- **修订驱动的创作流程**：先快速铺量，再用章节工作台精修局部段落和整章方向。
- **AI 协作写作实验**：适合研究多 Agent 分工、轨迹审计和 prompt/process 设计。
- **可导出的生产工作流**：从设定到草稿到导出，适合形成完整项目资产。

## Product Surfaces

除了核心生成流程，Morpheus 现在已经具备多块可独立演示的产品表面：

- **项目创建与模板**：题材/文风预设、自定义输入、梗概写入记忆
- **创作控制台**：批量生成、续写、日志、统计、审批流
- **章节工作台**：蓝图、冲突、正文流、修改方向、重做本章
- **记忆 / 图谱 / 轨迹**：Memory Browser、Knowledge Graph、Trace Replay
- **导出**：章节/整书导出与项目级导入导出

![Morpheus Supporting Surface](docs/assets/readme/workflow.jpeg)

## 技术栈

**前端**
- React 18 + TypeScript + Vite 5
- Zustand 4
- Tailwind CSS 3 + Framer Motion
- ReactFlow 11 + D3.js 7 + Recharts 2
- Vitest 4 + Playwright 1.58 + fast-check 4

**后端**
- FastAPI + Pydantic 2 + Uvicorn
- SQLite + LanceDB
- DeepSeek（唯一运行时 LLM）
- SSE（Server-Sent Events）

## 当前产品能力

### 1. 项目创建与模板
- 创建项目时可填写：项目名、题材、文风契约、目标篇幅、禁忌约束、故事梗概
- 题材/文风支持“预设下拉 + 自定义输入”
- 支持从故事模板一键带入建议题材、文风、篇幅和禁忌约束
- `synopsis` 会写入项目身份记忆，供后续生成流程直接引用

相关代码：
- `frontend/src/components/project/ProjectCreateModal.tsx`
- `frontend/src/stores/useProjectStore.ts`
- `backend/api/main.py`

### 2. 创作控制台（批量生成）
- 主输入已从旧的“一句话梗概”收敛为“创作方向（batch direction）”
- 支持选择生成模式：`studio / quick / cinematic`
- 支持设置章节数、每章字数、自动审批
- 支持“从最新章节续写”
- 流式显示章节内容、目录、日志和统计信息

相关代码：
- `frontend/src/pages/WritingConsolePage.tsx`
- `frontend/src/hooks/useSSEStream.ts`
- `frontend/src/stores/useStreamStore.ts`

### 3. 章节工作台（逐章修改）
- 查看蓝图、冲突、草稿与多通道流式输出（导演 / 设定 / 润色 / 终稿）
- 支持正文手工编辑与保存
- 支持填写“修改方向”，重新生成蓝图或重做本章
- 当后续章节已存在时，会提醒重做本章可能导致上下文不一致

相关代码：
- `frontend/src/pages/ChapterWorkbenchPage.tsx`
- `backend/api/main.py`

### 4. 记忆、轨迹与分析
- 记忆子系统以 L1 / L2 / L3 为核心，并额外包含 `RUNTIME_STATE`、`OPEN_THREADS` 等运行态派生记忆
- `MemoryContextService` 会把身份记忆、运行态、开放线程、章节摘要等装配成 generation context pack
- 决策轨迹回放页面
- Dashboard 质量看板
- Memory Browser 记忆浏览器

### 5. 知识图谱
- 图谱不是独立于记忆的“第四层主架构”，而是建立在 L4 角色档案、图节点覆盖层与审计日志之上的独立子系统
- 但它受 `VITE_GRAPH_FEATURE_ENABLED` 开关控制；关闭时页面会直接显示“功能已暂时关闭”

相关代码：
- `frontend/src/pages/KnowledgeGraphPage.tsx`
- `frontend/src/config/features.ts`

## 系统架构

> **架构澄清**：Morpheus 的“**三层**”现在只准确对应**记忆子系统**，不再能概括整个平台。
> 平台整体更接近一个**多子系统架构**：前端工作台、FastAPI/SSE 接口层、多 Agent 编排层、上下文装配与回写层、记忆与检索层、可选 L4 角色档案/图谱子系统、审阅一致性子系统、轨迹与指标子系统、导入导出子系统共同组成当前运行时。

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                            Browser / React SPA                              │
│  项目列表 · 项目详情 · 创作控制台 · 章节工作台 · 记忆浏览器 · 图谱 · 轨迹 · 看板 │
│                    Zustand Stores + SSE Runtime State                      │
└──────────────────────────────────────────────────────────────────────────────┘
                                   │
                              Vite Proxy (/api)
                                   │
┌──────────────────────────────────────────────────────────────────────────────┐
│                           FastAPI Application Layer                          │
│                 REST API · SSE Streaming · Import / Export                  │
├───────────────────────────────┬──────────────────────────────────────────────┤
│ Multi-Agent Orchestration     │ Review / Consistency / Metrics / Trace      │
│ Agent Studio · DeepSeek       │ 审阅动作 · 冲突规则 · 轨迹回放 · 项目指标         │
├───────────────────────────────┼──────────────────────────────────────────────┤
│ Context Assembly / Writeback  │ Memory & Retrieval Core                      │
│ Context Pack · Chapter Writeback│ L1/L2/L3 文件记忆 · SQLite 索引 · LanceDB   │
├───────────────────────────────┼──────────────────────────────────────────────┤
│ Optional L4 Profile / Graph   │ Project Persistence                          │
│ 角色画像 · 图节点覆盖 · 审计日志   │ Projects / Chapters / Traces / Exports      │
└───────────────────────────────┴──────────────────────────────────────────────┘
```

**运行时特点**
- 单 LLM：DeepSeek
- API Key 缺失时自动降级到本地 fallback
- 章节与整书生成通过 SSE 推送进度和正文片段
- 推荐 `API_WORKERS=2+`，避免长生成阻塞读接口

### 架构拆解（按当前源码）

#### 1. 前端工作台层
- 路由级页面由 `frontend/src/App.tsx` 组织
- 当前不是“单工作台”结构，而是多页面工作流：项目、批量生成、逐章编辑、记忆浏览、图谱、轨迹、Dashboard

#### 2. API / 流式接口层
- `backend/api/main.py` 承担主要 REST 与 SSE 入口
- 同时承载项目、章节、审阅、图谱、档案、轨迹、导入导出、运行时诊断等接口

#### 3. 多 Agent 编排层
- `backend/agents/studio.py` 负责导演 / 设定 / 连续性 / 文风 / 裁决等角色编排
- DeepSeek 作为当前唯一运行时模型，由 `backend/core/llm_client.py` 提供统一入口

#### 4. 上下文装配与回写层
- `backend/services/memory_context.py` 负责构建 generation context pack
- 它把 identity、runtime state、memory compact、previous synopsis、open threads、previous chapters compact 等内容组合后再交给生成流程

#### 5. 记忆与检索层
- `backend/memory/__init__.py` 中的 `ThreeLayerMemory` 仍然定义核心三层：L1 / L2 / L3
- 但当前实际运行时还包含 `RUNTIME_STATE.md`、`OPEN_THREADS.md` 等派生记忆，以及 `MemoryStore` 的 SQLite/FTS/LanceDB 检索能力

#### 6. 审阅 / 一致性 / 轨迹层
- `backend/services/consistency.py` 提供时间线、角色状态、关系、世界规则等一致性检查
- `backend/api/main.py` 中的 `/api/review`、`/api/trace/*`、`/api/metrics` 构成独立的质量控制与可观测性子系统

#### 7. 可选 L4 档案 / 图谱子系统
- `backend/models/__init__.py` 已定义 `Layer.L4`
- 实际实现体现在 `MemoryStore` 的 `character_profiles`、`graph_node_overrides`、`graph_node_aliases`、`graph_audit_log`
- 前端图谱页面消费的是这个子系统，而不是简单把它当作“三层记忆的第 4 层文件夹”

#### 8. 导入导出与项目持久化层
- `backend/api/main.py` 提供项目 ZIP 导入导出
- `frontend/src/services/exportService.ts`、`ChapterExportMenu` 支持章节/整书导出

## 目录结构

```text
Morpheus/
  backend/
    api/main.py            # 主 API 入口（REST + SSE）
    agents/                # Agent Studio 与角色提示词
    core/                  # LLM 客户端、故事模板等
    memory/                # L1/L2/L3 记忆、索引同步、L4 档案/图谱覆盖存储
    services/              # 上下文打包、画像抽取/合并、一致性校验等服务
    tests/                 # 后端测试
  frontend/
    src/pages/             # 项目列表、创作控制台、章节工作台、图谱等页面
    src/components/        # 组件与项目弹窗、阅读模式等 UI
    src/stores/            # Zustand stores
    src/hooks/             # SSE、自动保存等 hooks
    e2e/                   # Playwright E2E
  data/                    # 运行时数据库、向量与项目产物（git ignore）
  docs/                    # 文档与实现计划
```

## 环境要求

- Python `>=3.11`
- Node.js `>=18`
- npm `>=9`

## 运行配置

常用环境变量示例：

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat

API_WORKERS=2
LOG_LEVEL=info
GRAPH_FEATURE_ENABLED=true
L4_PROFILE_ENABLED=true
```

### 生产部署

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## 开发命令

### 前端

```bash
cd frontend

npm run dev
npm run build
npm run lint
npm run test
npm run test:e2e
npm run test:e2e:headed
npm run test:e2e:ui
```

### 后端

```bash
cd backend

python -m pytest -v
python -m pytest tests/test_api_smoke.py -v
python -m pytest tests/test_l4_api.py -v

python -m ruff check .
python -m ruff format .
python -m mypy .
```

## 前端路由

| 路径 | 页面 | 说明 |
|------|------|------|
| `/` | 项目列表 | 查看项目、创建项目 |
| `/project/:projectId` | 项目详情 | 项目概览、章节列表、导出入口 |
| `/project/:projectId/write` | 创作控制台 | 批量生成、续写、日志、统计 |
| `/project/:projectId/chapter` | 章节工作台 | 章节工作台入口 |
| `/project/:projectId/chapter/:chapterId` | 章节工作台 | 蓝图、冲突、草稿、修改方向 |
| `/project/:projectId/memory` | 记忆浏览器 | 三层记忆查看 |
| `/project/:projectId/graph` | 知识图谱 | 图谱页面（受 feature flag 控制） |
| `/project/:projectId/trace` | 轨迹回放 | 决策轨迹总览 |
| `/project/:projectId/trace/:chapterId` | 轨迹回放 | 指定章节轨迹 |
| `/dashboard` | 质量看板 | 统计指标与健康信息 |

## 关键 API

### 项目
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/{id}`
- `DELETE /api/projects/{id}`

### 整书 / 批量生成
- `POST /api/projects/{id}/one-shot-book`
- `GET /api/projects/{id}/one-shot-book/stream`

### 章节
- `GET /api/chapters/{id}`
- `POST /api/chapters/{id}/plan`
- `GET /api/chapters/{id}/draft/stream`
- `POST /api/review`

### 记忆 / 图谱 / 轨迹
- `GET /api/entities/{project_id}`
- `GET /api/events/{project_id}`
- `GET /api/trace/{chapter_id}`
- `GET /api/runtime/llm`
- `GET /api/health`

完整 OpenAPI 文档：`http://127.0.0.1:8000/docs`

## 当前开发约定

- 提交风格以 `feat(...)` / `fix(...)` / `refactor(...)` / `chore(...)` 为主
- UI 文案以中文为主
- 运行时 LLM 固定为 DeepSeek
- 数据目录 `data/` 为运行时产物，不进 git

## 相关文档

- `docs/QUICKSTART.md`
- `docs/novelist-agent-requirements.md`
- `docs/knowledge-graph-standard-mode.md`
- `docs/writing-console-simplification-plan.md`

---

**项目状态**：活跃开发中  
**版本**：1.0.0
