import { create } from 'zustand'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastAction {
    label: string
    onClick: () => void
}

export interface ToastItem {
    id: string
    type: ToastType
    message: string
    duration: number // ms
    context?: string       // 请求上下文（如"创建章节"）
    actions?: ToastAction[] // 恢复动作按钮
    detail?: string        // 可展开的错误详情
}

const DURATION_MAP: Record<ToastType, number> = {
    success: 3000,
    error: 5000,
    info: 3000,
    warning: 4000,
}

interface ToastStore {
    toasts: ToastItem[]
    addToast: (type: ToastType, message: string, options?: {
        context?: string
        actions?: ToastAction[]
        detail?: string
    }) => void
    removeToast: (id: string) => void
}

export const useToastStore = create<ToastStore>((set) => ({
    toasts: [],

    addToast: (type, message, options) => {
        const toast: ToastItem = {
            id: crypto.randomUUID(),
            type,
            message,
            duration: DURATION_MAP[type],
            ...options,
        }
        set((state) => ({ toasts: [...state.toasts, toast] }))
    },

    removeToast: (id) => {
        set((state) => ({
            toasts: state.toasts.filter((t) => t.id !== id),
        }))
    },
}))
