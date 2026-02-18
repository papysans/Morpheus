import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import TraceReplayPage, { AGENT_ROLE_COLORS } from '../TraceReplayPage'
import { useToastStore } from '../../stores/useToastStore'

/* ── Mocks ── */

vi.mock('framer-motion', () => ({
    motion: {
        div: ({ children, ...props }: any) => <div {...filterMotionProps(props)}>{children}</div>,
        button: ({ children, ...props }: any) => <button {...filterMotionProps(props)}>{children}</button>,
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
vi.mock('../../lib/api', () => ({
    api: { get: (...args: any[]) => mockApiGet(...args) },
}))

const mockFetchProject = vi.fn()
vi.mock('../../stores/useProjectStore', () => ({
    useProjectStore: (selector: (s: any) => any) =>
        selector({
            fetchProject: mockFetchProject,
            currentProject: { id: 'proj-1', name: '测试项目' },
        }),
}))

/* ── Test data ── */

const sampleTrace = {
    id: 'trace-1',
    chapter_id: 3,
    decisions: [
        {
            id: 'dec-1',
            agent_role: 'director',
            input_refs: ['ref-a', 'ref-b'],
            decision_text: '导演决策文本内容',
            reasoning: '导演推理过程',
            timestamp: '2024-01-01T10:00:00Z',
        },
        {
            id: 'dec-2',
            agent_role: 'worldbuilder',
            input_refs: [],
            decision_text: '设定官决策文本',
            timestamp: '2024-01-01T10:01:00Z',
        },
        {
            id: 'dec-3',
            agent_role: 'continuity',
            input_refs: ['ref-c'],
            decision_text: '连续性审校决策',
            timestamp: '2024-01-01T10:02:00Z',
        },
    ],
    memory_hits: [
        { layer: 'L1', summary: '世界观设定命中' },
        { layer: 'L2', source_path: '/ch1/decisions.md' },
    ],
    conflicts_detected: [
        { id: 'c-1', severity: 'P0', rule_id: 'R001', reason: '角色名称冲突' },
        { id: 'c-2', severity: 'P1', rule_id: 'R002', reason: '时间线矛盾', suggested_fix: '调整时间顺序' },
    ],
}

function renderPage(projectId = 'proj-1', chapterId = 'ch-3') {
    return render(
        <MemoryRouter initialEntries={[`/project/${projectId}/trace/${chapterId}`]}>
            <Routes>
                <Route path="/project/:projectId/trace/:chapterId" element={<TraceReplayPage />} />
                <Route path="/project/:projectId/chapter/:chapterId" element={<div>Chapter Workbench</div>} />
            </Routes>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
})

describe('TraceReplayPage', () => {
    it('shows skeleton loading state initially', () => {
        mockApiGet.mockReturnValue(new Promise(() => { }))
        const { container } = renderPage()
        expect(container.querySelector('.skeleton--text')).toBeInTheDocument()
        expect(container.querySelector('.skeleton--card')).toBeInTheDocument()
    })

    it('renders page title and subtitle after loading', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText(/决策回放 · 第 3 章/)).toBeInTheDocument()
        })
        expect(screen.getByText(/追踪多 Agent 决策链/)).toBeInTheDocument()
    })

    it('has back link to chapter workbench', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('← 返回章节工作台')).toBeInTheDocument()
        })
        const link = screen.getByText('← 返回章节工作台').closest('a')
        expect(link).toHaveAttribute('href', '/project/proj-1/chapter/ch-3')
    })

    it('renders decision timeline with role labels', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            // Role labels appear in timeline buttons (and possibly detail chip for selected)
            expect(screen.getAllByText('导演').length).toBeGreaterThanOrEqual(1)
            expect(screen.getAllByText('设定官').length).toBeGreaterThanOrEqual(1)
            expect(screen.getAllByText('连续性审校').length).toBeGreaterThanOrEqual(1)
        })
    })

    it('selects first decision by default and shows detail', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('输入引用')).toBeInTheDocument()
            expect(screen.getByText('ref-a')).toBeInTheDocument()
            expect(screen.getByText('ref-b')).toBeInTheDocument()
            // Decision text appears in both timeline and detail; verify detail panel has it
            expect(screen.getAllByText('导演决策文本内容').length).toBeGreaterThanOrEqual(2)
        })
    })

    it('shows reasoning section when available', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('推理过程')).toBeInTheDocument()
            expect(screen.getByText('导演推理过程')).toBeInTheDocument()
        })
    })

    it('sanitizes leaked thinking tags in decision content', async () => {
        mockApiGet.mockResolvedValueOnce({
            data: {
                ...sampleTrace,
                decisions: [
                    {
                        ...sampleTrace.decisions[0],
                        decision_text: '<think>private</think>公开内容',
                        reasoning: 'thinking: secret\n可见推理',
                    },
                ],
            },
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getAllByText('公开内容').length).toBeGreaterThanOrEqual(2)
            expect(screen.getByText('可见推理')).toBeInTheDocument()
        })
        expect(screen.queryByText(/private/i)).not.toBeInTheDocument()
        expect(screen.queryByText(/thinking:/i)).not.toBeInTheDocument()
    })

    it('switches decision on click', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(screen.getAllByText('导演决策文本内容').length).toBeGreaterThanOrEqual(1)
        })

        fireEvent.click(screen.getByTestId('decision-dec-2'))

        await waitFor(() => {
            // Detail panel now shows worldbuilder decision text
            expect(screen.getByText('决策文本')).toBeInTheDocument()
            expect(screen.getAllByText('设定官决策文本').length).toBeGreaterThanOrEqual(2)
        })
    })

    it('shows "无" when selected decision has no input refs', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(screen.getAllByText('导演决策文本内容').length).toBeGreaterThanOrEqual(1)
        })

        fireEvent.click(screen.getByTestId('decision-dec-2'))

        await waitFor(() => {
            expect(screen.getByText('无')).toBeInTheDocument()
        })
    })

    it('renders memory hits', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('记忆命中')).toBeInTheDocument()
            expect(screen.getByText('世界观设定命中')).toBeInTheDocument()
        })
    })

    it('renders conflicts with severity badges', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('冲突检测')).toBeInTheDocument()
            expect(screen.getByText('P0')).toBeInTheDocument()
            expect(screen.getByText('角色名称冲突')).toBeInTheDocument()
            expect(screen.getByText('P1')).toBeInTheDocument()
            expect(screen.getByText('时间线矛盾')).toBeInTheDocument()
        })
    })

    it('shows suggested fix when available', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText(/建议修复: 调整时间顺序/)).toBeInTheDocument()
        })
    })

    it('shows empty state when trace is null after load', async () => {
        mockApiGet.mockRejectedValueOnce(new Error('not found'))
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('暂无决策回放数据')).toBeInTheDocument()
        })
    })

    it('shows error toast on API failure', async () => {
        mockApiGet.mockRejectedValueOnce(new Error('network error'))
        renderPage()
        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('error')
            expect(toasts[0].message).toBe('获取决策回放数据失败')
        })
    })

    it('shows empty decisions message when no decisions', async () => {
        mockApiGet.mockResolvedValueOnce({
            data: { ...sampleTrace, decisions: [] },
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('暂无决策记录。')).toBeInTheDocument()
        })
    })

    it('shows empty memory hits message', async () => {
        mockApiGet.mockResolvedValueOnce({
            data: { ...sampleTrace, memory_hits: [] },
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('暂无命中。')).toBeInTheDocument()
        })
    })

    it('shows empty conflicts message', async () => {
        mockApiGet.mockResolvedValueOnce({
            data: { ...sampleTrace, conflicts_detected: [] },
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('未发现冲突。')).toBeInTheDocument()
        })
    })

    it('fetches project on mount', async () => {
        mockApiGet.mockResolvedValueOnce({ data: sampleTrace })
        renderPage()
        await waitFor(() => {
            expect(mockFetchProject).toHaveBeenCalledWith('proj-1')
        })
    })
})

describe('AGENT_ROLE_COLORS', () => {
    it('exports color mappings for all five roles', () => {
        const roles = ['director', 'worldbuilder', 'continuity', 'stylist', 'arbiter']
        for (const role of roles) {
            expect(AGENT_ROLE_COLORS[role]).toBeDefined()
            expect(AGENT_ROLE_COLORS[role].color).toBeTruthy()
            expect(AGENT_ROLE_COLORS[role].borderColor).toBeTruthy()
            expect(AGENT_ROLE_COLORS[role].label).toBeTruthy()
        }
    })

    it('has unique colors for each role', () => {
        const colors = Object.values(AGENT_ROLE_COLORS).map((v) => v.color)
        expect(new Set(colors).size).toBe(colors.length)
    })

    it('has correct Chinese labels', () => {
        expect(AGENT_ROLE_COLORS.director.label).toBe('导演')
        expect(AGENT_ROLE_COLORS.worldbuilder.label).toBe('设定官')
        expect(AGENT_ROLE_COLORS.continuity.label).toBe('连续性审校')
        expect(AGENT_ROLE_COLORS.stylist.label).toBe('文风润色')
        expect(AGENT_ROLE_COLORS.arbiter.label).toBe('裁决器')
    })
})
