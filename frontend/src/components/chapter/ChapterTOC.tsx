import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

export interface ChapterTOCProps {
    chapters: Array<{
        id: string
        chapterNumber: number
        title: string
        wordCount: number
    }>
    activeChapterId?: string
    onSelect: (chapterId: string) => void
}

export default function ChapterTOC({ chapters, activeChapterId, onSelect }: ChapterTOCProps) {
    const [collapsed, setCollapsed] = useState(false)

    if (chapters.length === 0) return null

    return (
        <div className="writing-toc">
            <button
                className="writing-toc__toggle"
                onClick={() => setCollapsed((v) => !v)}
                aria-label={collapsed ? '展开目录' : '折叠目录'}
            >
                <span className="writing-toc__title">章节目录</span>
                <span>{collapsed ? '▸' : '▾'}</span>
            </button>
            <AnimatePresence initial={false}>
                {!collapsed && (
                    <motion.ul
                        className="writing-toc__list"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                    >
                        {chapters.map((ch) => (
                            <li key={ch.id}>
                                <button
                                    className={`writing-toc__item ${ch.id === activeChapterId ? 'writing-toc__item--active' : ''}`}
                                    onClick={() => onSelect(ch.id)}
                                >
                                    <span className="writing-toc__num">第{ch.chapterNumber}章</span>
                                    <span className="writing-toc__name">{ch.title}</span>
                                    <span className="writing-toc__words">{ch.wordCount}字</span>
                                </button>
                            </li>
                        ))}
                    </motion.ul>
                )}
            </AnimatePresence>
        </div>
    )
}
