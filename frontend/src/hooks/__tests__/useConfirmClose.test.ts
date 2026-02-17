import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useConfirmClose } from '../useConfirmClose'

describe('useConfirmClose', () => {
    it('calls onClose immediately when isDirty=false', () => {
        const onClose = vi.fn()
        const { result } = renderHook(() => useConfirmClose({ isDirty: false }))

        act(() => {
            result.current.confirmClose(onClose)
        })

        expect(onClose).toHaveBeenCalledTimes(1)
        expect(result.current.showConfirm).toBe(false)
    })

    it('sets showConfirm=true without calling onClose when isDirty=true', () => {
        const onClose = vi.fn()
        const { result } = renderHook(() => useConfirmClose({ isDirty: true }))

        act(() => {
            result.current.confirmClose(onClose)
        })

        expect(onClose).not.toHaveBeenCalled()
        expect(result.current.showConfirm).toBe(true)
    })

    it('handleConfirm calls stored onClose and resets showConfirm', () => {
        const onClose = vi.fn()
        const { result } = renderHook(() => useConfirmClose({ isDirty: true }))

        act(() => {
            result.current.confirmClose(onClose)
        })
        expect(result.current.showConfirm).toBe(true)

        act(() => {
            result.current.handleConfirm()
        })

        expect(onClose).toHaveBeenCalledTimes(1)
        expect(result.current.showConfirm).toBe(false)
    })

    it('handleCancel resets showConfirm without calling onClose', () => {
        const onClose = vi.fn()
        const { result } = renderHook(() => useConfirmClose({ isDirty: true }))

        act(() => {
            result.current.confirmClose(onClose)
        })
        expect(result.current.showConfirm).toBe(true)

        act(() => {
            result.current.handleCancel()
        })

        expect(onClose).not.toHaveBeenCalled()
        expect(result.current.showConfirm).toBe(false)
    })

    it('uses default message when none provided', () => {
        const { result } = renderHook(() => useConfirmClose({ isDirty: true }))
        expect(result.current.message).toBe('有未保存的修改，确定要关闭吗？')
    })

    it('returns custom message when provided', () => {
        const { result } = renderHook(() =>
            useConfirmClose({ isDirty: true, message: '确定放弃编辑？' }),
        )
        expect(result.current.message).toBe('确定放弃编辑？')
    })

    it('updates stored callback on multiple confirmClose calls', () => {
        const firstClose = vi.fn()
        const secondClose = vi.fn()
        const { result } = renderHook(() => useConfirmClose({ isDirty: true }))

        act(() => {
            result.current.confirmClose(firstClose)
        })

        // Call confirmClose again with a different callback
        act(() => {
            result.current.confirmClose(secondClose)
        })

        act(() => {
            result.current.handleConfirm()
        })

        expect(firstClose).not.toHaveBeenCalled()
        expect(secondClose).toHaveBeenCalledTimes(1)
    })
})
