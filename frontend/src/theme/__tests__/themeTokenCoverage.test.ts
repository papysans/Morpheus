import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
    AGENT_ROLE_COLORS,
    SEVERITY_STYLES,
} from '../../pages/TraceReplayPage'
import { LAYER_META } from '../../pages/MemoryBrowserPage'

const indexCss = readFileSync(resolve(__dirname, '../../index.css'), 'utf8')
const projectListPage = readFileSync(resolve(__dirname, '../../pages/ProjectList.tsx'), 'utf8')
const projectDetailPage = readFileSync(resolve(__dirname, '../../pages/ProjectDetail.tsx'), 'utf8')
const chapterWorkbenchPage = readFileSync(resolve(__dirname, '../../pages/ChapterWorkbenchPage.tsx'), 'utf8')

describe('theme token coverage', () => {
    it('does not keep the legacy bright-theme :root override block', () => {
        expect(indexCss.includes('--bg-0: #f6f9ff;')).toBe(false)
        expect(indexCss.includes('--bg-1: #eef4ff;')).toBe(false)
        expect(indexCss.includes('--bg-2: #fffdf8;')).toBe(false)
    })

    it('keeps shared card surfaces bound to semantic theme tokens', () => {
        expect(indexCss).toMatch(/\.card\s*\{[\s\S]*background:\s*var\(--surface-card\)/)
        expect(indexCss).toMatch(/\.card-strong\s*\{[\s\S]*background:\s*var\(--surface-card-strong\)/)
        expect(indexCss).not.toContain('background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 252, 255, 0.92));')
    })

    it('maps trace replay role and severity styles to CSS tokens', () => {
        for (const style of Object.values(AGENT_ROLE_COLORS)) {
            expect(style.color.startsWith('var(--')).toBe(true)
            expect(style.borderColor.startsWith('var(--')).toBe(true)
        }
        for (const color of Object.values(SEVERITY_STYLES)) {
            expect(color.startsWith('var(--')).toBe(true)
        }
    })

    it('maps memory browser layer metadata to CSS tokens', () => {
        for (const meta of Object.values(LAYER_META)) {
            expect(meta.color.startsWith('var(--')).toBe(true)
        }
        expect(indexCss.includes('var(--text-muted, #888)')).toBe(false)
        expect(indexCss.includes('var(--text-muted, #666)')).toBe(false)
    })

    it('keeps remaining page cards and warnings free of hard-coded theme colors', () => {
        const combinedPages = `${projectListPage}\n${projectDetailPage}\n${chapterWorkbenchPage}`
        expect(combinedPages.includes("style={{ color: 'var(--warning, #faad14)' }}")).toBe(false)
        expect(combinedPages.includes("style={{ color: 'var(--warning, #faad14)'")).toBe(false)
        expect(combinedPages.includes("border: '1px solid var(--glass-border)'")).toBe(false)
        expect(combinedPages.includes('rgba(10, 139, 131')).toBe(false)
        expect(combinedPages.includes('rgba(255, 255, 255')).toBe(false)
    })
})
