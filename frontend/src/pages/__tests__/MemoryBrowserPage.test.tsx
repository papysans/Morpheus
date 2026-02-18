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

beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
    mockApiGet.mockResolvedValue({ data: { content: '默认身份设定内容' } })
})

describe('MemoryBrowserPage', () => {
    it('route 项目与 currentProject 不一致时会重新拉取项目', async () => {
        renderPage('proj-2')
        await waitFor(() => {
            expect(mockFetchProject).toHaveBeenCalledWith('proj-2')
        })
    })

    it('renders page title and subtitle', () => {
        renderPage()
        expect(screen.getByText('记忆浏览器')).toBeInTheDocument()
        expect(screen.getByText(/检索三层记忆/)).toBeInTheDocument()
    })

    it('renders three tab buttons', () => {
        renderPage()
        expect(screen.getByText('L1 身份设定')).toBeInTheDocument()
        expect(screen.getByText('L2/L3 记忆搜索')).toBeInTheDocument()
        expect(screen.getByText('分层说明')).toBeInTheDocument()
    })

    it('defaults to L1 identity tab', () => {
        renderPage()
        const identityTab = screen.getByText('L1 身份设定')
        expect(identityTab.getAttribute('aria-selected')).toBe('true')
    })

    it('loads identity content on mount', async () => {
        mockApiGet.mockResolvedValueOnce({ data: { content: '测试身份内容' } })
        renderPage()
        await waitFor(() => {
            expect(mockApiGet).toHaveBeenCalledWith('/identity/proj-1')
        })
    })

    it('shows skeleton while identity is loading', () => {
        mockApiGet.mockReturnValue(new Promise(() => { }))
        const { container } = renderPage()
        expect(container.querySelector('.skeleton--card')).toBeInTheDocument()
    })

    it('shows editable textarea after identity loads', async () => {
        mockApiGet.mockResolvedValueOnce({ data: { content: '身份设定文本' } })
        renderPage()
        await waitFor(() => {
            expect(screen.getByDisplayValue('身份设定文本')).toBeInTheDocument()
        })
    })

    it('saves identity and shows success toast', async () => {
        mockApiGet.mockResolvedValueOnce({ data: { content: '原始内容' } })
        mockApiPut.mockResolvedValueOnce({ data: {} })
        renderPage()

        await waitFor(() => {
            expect(screen.getByDisplayValue('原始内容')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('保存身份设定'))

        await waitFor(() => {
            expect(mockApiPut).toHaveBeenCalledWith('/identity/proj-1', { content: '原始内容' })
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('success')
            expect(toasts[0].message).toBe('身份设定已保存')
        })
    })

    it('shows error toast when identity save fails', async () => {
        mockApiGet.mockResolvedValueOnce({ data: { content: '内容' } })
        mockApiPut.mockRejectedValueOnce(new Error('save failed'))
        renderPage()

        await waitFor(() => {
            expect(screen.getByDisplayValue('内容')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('保存身份设定'))

        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('error')
            expect(toasts[0].message).toBe('保存身份设定失败')
        })
    })

    it('switches to search tab and shows search UI', async () => {
        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))

        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
            expect(screen.getByText('检索')).toBeInTheDocument()
        })
    })

    it('performs search and displays results', async () => {
        mockApiGet
            .mockResolvedValueOnce({ data: { content: '' } })
            .mockResolvedValueOnce({ data: { results: sampleResults } })

        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))

        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), {
            target: { value: '冰霜' },
        })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            expect(screen.getByText('世界观设定：冰霜大陆')).toBeInTheDocument()
            expect(screen.getByText('第一章决策：主角出发')).toBeInTheDocument()
            expect(screen.getByText('第一章摘要')).toBeInTheDocument()
        })
    })

    it('shows layer badges with correct labels', async () => {
        mockApiGet
            .mockResolvedValueOnce({ data: { content: '' } })
            .mockResolvedValueOnce({ data: { results: sampleResults } })

        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))

        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), {
            target: { value: '测试' },
        })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            const badges = screen.getAllByText(/^L[123]$/)
            expect(badges.length).toBe(3)
        })
    })

    it('expands result on click to show full content and source path', async () => {
        mockApiGet
            .mockResolvedValueOnce({ data: { content: '' } })
            .mockResolvedValueOnce({ data: { results: sampleResults } })

        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))

        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), {
            target: { value: '冰霜' },
        })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            expect(screen.getByText('世界观设定：冰霜大陆')).toBeInTheDocument()
        })

        // Click to expand
        fireEvent.click(screen.getByText('世界观设定：冰霜大陆'))

        await waitFor(() => {
            expect(screen.getByText(/来源: memory\/L1\/IDENTITY\.md/)).toBeInTheDocument()
            expect(screen.getByText(/冰霜大陆是一个被永恒寒冬笼罩的世界/)).toBeInTheDocument()
        })
    })

    it('shows semantic snippet and open-source link for result without evidence', async () => {
        mockApiGet
            .mockResolvedValueOnce({ data: { content: '' } })
            .mockResolvedValueOnce({ data: { results: sampleResults } })

        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), {
            target: { value: '第一章' },
        })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            expect(screen.getByText('第一章摘要')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('第一章摘要'))

        await waitFor(() => {
            expect(screen.getByText('语义命中片段')).toBeInTheDocument()
            expect(screen.getByText(/第一章中主角被迫离开家乡/)).toBeInTheDocument()
            const link = screen.getByText('打开原文 MD').closest('a')
            expect(link).toHaveAttribute(
                'href',
                '/api/projects/proj-1/memory/source?source_path=memory%2FL3%2Fch1-summary.md',
            )
        })
    })

    it('shows chapter jump button when source maps to chapter markdown', async () => {
        mockApiGet
            .mockResolvedValueOnce({ data: { content: '' } })
            .mockResolvedValueOnce({ data: { results: sampleResults } })

        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), {
            target: { value: '决策' },
        })
        fireEvent.click(screen.getByText('检索'))
        await waitFor(() => {
            expect(screen.getByText('第一章决策：主角出发')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('第一章决策：主角出发'))
        await waitFor(() => {
            expect(screen.getByText('跳到章节')).toBeInTheDocument()
        })
    })

    it('renders bracketed evidence as highlight mark instead of raw [] text', async () => {
        const highlightedResult = [
            {
                item_id: 'mem-hit-1',
                layer: 'L2',
                source_path: 'memory/L2/MEMORY.md',
                summary: '命中测试',
                evidence: '门外是昨晚那个中年女声：“[林七]？是我……”',
                combined_score: 0.88,
            },
        ]

        mockApiGet
            .mockResolvedValueOnce({ data: { content: '' } })
            .mockResolvedValueOnce({ data: { results: highlightedResult } })

        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))
        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), {
            target: { value: '林七' },
        })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            expect(screen.getByText('命中测试')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByText('命中测试'))
        await waitFor(() => {
            const mark = screen.getByText('林七')
            expect(mark.tagName.toLowerCase()).toBe('mark')
            expect(mark).toHaveClass('memory-hit-mark')
            expect(screen.queryByText('[林七]')).not.toBeInTheDocument()
        })
    })

    it('shows error toast when search fails', async () => {
        mockApiGet
            .mockResolvedValueOnce({ data: { content: '' } })
            .mockRejectedValueOnce(new Error('search failed'))

        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))

        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), {
            target: { value: '测试' },
        })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts.some((t) => t.type === 'error' && t.message === '记忆检索失败')).toBe(true)
        })
    })

    it('filters results by layer', async () => {
        mockApiGet
            .mockResolvedValueOnce({ data: { content: '' } })
            .mockResolvedValueOnce({ data: { results: sampleResults } })

        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))

        await waitFor(() => {
            expect(screen.getByPlaceholderText(/输入角色、事件/)).toBeInTheDocument()
        })

        // Set filter to L1 before searching
        fireEvent.change(screen.getByLabelText('层级筛选'), {
            target: { value: 'L1' },
        })

        fireEvent.change(screen.getByPlaceholderText(/输入角色、事件/), {
            target: { value: '冰霜' },
        })
        fireEvent.click(screen.getByText('检索'))

        await waitFor(() => {
            // Only L1 result should be visible
            expect(screen.getByText('世界观设定：冰霜大陆')).toBeInTheDocument()
            expect(screen.queryByText('第一章决策：主角出发')).not.toBeInTheDocument()
            expect(screen.queryByText('第一章摘要')).not.toBeInTheDocument()
        })
    })

    it('switches to layers tab and shows three layer descriptions', async () => {
        renderPage()
        fireEvent.click(screen.getByText('分层说明'))

        await waitFor(() => {
            expect(screen.getByText('L1 稳态记忆')).toBeInTheDocument()
            expect(screen.getByText('L2 过程记忆')).toBeInTheDocument()
            expect(screen.getByText('L3 长期记忆')).toBeInTheDocument()
        })
    })

    it('has back link to project detail', () => {
        renderPage()
        const backLink = screen.getByText('← 返回项目')
        expect(backLink.closest('a')).toHaveAttribute('href', '/project/proj-1')
    })

    it('disables search button when query is empty', async () => {
        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))

        await waitFor(() => {
            const searchBtn = screen.getByText('检索')
            expect(searchBtn).toBeDisabled()
        })
    })

    it('triggers search on Enter key', async () => {
        mockApiGet
            .mockResolvedValueOnce({ data: { content: '' } })
            .mockResolvedValueOnce({ data: { results: [] } })

        renderPage()
        fireEvent.click(screen.getByText('L2/L3 记忆搜索'))

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
})
