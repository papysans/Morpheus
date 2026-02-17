import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { exportChapter, exportBook, type ChapterContent, type ExportOptions } from '../../services/exportService'

export interface ChapterExportMenuProps {
    /** 当前章节数据（用于单章导出） */
    currentChapter?: ChapterContent
    /** 所有章节数据（用于整书导出） */
    allChapters?: ChapterContent[]
    /** 项目名称 */
    projectName: string
}

export default function ChapterExportMenu({
    currentChapter,
    allChapters,
    projectName,
}: ChapterExportMenuProps) {
    const [open, setOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    /* ── 点击外部关闭 ── */
    useEffect(() => {
        if (!open) return
        function handleClickOutside(e: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [open])

    /* ── Escape 关闭 ── */
    useEffect(() => {
        if (!open) return
        function handleEsc(e: KeyboardEvent) {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', handleEsc)
        return () => document.removeEventListener('keydown', handleEsc)
    }, [open])

    function handleExport(
        scope: 'chapter' | 'book',
        format: ExportOptions['format'],
    ) {
        const options: ExportOptions = {
            format,
            includeTableOfContents: true,
            projectName,
        }

        if (scope === 'chapter' && currentChapter) {
            exportChapter(currentChapter, options)
        } else if (scope === 'book' && allChapters) {
            exportBook(allChapters, options)
        }

        setOpen(false)
    }

    const hasChapter = !!currentChapter
    const hasBook = !!allChapters && allChapters.some((chapter) => chapter.content?.trim().length > 0)

    if (!hasChapter && !hasBook) return null

    return (
        <div className="export-menu" ref={menuRef}>
            <button
                className="glass-btn export-menu__trigger"
                onClick={() => setOpen((v) => !v)}
                aria-haspopup="true"
                aria-expanded={open}
                aria-label="导出菜单"
            >
                <span className="export-menu__icon" aria-hidden="true">↓</span>
                导出
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        className="export-menu__dropdown"
                        role="menu"
                        initial={{ opacity: 0, y: -6, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -6, scale: 0.96 }}
                        transition={{ duration: 0.15 }}
                    >
                        {hasChapter && (
                            <div className="export-menu__group">
                                <span className="export-menu__group-label">导出当前章节</span>
                                <button
                                    className="export-menu__item"
                                    role="menuitem"
                                    onClick={() => handleExport('chapter', 'markdown')}
                                >
                                    Markdown (.md)
                                </button>
                                <button
                                    className="export-menu__item"
                                    role="menuitem"
                                    onClick={() => handleExport('chapter', 'txt')}
                                >
                                    纯文本 (.txt)
                                </button>
                            </div>
                        )}

                        {hasChapter && hasBook && (
                            <div className="export-menu__divider" />
                        )}

                        {hasBook && (
                            <div className="export-menu__group">
                                <span className="export-menu__group-label">导出整书</span>
                                <button
                                    className="export-menu__item"
                                    role="menuitem"
                                    onClick={() => handleExport('book', 'markdown')}
                                >
                                    Markdown (.md)
                                </button>
                                <button
                                    className="export-menu__item"
                                    role="menuitem"
                                    onClick={() => handleExport('book', 'txt')}
                                >
                                    纯文本 (.txt)
                                </button>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
