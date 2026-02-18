import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ProjectList from '../ProjectList'
import { useProjectStore } from '../../stores/useProjectStore'
import { useToastStore } from '../../stores/useToastStore'

// Mock useNavigate
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
    const actual = await vi.importActual('react-router-dom')
    return { ...actual, useNavigate: () => mockNavigate }
})

function renderPage() {
    return render(
        <MemoryRouter>
            <ProjectList />
        </MemoryRouter>
    )
}

const sampleProjects = [
    {
        id: 'p1',
        name: '霜城编年史',
        genre: '奇幻',
        style: '冷峻现实主义',
        status: 'active',
        chapter_count: 5,
        entity_count: 12,
        event_count: 8,
    },
    {
        id: 'p2',
        name: '星际迷途',
        genre: '科幻',
        style: '硬科幻',
        status: 'draft',
        chapter_count: 3,
        entity_count: 7,
        event_count: 4,
    },
]

beforeEach(() => {
    mockNavigate.mockClear()
    useToastStore.setState({ toasts: [] })
    useProjectStore.setState({
        projects: [],
        currentProject: null,
        chapters: [],
        loading: false,
    })
})

describe('ProjectListPage', () => {
    it('calls fetchProjects on mount', () => {
        const fetchProjects = vi.fn()
        useProjectStore.setState({ fetchProjects } as any)
        renderPage()
        expect(fetchProjects).toHaveBeenCalled()
    })

    it('shows skeleton when loading with no projects', () => {
        useProjectStore.setState({ loading: true, projects: [] })
        const { container } = renderPage()
        expect(container.querySelectorAll('.skeleton--metric-card').length).toBeGreaterThan(0)
        expect(container.querySelectorAll('.skeleton--card').length).toBeGreaterThan(0)
    })

    it('shows empty state when no projects and not loading', () => {
        useProjectStore.setState({ loading: false, projects: [] })
        renderPage()
        expect(screen.getByText(/还没有项目/)).toBeInTheDocument()
    })

    it('shows timeout error state with reload action when projects request fails', () => {
        const fetchProjects = vi.fn()
        useProjectStore.setState({
            loading: false,
            projects: [],
            projectsError: '请求超时：后端可能正在生成中，请稍后重试',
            fetchProjects,
        } as any)
        renderPage()
        expect(screen.getByText('请求超时：后端可能正在生成中，请稍后重试')).toBeInTheDocument()
        fireEvent.click(screen.getByText('重新加载'))
        expect(fetchProjects).toHaveBeenCalledWith({ force: true })
    })

    it('renders project cards with correct data', () => {
        useProjectStore.setState({ projects: sampleProjects, loading: false })
        renderPage()
        expect(screen.getByText('霜城编年史')).toBeInTheDocument()
        expect(screen.getByText('星际迷途')).toBeInTheDocument()
        expect(screen.getByText(/奇幻/)).toBeInTheDocument()
    })

    it('displays correct totals in metric cards', () => {
        useProjectStore.setState({ projects: sampleProjects, loading: false })
        const { container } = renderPage()
        const metricCards = container.querySelectorAll('.metric-card')
        const values = Array.from(metricCards).map(
            (card) => card.querySelector('.metric-value')?.textContent
        )
        // 2 projects, 8 chapters, 19 entities, 12 events
        expect(values).toEqual(['2', '8', '19', '12'])
    })

    it('navigates to project detail on card click', () => {
        useProjectStore.setState({ projects: sampleProjects, loading: false })
        renderPage()
        fireEvent.click(screen.getByText('霜城编年史'))
        expect(mockNavigate).toHaveBeenCalledWith('/project/p1')
    })

    it('shows story template selector in create modal', () => {
        useProjectStore.setState({ projects: [], loading: false })
        renderPage()
        fireEvent.click(screen.getByText('新建项目'))
        expect(screen.getByText('创作模板')).toBeInTheDocument()
        expect(screen.getByText('不使用模板（自由创作）')).toBeInTheDocument()
    })

    it('keeps focus on edited genre/style fields without jumping back to name', async () => {
        useProjectStore.setState({ projects: [], loading: false })
        renderPage()

        fireEvent.click(screen.getByText('新建项目'))
        const nameInput = screen.getByPlaceholderText('例如：霜城编年史')
        const genreInput = screen.getByPlaceholderText('例如：赛博修仙 / 太空歌剧 / 克苏鲁')
        const styleInput = screen.getByDisplayValue('冷峻现实主义')

        await waitFor(() => expect(nameInput).toHaveFocus())

        genreInput.focus()
        expect(genreInput).toHaveFocus()
        fireEvent.change(genreInput, { target: { value: '赛博修仙' } })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(genreInput).toHaveFocus()

        styleInput.focus()
        expect(styleInput).toHaveFocus()
        fireEvent.change(styleInput, { target: { value: '硬核纪实' } })
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(styleInput).toHaveFocus()
    })

    it('shows toast on successful project creation', async () => {
        const createProject = vi.fn().mockResolvedValue('new-id')
        useProjectStore.setState({ projects: [], loading: false, createProject } as any)
        renderPage()

        fireEvent.click(screen.getByText('新建项目'))
        fireEvent.change(screen.getByPlaceholderText('例如：霜城编年史'), {
            target: { value: '测试项目' },
        })
        fireEvent.click(screen.getByText('创建项目'))

        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('success')
            expect(toasts[0].message).toBe('项目创建成功')
        })
    })

    it('shows error toast when project creation fails', async () => {
        const createProject = vi.fn().mockRejectedValue(new Error('fail'))
        useProjectStore.setState({ projects: [], loading: false, createProject } as any)
        renderPage()

        fireEvent.click(screen.getByText('新建项目'))
        fireEvent.change(screen.getByPlaceholderText('例如：霜城编年史'), {
            target: { value: '测试项目' },
        })
        fireEvent.click(screen.getByText('创建项目'))

        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('error')
        })
    })

    it('submits custom genre when creating project', async () => {
        const createProject = vi.fn().mockResolvedValue('new-id')
        useProjectStore.setState({ projects: [], loading: false, createProject } as any)
        renderPage()

        fireEvent.click(screen.getByText('新建项目'))
        fireEvent.change(screen.getByPlaceholderText('例如：霜城编年史'), {
            target: { value: '不靠谱事务所' },
        })
        fireEvent.change(screen.getByPlaceholderText('例如：赛博修仙 / 太空歌剧 / 克苏鲁'), {
            target: { value: '赛博修仙' },
        })
        fireEvent.click(screen.getByText('创建项目'))

        await waitFor(() => {
            expect(createProject).toHaveBeenCalled()
        })
        expect(createProject).toHaveBeenCalledWith(
            expect.objectContaining({
                name: '不靠谱事务所',
                genre: '赛博修仙',
            }),
        )
    })

    it('allows clearing and retyping target length without forcing 0', async () => {
        useProjectStore.setState({ projects: [], loading: false })
        renderPage()

        fireEvent.click(screen.getByText('新建项目'))
        const dialog = screen.getByRole('dialog')
        const targetInput = dialog.querySelector('input[type="number"]') as HTMLInputElement
        expect(targetInput).toBeTruthy()
        expect(targetInput.value).toBe('300000')

        fireEvent.change(targetInput, { target: { value: '' } })
        expect(targetInput.value).toBe('')

        fireEvent.change(targetInput, { target: { value: '80000' } })
        expect(targetInput.value).toBe('80000')
    })

    it('shows toast on successful project deletion', async () => {
        const deleteProject = vi.fn().mockResolvedValue(undefined)
        useProjectStore.setState({ projects: sampleProjects, loading: false, deleteProject } as any)
        renderPage()

        const deleteButtons = screen.getAllByText('删除')
        fireEvent.click(deleteButtons[0])

        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('success')
            expect(toasts[0].message).toBe('项目已删除')
        })
    })

    it('supports bulk selection and batch delete', async () => {
        const deleteProjects = vi.fn().mockResolvedValue({
            requested_count: 1,
            deleted_count: 1,
            missing_count: 0,
            failed_count: 0,
            deleted_ids: ['p1'],
            missing_ids: [],
            failed_ids: [],
        })
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
        useProjectStore.setState({ projects: sampleProjects, loading: false, deleteProjects } as any)
        renderPage()

        fireEvent.click(screen.getByLabelText('选择项目 霜城编年史'))
        fireEvent.click(screen.getByRole('button', { name: '批量删除 (1)' }))

        await waitFor(() => {
            expect(deleteProjects).toHaveBeenCalledWith(['p1'])
        })
        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('success')
            expect(toasts[0].message).toContain('批量删除完成')
        })
        confirmSpy.mockRestore()
    })

    it('selects only filtered projects when using select-all action', () => {
        useProjectStore.setState({ projects: sampleProjects, loading: false })
        renderPage()

        fireEvent.change(screen.getByLabelText('搜索项目'), {
            target: { value: '星际' },
        })
        fireEvent.click(screen.getByRole('button', { name: '全选当前筛选 (1)' }))
        fireEvent.click(screen.getByText('清空筛选'))

        const p1Checkbox = screen.getByLabelText('选择项目 霜城编年史') as HTMLInputElement
        const p2Checkbox = screen.getByLabelText('选择项目 星际迷途') as HTMLInputElement
        expect(p1Checkbox.checked).toBe(false)
        expect(p2Checkbox.checked).toBe(true)
        expect(screen.getByRole('button', { name: '批量删除 (1)' })).toBeEnabled()
    })

    it('wraps content in PageTransition (framer-motion div)', () => {
        useProjectStore.setState({ projects: [], loading: false })
        const { container } = renderPage()
        // PageTransition renders a motion.div which becomes a regular div
        const pageHead = container.querySelector('.page-head')
        expect(pageHead).toBeInTheDocument()
    })
})
