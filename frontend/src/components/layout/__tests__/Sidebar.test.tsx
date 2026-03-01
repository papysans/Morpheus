import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Sidebar from '../Sidebar'
import { useProjectStore } from '../../../stores/useProjectStore'
import { useUIStore } from '../../../stores/useUIStore'
import { useActivityStore } from '../../../stores/useActivityStore'
import { useRecentAccessStore } from '../../../stores/useRecentAccessStore'

function renderSidebar(initialPath = '/') {
    return render(
        <MemoryRouter initialEntries={[initialPath]}>
            <Sidebar />
        </MemoryRouter>
    )
}

beforeEach(() => {
    useProjectStore.setState({
        projects: [],
        currentProject: null,
        chapters: [],
        loading: false,
        projectError: null,
    })
    useUIStore.setState({
        sidebarCollapsed: false,
        readingMode: false,
        shortcutHelpOpen: false,
    })
    useActivityStore.setState({
        records: [],
        panelOpen: false,
    })
    useRecentAccessStore.setState({
        items: [],
    })
})

describe('Sidebar', () => {
    describe('基本渲染', () => {
        it('renders brand and navigation sections', () => {
            renderSidebar()
            expect(screen.getByText('Morpheus')).toBeInTheDocument()
            expect(screen.getByText('项目列表')).toBeInTheDocument()
            expect(screen.getByText('评测看板')).toBeInTheDocument()
        })

        it('hides text labels when collapsed', () => {
            useUIStore.setState({ sidebarCollapsed: true })
            renderSidebar()
            expect(screen.queryByText('Morpheus')).not.toBeInTheDocument()
            expect(screen.queryByText('项目列表')).not.toBeInTheDocument()
        })

        it('toggles sidebar on button click', () => {
            renderSidebar()
            fireEvent.click(screen.getByLabelText('收起侧边栏'))
            expect(useUIStore.getState().sidebarCollapsed).toBe(true)
        })
    })

    describe('项目子导航显示条件', () => {
        it('does NOT show project sub-nav on root path', () => {
            renderSidebar('/')
            expect(screen.queryByText('项目概览')).not.toBeInTheDocument()
            expect(screen.queryByText('创作控制台')).not.toBeInTheDocument()
        })

        it('does NOT show project sub-nav on /dashboard', () => {
            renderSidebar('/dashboard')
            expect(screen.queryByText('项目概览')).not.toBeInTheDocument()
        })

        it('shows project sub-nav when on a project route', () => {
            renderSidebar('/project/p1')
            expect(screen.getByText('项目概览')).toBeInTheDocument()
            expect(screen.getByText('创作控制台')).toBeInTheDocument()
            expect(screen.getByText('章节工作台')).toBeInTheDocument()
            expect(screen.getByText('记忆浏览器')).toBeInTheDocument()
            expect(screen.getByText('决策回放')).toBeInTheDocument()
        })

        it('shows project sub-nav on nested project routes', () => {
            renderSidebar('/project/p1/write')
            expect(screen.getByText('项目概览')).toBeInTheDocument()
            expect(screen.getByText('创作控制台')).toBeInTheDocument()
        })

        it('shows project name when currentProject is set', () => {
            useProjectStore.setState({
                currentProject: {
                    id: 'p1',
                    name: '霜城编年史',
                    genre: '奇幻',
                    style: '冷峻',
                    status: 'active',
                    chapter_count: 5,
                    entity_count: 10,
                    event_count: 8,
                    target_length: 100000,
                },
            })
            renderSidebar('/project/p1')
            expect(screen.getByText('霜城编年史')).toBeInTheDocument()
        })

        it('shows fallback "当前项目" when no currentProject', () => {
            renderSidebar('/project/p1')
            expect(screen.getByText('当前项目')).toBeInTheDocument()
        })

        it('hides project sub-nav when project is not found', () => {
            useProjectStore.setState({
                currentProject: null,
                projectError: 'Project not found',
            })
            renderSidebar('/project/p1')
            expect(screen.queryByText('项目概览')).not.toBeInTheDocument()
            expect(screen.queryByText('创作控制台')).not.toBeInTheDocument()
        })
    })

    describe('导航高亮状态', () => {
        it('highlights 项目列表 on root path', () => {
            const { container } = renderSidebar('/')
            const links = container.querySelectorAll('.sidebar__link')
            expect(links[0].classList.contains('sidebar__link--active')).toBe(true)
        })

        it('does NOT highlight 项目列表 when on a project route', () => {
            const { container } = renderSidebar('/project/p1')
            const projectListLink = container.querySelectorAll('.sidebar__link')[0]
            expect(projectListLink.classList.contains('sidebar__link--active')).toBe(false)
        })

        it('highlights 项目概览 on exact project path', () => {
            const { container } = renderSidebar('/project/p1')
            const subNavLinks = container.querySelectorAll('.sidebar__section:nth-child(2) .sidebar__link')
            expect(subNavLinks[0].classList.contains('sidebar__link--active')).toBe(true)
        })

        it('highlights 创作控制台 on /project/:id/write', () => {
            const { container } = renderSidebar('/project/p1/write')
            const subNavLinks = container.querySelectorAll('.sidebar__section:nth-child(2) .sidebar__link')
            expect(subNavLinks[1].classList.contains('sidebar__link--active')).toBe(true)
            expect(subNavLinks[0].classList.contains('sidebar__link--active')).toBe(false)
        })

        it('highlights 章节工作台 on /project/:id/chapter/:chapterId (prefix match)', () => {
            const { container } = renderSidebar('/project/p1/chapter/ch1')
            const subNavLinks = container.querySelectorAll('.sidebar__section:nth-child(2) .sidebar__link')
            expect(subNavLinks[2].classList.contains('sidebar__link--active')).toBe(true)
        })

        it('highlights 决策回放 on /project/:id/trace/:chapterId (prefix match)', () => {
            const { container } = renderSidebar('/project/p1/trace/ch1')
            const subNavLinks = container.querySelectorAll('.sidebar__section:nth-child(2) .sidebar__link')
            expect(subNavLinks[5].classList.contains('sidebar__link--active')).toBe(true)
        })

        it('highlights 评测看板 on /dashboard', () => {
            const { container } = renderSidebar('/dashboard')
            const globalLinks = container.querySelectorAll('.sidebar__section:last-child .sidebar__link')
            expect(globalLinks[0].classList.contains('sidebar__link--active')).toBe(true)
        })
    })

    describe('知识图谱 nav entry', () => {
        it('shows 知识图谱 link when on project route (GRAPH_FEATURE_ENABLED=true)', () => {
            renderSidebar('/project/p1')
            expect(screen.getByText('知识图谱')).toBeInTheDocument()
        })

        it('highlights 知识图谱 on /project/:id/graph', () => {
            const { container } = renderSidebar('/project/p1/graph')
            const subNavLinks = container.querySelectorAll('.sidebar__section:nth-child(2) .sidebar__link')
            // 知识图谱 is the 5th sub-nav link (index 4)
            expect(subNavLinks[4].classList.contains('sidebar__link--active')).toBe(true)
        })

        it('includes 知识图谱 in project sub-nav items', () => {
            renderSidebar('/project/p1')
            const graphLink = screen.getByText('知识图谱')
            expect(graphLink).toBeInTheDocument()
            // Verify it's a link to /project/:id/graph
            const linkElement = graphLink.closest('a')
            expect(linkElement?.getAttribute('href')).toBe('/project/p1/graph')
        })
    })

    describe('浏览器前进/后退同步', () => {
        it('updates active state when location changes (simulated via re-render)', () => {
            const { container, unmount } = render(
                <MemoryRouter initialEntries={['/', '/project/p1']} initialIndex={1}>
                    <Sidebar />
                </MemoryRouter>
            )
            expect(screen.getByText('项目概览')).toBeInTheDocument()
            const subNavLinks = container.querySelectorAll('.sidebar__section:nth-child(2) .sidebar__link')
            expect(subNavLinks[0].classList.contains('sidebar__link--active')).toBe(true)
            unmount()

            const { container: container2 } = render(
                <MemoryRouter initialEntries={['/', '/project/p1']} initialIndex={0}>
                    <Sidebar />
                </MemoryRouter>
            )
            expect(screen.queryByText('项目概览')).not.toBeInTheDocument()
            const rootLinks = container2.querySelectorAll('.sidebar__link')
            expect(rootLinks[0].classList.contains('sidebar__link--active')).toBe(true)
        })
    })

    describe('ActivityPanel 集成', () => {
        it('renders ActivityPanel when sidebar is expanded', () => {
            renderSidebar()
            expect(screen.getByText('操作历史')).toBeInTheDocument()
        })

        it('hides ActivityPanel when sidebar is collapsed', () => {
            useUIStore.setState({ sidebarCollapsed: true })
            renderSidebar()
            expect(screen.queryByText('操作历史')).not.toBeInTheDocument()
        })
    })

    describe('最近访问', () => {
        it('shows 最近访问 section when there are items', () => {
            useRecentAccessStore.setState({
                items: [
                    { type: 'project', id: 'p1', name: '测试项目', path: '/project/p1', timestamp: Date.now() },
                    { type: 'chapter', id: 'ch1', name: '第一章', path: '/project/p1/chapter/ch1', timestamp: Date.now(), projectId: 'p1' },
                ],
            })
            renderSidebar()
            expect(screen.getByText('最近访问')).toBeInTheDocument()
            expect(screen.getByText('测试项目')).toBeInTheDocument()
            expect(screen.getByText('第一章')).toBeInTheDocument()
        })

        it('does not show 最近访问 section when items is empty', () => {
            useRecentAccessStore.setState({ items: [] })
            renderSidebar()
            expect(screen.queryByText('最近访问')).not.toBeInTheDocument()
        })

        it('does not show 最近访问 section when sidebar is collapsed', () => {
            useUIStore.setState({ sidebarCollapsed: true })
            useRecentAccessStore.setState({
                items: [
                    { type: 'project', id: 'p1', name: '测试项目', path: '/project/p1', timestamp: Date.now() },
                ],
            })
            renderSidebar()
            expect(screen.queryByText('最近访问')).not.toBeInTheDocument()
        })
    })
})
