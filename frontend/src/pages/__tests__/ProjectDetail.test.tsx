import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import ProjectDetail from '../ProjectDetail'
import { useProjectStore } from '../../stores/useProjectStore'
import { useToastStore } from '../../stores/useToastStore'

const mockApiPost = vi.fn()
vi.mock('../../lib/api', () => ({
    api: {
        get: vi.fn().mockResolvedValue({ data: {} }),
        post: (...args: any[]) => mockApiPost(...args),
    },
}))

function renderPage(projectId = 'p1') {
    return render(
        <MemoryRouter initialEntries={[`/project/${projectId}`]}>
            <Routes>
                <Route path="/project/:projectId" element={<ProjectDetail />} />
                <Route path="/" element={<div>项目列表页</div>} />
            </Routes>
        </MemoryRouter>
    )
}

const sampleProject = {
    id: 'p1',
    name: '霜城编年史',
    genre: '奇幻',
    style: '冷峻现实主义',
    status: 'active',
    target_length: 200000,
    chapter_count: 5,
    entity_count: 12,
    event_count: 8,
}

const sampleChapters = [
    {
        id: 'c1',
        chapter_number: 1,
        title: '雪夜惊变',
        goal: '主角在雪夜遭遇背叛',
        status: 'completed',
        word_count: 1600,
        conflict_count: 0,
    },
    {
        id: 'c2',
        chapter_number: 2,
        title: '潜伏反击',
        goal: '主角开始策划反击',
        status: 'draft',
        word_count: 1200,
        conflict_count: 1,
    },
]

beforeEach(() => {
    mockApiPost.mockReset()
    useToastStore.setState({ toasts: [] })
    useProjectStore.setState({
        projects: [],
        currentProject: null,
        chapters: [],
        loading: false,
        fetchProject: vi.fn(),
        fetchChapters: vi.fn(),
    } as any)
})

describe('ProjectDetailPage', () => {
    it('calls fetchProject and fetchChapters on mount', () => {
        const fetchProject = vi.fn()
        const fetchChapters = vi.fn()
        useProjectStore.setState({ fetchProject, fetchChapters } as any)
        renderPage()
        expect(fetchProject).toHaveBeenCalledWith('p1')
        expect(fetchChapters).toHaveBeenCalledWith('p1')
    })

    it('shows skeleton when loading with no project', () => {
        useProjectStore.setState({ loading: true, currentProject: null })
        const { container } = renderPage()
        expect(container.querySelectorAll('.skeleton--metric-card').length).toBeGreaterThan(0)
        expect(container.querySelectorAll('.skeleton--text').length).toBeGreaterThan(0)
    })

    it('shows error state when not loading and no project', () => {
        useProjectStore.setState({ loading: false, currentProject: null })
        renderPage()
        expect(screen.getByText('项目不存在或加载失败')).toBeInTheDocument()
        expect(screen.getByText('返回项目列表')).toBeInTheDocument()
    })

    it('shows request error and allows retry when project request times out', () => {
        const fetchProject = vi.fn()
        useProjectStore.setState({
            loading: false,
            currentProject: null,
            projectError: '请求超时：后端可能正在生成中，请稍后重试',
            fetchProject,
        } as any)
        renderPage()
        expect(screen.getByText('请求超时：后端可能正在生成中，请稍后重试')).toBeInTheDocument()
        fireEvent.click(screen.getByText('重试加载'))
        expect(fetchProject).toHaveBeenCalledWith('p1', { force: true })
    })

    it('does not render stale project when route projectId differs from currentProject.id', () => {
        useProjectStore.setState({
            loading: false,
            currentProject: { ...sampleProject, id: 'p-other', name: '其他小说' } as any,
            chapters: sampleChapters,
        })
        const { container } = renderPage('p1')
        expect(screen.queryByText('其他小说')).not.toBeInTheDocument()
        expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0)
    })

    it('renders project details correctly', () => {
        useProjectStore.setState({ currentProject: sampleProject, chapters: sampleChapters, loading: false })
        renderPage()
        expect(screen.getByText('霜城编年史')).toBeInTheDocument()
        expect(screen.getByText(/奇幻/)).toBeInTheDocument()
        expect(screen.getByText(/200,000/)).toBeInTheDocument()
    })

    it('displays metric cards with correct values', () => {
        useProjectStore.setState({ currentProject: sampleProject, chapters: [], loading: false })
        const { container } = renderPage()
        const metricCards = container.querySelectorAll('.metric-card')
        const values = Array.from(metricCards).map(
            (card) => card.querySelector('.metric-value')?.textContent
        )
        expect(values).toEqual(['5', '12', '8', 'active'])
    })

    it('renders chapter list table', () => {
        useProjectStore.setState({ currentProject: sampleProject, chapters: sampleChapters, loading: false })
        renderPage()
        expect(screen.getByText('雪夜惊变')).toBeInTheDocument()
        expect(screen.getByText('潜伏反击')).toBeInTheDocument()
        expect(screen.getByText('共 2 章')).toBeInTheDocument()
    })

    it('shows empty chapter message when no chapters', () => {
        useProjectStore.setState({ currentProject: sampleProject, chapters: [], loading: false })
        renderPage()
        expect(screen.getByText(/暂无章节/)).toBeInTheDocument()
    })

    it('renders sub-page navigation links', () => {
        useProjectStore.setState({ currentProject: sampleProject, chapters: [], loading: false })
        renderPage()
        expect(screen.getByText('创作控制台')).toBeInTheDocument()
        expect(screen.getByText('记忆浏览器')).toBeInTheDocument()
        expect(screen.getByText('知识图谱')).toBeInTheDocument()
        expect(screen.getByText('评测看板')).toBeInTheDocument()
    })

    it('renders export book button', () => {
        useProjectStore.setState({ currentProject: sampleProject, chapters: [], loading: false })
        renderPage()
        expect(screen.getByText('整书导出')).toBeInTheDocument()
    })

    it('shows warning toast when exporting without chapters', () => {
        useProjectStore.setState({ currentProject: sampleProject, chapters: [], loading: false })
        renderPage()
        fireEvent.click(screen.getByText('整书导出'))
        const toasts = useToastStore.getState().toasts
        expect(toasts).toHaveLength(1)
        expect(toasts[0].type).toBe('warning')
        expect(toasts[0].message).toContain('暂无章节可导出')
    })

    it('wraps content in PageTransition', () => {
        useProjectStore.setState({ currentProject: sampleProject, chapters: [], loading: false })
        const { container } = renderPage()
        expect(container.querySelector('.page-head')).toBeInTheDocument()
    })

    it('chapter rows link to chapter workbench', () => {
        useProjectStore.setState({ currentProject: sampleProject, chapters: sampleChapters, loading: false })
        renderPage()
        const links = screen.getAllByText('进入工作台')
        expect(links[0].closest('a')).toHaveAttribute('href', '/project/p1/chapter/c1')
        expect(links[1].closest('a')).toHaveAttribute('href', '/project/p1/chapter/c2')
    })

    describe('chapter creation modal field validation', () => {
        beforeEach(() => {
            useProjectStore.setState({ currentProject: sampleProject, chapters: sampleChapters, loading: false })
        })

        function openModal() {
            renderPage()
            fireEvent.click(screen.getByText('新建章节'))
            return document.querySelector('.modal-card') as HTMLElement
        }

        it('shows required error on title blur when empty', () => {
            const modal = openModal()
            const titleInput = modal.querySelectorAll('input.input')[1] as HTMLInputElement // second input (after chapter_number)
            fireEvent.blur(titleInput)
            expect(screen.getByText('此字段为必填项')).toBeInTheDocument()
        })

        it('shows required error on goal blur when empty', () => {
            const modal = openModal()
            const goalTextarea = modal.querySelector('textarea') as HTMLTextAreaElement
            fireEvent.blur(goalTextarea)
            expect(screen.getByText('此字段为必填项')).toBeInTheDocument()
        })

        it('shows range error on chapter_number blur when out of range', () => {
            const modal = openModal()
            const numberInput = modal.querySelector('input[type="number"]') as HTMLInputElement
            fireEvent.change(numberInput, { target: { value: '0' } })
            fireEvent.blur(numberInput)
            expect(screen.getByText('范围：1-999')).toBeInTheDocument()
        })

        it('shows range error for chapter_number above 999', () => {
            const modal = openModal()
            const numberInput = modal.querySelector('input[type="number"]') as HTMLInputElement
            fireEvent.change(numberInput, { target: { value: '1000' } })
            fireEvent.blur(numberInput)
            expect(screen.getByText('范围：1-999')).toBeInTheDocument()
        })

        it('allows chapter_number input to clear then retype', () => {
            const modal = openModal()
            const numberInput = modal.querySelector('input[type="number"]') as HTMLInputElement
            fireEvent.change(numberInput, { target: { value: '' } })
            expect(numberInput.value).toBe('')
            fireEvent.change(numberInput, { target: { value: '8' } })
            expect(numberInput.value).toBe('8')
        })

        it('does not show error when title has value on blur', () => {
            const modal = openModal()
            const titleInput = modal.querySelectorAll('input.input')[1] as HTMLInputElement
            fireEvent.change(titleInput, { target: { value: '第一章' } })
            fireEvent.blur(titleInput)
            expect(screen.queryByText('此字段为必填项')).not.toBeInTheDocument()
        })

        it('applies field-error class to invalid inputs', () => {
            const modal = openModal()
            const goalTextarea = modal.querySelector('textarea') as HTMLTextAreaElement
            expect(goalTextarea.classList.contains('field-error')).toBe(false)
            fireEvent.blur(goalTextarea)
            expect(goalTextarea.classList.contains('field-error')).toBe(true)
        })

        it('clears field errors when modal is cancelled', () => {
            const modal = openModal()
            const goalTextarea = modal.querySelector('textarea') as HTMLTextAreaElement
            fireEvent.blur(goalTextarea)
            expect(screen.getByText('此字段为必填项')).toBeInTheDocument()
            fireEvent.click(screen.getByText('取消'))
            // Reopen modal
            fireEvent.click(screen.getByText('新建章节'))
            expect(screen.queryByText('此字段为必填项')).not.toBeInTheDocument()
        })
    })

    describe('chapter creation modal confirm close', () => {
        beforeEach(() => {
            useProjectStore.setState({ currentProject: sampleProject, chapters: sampleChapters, loading: false })
        })

        function openModal() {
            renderPage()
            fireEvent.click(screen.getByText('新建章节'))
        }

        it('closes immediately when form is clean', () => {
            openModal()
            expect(screen.getByText('创建章节')).toBeInTheDocument()
            fireEvent.click(screen.getByText('取消'))
            expect(screen.queryByText('创建章节')).not.toBeInTheDocument()
        })

        it('shows confirmation dialog when closing dirty form', () => {
            openModal()
            const modal = document.querySelector('.modal-card') as HTMLElement
            const titleInput = modal.querySelectorAll('input.input')[1] as HTMLInputElement
            fireEvent.change(titleInput, { target: { value: '测试标题' } })
            fireEvent.click(screen.getByText('取消'))
            expect(screen.getByText('有未保存的修改，确定要关闭吗？')).toBeInTheDocument()
        })

        it('closes modal when confirming close on dirty form', () => {
            openModal()
            const modal = document.querySelector('.modal-card') as HTMLElement
            const titleInput = modal.querySelectorAll('input.input')[1] as HTMLInputElement
            fireEvent.change(titleInput, { target: { value: '测试标题' } })
            fireEvent.click(screen.getByText('取消'))
            fireEvent.click(screen.getByText('确定关闭'))
            expect(screen.queryByText('创建章节')).not.toBeInTheDocument()
        })

        it('stays open when cancelling confirmation on dirty form', () => {
            openModal()
            const modal = document.querySelector('.modal-card') as HTMLElement
            const titleInput = modal.querySelectorAll('input.input')[1] as HTMLInputElement
            fireEvent.change(titleInput, { target: { value: '测试标题' } })
            fireEvent.click(screen.getByText('取消'))
            fireEvent.click(screen.getByText('继续编辑'))
            expect(screen.getByText('创建章节')).toBeInTheDocument()
        })

        it('Escape key triggers confirmation when form is dirty', () => {
            openModal()
            const modal = document.querySelector('.modal-card') as HTMLElement
            const goalTextarea = modal.querySelector('textarea') as HTMLTextAreaElement
            fireEvent.change(goalTextarea, { target: { value: '测试目标' } })
            fireEvent.keyDown(document, { key: 'Escape' })
            expect(screen.getByText('有未保存的修改，确定要关闭吗？')).toBeInTheDocument()
        })

        it('Escape key closes immediately when form is clean', () => {
            openModal()
            expect(screen.getByText('创建章节')).toBeInTheDocument()
            fireEvent.keyDown(document, { key: 'Escape' })
            expect(screen.queryByText('创建章节')).not.toBeInTheDocument()
        })
    })

    describe('quick start entry', () => {
        beforeEach(() => {
            useProjectStore.setState({ currentProject: sampleProject, chapters: sampleChapters, loading: false })
        })

        it('renders quick start section with synopsis textarea', () => {
            renderPage()
            expect(screen.getByText('创作起点')).toBeInTheDocument()
            expect(screen.getByPlaceholderText('先写一句话梗概，带着它进入创作控制台继续生成。')).toBeInTheDocument()
        })

        it('builds writing console link with prompt and scope', () => {
            renderPage()
            const textarea = screen.getByPlaceholderText('先写一句话梗概，带着它进入创作控制台继续生成。')
            fireEvent.change(textarea, { target: { value: '测试梗概' } })
            fireEvent.change(screen.getByDisplayValue('整卷模式'), { target: { value: 'book' } })

            const link = screen.getByText('进入创作控制台').closest('a')
            expect(link).toHaveAttribute('href', '/project/p1/write?prompt=%E6%B5%8B%E8%AF%95%E6%A2%97%E6%A6%82&scope=book')
        })
    })
})
