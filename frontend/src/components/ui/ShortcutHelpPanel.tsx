import { AnimatePresence, motion } from 'framer-motion'
import { useUIStore } from '../../stores/useUIStore'

const isMac =
    typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

const modLabel = isMac ? '⌘' : 'Ctrl'

const SHORTCUTS = [
    { keys: `${modLabel} + Enter`, description: '主操作（开始生成/提交）' },
    { keys: `${modLabel} + E`, description: '导出' },
    { keys: `${modLabel} + S`, description: '保存' },
    { keys: `${modLabel} + /`, description: '快捷键帮助' },
    { keys: 'Escape', description: '关闭模态框 / 退出阅读模式' },
]

export default function ShortcutHelpPanel() {
    const open = useUIStore((s) => s.shortcutHelpOpen)
    const toggle = useUIStore((s) => s.toggleShortcutHelp)

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    className="shortcut-panel-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    onClick={toggle}
                    role="dialog"
                    aria-modal="true"
                    aria-label="快捷键帮助"
                >
                    <motion.div
                        className="shortcut-panel"
                        initial={{ opacity: 0, scale: 0.92, y: 24 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.92, y: 24 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="shortcut-panel__header">
                            <h2 className="shortcut-panel__title">快捷键</h2>
                            <button
                                className="shortcut-panel__close"
                                onClick={toggle}
                                aria-label="关闭快捷键帮助"
                            >
                                ×
                            </button>
                        </div>
                        <ul className="shortcut-panel__list">
                            {SHORTCUTS.map((s) => (
                                <li key={s.keys} className="shortcut-panel__row">
                                    <kbd className="shortcut-panel__kbd">{s.keys}</kbd>
                                    <span className="shortcut-panel__desc">{s.description}</span>
                                </li>
                            ))}
                        </ul>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}
