import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import MemoryBrowserPage from '../MemoryBrowserPage'
import { useToastStore } from '../../stores/useToastStore'

/* ── Mocks ── */

vi.mock('framer-motion', () => ({
    motion: {
        div: ({ children, ...props }: any) => <div {...filterMotionProps(props)}>{children}</div>,
        section: ({ children, ...props }: any) => <section {...filterMotionProps(props)}>{children}</section>,
        article: ({ children, ...props }: any) => <article {...filterMotionProps(props)}>{children}</article>,
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

const mockApiGet = vi.fn()
const mockApiPut = vi.fn()

vi.mock('../../lib/api', () => ({
    api: {
        get: (...args: any[]) => mockApiGet(...args),
        put: (...args: any[]) => mockApiPut(...args),
    },
}))

const mockFetchProject = vi.fn()
vi.mock('../../stores/useProjectStore', () => ({
    useProjectStore: (selector: (s: any) => any) =>
        selector({
            fetchProject: mockFetchProject,
            currentProject: { id: 'proj-1', name: '测试项目' },
        }),
}))

function renderPage(projectId = 'proj-1') {
    return render(
        <MemoryRouter initialEntries={[`/project/${projectId}/memory`]}>
            <Routes>
                <Route path="/project/:projectId/memory" element={<MemoryBrowserPage />} />
                <Route path="/project/:projectId" element={<div>Project Detail</div>} />
            </Routes>
        </MemoryRouter>
    )
}

const sampleResults = [
    {
        item_id: 'mem-1',
        layer: 'L1',
        source_path: 'memory/L1/IDENTITY.md',
        summary: '世界观设定：冰霜大陆',
        evidence: '冰霜大陆是一个被永恒寒冬笼罩的世界',
        combined_score: 0.95,
    },
    {
        item_id: 'mem-2',
        layer: 'L2',
        source_path: 'chapters/ch-1.md',
        summary: '第一章决策：主角出发',
        evidence: '主角决定离开家乡',
        combined_score: 0.82,
    },
    {
        item_id: 'mem-3',
        layer: 'L3',
        source_path: 'memory/L3/ch1-summary.md',
        summary: '第一章摘要',
        content: '第一章中主角被迫离开家乡，踏上未知旅程，并与关键配角发生第一次冲突。',
        combined_score: 0.71,
    },
]

const sampleFiles = [
    { layer: 'L1', name: 'IDENTITY.md', path: 'memory/L1/IDENTITY.md', summary: '身份设定', item_type: 'identity', size_bytes: 2048, modified_at: '2026-02-20T10:00:00Z' },
    { layer: 'L2', name: 'MEMORY.md', path: 'memory/L2/MEMORY.md', summary: '过程记忆', item_type: 'memory', size_bytes: 4096, modified_at: '2026-02-21T10:00:00Z' },
]

beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
    // Default: identity + files both load
    mockApiGet.mockImplementation((url: string) => {
        if (url.includes('/identity/')) return Promise.resolve({ data: { content: '默认身份设定内容' } })
        if (url.includes('/memory/files')) return Promise.resolve({ data: { files: sampleFiles } })
        return Promise.resolve({ data: {} })
    })
})

describe('MemoryBrowserPage', () => {
    it('renders page title and subtitle', () => {
        renderPage()
        expect(screen.getByText('记忆浏览器')).toBeInTheDocument()
        expect(screen.getByText(/检索三层记忆/)).toBeInTheDocument()
    })

    it('has back link to project detail', () => {
        renderPage()
        const backLink = screen.getByText('← 返回项目')
        expect(backLink.closest('a')).toHaveAttribute('href', '/project/proj-1')
    })

    it('renders view toggle buttons', () => {
        renderPage()
        expect(screen.getByText('浏览与搜索')).toBeInTheDocument()
        expect(screen.getByText('身份设定')).toBeInTheDocument()
    })

    it('defaults to browse view with search and file panels', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('语义搜索')).toBeInTheDocument()
            expect(screen.getByText('记忆文件')).toBeInTheDocument()
        })
    })

    it('loads identity and memory files on mount', async () => {
        renderPage()
        await waitFor(() => {
            expect(mockApiGet).toHaveBeenCalledWith('/identity/proj-1')
            expect(mockApiGet).toHaveBeenCalledWith('/projects/proj-1/memory/files')
        })
    })

    it('route 项目与 currentProject 不一致时会重新拉取项目', async () => {
        renderPage('proj-2')
        await waitFor(() => {
            expect(mockFetchProject).toHaveBeenCalledWith('proj-2')
        })
    })

    it('shows layer stats bar after files load', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('L1 稳态')).toBeInTheDocument()
            expect(screen.getByText('L2 过程')).toBeInTheDocument()
        })
    })

    it('shows layer legend inline in browse view', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText(/世界观 · 角色约束/)).toBeInTheDocument()
            expect(screen.getByText(/章节决策 · 临时线索/)).toBeInTheDocument()
            expect(screen.getByText(/章节摘要 · 事件卡/)).toBeInTheDocument()
        })
    })

    /* ── Search ── */

    it('shows quick query chips when no search has been performed', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('主角动机')).toBeInTheDocument()
            expect(screen.getByText('伏笔回收')).toBeInTheDocument()
        })
    })

    it('performs search and displays results', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            if (url.includes('/memory/query')) return Promise.resolve({ data: { results: sampleResults } })
            return Promise.resolve({ data: {} })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), { target: { value: '冰霜' } })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            expect(screen.getByText('世界观设定：冰霜大陆')).toBeInTheDocument()
            expect(screen.getByText('第一章决策：主角出发')).toBeInTheDocument()
            expect(screen.getByText('第一章摘要')).toBeInTheDocument()
        })
    })

    it('disables search button when query is empty', async () => {
        renderPage()
        await waitFor(() => {
            const searchBtn = screen.getByText('检索')
            expect(searchBtn).toBeDisabled()
        })
    })

    it('triggers search on Enter key', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            if (url.includes('/memory/query')) return Promise.resolve({ data: { results: [] } })
            return Promise.resolve({ data: {} })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        const input = screen.getByPlaceholderText(/输入角色、事件/)
        fireEvent.change(input, { target: { value: '测试关键词' } })
        fireEvent.keyDown(input, { key: 'Enter' })

        await waitFor(() => {
            expect(mockApiGet).toHaveBeenCalledWith('/memory/query', expect.objectContaining({
                params: expect.objectContaining({ query: '测试关键词' }),
            }))
        })
    })

    it('quick search fills query and triggers search', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            if (url.includes('/memory/query')) return Promise.resolve({ data: { results: sampleResults } })
            return Promise.resolve({ data: {} })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByText('主角动机')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('主角动机'))

        await waitFor(() => {
            expect(mockApiGet).toHaveBeenCalledWith('/memory/query', expect.objectContaining({
                params: expect.objectContaining({ query: '主角 目标 动机' }),
            }))
        })
    })

    it('shows layer badges on results', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            if (url.includes('/memory/query')) return Promise.resolve({ data: { results: sampleResults } })
            return Promise.resolve({ data: {} })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), { target: { value: '测试' } })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            const badges = screen.getAllByText(/^L[123]$/)
            expect(badges.length).toBe(3)
        })
    })

    it('expands result on click to show source path and actions', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            if (url.includes('/memory/query')) return Promise.resolve({ data: { results: sampleResults } })
            return Promise.resolve({ data: {} })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), { target: { value: '冰霜' } })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            expect(screen.getByText('世界观设定：冰霜大陆')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('世界观设定：冰霜大陆'))

        await waitFor(() => {
            expect(screen.getByText('memory/L1/IDENTITY.md')).toBeInTheDocument()
            expect(screen.getByText('打开原文')).toBeInTheDocument()
        })
    })

    it('shows chapter jump button when source maps to chapter', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            if (url.includes('/memory/query')) return Promise.resolve({ data: { results: sampleResults } })
            return Promise.resolve({ data: {} })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), { target: { value: '决策' } })
        fireEvent.click(screen.getByText('检索'))
        await waitFor(() => {
            expect(screen.getByText('第一章决策：主角出发')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('第一章决策：主角出发'))
        await waitFor(() => {
            expect(screen.getByText('跳到章节')).toBeInTheDocument()
        })
    })

    it('renders bracketed evidence as highlight mark', async () => {
        const highlightedResult = [{
            item_id: 'mem-hit-1',
            layer: 'L2' as const,
            source_path: 'memory/L2/MEMORY.md',
            summary: '命中测试',
            evidence: '门外是昨晚那个中年女声："[林七]？是我……"',
            combined_score: 0.88,
        }]

        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            if (url.includes('/memory/query')) return Promise.resolve({ data: { results: highlightedResult } })
            return Promise.resolve({ data: {} })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), { target: { value: '林七' } })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            expect(screen.getByText('命中测试')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('命中测试'))
        await waitFor(() => {
            const mark = screen.getByText('林七')
            expect(mark.tagName.toLowerCase()).toBe('mark')
            expect(mark).toHaveClass('memory-hit-mark')
        })
    })

    it('shows error toast when search fails', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            if (url.includes('/memory/query')) return Promise.reject(new Error('search failed'))
            return Promise.resolve({ data: {} })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), { target: { value: '测试' } })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts.some((t) => t.type === 'error' && t.message === '记忆检索失败')).toBe(true)
        })
    })

    it('filters results by layer', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            if (url.includes('/memory/query')) return Promise.resolve({ data: { results: sampleResults } })
            return Promise.resolve({ data: {} })
        })

        renderPage()
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByLabelText('层级筛选'), { target: { value: 'L1' } })
        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), { target: { value: '冰霜' } })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            expect(screen.getByText('世界观设定：冰霜大陆')).toBeInTheDocument()
            expect(screen.queryByText('第一章决策：主角出发')).not.toBeInTheDocument()
        })
    })

    /* ── Identity View ── */

    it('switches to identity view and shows editor', async () => {
        renderPage()
        fireEvent.click(screen.getByText('身份设定'))

        await waitFor(() => {
            expect(screen.getByPlaceholderText('在此编辑身份设定内容...')).toBeInTheDocument()
        })
    })

    it('loads and displays identity content', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '测试身份内容' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            return Promise.resolve({ data: {} })
        })

        renderPage()
        fireEvent.click(screen.getByText('身份设定'))

        await waitFor(() => {
            expect(screen.getByDisplayValue('测试身份内容')).toBeInTheDocument()
        })
    })

    it('saves identity and shows success toast', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '原始内容' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            return Promise.resolve({ data: {} })
        })
        mockApiPut.mockResolvedValueOnce({ data: {} })

        renderPage()
        fireEvent.click(screen.getByText('身份设定'))

        await waitFor(() => {
            expect(screen.getByDisplayValue('原始内容')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => {
            expect(mockApiPut).toHaveBeenCalledWith('/identity/proj-1', { content: '原始内容' })
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('success')
        })
    })

    it('shows error toast when identity save fails', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url.includes('/identity/')) return Promise.resolve({ data: { content: '内容' } })
            if (url.includes('/memory/files')) return Promise.resolve({ data: { files: [] } })
            return Promise.resolve({ data: {} })
        })
        mockApiPut.mockRejectedValueOnce(new Error('save failed'))

        renderPage()
        fireEvent.click(screen.getByText('身份设定'))

        await waitFor(() => {
            expect(screen.getByDisplayValue('内容')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('error')
        })
    })

    /* ── File Browser ── */

    it('shows memory files in the file panel', async () => {
        renderPage()
        await waitFor(() => {
            // File card titles rendered in .mb-file-card__title
            expect(screen.getByText('过程记忆')).toBeInTheDocument()
            // "身份设定" appears both as button and file card; check file paths instead
            expect(screen.getByText('memory/L1/IDENTITY.md')).toBeInTheDocument()
            expect(screen.getByText('memory/L2/MEMORY.md')).toBeInTheDocument()
        })
    })

    it('filters files by layer using file panel filter chips', async () => {
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('过程记忆')).toBeInTheDocument()
        })

        // The file panel filter area has chip-btn buttons inside .mb-layer-filters
        const filtersContainer = document.querySelector('.mb-layer-filters')
        expect(filtersContainer).toBeTruthy()
        const l1FilterBtn = Array.from(filtersContainer!.querySelectorAll('button')).find(
            (btn) => btn.textContent?.includes('L1 稳态')
        )
        expect(l1FilterBtn).toBeTruthy()
        fireEvent.click(l1FilterBtn!)

        await waitFor(() => {
            expect(screen.queryByText('过程记忆')).not.toBeInTheDocument()
        })
    })
})
