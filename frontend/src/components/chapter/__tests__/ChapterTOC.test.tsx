import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ChapterTOC from '../ChapterTOC'

/* ── Mock framer-motion ── */
vi.mock('framer-motion', () => ({
    motion: {
        ul: ({ children, ...props }: any) => {
            const filtered: Record<string, any> = {}
            for (const key of Object.keys(props)) {
                if (!['initial', 'animate', 'exit', 'transition'].includes(key)) {
                    filtered[key] = props[key]
                }
            }
            return <ul {...filtered}>{children}</ul>
        },
    },
    AnimatePresence: ({ children }: any) => <>{children}</>,
}))

const sampleChapters = [
    { id: 'ch-1', chapterNumber: 1, title: '序章', wordCount: 1200 },
    { id: 'ch-2', chapterNumber: 2, title: '觉醒', wordCount: 1800 },
    { id: 'ch-3', chapterNumber: 3, title: '冲突', wordCount: 2100 },
]

describe('ChapterTOC', () => {
    it('章节为空时不渲染', () => {
        const { container } = render(
            <ChapterTOC chapters={[]} onSelect={vi.fn()} />,
        )
        expect(container.innerHTML).toBe('')
    })

    it('渲染所有章节的编号、标题和字数', () => {
        render(<ChapterTOC chapters={sampleChapters} onSelect={vi.fn()} />)
        expect(screen.getByText('章节目录')).toBeTruthy()
        expect(screen.getByText('第1章')).toBeTruthy()
        expect(screen.getByText('序章')).toBeTruthy()
        expect(screen.getByText('1200字')).toBeTruthy()
        expect(screen.getByText('第2章')).toBeTruthy()
        expect(screen.getByText('觉醒')).toBeTruthy()
        expect(screen.getByText('1800字')).toBeTruthy()
        expect(screen.getByText('第3章')).toBeTruthy()
        expect(screen.getByText('冲突')).toBeTruthy()
        expect(screen.getByText('2100字')).toBeTruthy()
    })

    it('点击条目调用 onSelect 并传入 chapterId', () => {
        const onSelect = vi.fn()
        render(<ChapterTOC chapters={sampleChapters} onSelect={onSelect} />)
        fireEvent.click(screen.getByText('觉醒'))
        expect(onSelect).toHaveBeenCalledWith('ch-2')
    })

    it('activeChapterId 对应条目添加 active 样式', () => {
        render(
            <ChapterTOC chapters={sampleChapters} activeChapterId="ch-2" onSelect={vi.fn()} />,
        )
        const activeBtn = screen.getByText('觉醒').closest('button')
        expect(activeBtn?.className).toContain('writing-toc__item--active')

        const inactiveBtn = screen.getByText('序章').closest('button')
        expect(inactiveBtn?.className).not.toContain('writing-toc__item--active')
    })

    it('点击折叠按钮切换目录显示', () => {
        render(<ChapterTOC chapters={sampleChapters} onSelect={vi.fn()} />)
        // Initially expanded
        expect(screen.getByText('序章')).toBeTruthy()

        // Collapse
        fireEvent.click(screen.getByLabelText('折叠目录'))
        expect(screen.queryByText('序章')).toBeNull()

        // Expand again
        fireEvent.click(screen.getByLabelText('展开目录'))
        expect(screen.getByText('序章')).toBeTruthy()
    })
})
