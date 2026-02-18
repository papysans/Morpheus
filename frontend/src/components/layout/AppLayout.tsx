import { useMemo } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'
import ToastContainer from '../ui/ToastContainer'
import ShortcutHelpPanel from '../ui/ShortcutHelpPanel'
import { useUIStore } from '../../stores/useUIStore'
import { useKeyboardShortcuts, type ShortcutDef } from '../../hooks/useKeyboardShortcuts'

export default function AppLayout() {
    const location = useLocation()
    const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed)
    const readingMode = useUIStore((s) => s.readingMode)
    const toggleShortcutHelp = useUIStore((s) => s.toggleShortcutHelp)
    const shortcutHelpOpen = useUIStore((s) => s.shortcutHelpOpen)
    const exitReadingMode = useUIStore((s) => s.exitReadingMode)

    const globalShortcuts: ShortcutDef[] = useMemo(
        () => [
            {
                key: 'escape',
                label: '关闭模态框 / 退出阅读模式',
                handler: () => {
                    if (shortcutHelpOpen) {
                        toggleShortcutHelp()
                    } else if (readingMode) {
                        exitReadingMode()
                    }
                },
                scope: 'global',
            },
            {
                key: 'mod+/',
                label: '打开快捷键帮助',
                handler: () => toggleShortcutHelp(),
                scope: 'global',
            },
        ],
        [shortcutHelpOpen, readingMode, toggleShortcutHelp, exitReadingMode],
    )

    useKeyboardShortcuts(globalShortcuts)

    const layoutClass = [
        'app-layout',
        sidebarCollapsed && !readingMode ? 'app-layout--collapsed' : '',
        readingMode ? 'app-layout--reading' : '',
    ]
        .filter(Boolean)
        .join(' ')

    const projectIdMatch = location.pathname.match(/^\/project\/([^/]+)/)
    const projectId = projectIdMatch ? projectIdMatch[1] : null

    const mobileProjectLinks = projectId
        ? [
              { to: `/project/${projectId}`, label: '概览', prefix: false },
              { to: `/project/${projectId}/write`, label: '写作', prefix: false },
              { to: `/project/${projectId}/chapter`, label: '章节', prefix: true },
              { to: `/project/${projectId}/memory`, label: '记忆', prefix: false },
              { to: `/project/${projectId}/graph`, label: '图谱', prefix: false },
              { to: `/project/${projectId}/trace`, label: '回放', prefix: true },
          ]
        : []

    const isActive = (to: string, prefix = false) =>
        prefix ? location.pathname.startsWith(to) : location.pathname === to

    return (
        <div className={layoutClass}>
            {!readingMode && <Sidebar />}
            {!readingMode && (
                <nav className="mobile-nav" aria-label="移动端快捷导航">
                    <Link to="/" className={`mobile-nav__link ${isActive('/') ? 'mobile-nav__link--active' : ''}`}>
                        项目
                    </Link>
                    {mobileProjectLinks.map((item) => (
                        <Link
                            key={item.to}
                            to={item.to}
                            className={`mobile-nav__link ${isActive(item.to, item.prefix) ? 'mobile-nav__link--active' : ''}`}
                        >
                            {item.label}
                        </Link>
                    ))}
                    <Link
                        to="/dashboard"
                        className={`mobile-nav__link ${isActive('/dashboard') ? 'mobile-nav__link--active' : ''}`}
                    >
                        看板
                    </Link>
                </nav>
            )}
            <main className="app-layout__content">
                <Outlet />
            </main>
            <ToastContainer />
            <ShortcutHelpPanel />
        </div>
    )
}
