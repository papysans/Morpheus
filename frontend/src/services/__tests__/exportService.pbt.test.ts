import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
    generateChapterMarkdown,
    generateChapterTxt,
    generateBookMarkdown,
    generateBookTxt,
    ChapterContent,
    ExportOptions,
} from '../exportService'

// === Smart Generators ===

/** Non-empty string suitable for chapter titles (no newlines) */
const titleArb = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => !s.includes('\n') && s.trim().length > 0)

/** Non-empty string suitable for chapter content */
const contentArb = fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0)

/** Positive integer for chapter numbers */
const chapterNumberArb = fc.integer({ min: 1, max: 999 })

/** Single chapter arbitrary */
const chapterArb: fc.Arbitrary<ChapterContent> = fc.record({
    chapterNumber: chapterNumberArb,
    title: titleArb,
    content: contentArb,
})

/** Non-empty project name */
const projectNameArb = fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0)

/** List of 2+ chapters with unique ascending chapter numbers and unique content per chapter */
const multiChapterArb: fc.Arbitrary<ChapterContent[]> = fc
    .uniqueArray(chapterNumberArb, { minLength: 2, maxLength: 10, comparator: (a: number, b: number) => a === b })
    .chain((nums) => {
        const sorted = [...nums].sort((a, b) => a - b)
        return fc.tuple(...sorted.map((n, i) =>
            fc.record({
                chapterNumber: fc.constant(n),
                title: titleArb,
                // Prefix content with unique marker so indexOf-based ordering checks work
                content: contentArb.map((c) => `[CH${n}_${i}] ${c}`),
            })
        )) as fc.Arbitrary<ChapterContent[]>
    })

// === Property Tests ===

describe('Feature: frontend-ux-overhaul, Property 1: Markdown 导出结构保持', () => {
    /**
     * **Validates: Requirements 2.1, 2.3**
     *
     * For any chapter content (with title and body), after calling Markdown export,
     * the output string should contain a chapter title line starting with `#`,
     * and the body content should be fully preserved.
     */
    it('Markdown output contains # heading with chapter info and preserves full body content', () => {
        fc.assert(
            fc.property(chapterArb, (chapter) => {
                const result = generateChapterMarkdown(chapter)

                // Output should contain a line starting with # that includes the chapter number and title
                const headingPattern = `# 第${chapter.chapterNumber}章 ${chapter.title}`
                expect(result).toContain(headingPattern)

                // The heading line should start with #
                const lines = result.split('\n')
                const headingLine = lines.find((l) => l.startsWith('#'))
                expect(headingLine).toBeDefined()

                // Body content should be fully preserved
                expect(result).toContain(chapter.content)
            }),
            { numRuns: 100 },
        )
    })
})

describe('Feature: frontend-ux-overhaul, Property 2: TXT 导出结构保持', () => {
    /**
     * **Validates: Requirements 2.1, 2.4**
     *
     * For any chapter content (with title and body), after calling TXT export,
     * the output string should contain the chapter title text and a separator line,
     * and the body content should be fully preserved.
     */
    it('TXT output contains chapter title, separator line of = chars, and preserves full body content', () => {
        fc.assert(
            fc.property(chapterArb, (chapter) => {
                const result = generateChapterTxt(chapter)

                // Output should contain the chapter title text
                const titleText = `第${chapter.chapterNumber}章 ${chapter.title}`
                expect(result).toContain(titleText)

                // Output should contain a separator line made of = characters
                const lines = result.split('\n')
                const separatorLine = lines.find((l) => /^=+$/.test(l))
                expect(separatorLine).toBeDefined()
                expect(separatorLine!.length).toBeGreaterThanOrEqual(40)

                // Body content should be fully preserved
                expect(result).toContain(chapter.content)
            }),
            { numRuns: 100 },
        )
    })
})

describe('Feature: frontend-ux-overhaul, Property 3: 多章节导出完整性与顺序', () => {
    /**
     * **Validates: Requirements 2.2, 2.5**
     *
     * For any ordered list of 2+ chapters, the exported file should:
     * (a) contain all chapters' content,
     * (b) chapters appear in original order,
     * (c) file begins with a table of contents listing all chapter titles.
     */
    const tocOptions = (name: string): ExportOptions => ({
        format: 'markdown',
        includeTableOfContents: true,
        projectName: name,
    })

    it('Markdown book export: all content present, in order, with TOC', () => {
        fc.assert(
            fc.property(multiChapterArb, projectNameArb, (chapters, projectName) => {
                const opts = tocOptions(projectName)
                const result = generateBookMarkdown(chapters, opts)

                // (a) All chapters' content is present
                for (const ch of chapters) {
                    expect(result).toContain(ch.content)
                    expect(result).toContain(ch.title)
                }

                // (b) Chapters appear in original order
                for (let i = 0; i < chapters.length - 1; i++) {
                    const idxCurrent = result.indexOf(chapters[i].content)
                    const idxNext = result.indexOf(chapters[i + 1].content)
                    expect(idxCurrent).toBeLessThan(idxNext)
                }

                // (c) TOC at the beginning lists all chapter titles
                expect(result).toContain('目录')
                for (const ch of chapters) {
                    expect(result).toContain(`第${ch.chapterNumber}章 ${ch.title}`)
                }

                // TOC appears before the first chapter body
                const tocIdx = result.indexOf('目录')
                const firstContentIdx = result.indexOf(chapters[0].content)
                expect(tocIdx).toBeLessThan(firstContentIdx)
            }),
            { numRuns: 100 },
        )
    })

    it('TXT book export: all content present, in order, with TOC', () => {
        fc.assert(
            fc.property(multiChapterArb, projectNameArb, (chapters, projectName) => {
                const opts: ExportOptions = {
                    format: 'txt',
                    includeTableOfContents: true,
                    projectName,
                }
                const result = generateBookTxt(chapters, opts)

                // (a) All chapters' content is present
                for (const ch of chapters) {
                    expect(result).toContain(ch.content)
                    expect(result).toContain(ch.title)
                }

                // (b) Chapters appear in original order
                for (let i = 0; i < chapters.length - 1; i++) {
                    const idxCurrent = result.indexOf(chapters[i].content)
                    const idxNext = result.indexOf(chapters[i + 1].content)
                    expect(idxCurrent).toBeLessThan(idxNext)
                }

                // (c) TOC at the beginning lists all chapter titles
                expect(result).toContain('目录')
                for (const ch of chapters) {
                    expect(result).toContain(`第${ch.chapterNumber}章 ${ch.title}`)
                }

                // TOC appears before the first chapter body
                const tocIdx = result.indexOf('目录')
                const firstContentIdx = result.indexOf(chapters[0].content)
                expect(tocIdx).toBeLessThan(firstContentIdx)
            }),
            { numRuns: 100 },
        )
    })
})
