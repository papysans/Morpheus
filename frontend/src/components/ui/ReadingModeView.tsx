import { useMemo } from 'react'
import { AnimatePresence } from 'framer-motion'
import ReactMarkdown from 'react-markdown'
import ReadingModeToolbar from './ReadingModeToolbar'

type ReadingContentType = 'markdown' | 'plain'

interface ReadingModeTocItem {
    id: string
    label: string
    active?: boolean
    onClick: () => void
}

interface ReadingModeViewProps {
    content: string
    contentType?: ReadingContentType
    emptyText?: string
    tocItems?: ReadingModeTocItem[]
    tocTitle?: string
    onExit: () => void
    onPrevChapter?: () => void
    onNextChapter?: () => void
    hasPrev?: boolean
    hasNext?: boolean
    currentLabel?: string
}

export default function ReadingModeView({
    content,
    contentType = 'markdown',
    emptyText = '暂无内容可阅读',
    tocItems = [],
    tocTitle = '章节目录',
    onExit,
    onPrevChapter,
    onNextChapter,
    hasPrev = false,
    hasNext = false,
    currentLabel,
}: ReadingModeViewProps) {
    const normalizedContent = content.trim()

    const plainParagraphs = useMemo(() => {
        if (!normalizedContent) return []
        return normalizedContent
            .split(/\n{2,}/)
            .map((item) => item.trim())
            .filter(Boolean)
    }, [normalizedContent])

    const hasContent = normalizedContent.length > 0
    const hasToc = tocItems.length > 0

    return (
        <section className={`reading-mode ${hasToc ? 'reading-mode--with-toc' : ''}`} aria-label="阅读模式">
            <div className="reading-mode-toolbar-wrap">
                <AnimatePresence>
                    <ReadingModeToolbar
                        onExit={onExit}
                        onPrevChapter={onPrevChapter}
                        onNextChapter={onNextChapter}
                        hasPrev={hasPrev}
                        hasNext={hasNext}
                        currentLabel={currentLabel}
                    />
                </AnimatePresence>
            </div>

            <div className="reading-mode__layout">
                {hasToc && (
                    <aside className="reading-mode__toc" aria-label={tocTitle}>
                        <p className="reading-mode__toc-title">{tocTitle}</p>
                        <div className="reading-mode__toc-list">
                            {tocItems.map((item) => (
                                <button
                                    key={item.id}
                                    type="button"
                                    className={`reading-mode__toc-item ${item.active ? 'is-active' : ''}`}
                                    onClick={item.onClick}
                                    title={item.label}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </aside>
                )}

                <div className="reading-mode__inner">
                    <article className="reading-mode__paper">
                        {!hasContent && <p className="reading-mode__empty">{emptyText}</p>}

                        {hasContent && contentType === 'markdown' && (
                            <div className="reading-mode__markdown">
                                <ReactMarkdown>{normalizedContent}</ReactMarkdown>
                            </div>
                        )}

                        {hasContent && contentType === 'plain' && (
                            <div className="reading-mode__plain">
                                {plainParagraphs.length > 0 ? (
                                    plainParagraphs.map((paragraph, idx) => (
                                        <p key={`${idx}-${paragraph.slice(0, 16)}`}>{paragraph}</p>
                                    ))
                                ) : (
                                    <p>{normalizedContent}</p>
                                )}
                            </div>
                        )}
                    </article>
                </div>
            </div>
        </section>
    )
}
