import { AnimatePresence, motion } from 'framer-motion'

export type BatchState = 'idle' | 'generating' | 'paused' | 'interrupted' | 'completed'

export interface BatchStateMachineProps {
    state: BatchState
    progress: { completed: number; total: number }
    summary?: { totalWords: number; conflictCount: number }
    error?: string
    onPause: () => void
    onResume: () => void
    onStop: () => void
    onRetry: () => void
    onRestart: () => void
}

const STATE_COLORS: Record<BatchState, string> = {
    idle: 'var(--text-tertiary)',
    generating: 'var(--accent)',
    paused: 'var(--warning)',
    interrupted: 'var(--danger)',
    completed: 'var(--success)',
}

export default function BatchStateMachine({
    state,
    progress,
    summary,
    error,
    onPause,
    onResume,
    onStop,
    onRetry,
    onRestart,
}: BatchStateMachineProps) {
    const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0
    const barColor = STATE_COLORS[state]

    return (
        <div className="batch-sm" role="region" aria-label="批量生成状态">
            {/* Progress bar */}
            <div className="batch-sm__bar-track">
                <AnimatePresence>
                    <motion.div
                        className="batch-sm__bar-fill"
                        style={{ backgroundColor: barColor }}
                        initial={{ width: 0 }}
                        animate={{ width: `${percent}%` }}
                        transition={{ duration: 0.4, ease: 'easeOut' }}
                    />
                </AnimatePresence>
            </div>

            {/* Progress text */}
            <p className="batch-sm__text" data-testid="batch-progress-text" aria-live="assertive">
                {progress.completed}/{progress.total} ({percent}%)
            </p>

            {/* State-specific content */}
            {state === 'idle' && (
                <p className="batch-sm__idle muted">等待开始</p>
            )}

            {state === 'generating' && (
                <div className="batch-sm__actions">
                    <button className="btn btn-secondary" onClick={onPause}>暂停</button>
                    <button className="btn danger-btn" onClick={onStop}>终止</button>
                </div>
            )}

            {state === 'paused' && (
                <div className="batch-sm__actions">
                    <button className="btn btn-primary" onClick={onResume}>继续</button>
                    <button className="btn danger-btn" onClick={onStop}>终止</button>
                </div>
            )}

            {state === 'interrupted' && (
                <>
                    {error && <p className="batch-sm__error" role="alert">{error}</p>}
                    <div className="batch-sm__actions">
                        <button className="btn btn-primary" onClick={onRetry}>从断点恢复</button>
                        <button className="btn btn-secondary" onClick={onRestart}>重新开始</button>
                    </div>
                </>
            )}

            {state === 'completed' && summary && (
                <div className="batch-sm__summary">
                    <span>总字数: {summary.totalWords.toLocaleString()}</span>
                    <span>冲突数: {summary.conflictCount}</span>
                </div>
            )}
        </div>
    )
}
