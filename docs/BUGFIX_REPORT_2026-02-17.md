# Morpheus 系统级除虫修复文档（2026-02-17）

## 1. 本轮结论
- 结论：未发现新的阻断级问题（P0/P1）。
- 当前状态：核心链路（项目创建/进入/切换/删除、章节输入、阅读与工作台）可用。
- 说明：`npm run lint` 无法执行，不是代码错误，而是仓库当前未配置 ESLint 配置文件（历史状态）。

## 2. 已修复问题

### 2.1 跨项目串数据（进入 B 项目却显示 A 项目）
- 现象：页面在 `currentProject` 非空时不重拉数据，导致 route 已切换但项目上下文仍是旧值。
- 根因：页面只判断 `!currentProject`，未比较 `currentProject.id` 与 `route.projectId`。
- 修复：统一改为 `projectId && currentProject?.id !== projectId` 时强制拉取。
- 影响文件：
  - `/Volumes/Work/Projects/Morpheus/frontend/src/pages/WritingConsolePage.tsx`
  - `/Volumes/Work/Projects/Morpheus/frontend/src/pages/MemoryBrowserPage.tsx`
  - `/Volumes/Work/Projects/Morpheus/frontend/src/pages/KnowledgeGraphPage.tsx`

### 2.2 Project not found 页面仍显示“当前项目”侧栏子导航
- 现象：项目已删除/不存在时，左侧仍出现该项目子导航，造成误导。
- 根因：Sidebar 仅依据 URL 是否含 `projectId` 渲染子导航。
- 修复：引入 `projectError` + `projectResolved` 判定，`not found` 场景隐藏项目子导航。
- 影响文件：
  - `/Volumes/Work/Projects/Morpheus/frontend/src/components/layout/Sidebar.tsx`

### 2.3 数字输入 UX（不能顺滑清空再重输）
- 现象：章节号/字数输入中，用户清空或改写时体验割裂。
- 根因：直接用 number state 绑定，输入过程与提交态耦合。
- 修复：采用 `string input state + parse on blur/commit` 模式。
- 影响文件：
  - `/Volumes/Work/Projects/Morpheus/frontend/src/pages/ProjectDetail.tsx`
  - `/Volumes/Work/Projects/Morpheus/frontend/src/pages/ChapterWorkbenchPage.tsx`

## 3. 新增回归测试
- `/Volumes/Work/Projects/Morpheus/frontend/src/pages/__tests__/WritingConsolePage.test.tsx`
- `/Volumes/Work/Projects/Morpheus/frontend/src/pages/__tests__/MemoryBrowserPage.test.tsx`
- `/Volumes/Work/Projects/Morpheus/frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx`
- `/Volumes/Work/Projects/Morpheus/frontend/src/components/layout/__tests__/Sidebar.test.tsx`
- `/Volumes/Work/Projects/Morpheus/frontend/src/pages/__tests__/ProjectDetail.test.tsx`
- `/Volumes/Work/Projects/Morpheus/frontend/src/pages/__tests__/ChapterWorkbenchPage.test.tsx`

## 4. 验证结果

### 4.1 自动化测试
- 前端：`npm test -- --run` 通过（`434 passed`）。
- 后端：`venv/bin/python -m pytest -q` 通过（`28 passed`）。
- 前端构建：`npm run build` 通过。

### 4.2 Playwright 回归
- 报告：`/Volumes/Work/Projects/Morpheus/output/playwright/system_bugfix_verify_2026-02-17T16-24-09-175Z.json`
- 结果：`ok = true`
- 覆盖检查：
  - 项目 A/B 切换后上下文正确
  - 项目详情章节号输入可清空重输
  - 章节工作台字数输入可清空重输
  - 删除后 Project not found 场景侧栏子导航隐藏正确

### 4.3 Playwright 截图
- `/Volumes/Work/Projects/Morpheus/output/playwright/system_bugfix_verify_2026-02-17T16-24-09-175Z_01_write_a.png`
- `/Volumes/Work/Projects/Morpheus/output/playwright/system_bugfix_verify_2026-02-17T16-24-09-175Z_02_write_b.png`
- `/Volumes/Work/Projects/Morpheus/output/playwright/system_bugfix_verify_2026-02-17T16-24-09-175Z_03_numbers.png`
- `/Volumes/Work/Projects/Morpheus/output/playwright/system_bugfix_verify_2026-02-17T16-24-09-175Z_04_not_found.png`

## 5. 非阻断项
- `npm run lint` 当前不可用：仓库缺失 ESLint 配置文件（非本次改动引入）。
- 建议后续单独补一份统一 ESLint 配置并接入 CI。

## 6. 回滚与兼容性
- 本次修改均为前端逻辑与测试增强，不涉及破坏性 API 变更。
- 后端接口行为保持兼容。
