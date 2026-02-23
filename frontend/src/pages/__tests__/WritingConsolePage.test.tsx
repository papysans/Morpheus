import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import WritingConsolePage from '../WritingConsolePage'

/* ── localStorage mock ── */

const localStorageMock = (() => {
    let store: Record<string, string> = {}
    return {
        getItem: vi.fn((key: string) => (key in store ? store[key] : null)),
        setItem: vi.fn((key: string, value: string) => {
            store[key] = String(value)
        }),
        removeItem: vi.fn((key: string) => {
            delete store[key]
        }),
        clear: vi.fn(() => {
            store = {}
        }),
    }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

/* ── Mocks ── */

const mockStart = vi.fn()
const mockStop = vi.fn()
const mockApiGet = vi.fn()

vi.mock('../../hooks/useSSEStream', () => ({
    useSSEStream: () => ({
        start: mockStart,
        stop: mockStop,
        generating: false,
    }),
}))

vi.mock('../../lib/api', () => ({
    api: {
        get: (...args: any[]) => mockApiGet(...args),
    },
}))

vi.mock('framer-motion', () => ({
    motion: {
        div: ({ children, ...props }: any) => <div {...filterMotionProps(props)}>{children}</div>,
        ul: ({ children, ...props }: any) => <ul {...filterMotionProps(props)}>{children}</ul>,
    },
    AnimatePresence: ({ children }: any) => <>{children}</>,
}))

function filterMotionProps(props: Record<string, any>) {
    const filtered: Record<string, any> = {}
    for (const key of Object.keys(props)) {
        if (!['initial', 'animate', 'exit', 'transition', 'whileHover', 'whileTap', 'layout'].includes(key)) {
            filtered[key] = props[key]
        }
    }
    return filtered
}

// Mock stores with minimal state
const mockStreamStore: Record<string, any> = {
    sections: [],
    chapters: [],
    logs: [],
    error: null,
    generating: false,
    clearStream: vi.fn(),
}

vi.mock('../../stores/useStreamStore', () => ({
    useStreamStore: (selector: (s: any) => any) => selector(mockStreamStore),
}))

const mockProjectStore: Record<string, any> = {
    currentProject: { id: 'proj-1', name: '测试项目', genre: '奇幻', style: '叙事', status: 'active', chapter_count: 0, entity_count: 0, event_count: 0, target_length: 300000 },
    fetchProject: vi.fn(),
}

vi.mock('../../stores/useProjectStore', () => ({
    useProjectStore: (selector: (s: any) => any) => selector(mockProjectStore),
}))

const mockAddToast = vi.fn()
vi.mock('../../stores/useToastStore', () => ({
    useToastStore: (selector: (s: any) => any) => selector({ addToast: mockAddToast }),
}))

let mockReadingMode = false
const mockEnterReadingMode = vi.fn(() => { mockReadingMode = true })
const mockExitReadingMode = vi.fn(() => { mockReadingMode = false })

vi.mock('../../stores/useUIStore', () => ({
    useUIStore: (selector: (s: any) => any) =>
        selector({
            readingMode: mockReadingMode,
            enterReadingMode: mockEnterReadingMode,
            exitReadingMode: mockExitReadingMode,
        }),
}))

/* ── Helpers ── */

function renderPage(initialPath = '/project/proj-1/write') {
    return render(
        <MemoryRouter initialEntries={[initialPath]}>
            <Routes>
                <Route path="/project/:projectId/write" element={<WritingConsolePage />} />
            </Routes>
        </MemoryRouter>,
    )
}

/* ── Tests ── */

describe('WritingConsolePage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        localStorageMock.clear()
        mockApiGet.mockResolvedValue({ data: [] })
        mockStreamStore.sections = []
        mockStreamStore.chapters = []
        mockStreamStore.logs = []
        mockStreamStore.error = null
        mockStreamStore.clearStream = vi.fn()
        mockReadingMode = false
        vi.stubGlobal('confirm', vi.fn(() => true))
    })

    it('渲染页面标题和项目名', () => {
        renderPage()
        expect(screen.getByText('创作控制台')).toBeTruthy()
        expect(screen.getByText(/测试项目/)).toBeTruthy()
    })

    it('route 项目与 currentProject 不一致时会重新拉取项目', async () => {
        renderPage('/project/proj-2/write')
        await waitFor(() => {
            expect(mockProjectStore.fetchProject).toHaveBeenCalledWith('proj-2')
        })
    })

    it('渲染生成表单的 prompt 输入框', () => {
        renderPage()
        const textarea = screen.getByPlaceholderText(/一句话输入你的小说核心/)
        expect(textarea).toBeTruthy()
    })

    it('从项目概览带参进入时自动填充 prompt 与 scope', () => {
        renderPage('/project/proj-1/write?prompt=%E6%B5%8B%E8%AF%95%E6%A2%97%E6%A6%82&scope=book')
        const textarea = screen.getByPlaceholderText(/一句话输入你的小说核心/) as HTMLTextAreaElement
        expect(textarea.value).toBe('测试梗概')
        expect(screen.getByText('整本').className).toContain('active')
    })

    it('渲染模式选择按钮', () => {
        renderPage()
        expect(screen.getByText('工作室')).toBeTruthy()
        expect(screen.getByText('快速')).toBeTruthy()
        expect(screen.getByText('电影感')).toBeTruthy()
    })

    it('渲染范围选择按钮', () => {
        renderPage()
        expect(screen.getByText('单卷')).toBeTruthy()
        expect(screen.getByText('整本')).toBeTruthy()
    })

    it('渲染模板预设选择器', () => {
        renderPage()
        expect(screen.getByLabelText('模板预设')).toBeTruthy()
    })

    it('prompt 为空时禁用开始生成按钮', () => {
        renderPage()
        const btn = screen.getByText('开始生成')
        expect(btn).toHaveProperty('disabled', true)
    })

    it('输入 prompt 后可以点击开始生成', () => {
        renderPage()
        const textarea = screen.getByPlaceholderText(/一句话输入你的小说核心/)
        fireEvent.change(textarea, { target: { value: '一个关于时间旅行的故事' } })
        const btn = screen.getByText('开始生成')
        expect(btn).toHaveProperty('disabled', false)
    })

    it('点击开始生成时调用 start 并触发 Toast', () => {
        renderPage()
        const textarea = screen.getByPlaceholderText(/一句话输入你的小说核心/)
        fireEvent.change(textarea, { target: { value: '测试提示' } })
        fireEvent.click(screen.getByText('开始生成'))
        expect(mockStart).toHaveBeenCalledTimes(1)
        expect(mockAddToast).toHaveBeenCalledWith('info', '开始生成，请稍候…')
    })

    it('点击从最新章节续写时带 continuation 参数启动', async () => {
        mockApiGet.mockResolvedValue({
            data: [{ id: 'ch-3', chapter_number: 3 }],
        })
        renderPage()
        fireEvent.click(screen.getByText('从最新章节续写'))

        await waitFor(() => {
            expect(mockStart).toHaveBeenCalledTimes(1)
        })
        const payload = mockStart.mock.calls[0][0]
        expect(payload.form.continuation_mode).toBe(true)
        expect(payload.form.start_chapter_number).toBe(4)
        expect(String(payload.form.prompt)).toContain('延续当前故事')
    })

    it('有 sections 时渲染 Markdown 内容', () => {
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '这是正文内容', waiting: false },
        ]
        renderPage()
        expect(screen.getByText('这是正文内容')).toBeTruthy()
    })

    it('计划 JSON 会结构化展示而不是原样输出', () => {
        mockStreamStore.sections = [
            {
                chapterId: 'ch-1',
                chapterNumber: 1,
                title: '序章',
                body: JSON.stringify({
                    beats: ['主角潜入镜城', '发现旧日志'],
                    conflicts: ['外部阻力：哨兵追捕'],
                    foreshadowing: ['日志指向导师编号'],
                    callback_targets: ['回收第19章镜灵警告'],
                    role_goals: { 林深: '带陈默活着离开' },
                }),
                waiting: false,
            },
        ]
        renderPage()
        expect(screen.getByText('章节计划草稿')).toBeTruthy()
        expect(screen.getByText('主角潜入镜城')).toBeTruthy()
        expect(
            screen.getAllByText((_, node) => node?.textContent?.trim() === '林深：带陈默活着离开').length,
        ).toBeGreaterThan(0)
        expect(screen.queryByText(/"beats":/)).toBeNull()
    })

    it('无内容时显示占位提示', () => {
        renderPage()
        expect(screen.getByText(/输入创作提示并点击/)).toBeTruthy()
    })

    it('有 chapters 时显示统计信息', () => {
        mockStreamStore.chapters = [
            { id: 'ch-1', chapter_number: 1, title: '序章', status: 'done', word_count: 1500, p0_count: 0 },
        ]
        renderPage()
        fireEvent.click(screen.getByText('显示辅助面板'))
        fireEvent.click(screen.getByText('统计'))
        expect(screen.getByText('1 章')).toBeTruthy()
    })

    it('有 sections 时渲染章节目录', () => {
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '内容', waiting: false },
            { chapterId: 'ch-2', chapterNumber: 2, title: '觉醒', body: '更多内容', waiting: false },
        ]
        renderPage()
        fireEvent.click(screen.getByText('显示辅助面板'))
        expect(screen.getAllByText('章节目录').length).toBeGreaterThan(0)
        expect(screen.getByText('第1章')).toBeTruthy()
        expect(screen.getByText('序章')).toBeTruthy()
        expect(screen.getByText('第2章')).toBeTruthy()
        expect(screen.getByText('觉醒')).toBeTruthy()
    })

    it('显示错误信息', () => {
        mockStreamStore.error = '连接超时'
        renderPage()
        expect(screen.getByText('连接超时')).toBeTruthy()
    })

    it('点击清空当前草稿只清空工作台展示区', () => {
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '内容', waiting: false },
        ]
        mockStreamStore.chapters = [
            { id: 'ch-1', chapter_number: 1, title: '序章', status: 'done', word_count: 1234, p0_count: 0 },
        ]
        mockStreamStore.logs = ['log-1']
        renderPage()

        fireEvent.click(screen.getByText('清空当前草稿'))

        expect(mockStreamStore.clearStream).toHaveBeenCalledTimes(1)
        expect(mockAddToast).toHaveBeenCalledWith('success', '已清空当前创作草稿显示区')
    })

    it('渲染高级设置区域', () => {
        renderPage()
        expect(screen.getByText('高级设置')).toBeTruthy()
    })

    it('渲染日志面板', () => {
        mockStreamStore.logs = ['10:00:00  开始流式生成']
        renderPage()
        fireEvent.click(screen.getByText('显示辅助面板'))
        fireEvent.click(screen.getByText('日志'))
        expect(screen.getByText('生成日志')).toBeTruthy()
        expect(screen.getByText(/10:00:00.*开始流式生成/)).toBeTruthy()
    })

    /* ── 阅读模式测试 ── */

    it('有 sections 时显示阅读模式按钮', () => {
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '内容', waiting: false },
        ]
        renderPage()
        expect(screen.getByTitle('进入阅读模式')).toBeTruthy()
    })

    it('无 sections 时不显示阅读模式按钮', () => {
        renderPage()
        expect(screen.queryByTitle('进入阅读模式')).toBeNull()
    })

    it('点击阅读模式按钮调用 enterReadingMode', () => {
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '内容', waiting: false },
        ]
        renderPage()
        fireEvent.click(screen.getByTitle('进入阅读模式'))
        expect(mockEnterReadingMode).toHaveBeenCalledTimes(1)
    })

    it('阅读模式下显示浮动工具条和退出按钮', () => {
        mockReadingMode = true
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '阅读内容', waiting: false },
        ]
        renderPage()
        expect(screen.getByText(/退出阅读/)).toBeTruthy()
        expect(screen.getByText('阅读内容')).toBeTruthy()
    })

    it('阅读模式下隐藏生成表单和侧边栏', () => {
        mockReadingMode = true
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '内容', waiting: false },
        ]
        renderPage()
        expect(screen.queryByText('创作控制台')).toBeNull()
        expect(screen.queryByPlaceholderText(/一句话输入你的小说核心/)).toBeNull()
        expect(screen.queryByText('生成日志')).toBeNull()
    })

    it('阅读模式下点击退出按钮调用 exitReadingMode', () => {
        mockReadingMode = true
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '内容', waiting: false },
        ]
        renderPage()
        fireEvent.click(screen.getByText(/退出阅读/))
        expect(mockExitReadingMode).toHaveBeenCalledTimes(1)
    })

    it('阅读模式下按 Escape 调用 exitReadingMode', () => {
        mockReadingMode = true
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '内容', waiting: false },
        ]
        renderPage()
        fireEvent.keyDown(window, { key: 'Escape' })
        expect(mockExitReadingMode).toHaveBeenCalledTimes(1)
    })

    it('阅读模式下显示章节导航按钮', () => {
        mockReadingMode = true
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '内容一', waiting: false },
            { chapterId: 'ch-2', chapterNumber: 2, title: '觉醒', body: '内容二', waiting: false },
        ]
        renderPage()
        expect(screen.getByText('← 上一章')).toBeTruthy()
        expect(screen.getByText('下一章 →')).toBeTruthy()
    })

    it('阅读模式下第一章时上一章按钮禁用', () => {
        mockReadingMode = true
        mockStreamStore.sections = [
            { chapterId: 'ch-1', chapterNumber: 1, title: '序章', body: '内容', waiting: false },
            { chapterId: 'ch-2', chapterNumber: 2, title: '觉醒', body: '内容二', waiting: false },
        ]
        renderPage()
        const prevBtn = screen.getByText('← 上一章')
        expect(prevBtn).toHaveProperty('disabled', true)
    })

    /* ── 高级设置字段级校验测试 ── */

    it('章节数输入获得焦点时显示推荐值提示', () => {
        renderPage()
        const input = screen.getByLabelText('章节数')
        fireEvent.focus(input)
        expect(screen.getByText('推荐 8-12 章')).toBeTruthy()
    })

    it('每章目标字数输入获得焦点时显示推荐值提示', () => {
        renderPage()
        const input = screen.getByLabelText('每章目标字数')
        fireEvent.focus(input)
        expect(screen.getByText('推荐 1200-2000 字')).toBeTruthy()
    })

    it('章节数超出范围时失焦显示错误提示', () => {
        renderPage()
        const input = screen.getByLabelText('章节数')
        fireEvent.change(input, { target: { value: '100' } })
        fireEvent.blur(input)
        expect(screen.getByText('范围：1-60')).toBeTruthy()
    })

    it('每章目标字数超出范围时失焦显示错误提示', () => {
        renderPage()
        const input = screen.getByLabelText('每章目标字数')
        fireEvent.change(input, { target: { value: '50000' } })
        fireEvent.blur(input)
        expect(screen.getByText('范围：300-12000')).toBeTruthy()
    })

    it('章节数超出范围时输入框添加 field-error 类', () => {
        renderPage()
        const input = screen.getByLabelText('章节数')
        fireEvent.change(input, { target: { value: '100' } })
        fireEvent.blur(input)
        expect(input.className).toContain('field-error')
    })

    it('章节数在范围内时不添加 field-error 类', () => {
        renderPage()
        const input = screen.getByLabelText('章节数')
        fireEvent.focus(input)
        expect(input.className).not.toContain('field-error')
    })

    it('章节数支持先清空再输入新值', () => {
        renderPage()
        const input = screen.getByLabelText('章节数') as HTMLInputElement
        fireEvent.change(input, { target: { value: '' } })
        expect(input.value).toBe('')

        fireEvent.change(input, { target: { value: '18' } })
        expect(input.value).toBe('18')
    })

    it('每章字数支持先清空再输入新值', () => {
        renderPage()
        const input = screen.getByLabelText('每章目标字数') as HTMLInputElement
        fireEvent.change(input, { target: { value: '' } })
        expect(input.value).toBe('')

        fireEvent.change(input, { target: { value: '2400' } })
        expect(input.value).toBe('2400')
    })

    it('高级设置会按项目持久化并在重新进入后沿用', () => {
        const { unmount } = renderPage()
        const chapterInput = screen.getByLabelText('章节数') as HTMLInputElement
        const wordsInput = screen.getByLabelText('每章目标字数') as HTMLInputElement
        const bookBtn = screen.getByText('整本')
        const quickBtn = screen.getByText('快速')
        const autoApprove = screen.getByLabelText('无 P0 冲突自动审批') as HTMLInputElement

        fireEvent.change(chapterInput, { target: { value: '16' } })
        fireEvent.change(wordsInput, { target: { value: '2200' } })
        fireEvent.click(bookBtn)
        fireEvent.click(quickBtn)
        fireEvent.click(autoApprove)

        unmount()

        renderPage()
        expect((screen.getByLabelText('章节数') as HTMLInputElement).value).toBe('16')
        expect((screen.getByLabelText('每章目标字数') as HTMLInputElement).value).toBe('2200')
        expect(screen.getByText('整本').className).toContain('active')
        expect(screen.getByText('快速').className).toContain('active')
        expect((screen.getByLabelText('无 P0 冲突自动审批') as HTMLInputElement).checked).toBe(false)
    })

    it('初次加载不会弹出高级设置已保存提示', () => {
        vi.useFakeTimers()
        try {
            renderPage()
            vi.advanceTimersByTime(800)
            expect(mockAddToast).not.toHaveBeenCalledWith('info', '高级设置已保存')
        } finally {
            vi.useRealTimers()
        }
    })

    it('修改高级设置后会静默持久化', () => {
        renderPage()
        const input = screen.getByLabelText('章节数') as HTMLInputElement
        fireEvent.change(input, { target: { value: '12' } })
        fireEvent.blur(input)
        expect(localStorageMock.setItem).toHaveBeenCalled()
        expect(mockAddToast).not.toHaveBeenCalledWith('info', '高级设置已保存')
    })
})
