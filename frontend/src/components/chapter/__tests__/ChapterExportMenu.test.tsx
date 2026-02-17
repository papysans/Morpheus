import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ChapterExportMenu from '../ChapterExportMenu'
import type { ChapterContent } from '../../../services/exportService'

/* ── Mock framer-motion ── */
vi.mock('framer-motion', () => ({
    motion: {
        div: ({ children, ...props }: any) => {
            const filtered: Record<string, any> = {}
            for (const key of Object.keys(props)) {
                if (!['initial', 'animate', 'exit', 'transition'].includes(key)) {
                    filtered[key] = props[key]
                }
            }
            return <div {...filtered}>{children}</div>
        },
    },
    AnimatePresence: ({ children }: any) => <>{children}</>,
}))

/* ── Mock exportService ── */
vi.mock('../../../services/exportService', async () => {
    const actual = await vi.importActual('../../../services/exportService')
    return {
        ...actual,
        exportChapter: vi.fn(),
        exportBook: vi.fn(),
    }
})

import { exportChapter, exportBook } from '../../../services/exportService'

const sampleChapter: ChapterContent = {
    chapterNumber: 1,
    title: '序章',
    content: '这是第一章的内容。',
}

const sampleChapters: ChapterContent[] = [
    sampleChapter,
    { chapterNumber: 2, title: '觉醒', content: '这是第二章的内容。' },
]

describe('ChapterExportMenu', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('无数据时不渲染', () => {
        const { container } = render(
            <ChapterExportMenu projectName="测试项目" />,
        )
        expect(container.innerHTML).toBe('')
    })

    it('渲染导出按钮', () => {
        render(
            <ChapterExportMenu
                currentChapter={sampleChapter}
                projectName="测试项目"
            />,
        )
        expect(screen.getByLabelText('导出菜单')).toBeTruthy()
        expect(screen.getByText('导出')).toBeTruthy()
    })

    it('点击按钮展开下拉菜单', () => {
        render(
            <ChapterExportMenu
                currentChapter={sampleChapter}
                projectName="测试项目"
            />,
        )
        expect(screen.queryByRole('menu')).toBeNull()

        fireEvent.click(screen.getByLabelText('导出菜单'))
        expect(screen.getByRole('menu')).toBeTruthy()
    })

    it('仅传 currentChapter 时只显示章节导出选项', () => {
        render(
            <ChapterExportMenu
                currentChapter={sampleChapter}
                projectName="测试项目"
            />,
        )
        fireEvent.click(screen.getByLabelText('导出菜单'))

        expect(screen.getByText('导出当前章节')).toBeTruthy()
        expect(screen.getByText('Markdown (.md)')).toBeTruthy()
        expect(screen.getByText('纯文本 (.txt)')).toBeTruthy()
        expect(screen.queryByText('导出整书')).toBeNull()
    })

    it('仅传 allChapters 时只显示整书导出选项', () => {
        render(
            <ChapterExportMenu
                allChapters={sampleChapters}
                projectName="测试项目"
            />,
        )
        fireEvent.click(screen.getByLabelText('导出菜单'))

        expect(screen.getByText('导出整书')).toBeTruthy()
        expect(screen.queryByText('导出当前章节')).toBeNull()
    })

    it('同时传入两者时显示所有选项', () => {
        render(
            <ChapterExportMenu
                currentChapter={sampleChapter}
                allChapters={sampleChapters}
                projectName="测试项目"
            />,
        )
        fireEvent.click(screen.getByLabelText('导出菜单'))

        expect(screen.getByText('导出当前章节')).toBeTruthy()
        expect(screen.getByText('导出整书')).toBeTruthy()
    })

    it('点击章节 Markdown 导出调用 exportChapter', () => {
        render(
            <ChapterExportMenu
                currentChapter={sampleChapter}
                projectName="测试项目"
            />,
        )
        fireEvent.click(screen.getByLabelText('导出菜单'))
        fireEvent.click(screen.getByText('Markdown (.md)'))

        expect(exportChapter).toHaveBeenCalledWith(sampleChapter, {
            format: 'markdown',
            includeTableOfContents: true,
            projectName: '测试项目',
        })
    })

    it('点击章节 TXT 导出调用 exportChapter', () => {
        render(
            <ChapterExportMenu
                currentChapter={sampleChapter}
                projectName="测试项目"
            />,
        )
        fireEvent.click(screen.getByLabelText('导出菜单'))
        fireEvent.click(screen.getByText('纯文本 (.txt)'))

        expect(exportChapter).toHaveBeenCalledWith(sampleChapter, {
            format: 'txt',
            includeTableOfContents: true,
            projectName: '测试项目',
        })
    })

    it('点击整书 Markdown 导出调用 exportBook', () => {
        render(
            <ChapterExportMenu
                allChapters={sampleChapters}
                projectName="测试项目"
            />,
        )
        fireEvent.click(screen.getByLabelText('导出菜单'))

        // There are two "Markdown (.md)" buttons, get the one under 导出整书
        const items = screen.getAllByText('Markdown (.md)')
        fireEvent.click(items[0])

        expect(exportBook).toHaveBeenCalledWith(sampleChapters, {
            format: 'markdown',
            includeTableOfContents: true,
            projectName: '测试项目',
        })
    })

    it('导出后菜单自动关闭', () => {
        render(
            <ChapterExportMenu
                currentChapter={sampleChapter}
                projectName="测试项目"
            />,
        )
        fireEvent.click(screen.getByLabelText('导出菜单'))
        expect(screen.getByRole('menu')).toBeTruthy()

        fireEvent.click(screen.getByText('Markdown (.md)'))
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('Escape 键关闭菜单', () => {
        render(
            <ChapterExportMenu
                currentChapter={sampleChapter}
                projectName="测试项目"
            />,
        )
        fireEvent.click(screen.getByLabelText('导出菜单'))
        expect(screen.getByRole('menu')).toBeTruthy()

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('aria-expanded 属性正确反映菜单状态', () => {
        render(
            <ChapterExportMenu
                currentChapter={sampleChapter}
                projectName="测试项目"
            />,
        )
        const trigger = screen.getByLabelText('导出菜单')
        expect(trigger.getAttribute('aria-expanded')).toBe('false')

        fireEvent.click(trigger)
        expect(trigger.getAttribute('aria-expanded')).toBe('true')
    })
})
