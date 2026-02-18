import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import DashboardPage, {
    CHART_THEME,
    METRIC_CARDS,
    buildBarChartData,
    buildLineChartData,
    computeTotals,
} from '../DashboardPage'
import { useToastStore } from '../../stores/useToastStore'

/* ── Mocks ── */

vi.mock('framer-motion', () => ({
    motion: {
        div: ({ children, ...props }: any) => <div {...filterMotionProps(props)}>{children}</div>,
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

// Mock Recharts to avoid SVG rendering issues in jsdom
vi.mock('recharts', () => ({
    ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
    BarChart: ({ children }: any) => <div data-testid="recharts-bar-chart">{children}</div>,
    Bar: () => <div data-testid="recharts-bar" />,
    LineChart: ({ children }: any) => <div data-testid="recharts-line-chart">{children}</div>,
    Line: () => <div data-testid="recharts-line" />,
    XAxis: () => null,
    YAxis: () => null,
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: () => null,
}))

const mockApiGet = vi.fn()
vi.mock('../../lib/api', () => ({
    api: { get: (...args: any[]) => mockApiGet(...args) },
}))

/* ── Test data ── */

const sampleMetrics = {
    chapter_generation_time: 12.34,
    search_time: 0.56,
    conflicts_per_chapter: 2.1,
    p0_ratio: 0.15,
    first_pass_rate: 0.82,
    exemption_rate: 0.05,
    recall_hit_rate: 0.91,
    sample_size: 2,
    quality_details: {
        p0_conflict_chapters: [
            {
                project_id: 'p1',
                project_name: '仙侠奇缘',
                chapter_id: 'c-1',
                chapter_number: 1,
                chapter_title: '开局',
                chapter_status: 'reviewing',
                p0_count: 1,
                first_pass_ok: false,
                memory_hit_count: 2,
                has_unresolved_p0: true,
            },
        ],
        first_pass_failed_chapters: [
            {
                project_id: 'p2',
                project_name: '都市传说',
                chapter_id: 'c-2',
                chapter_number: 2,
                chapter_title: '对峙',
                chapter_status: 'reviewing',
                p0_count: 1,
                first_pass_ok: false,
                memory_hit_count: 1,
                has_unresolved_p0: true,
            },
        ],
        recall_missed_chapters: [
            {
                project_id: 'p2',
                project_name: '都市传说',
                chapter_id: 'c-3',
                chapter_number: 3,
                chapter_title: '转折',
                chapter_status: 'reviewing',
                p0_count: 0,
                first_pass_ok: true,
                memory_hit_count: 0,
                has_unresolved_p0: false,
            },
        ],
    },
}

const sampleProjects = [
    { id: 'p1', name: '仙侠奇缘', genre: '仙侠', style: '古典', status: 'active', chapter_count: 10, entity_count: 25, event_count: 40 },
    { id: 'p2', name: '都市传说', genre: '都市', style: '现代', status: 'active', chapter_count: 5, entity_count: 12, event_count: 18 },
]

function renderPage() {
    return render(
        <MemoryRouter initialEntries={['/dashboard']}>
            <Routes>
                <Route path="/dashboard" element={<DashboardPage />} />
            </Routes>
        </MemoryRouter>,
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
})

describe('DashboardPage', () => {
    it('shows skeleton loading state initially', () => {
        mockApiGet.mockReturnValue(new Promise(() => { }))
        const { container } = renderPage()
        expect(screen.getByTestId('dashboard-skeleton')).toBeInTheDocument()
        expect(container.querySelector('.skeleton--metric-card')).toBeInTheDocument()
    })

    it('renders page title and subtitle after loading', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/metrics') return Promise.resolve({ data: sampleMetrics })
            if (url === '/projects') return Promise.resolve({ data: sampleProjects })
            return Promise.reject(new Error('unknown'))
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('评测看板')).toBeInTheDocument()
            expect(screen.getByText(/监控生成效率/)).toBeInTheDocument()
        })
    })

    it('renders four metric cards with correct values', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/metrics') return Promise.resolve({ data: sampleMetrics })
            if (url === '/projects') return Promise.resolve({ data: sampleProjects })
            return Promise.reject(new Error('unknown'))
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('平均生成时间')).toBeInTheDocument()
            expect(screen.getByText('12.34s')).toBeInTheDocument()
            expect(screen.getByText('P0 冲突率')).toBeInTheDocument()
            expect(screen.getByText('15.0%')).toBeInTheDocument()
            expect(screen.getByText('一次通过率')).toBeInTheDocument()
            expect(screen.getByText('82.0%')).toBeInTheDocument()
            expect(screen.getByText('记忆召回命中率')).toBeInTheDocument()
            expect(screen.getByText('91.0%')).toBeInTheDocument()
        })
    })

    it('renders Recharts bar and line charts', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/metrics') return Promise.resolve({ data: sampleMetrics })
            if (url === '/projects') return Promise.resolve({ data: sampleProjects })
            return Promise.reject(new Error('unknown'))
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByTestId('bar-chart')).toBeInTheDocument()
            expect(screen.getByTestId('line-chart')).toBeInTheDocument()
            expect(screen.getByTestId('recharts-bar-chart')).toBeInTheDocument()
            expect(screen.getByTestId('recharts-line-chart')).toBeInTheDocument()
        })
    })

    it('renders summary stats with correct totals', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/metrics') return Promise.resolve({ data: sampleMetrics })
            if (url === '/projects') return Promise.resolve({ data: sampleProjects })
            return Promise.reject(new Error('unknown'))
        })
        renderPage()
        await waitFor(() => {
            const summarySection = screen.getByTestId('summary-stats')
            expect(summarySection).toBeInTheDocument()
            // 2 projects, 15 chapters, 37 entities, 58 events
            expect(within(summarySection).getByText('2')).toBeInTheDocument()
            expect(within(summarySection).getByText('15')).toBeInTheDocument()
            expect(within(summarySection).getByText('37')).toBeInTheDocument()
            expect(within(summarySection).getByText('58')).toBeInTheDocument()
        })
    })

    it('renders project snapshot table', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/metrics') return Promise.resolve({ data: sampleMetrics })
            if (url === '/projects') return Promise.resolve({ data: sampleProjects })
            return Promise.reject(new Error('unknown'))
        })
        renderPage()
        await waitFor(() => {
            const table = screen.getByRole('table', { name: '项目快照表格' })
            expect(within(table).getByText('仙侠奇缘')).toBeInTheDocument()
            expect(within(table).getByText('都市传说')).toBeInTheDocument()
        })
    })

    it('shows empty state when no projects', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/metrics') return Promise.resolve({ data: sampleMetrics })
            if (url === '/projects') return Promise.resolve({ data: [] })
            return Promise.reject(new Error('unknown'))
        })
        renderPage()
        await waitFor(() => {
            expect(screen.getByText('暂无项目数据。')).toBeInTheDocument()
        })
    })

    it('shows error toast on API failure', async () => {
        mockApiGet.mockRejectedValue(new Error('network error'))
        renderPage()
        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('error')
            expect(toasts[0].message).toBe('获取看板数据失败')
        })
    })

    it('renders quality drilldown and switches categories', async () => {
        mockApiGet.mockImplementation((url: string) => {
            if (url === '/metrics') return Promise.resolve({ data: sampleMetrics })
            if (url === '/projects') return Promise.resolve({ data: sampleProjects })
            return Promise.reject(new Error('unknown'))
        })
        renderPage()

        await waitFor(() => {
            expect(screen.getByTestId('quality-drilldown')).toBeInTheDocument()
            expect(screen.getByText('当前列表：P0 冲突章节（1 章）')).toBeInTheDocument()
            expect(screen.getByText('第 1 章 · 开局')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByRole('button', { name: '一次通过失败章节' }))
        await waitFor(() => {
            expect(screen.getByText('当前列表：一次通过失败章节（1 章）')).toBeInTheDocument()
            expect(screen.getByText('第 2 章 · 对峙')).toBeInTheDocument()
        })

        fireEvent.click(screen.getByRole('button', { name: '记忆召回未命中章节' }))
        await waitFor(() => {
            expect(screen.getByText('当前列表：记忆召回未命中章节（1 章）')).toBeInTheDocument()
            expect(screen.getByText('第 3 章 · 转折')).toBeInTheDocument()
        })
    })
})

describe('buildBarChartData', () => {
    it('returns three data points for performance metrics', () => {
        const data = buildBarChartData(sampleMetrics)
        expect(data).toHaveLength(3)
        expect(data[0]).toEqual({ name: '章节生成时间', value: 12.34 })
        expect(data[1]).toEqual({ name: '检索时延', value: 0.56 })
        expect(data[2]).toEqual({ name: '每章冲突数', value: 2.1 })
    })
})

describe('buildLineChartData', () => {
    it('returns four data points for quality metrics as percentages', () => {
        const data = buildLineChartData(sampleMetrics)
        expect(data).toHaveLength(4)
        expect(data[0]).toEqual({ name: 'P0 冲突率', value: 15.0 })
        expect(data[1]).toEqual({ name: '一次通过率', value: 82.0 })
        expect(data[2]).toEqual({ name: '豁免率', value: 5.0 })
        expect(data[3]).toEqual({ name: '召回命中率', value: 91.0 })
    })
})

describe('computeTotals', () => {
    it('computes correct totals from project list', () => {
        const totals = computeTotals(sampleProjects)
        expect(totals.projectCount).toBe(2)
        expect(totals.chapterCount).toBe(15)
        expect(totals.entityCount).toBe(37)
        expect(totals.eventCount).toBe(58)
    })

    it('returns zeros for empty project list', () => {
        const totals = computeTotals([])
        expect(totals.projectCount).toBe(0)
        expect(totals.chapterCount).toBe(0)
        expect(totals.entityCount).toBe(0)
        expect(totals.eventCount).toBe(0)
    })
})

describe('METRIC_CARDS', () => {
    it('defines four metric cards', () => {
        expect(METRIC_CARDS).toHaveLength(4)
    })

    it('formats values correctly', () => {
        expect(METRIC_CARDS[0].format(12.345)).toBe('12.35s')
        expect(METRIC_CARDS[1].format(0.153)).toBe('15.3%')
        expect(METRIC_CARDS[2].format(0.821)).toBe('82.1%')
        expect(METRIC_CARDS[3].format(0.9)).toBe('90.0%')
    })
})

describe('CHART_THEME', () => {
    it('accentColor matches --accent (#0a8b83)', () => {
        expect(CHART_THEME.accentColor).toBe('#0a8b83')
    })

    it('gridColor matches --glass-border based rgba', () => {
        expect(CHART_THEME.gridColor).toBe('rgba(102, 124, 164, 0.16)')
    })

    it('tickColor matches --text-tertiary (#7e8fab)', () => {
        expect(CHART_THEME.tickColor).toBe('#7e8fab')
    })

    it('legendColor matches --text-secondary (#5a6e8d)', () => {
        expect(CHART_THEME.legendColor).toBe('#5a6e8d')
    })

    it('tooltipBg uses bright near-white background', () => {
        expect(CHART_THEME.tooltipBg).toBe('rgba(255, 255, 255, 0.96)')
    })

    it('tooltipBorder uses unified border color', () => {
        expect(CHART_THEME.tooltipBorder).toBe('rgba(102, 124, 164, 0.22)')
    })

    it('tooltipColor matches --text-primary (#1e2a3f)', () => {
        expect(CHART_THEME.tooltipColor).toBe('#1e2a3f')
    })
})
