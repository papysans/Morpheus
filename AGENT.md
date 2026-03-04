# AGENT.md

本文件定义在 **Morpheus** 仓库中工作的通用 AI 开发代理行为规范与项目上下文。
目标：让任何代理在最少沟通成本下，安全、稳定、可验证地完成开发任务。

---

## 1) 项目定位（你正在维护什么）

Morpheus 是一个多智能体小说创作系统，核心链路是：

1. 项目设定初始化
2. 章节规划（Plan）
3. 正文生成（Draft，支持 SSE 流式）
4. 一致性审查（Consistency）
5. 记忆回写（L1/L2/L3）
6. 轨迹回放与可视化

系统由前后端组成：

- **Backend**: FastAPI + Pydantic + SQLite + LanceDB
- **Frontend**: React + TypeScript + Vite + Zustand + Tailwind
- **Agent Studio**: Director / Setter / Stylist / Arbiter 四角色协作

---

## 2) 关键目录（先看哪里）

```text
backend/
  api/main.py              # 主 API（大型单体，含 REST + SSE 入口）
  agents/studio.py         # 多 Agent 编排逻辑
  memory/__init__.py       # 三层记忆核心实现
  memory/search.py         # 混合检索（FTS + 向量）
  services/consistency.py  # 一致性检查规则
  core/llm_client.py       # 多 LLM Provider 适配与降级

frontend/
  src/pages/               # 路由页面（核心业务页面集中）
  src/stores/              # Zustand 状态管理
  src/hooks/useSSEStream.ts# 流式生成客户端
```

> 注意：`backend/api/main.py` 体量较大，改动前先定位具体 endpoint/模型/服务调用链，避免“全文件扫射式”修改。

---

## 3) 本地运行与开发命令

### Backend（在 `backend/` 目录执行）

```bash
poetry install
poetry run uvicorn api.main:app --reload

# 推荐多 worker，减少长生成阻塞
API_WORKERS=2 ./scripts/run_api.sh

# 测试与质量
python -m pytest -v
python -m ruff check .
python -m ruff format .
python -m mypy .
```

### Frontend（在 `frontend/` 目录执行）

```bash
npm install
npm run dev

# 质量与测试
npm run lint
npm run test
npm run build
```

---

## 4) 配置与运行时约束

- 后端配置文件：`backend/.env`（参考 `.env.example`）
- 关键环境变量：
  - `LLM_PROVIDER`：`deepseek`
  - `API_WORKERS`：建议 `2+`
  - `GRAPH_FEATURE_ENABLED` / `L4_PROFILE_ENABLED`：图谱相关开关

运行链路：

- 前端通过 Vite 代理 `/api` 到后端 `:8000`
- 长文本生成采用 **SSE**（不是 WebSocket）

---

## 5) 开发原则（必须遵守）

1. **先读后改**：先定位现有模式，再做最小必要改动。
2. **保持风格一致**：
   - Python：Ruff/Black 风格、类型清晰
   - TypeScript：strict 模式，不引入 `any` 逃逸
3. **禁止破坏性改动**：除非明确要求，不做数据库结构破坏、批量删除、接口协议破坏。
4. **不提交运行时数据**：`data/` 下内容为运行产物，不应纳入版本控制。
5. **不在未验证情况下宣称完成**：必须给出实际验证结果。
6. **提交信息使用中文**：所有 git commit message 必须使用中文。

---

## 6) 任务执行标准流程（代理工作流）

每次实现/修复默认遵循：

1. **定位影响面**：确认涉及 backend / frontend / memory / stream 哪些模块。
2. **对齐现有实现**：优先复用已有工具函数与状态流，不重复造轮子。
3. **实施最小改动**：先做最小可工作的修改，再扩展。
4. **本地验证**（至少覆盖改动侧）：
   - 后端改动：`pytest` + `ruff check` + `mypy`
   - 前端改动：`npm run lint` + `npm run test` + `npm run build`
5. **输出变更说明**：说明改了什么、为什么改、如何验证。

---

## 7) 高风险区域与注意事项

### A. SSE 流式链路

- 关注事件类型一致性：`outline_ready` / `chapter_chunk` / `done` / `error`
- 前后端事件字段名必须严格对齐

### B. 记忆系统（L1/L2/L3）

- 不要绕过记忆回写流程直接写“最终态”
- 关注实体更新窗口、事件置信度与检索排序影响

### C. 一致性检查

- 规则调整要提供示例输入/输出，避免误报率上升

### D. API 单体文件

- 在 `backend/api/main.py` 修改时，尽量抽取到 `services/` 或 `core/`，避免继续膨胀

---

## 8) 常见任务模板（给代理的快捷指令）

### 新增后端接口

1. 在 `api/main.py` 增加路由与请求/响应模型
2. 业务逻辑优先下沉到 `services/` 或 `core/`
3. 补充/更新测试（`backend/tests/`）
4. 运行：`pytest` + `ruff check` + `mypy`

### 调整前端页面行为

1. 优先检查对应 page + store + service + hook
2. 保持 Zustand 状态流与现有页面约定一致
3. 补测（Vitest 必要时 + E2E 关键路径）
4. 运行：`npm run lint && npm run test && npm run build`

### 修复一致性/记忆相关 bug

1. 先最小复现
2. 确认问题在“检索召回 / 规则判断 / 回写过程”哪一层
3. 加回归测试避免复发

---

## 9) 完成定义（Definition of Done）

仅当以下全部满足，任务才算完成：

- 功能按需求实现，且未引入明显回归
- 相关测试通过
- 代码质量检查通过（lint/type/build）
- 变更说明清晰（影响范围 + 验证命令 + 结果）

---

## 10) 语言与文档约定

- 产品/UI 文案以中文为主
- 代码标识符与技术注释优先英文
- 文档可中英混写，但需保证团队可读性与可维护性

---

如无特殊说明，代理应优先采用“最小、可验证、可回滚”的改动策略。
