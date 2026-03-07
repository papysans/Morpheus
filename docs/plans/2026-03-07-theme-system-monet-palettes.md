# Theme System with Monet Palettes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a system-wide customizable theme system with light/dark mode and curated Monet-inspired palettes that change background and button/accent presentation across the frontend.

**Architecture:** Keep theme preference in `useUIStore`, define a typed palette contract in frontend TypeScript, and apply the resolved theme + palette to `document.documentElement` via data attributes and CSS custom properties. Refactor shared/global CSS and the highest-risk visual pages (`DashboardPage`, `KnowledgeGraphPage`) to consume semantic theme variables instead of hard-coded colors.

**Tech Stack:** React 18, TypeScript, Zustand, CSS custom properties, Vitest, Testing Library, Recharts, ReactFlow.

---

### Task 1: Define theme contract tests

**Files:**
- Modify: `frontend/src/stores/__tests__/useUIStore.test.ts`
- Modify: `frontend/src/stores/__tests__/useUIStore.pbt.test.ts`
- Create: `frontend/src/theme/__tests__/themeSystem.test.ts`

**Step 1: Write failing tests for theme state and palette behavior**
- Add store tests for default theme mode, default palette id, mode cycling/setters, and palette setter behavior.
- Add theme system tests covering curated Monet palettes, palette lookup, and root attribute/style application.

**Step 2: Run the targeted tests to verify RED**
- Run: `npm run test -- src/stores/__tests__/useUIStore.test.ts src/stores/__tests__/useUIStore.pbt.test.ts src/theme/__tests__/themeSystem.test.ts`
- Expected: failing assertions for missing theme fields/helpers.

**Step 3: Keep tests minimal and behavior-focused**
- Avoid snapshot tests.
- Verify DOM attributes/styles, not implementation details.

### Task 2: Implement theme state and root application

**Files:**
- Create: `frontend/src/theme/themeSystem.ts`
- Modify: `frontend/src/stores/useUIStore.ts`
- Modify: `frontend/src/components/layout/AppLayout.tsx`

**Step 1: Implement typed palette definitions and helpers**
- Export a curated palette list with Monet-inspired ids/names.
- Add helpers for applying theme attributes/custom properties and resolving system mode.

**Step 2: Extend UI store minimally**
- Add `themeMode`, `themePaletteId`, setters, and safe localStorage persistence.

**Step 3: Apply theme in shared layout**
- Sync theme mode + palette to `document.documentElement` in `AppLayout`.
- Set `data-theme`, `data-palette`, and `color-scheme` consistently.

**Step 4: Re-run targeted tests to verify GREEN**
- Run same command from Task 1.

### Task 3: Expose theme controls in navigation

**Files:**
- Modify: `frontend/src/components/layout/Sidebar.tsx`
- Modify: `frontend/src/components/layout/__tests__/Sidebar.test.tsx`

**Step 1: Write failing Sidebar tests**
- Verify the sidebar shows a theme mode control and Monet palette options.
- Verify interactions update `useUIStore`.

**Step 2: Run Sidebar test to verify RED**
- Run: `npm run test -- src/components/layout/__tests__/Sidebar.test.tsx`

**Step 3: Implement minimal UI controls**
- Add a compact theme mode switcher and palette selector in the global/sidebar section.

**Step 4: Re-run Sidebar test to verify GREEN**

### Task 4: Convert global CSS to dual-theme + palette-aware tokens

**Files:**
- Modify: `frontend/src/index.css`

**Step 1: Refactor CSS variable structure**
- Replace ambiguous duplicate `:root` blocks with explicit `:root`, `[data-theme="light"]`, and `[data-theme="dark"]` scopes.
- Add semantic variables for surfaces, inputs, overlays, charts, graph edges, badges, and selection states.

**Step 2: Map palette variables**
- Use root-injected CSS custom properties for background accent glows and button/accent gradients.

**Step 3: Update shared classes**
- Replace hard-coded light/bright values in common classes (`card`, `btn`, `input`, `sidebar`, `mobile-nav`, `stream-paper`, `layer-badge`, etc.) with semantic variables.

### Task 5: Adapt chart and graph hotspots

**Files:**
- Modify: `frontend/src/pages/DashboardPage.tsx`
- Modify: `frontend/src/pages/KnowledgeGraphPage.tsx`
- Modify: `frontend/src/pages/__tests__/DashboardPage.test.tsx`
- Modify: `frontend/src/pages/__tests__/KnowledgeGraphPage.test.tsx`
- Modify: `frontend/src/pages/__tests__/KnowledgeGraphPage.pbt.test.ts`

**Step 1: Write/adjust failing tests for theme-aware visual tokens**
- Stop asserting a single hard-coded bright theme where theme-aware values are now expected.
- Assert semantic token-backed values or helper outputs instead.

**Step 2: Refactor Dashboard**
- Replace fixed `CHART_THEME` constants with token-aware helpers.

**Step 3: Refactor Knowledge Graph**
- Move edge, node badge, tooltip, overlay, and highlight colors to theme-aware constants/helpers.

**Step 4: Re-run focused page tests**
- Run: `npm run test -- src/pages/__tests__/DashboardPage.test.tsx src/pages/__tests__/KnowledgeGraphPage.test.tsx src/pages/__tests__/KnowledgeGraphPage.pbt.test.ts`

### Task 6: Verify the whole frontend

**Files:**
- No new files

**Step 1: Run diagnostics / lint / tests / build**
- Run: `npm run lint`
- Run: `npm run test`
- Run: `npm run build`

**Step 2: Fix remaining issues**
- Address any type, lint, or test regressions.

**Step 3: Summarize implemented behavior**
- Confirm supported theme modes, palette list, and key files changed.
