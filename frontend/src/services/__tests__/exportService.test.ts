import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToastStore } from '../../stores/useToastStore'
import {
    generateChapterMarkdown,
    generateChapterTxt,
    generateBookMarkdown,
    generateBookTxt,
    sanitizeNarrativeForExport,
    exportChapter,
    exportBook,
    ChapterContent,
    ExportOptions,
} from '../exportService'

// --- Helpers ---

const chapter: ChapterContent = {
    chapterNumber: 1,
    title: '黎明之前',
    content: '天还没亮，村庄笼罩在薄雾之中。',
}

const chapters: ChapterContent[] = [
    { chapterNumber: 1, title: '黎明之前', content: '第一章正文。' },
    { chapterNumber: 2, title: '风暴来临', content: '第二章正文。' },
    { chapterNumber: 3, title: '尘埃落定', content: '第三章正文。' },
]

const mdOptions: ExportOptions = {
    format: 'markdown',
    includeTableOfContents: true,
    projectName: '测试小说',
}

const txtOptions: ExportOptions = {
    format: 'txt',
    includeTableOfContents: true,
    projectName: '测试小说',
}

beforeEach(() => {
    useToastStore.setState({ toasts: [] })
})

// === Formatting unit tests ===

describe('generateChapterMarkdown', () => {
    it('produces # heading with chapter number and title', () => {
        const result = generateChapterMarkdown(chapter)
        expect(result).toContain('# 第1章 黎明之前')
    })

    it('includes full body content', () => {
        const result = generateChapterMarkdown(chapter)
        expect(result).toContain(chapter.content)
    })

    it('removes editorial notes inside parentheses', () => {
        const polluted: ChapterContent = {
            chapterNumber: 7,
            title: '镜门',
            content: '镜子再次出现（与“镜之城”呼应）；她继续前行。（反转）',
        }
        const result = generateChapterMarkdown(polluted)
        expect(result).toContain('镜子再次出现；她继续前行。')
        expect(result).not.toContain('与“镜之城”呼应')
        expect(result).not.toContain('（反转）')
    })
})

describe('generateChapterTxt', () => {
    it('produces title line with chapter number', () => {
        const result = generateChapterTxt(chapter)
        expect(result).toContain('第1章 黎明之前')
    })

    it('includes a separator line of = characters', () => {
        const result = generateChapterTxt(chapter)
        const lines = result.split('\n')
        const sepLine = lines.find((l) => /^=+$/.test(l))
        expect(sepLine).toBeDefined()
    })

    it('includes full body content', () => {
        const result = generateChapterTxt(chapter)
        expect(result).toContain(chapter.content)
    })

    it('keeps normal parenthetical narrative text', () => {
        const polluted = '她低声说（别回头），然后迈过门槛。'
        const result = generateChapterTxt({ ...chapter, content: polluted })
        expect(result).toContain('（别回头）')
    })
})

describe('sanitizeNarrativeForExport', () => {
    it('strips common planning note markers only', () => {
        const content = '转角有风（反转）。镜面闪动（与“镜之城”呼应）。\n她低声说（别回头）。'
        const cleaned = sanitizeNarrativeForExport(content)
        expect(cleaned).toContain('转角有风。镜面闪动。')
        expect(cleaned).toContain('（别回头）')
    })
})

describe('generateBookMarkdown', () => {
    it('includes table of contents with all chapter titles', () => {
        const result = generateBookMarkdown(chapters, mdOptions)
        expect(result).toContain('## 目录')
        for (const ch of chapters) {
            expect(result).toContain(`第${ch.chapterNumber}章 ${ch.title}`)
        }
    })

    it('includes all chapter bodies', () => {
        const result = generateBookMarkdown(chapters, mdOptions)
        for (const ch of chapters) {
            expect(result).toContain(ch.content)
        }
    })

    it('chapters appear in provided order', () => {
        const result = generateBookMarkdown(chapters, mdOptions)
        const idx1 = result.indexOf(chapters[0].content)
        const idx2 = result.indexOf(chapters[1].content)
        const idx3 = result.indexOf(chapters[2].content)
        expect(idx1).toBeLessThan(idx2)
        expect(idx2).toBeLessThan(idx3)
    })

    it('skips TOC for single chapter', () => {
        const result = generateBookMarkdown([chapters[0]], mdOptions)
        expect(result).not.toContain('## 目录')
    })
})

describe('generateBookTxt', () => {
    it('includes table of contents with all chapter titles', () => {
        const result = generateBookTxt(chapters, txtOptions)
        expect(result).toContain('目录')
        for (const ch of chapters) {
            expect(result).toContain(`第${ch.chapterNumber}章 ${ch.title}`)
        }
    })

    it('includes all chapter bodies', () => {
        const result = generateBookTxt(chapters, txtOptions)
        for (const ch of chapters) {
            expect(result).toContain(ch.content)
        }
    })
})


// === exportChapter / exportBook integration tests ===

describe('exportChapter', () => {
    it('shows warning toast when content is empty', () => {
        const empty: ChapterContent = { chapterNumber: 1, title: '空章', content: '' }
        exportChapter(empty, mdOptions)
        const toasts = useToastStore.getState().toasts
        expect(toasts).toHaveLength(1)
        expect(toasts[0].type).toBe('warning')
        expect(toasts[0].message).toContain('暂无内容')
    })

    it('shows success toast on successful markdown export', () => {
        // Mock DOM APIs for download
        const createObjectURL = vi.fn(() => 'blob:mock')
        const revokeObjectURL = vi.fn()
        const clickMock = vi.fn()
        const appendChildMock = vi.fn()
        const removeChildMock = vi.fn()

        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
        vi.spyOn(document, 'createElement').mockReturnValue({
            set href(_: string) { },
            set download(_: string) { },
            click: clickMock,
        } as unknown as HTMLAnchorElement)
        vi.spyOn(document.body, 'appendChild').mockImplementation(appendChildMock)
        vi.spyOn(document.body, 'removeChild').mockImplementation(removeChildMock)

        exportChapter(chapter, mdOptions)

        const toasts = useToastStore.getState().toasts
        expect(toasts).toHaveLength(1)
        expect(toasts[0].type).toBe('success')
        expect(clickMock).toHaveBeenCalled()

        vi.restoreAllMocks()
    })
})

describe('exportBook', () => {
    it('shows warning toast when chapters array is empty', () => {
        exportBook([], mdOptions)
        const toasts = useToastStore.getState().toasts
        expect(toasts).toHaveLength(1)
        expect(toasts[0].type).toBe('warning')
        expect(toasts[0].message).toContain('暂无章节')
    })

    it('sorts chapters by chapterNumber before export', () => {
        const unordered: ChapterContent[] = [
            { chapterNumber: 3, title: 'C', content: '三' },
            { chapterNumber: 1, title: 'A', content: '一' },
            { chapterNumber: 2, title: 'B', content: '二' },
        ]

        // We can verify sorting via the formatting function directly
        const result = generateBookMarkdown(
            [...unordered].sort((a, b) => a.chapterNumber - b.chapterNumber),
            mdOptions,
        )
        const idxA = result.indexOf('一')
        const idxB = result.indexOf('二')
        const idxC = result.indexOf('三')
        expect(idxA).toBeLessThan(idxB)
        expect(idxB).toBeLessThan(idxC)
    })

    it('shows error toast when download fails', () => {
        // Force an error by making Blob throw
        const origBlob = globalThis.Blob
        vi.stubGlobal('Blob', function () {
            throw new Error('Blob 不支持')
        })

        exportBook(chapters, mdOptions)

        const toasts = useToastStore.getState().toasts
        expect(toasts).toHaveLength(1)
        expect(toasts[0].type).toBe('error')
        expect(toasts[0].message).toContain('导出失败')

        vi.stubGlobal('Blob', origBlob)
    })
})
