import { useToastStore } from '../stores/useToastStore'

// === Types ===

export interface ExportOptions {
    format: 'markdown' | 'txt'
    includeTableOfContents: boolean
    projectName: string
}

export interface ChapterContent {
    chapterNumber: number
    title: string
    content: string
}

const EDITORIAL_NOTE_PATTERNS: RegExp[] = [
    /^反转(?:[：:、，,\-\s].*)?$/i,
    /^余震(?:[：:、，,\-\s].*)?$/i,
    /^(?:章尾)?钩子(?:[：:、，,\-\s].*)?$/i,
    /^(?:与|和).{0,40}呼应$/i,
    /^呼应.{0,40}$/i,
    /^callback(?:[：:、，,\-\s].*)?$/i,
    /^回收(?:[：:、，,\-\s].*)?$/i,
]

function isEditorialNote(inner: string): boolean {
    const candidate = String(inner || '').replace(/\s+/g, ' ').trim()
    if (!candidate || candidate.length > 60) return false
    return EDITORIAL_NOTE_PATTERNS.some((pattern) => pattern.test(candidate))
}

export function sanitizeNarrativeForExport(content: string): string {
    const normalized = String(content || '')
    if (!normalized.trim()) return ''

    return normalized
        .replace(/[（(]([^（）()]{1,80})[）)]/g, (match, inner) => (isEditorialNote(inner) ? '' : match))
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

// === Formatting Functions (exported for testing) ===

/**
 * Generate Markdown content for a single chapter.
 * Uses # heading for the title, followed by the body text.
 */
export function generateChapterMarkdown(chapter: ChapterContent): string {
    const content = sanitizeNarrativeForExport(chapter.content)
    return `# 第${chapter.chapterNumber}章 ${chapter.title}\n\n${content}`
}

/**
 * Generate TXT content for a single chapter.
 * Title text followed by a separator line, then the body text.
 */
export function generateChapterTxt(chapter: ChapterContent): string {
    const title = `第${chapter.chapterNumber}章 ${chapter.title}`
    const separator = '='.repeat(title.length > 40 ? title.length : 40)
    const content = sanitizeNarrativeForExport(chapter.content)
    return `${title}\n${separator}\n\n${content}`
}

/**
 * Generate Markdown content for multiple chapters (full book).
 * Includes a table of contents at the beginning when includeTableOfContents is true.
 */
export function generateBookMarkdown(
    chapters: ChapterContent[],
    options: ExportOptions,
): string {
    const parts: string[] = []

    if (options.includeTableOfContents && chapters.length >= 2) {
        parts.push(`# ${options.projectName}\n`)
        parts.push('## 目录\n')
        for (const ch of chapters) {
            parts.push(`- 第${ch.chapterNumber}章 ${ch.title}`)
        }
        parts.push('\n---\n')
    }

    for (const ch of chapters) {
        parts.push(generateChapterMarkdown(ch))
    }

    return parts.join('\n')
}

/**
 * Generate TXT content for multiple chapters (full book).
 * Includes a table of contents at the beginning when includeTableOfContents is true.
 */
export function generateBookTxt(
    chapters: ChapterContent[],
    options: ExportOptions,
): string {
    const parts: string[] = []

    if (options.includeTableOfContents && chapters.length >= 2) {
        parts.push(options.projectName)
        parts.push('='.repeat(40))
        parts.push('')
        parts.push('目录')
        parts.push('-'.repeat(20))
        for (const ch of chapters) {
            parts.push(`  第${ch.chapterNumber}章 ${ch.title}`)
        }
        parts.push('')
        parts.push('='.repeat(40))
        parts.push('')
    }

    for (let i = 0; i < chapters.length; i++) {
        if (i > 0) {
            parts.push('\n')
        }
        parts.push(generateChapterTxt(chapters[i]))
    }

    return parts.join('\n')
}


// === Download Helper ===

function triggerDownload(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
}

// === Public API ===

/**
 * Export a single chapter as Markdown or TXT file.
 * Triggers a browser download.
 */
export function exportChapter(chapter: ChapterContent, options: ExportOptions): void {
    try {
        const sanitizedContent = sanitizeNarrativeForExport(chapter.content)
        if (!sanitizedContent) {
            useToastStore.getState().addToast('warning', '该章节暂无内容可导出')
            return
        }

        const normalizedChapter = { ...chapter, content: sanitizedContent }
        let content: string
        let filename: string
        let mimeType: string

        if (options.format === 'markdown') {
            content = generateChapterMarkdown(normalizedChapter)
            filename = `${options.projectName}_第${chapter.chapterNumber}章_${chapter.title}.md`
            mimeType = 'text/markdown;charset=utf-8'
        } else {
            content = generateChapterTxt(normalizedChapter)
            filename = `${options.projectName}_第${chapter.chapterNumber}章_${chapter.title}.txt`
            mimeType = 'text/plain;charset=utf-8'
        }

        triggerDownload(content, filename, mimeType)
        useToastStore.getState().addToast('success', `章节「${chapter.title}」导出成功`)
    } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'
        useToastStore.getState().addToast('error', `导出失败：${message}`)
    }
}

/**
 * Export all chapters as a single Markdown or TXT file.
 * Triggers a browser download.
 */
export function exportBook(chapters: ChapterContent[], options: ExportOptions): void {
    try {
        if (!chapters.length) {
            useToastStore.getState().addToast('warning', '暂无章节可导出')
            return
        }

        const chaptersWithContent = chapters
            .map((chapter) => ({
                ...chapter,
                content: sanitizeNarrativeForExport(chapter.content),
            }))
            .filter((chapter) => chapter.content.trim().length > 0)
        if (!chaptersWithContent.length) {
            useToastStore.getState().addToast('warning', '暂无可导出的章节正文')
            return
        }

        const sorted = [...chaptersWithContent].sort((a, b) => a.chapterNumber - b.chapterNumber)

        let content: string
        let filename: string
        let mimeType: string

        if (options.format === 'markdown') {
            content = generateBookMarkdown(sorted, options)
            filename = `${options.projectName}.md`
            mimeType = 'text/markdown;charset=utf-8'
        } else {
            content = generateBookTxt(sorted, options)
            filename = `${options.projectName}.txt`
            mimeType = 'text/plain;charset=utf-8'
        }

        triggerDownload(content, filename, mimeType)
        useToastStore.getState().addToast('success', `整书导出成功（共${sorted.length}章）`)
    } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误'
        useToastStore.getState().addToast('error', `导出失败：${message}`)
    }
}
