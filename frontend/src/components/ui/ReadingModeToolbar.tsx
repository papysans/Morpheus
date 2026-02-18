import { motion } from 'framer-motion'

interface ReadingModeToolbarProps {
    onExit: () => void
    onPrevChapter?: () => void
    onNextChapter?: () => void
    hasPrev?: boolean
    hasNext?: boolean
    currentLabel?: string
}

export default function ReadingModeToolbar({
    onExit,
    onPrevChapter,
    onNextChapter,
    hasPrev = false,
    hasNext = false,
    currentLabel,
}: ReadingModeToolbarProps) {
    return (
        <motion.div
            className="reading-mode-toolbar"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
        >
            <button
                className="reading-mode-toolbar__btn reading-mode-toolbar__btn--exit"
                onClick={onExit}
                type="button"
                title="退出阅读模式 (Esc)"
            >
                ✕ 退出阅读
            </button>

            <div className="reading-mode-toolbar__nav">
                <button
                    className="reading-mode-toolbar__btn"
                    onClick={onPrevChapter}
                    disabled={!hasPrev}
                    type="button"
                    title="上一章"
                >
                    ← 上一章
                </button>
                {currentLabel && (
                    <span className="reading-mode-toolbar__label">{currentLabel}</span>
                )}
                <button
                    className="reading-mode-toolbar__btn"
                    onClick={onNextChapter}
                    disabled={!hasNext}
                    type="button"
                    title="下一章"
                >
                    下一章 →
                </button>
            </div>
        </motion.div>
    )
}
