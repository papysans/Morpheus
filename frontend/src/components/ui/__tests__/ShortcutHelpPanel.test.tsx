import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ShortcutHelpPanel from '../ShortcutHelpPanel'
import { useUIStore } from '../../../stores/useUIStore'

beforeEach(() => {
    useUIStore.setState({ shortcutHelpOpen: false })
})

describe('ShortcutHelpPanel', () => {
    it('does not render when shortcutHelpOpen is false', () => {
        render(<ShortcutHelpPanel />)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('renders modal with shortcut list when open', () => {
        useUIStore.setState({ shortcutHelpOpen: true })
        render(<ShortcutHelpPanel />)

        expect(screen.getByRole('dialog')).toBeInTheDocument()
        expect(screen.getByText('快捷键')).toBeInTheDocument()
        expect(screen.getByText('主操作（开始生成/提交）')).toBeInTheDocument()
        expect(screen.getByText('导出')).toBeInTheDocument()
        expect(screen.getByText('保存')).toBeInTheDocument()
        expect(screen.getByText('快捷键帮助')).toBeInTheDocument()
        expect(screen.getByText('关闭模态框 / 退出阅读模式')).toBeInTheDocument()
    })

    it('displays all 5 shortcut rows', () => {
        useUIStore.setState({ shortcutHelpOpen: true })
        render(<ShortcutHelpPanel />)

        const rows = document.querySelectorAll('.shortcut-panel__row')
        expect(rows.length).toBe(5)
    })

    it('closes when backdrop is clicked', () => {
        useUIStore.setState({ shortcutHelpOpen: true })
        render(<ShortcutHelpPanel />)

        fireEvent.click(screen.getByRole('dialog'))
        expect(useUIStore.getState().shortcutHelpOpen).toBe(false)
    })

    it('closes when close button is clicked', () => {
        useUIStore.setState({ shortcutHelpOpen: true })
        render(<ShortcutHelpPanel />)

        fireEvent.click(screen.getByLabelText('关闭快捷键帮助'))
        expect(useUIStore.getState().shortcutHelpOpen).toBe(false)
    })

    it('does not close when panel body is clicked', () => {
        useUIStore.setState({ shortcutHelpOpen: true })
        render(<ShortcutHelpPanel />)

        fireEvent.click(screen.getByText('快捷键'))
        expect(useUIStore.getState().shortcutHelpOpen).toBe(true)
    })

    it('renders kbd elements for shortcut keys', () => {
        useUIStore.setState({ shortcutHelpOpen: true })
        render(<ShortcutHelpPanel />)

        const kbds = document.querySelectorAll('.shortcut-panel__kbd')
        expect(kbds.length).toBe(5)
        // Escape should always be present regardless of platform
        const kbdTexts = Array.from(kbds).map((el) => el.textContent)
        expect(kbdTexts).toContain('Escape')
    })

    it('has aria-modal attribute for accessibility', () => {
        useUIStore.setState({ shortcutHelpOpen: true })
        render(<ShortcutHelpPanel />)

        const dialog = screen.getByRole('dialog')
        expect(dialog).toHaveAttribute('aria-modal', 'true')
        expect(dialog).toHaveAttribute('aria-label', '快捷键帮助')
    })
})
