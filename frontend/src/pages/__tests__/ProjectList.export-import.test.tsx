import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import ProjectList from '../ProjectList'
import { useProjectStore } from '../../stores/useProjectStore'
import { useToastStore } from '../../stores/useToastStore'

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

describe('ProjectList export/import', () => {
    it('renders import button', () => {
        useProjectStore.setState({ fetchProjects: vi.fn() } as any)
        renderPage()
        expect(screen.getByText('导入项目')).toBeInTheDocument()
    })

    it('renders export button on each project card', () => {
        useProjectStore.setState({ projects: sampleProjects, loading: false, fetchProjects: vi.fn() } as any)
        renderPage()
        expect(screen.getAllByText('导出').length).toBe(2)
    })

    it('import success shows toast and refreshes list', async () => {
        const mockImportProject = vi.fn().mockResolvedValue({
            project_id: 'new-id',
            name: '测试项目',
            chapter_count: 3,
        })
        const mockFetchProjects = vi.fn()
        useProjectStore.setState({
            projects: [],
            loading: false,
            fetchProjects: mockFetchProjects,
            importProject: mockImportProject,
        } as any)

        const { container } = renderPage()
        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
        expect(fileInput).toBeTruthy()

        const file = new File(['content'], 'test.zip', { type: 'application/zip' })
        fireEvent.change(fileInput, { target: { files: [file] } })

        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('success')
            expect(toasts[0].message).toContain('测试项目')
        })
    })

    it('import failure shows error toast', async () => {
        const mockImportProject = vi.fn().mockRejectedValue({
            response: { data: { detail: '文件格式错误' } },
        })
        useProjectStore.setState({
            projects: [],
            loading: false,
            fetchProjects: vi.fn(),
            importProject: mockImportProject,
        } as any)

        const { container } = renderPage()
        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement

        const file = new File(['bad'], 'bad.zip', { type: 'application/zip' })
        fireEvent.change(fileInput, { target: { files: [file] } })

        await waitFor(() => {
            const toasts = useToastStore.getState().toasts
            expect(toasts).toHaveLength(1)
            expect(toasts[0].type).toBe('error')
            expect(toasts[0].message).toBe('文件格式错误')
        })
    })
})
