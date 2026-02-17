import { useEffect, useState } from 'react'
import type { ToastItem } from '../../stores/useToastStore'
import { useToastStore } from '../../stores/useToastStore'

interface ToastProps {
    toast: ToastItem
}

const ICON_MAP: Record<ToastItem['type'], string> = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
    warning: '⚠',
}

export default function Toast({ toast }: ToastProps) {
    const removeToast = useToastStore((s) => s.removeToast)
    const [showDetail, setShowDetail] = useState(false)

    useEffect(() => {
        // Don't auto-dismiss if toast has actions (user needs to interact)
        if (toast.actions && toast.actions.length > 0) return
        const timer = setTimeout(() => {
            removeToast(toast.id)
        }, toast.duration)
        return () => clearTimeout(timer)
    }, [toast.id, toast.duration, toast.actions, removeToast])

    return (
        <div className={`toast toast--${toast.type}`} role="alert">
            <span className="toast__icon">{ICON_MAP[toast.type]}</span>
            <div className="toast__body">
                <span className="toast__message">
                    {toast.context && <strong className="toast__context">{toast.context}: </strong>}
                    {toast.message}
                </span>
                {toast.actions && toast.actions.length > 0 && (
                    <div className="toast__actions">
                        {toast.actions.map((action, i) => (
                            <button key={i} className="toast__action-btn" onClick={action.onClick}>
                                {action.label}
                            </button>
                        ))}
                    </div>
                )}
                {toast.detail && (
                    <div className="toast__detail-wrap">
                        <button className="toast__detail-toggle" onClick={() => setShowDetail(!showDetail)}>
                            {showDetail ? '收起详情' : '查看详情'}
                        </button>
                        {showDetail && <pre className="toast__detail">{toast.detail}</pre>}
                    </div>
                )}
            </div>
            <button
                className="toast__close"
                onClick={() => removeToast(toast.id)}
                aria-label="关闭通知"
            >
                ×
            </button>
        </div>
    )
}
