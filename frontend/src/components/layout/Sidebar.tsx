import { NavLink, useLocation } from 'react-router-dom'
import { useProjectStore } from '../../stores/useProjectStore'
import { useUIStore } from '../../stores/useUIStore'
import { useRecentAccessStore } from '../../stores/useRecentAccessStore'
import ActivityPanel from '../../components/ui/ActivityPanel'

interface SubNavItem {
    to: string
    label: string
    icon: React.ReactNode
    end?: boolean
    matchPrefix?: boolean
}

const IconFolder = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
)

const IconOverview = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
)

const IconPen = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
)

const IconBook = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
)

const IconBrain = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />
    </svg>
)

const IconGraph = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="6" r="3" /><circle cx="18" cy="18" r="3" /><circle cx="18" cy="6" r="3" />
        <line x1="8.5" y1="7.5" x2="15.5" y2="16.5" /><line x1="15.5" y1="7.5" x2="8.5" y2="16.5" />
    </svg>
)

const IconReplay = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
)

const IconChart = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" />
    </svg>
)

const projectSubNav: SubNavItem[] = [
    { to: '', label: '项目概览', icon: <IconOverview />, end: true },
    { to: '/write', label: '创作控制台', icon: <IconPen /> },
    { to: '/chapter', label: '章节工作台', icon: <IconBook />, matchPrefix: true },
    { to: '/memory', label: '记忆浏览器', icon: <IconBrain /> },
    { to: '/graph', label: '知识图谱', icon: <IconGraph /> },
    { to: '/trace', label: '决策回放', icon: <IconReplay />, matchPrefix: true },
]

export default function Sidebar() {
    const location = useLocation()
    const currentProject = useProjectStore((s) => s.currentProject)
    const projectError = useProjectStore((s) => s.projectError)
    const collapsed = useUIStore((s) => s.sidebarCollapsed)
    const toggleSidebar = useUIStore((s) => s.toggleSidebar)
    const recentItems = useRecentAccessStore((s) => s.items)

    const projectIdMatch = location.pathname.match(/^\/project\/([^/]+)/)
    const projectId = projectIdMatch ? projectIdMatch[1] : null
    const projectResolved = Boolean(projectId && currentProject?.id === projectId)
    const projectNotFound = Boolean(
        projectId &&
        !projectResolved &&
        typeof projectError === 'string' &&
        /not found|项目不存在/.test(projectError.toLowerCase()),
    )
    const showProjectSubNav = Boolean(projectId) && !projectNotFound

    return (
        <aside className={`sidebar ${collapsed ? 'sidebar--collapsed' : ''}`} role="navigation" aria-label="主导航">
            <div className="sidebar__header">
                {!collapsed && <span className="sidebar__brand">编剧室</span>}
                <button
                    className="sidebar__toggle"
                    onClick={toggleSidebar}
                    aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
                >
                    {collapsed ? '›' : '‹'}
                </button>
            </div>

            <nav className="sidebar__nav">
                <div className="sidebar__section">
                    {!collapsed && <span className="sidebar__section-title">导航</span>}
                    <NavLink to="/" end
                        className={({ isActive }) =>
                            `sidebar__link ${isActive && !projectId ? 'sidebar__link--active' : ''}`
                        }
                    >
                        <span className="sidebar__icon"><IconFolder /></span>
                        {!collapsed && <span>项目列表</span>}
                    </NavLink>
                </div>

                {showProjectSubNav && (
                    <div className="sidebar__section">
                        {!collapsed && (
                            <span className="sidebar__section-title">
                                {projectResolved ? currentProject?.name : '当前项目'}
                            </span>
                        )}
                        {projectSubNav.map((item) => {
                            const fullPath = `/project/${projectId}${item.to}`
                            const isActive = item.matchPrefix
                                ? location.pathname.startsWith(fullPath)
                                : location.pathname === fullPath
                            return (
                                <NavLink key={item.to} to={fullPath} end={item.end}
                                    className={`sidebar__link ${isActive ? 'sidebar__link--active' : ''}`}
                                >
                                    <span className="sidebar__icon">{item.icon}</span>
                                    {!collapsed && <span>{item.label}</span>}
                                </NavLink>
                            )
                        })}
                    </div>
                )}

                {!collapsed && recentItems.length > 0 && (
                    <div className="sidebar__section">
                        <span className="sidebar__section-title">最近访问</span>
                        {recentItems.map((item) => (
                            <NavLink
                                key={item.id}
                                to={item.path}
                                className={({ isActive }) =>
                                    `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`
                                }
                            >
                                <span className="sidebar__icon">
                                    {item.type === 'project' ? <IconFolder /> : <IconBook />}
                                </span>
                                <span>{item.name}</span>
                            </NavLink>
                        ))}
                    </div>
                )}

                <div className="sidebar__section">
                    {!collapsed && <span className="sidebar__section-title">全局</span>}
                    <NavLink to="/dashboard"
                        className={({ isActive }) =>
                            `sidebar__link ${isActive ? 'sidebar__link--active' : ''}`
                        }
                    >
                        <span className="sidebar__icon"><IconChart /></span>
                        {!collapsed && <span>评测看板</span>}
                    </NavLink>
                </div>
            </nav>
            {!collapsed && <ActivityPanel />}
        </aside>
    )
}
