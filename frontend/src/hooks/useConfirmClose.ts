import { useState, useRef, useCallback } from 'react'

export interface UseConfirmCloseOptions {
    isDirty: boolean
    message?: string
}

export interface UseConfirmCloseReturn {
    confirmClose: (onClose: () => void) => void
    showConfirm: boolean
    handleConfirm: () => void
    handleCancel: () => void
    message: string
}

const DEFAULT_MESSAGE = '有未保存的修改，确定要关闭吗？'

export function useConfirmClose(options: UseConfirmCloseOptions): UseConfirmCloseReturn {
    const { isDirty, message = DEFAULT_MESSAGE } = options
    const [showConfirm, setShowConfirm] = useState(false)
    const pendingClose = useRef<(() => void) | null>(null)

    const confirmClose = useCallback(
        (onClose: () => void) => {
            if (!isDirty) {
                onClose()
                return
            }
            pendingClose.current = onClose
            setShowConfirm(true)
        },
        [isDirty],
    )

    const handleConfirm = useCallback(() => {
        pendingClose.current?.()
        pendingClose.current = null
        setShowConfirm(false)
    }, [])

    const handleCancel = useCallback(() => {
        pendingClose.current = null
        setShowConfirm(false)
    }, [])

    return { confirmClose, showConfirm, handleConfirm, handleCancel, message }
}
