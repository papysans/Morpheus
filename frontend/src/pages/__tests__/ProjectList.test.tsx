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

    it('wraps content in PageTransition (framer-motion div)', () => {
        useProjectStore.setState({ projects: [], loading: false })
        const { container } = renderPage()
        // PageTransition renders a motion.div which becomes a regular div
        const pageHead = container.querySelector('.page-head')
        expect(pageHead).toBeInTheDocument()
    })
})
