import { useActivityStore, type ActivityRecord } from '../../stores/useActivityStore'

const TYPE_ICONS: Record<string, string> = {
    generate: '⚡',
    export: '📤',
    save: '💾',
    create: '➕',
    delete: '🗑',
    approve: '✅',
    error: '❌',
}

const STATUS_LABELS: Record<string, { text: string; className: string }> = {
    success: { text: '成功', className: 'chip chip--success' },
    error: { text: '失败', className: 'chip chip--error' },
    pending: { text: '进行中', className: 'chip chip--pending' },
}

function formatTime(timestamp: number): string {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMin = Math.floor(diffMs / 60000)

    if (diffMin < 1) return '刚刚'
    if (diffMin < 60) return `${diffMin} 分钟前`

    const diffHour = Math.floor(diffMin / 60)
    if (diffHour < 24) return `${diffHour} 小时前`

    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function ActivityItem({ record }: { record: ActivityRecord }) {
    const status = STATUS_LABELS[record.status] || STATUS_LABELS.pending

    return (
        <div className="activity-item">
            <span className="activity-item__icon">{TYPE_ICONS[record.type] || '📋'}</span>
            <div className="activity-item__body">
                <span className="activity-item__desc">{record.description}</span>
                <div className="activity-item__meta">
                    <span className="activity-item__time">{formatTime(record.timestamp)}</span>
                    <span className={status.className}>{status.text}</span>
                </div>
            </div>
            {record.status === 'error' && record.retryAction && (
                <button className="activity-item__retry" onClick={record.retryAction}>
                    重试
                </button>
            )}
        </div>
    )
}

export default function ActivityPanel() {
    const records = useActivityStore((s) => s.records)
    const panelOpen = useActivityStore((s) => s.panelOpen)
    const togglePanel = useActivityStore((s) => s.togglePanel)
    const clearRecords = useActivityStore((s) => s.clearRecords)

    return (
        <div className="activity-panel" role="complementary" aria-label="操作历史">
            <button className="activity-panel__toggle" onClick={togglePanel}>
                <span>操作历史</span>
                <span className="activity-panel__count">{records.length}</span>
            </button>
            {panelOpen && (
                <div className="activity-panel__list">
                    {records.length === 0 ? (
                        <p className="activity-panel__empty">暂无操作记录</p>
                    ) : (
                        <>
                            <div className="activity-panel__header">
                                <button className="activity-panel__clear" onClick={clearRecords}>
                                    清空
                                </button>
                            </div>
                            {records.map((record) => (
                                <ActivityItem key={record.id} record={record} />
                            ))}
                        </>
                    )}
                </div>
            )}
        </div>
    )
}
