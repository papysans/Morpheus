import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fc from 'fast-check'
import { useToastStore, ToastType, ToastAction } from '../useToastStore'

const toastTypeArb = fc.constantFrom<ToastType>('success', 'error', 'info', 'warning')
const messageArb = fc.string({ minLength: 1, maxLength: 200 })

const EXPECTED_DURATION: Record<ToastType, number> = {
    success: 3000,
    error: 5000,
    info: 3000,
    warning: 4000,
}

beforeEach(() => {
    useToastStore.setState({ toasts: [] })
})

describe('Feature: frontend-ux-overhaul, Property 4: Toast 类型与持续时间分配', () => {
    /**
     * **Validates: Requirements 4.1, 4.2, 4.5**
     *
     * For any Toast notification, when type is 'success' duration should be 3000ms,
     * when type is 'error' duration should be 5000ms, and the Toast's type field
     * should match the type specified at call time.
     */
    it('addToast assigns correct duration per type and preserves the type field', () => {
        fc.assert(
            fc.property(toastTypeArb, messageArb, (type, message) => {
                useToastStore.setState({ toasts: [] })
                useToastStore.getState().addToast(type, message)

                const toast = useToastStore.getState().toasts[0]
                expect(toast.type).toBe(type)
                expect(toast.duration).toBe(EXPECTED_DURATION[type])
                expect(toast.message).toBe(message)
            }),
            { numRuns: 100 },
        )
    })
})

describe('Feature: frontend-ux-overhaul, Property 5: Toast 队列累积', () => {
    /**
     * **Validates: Requirements 4.4**
     *
     * For any N consecutive addToast calls (N >= 1), the Toast queue length
     * should equal N, and each Toast's id should be unique.
     */
    it('N consecutive addToast calls produce N toasts with unique ids', () => {
        fc.assert(
            fc.property(
                fc.array(fc.tuple(toastTypeArb, messageArb), { minLength: 1, maxLength: 20 }),
                (calls) => {
                    useToastStore.setState({ toasts: [] })

                    for (const [type, message] of calls) {
                        useToastStore.getState().addToast(type, message)
                    }

                    const { toasts } = useToastStore.getState()
                    expect(toasts).toHaveLength(calls.length)

                    const ids = toasts.map((t) => t.id)
                    expect(new Set(ids).size).toBe(ids.length)
                },
            ),
            { numRuns: 100 },
        )
    })
})

describe('Feature: frontend-ux-polish, Task 5.1: Enhanced Toast fields', () => {
    /**
     * **Validates: Requirements 4.1, 4.2, 4.3**
     */

    it('addToast without options still works (backward compatibility)', () => {
        useToastStore.getState().addToast('error', '请求失败')

        const toast = useToastStore.getState().toasts[0]
        expect(toast.type).toBe('error')
        expect(toast.message).toBe('请求失败')
        expect(toast.duration).toBe(5000)
        expect(toast.context).toBeUndefined()
        expect(toast.actions).toBeUndefined()
        expect(toast.detail).toBeUndefined()
    })

    it('addToast with context option sets context field', () => {
        useToastStore.getState().addToast('error', '操作失败', {
            context: '创建章节',
        })

        const toast = useToastStore.getState().toasts[0]
        expect(toast.context).toBe('创建章节')
        expect(toast.message).toBe('操作失败')
        expect(toast.actions).toBeUndefined()
        expect(toast.detail).toBeUndefined()
    })

    it('addToast with actions option sets actions array', () => {
        const retryFn = vi.fn()
        const actions: ToastAction[] = [
            { label: '重试', onClick: retryFn },
        ]

        useToastStore.getState().addToast('error', '保存失败', { actions })

        const toast = useToastStore.getState().toasts[0]
        expect(toast.actions).toHaveLength(1)
        expect(toast.actions![0].label).toBe('重试')
        toast.actions![0].onClick()
        expect(retryFn).toHaveBeenCalledOnce()
    })

    it('addToast with detail option sets detail field', () => {
        useToastStore.getState().addToast('error', '请求失败', {
            detail: 'Error 500: Internal Server Error\nat /api/chapters',
        })

        const toast = useToastStore.getState().toasts[0]
        expect(toast.detail).toBe('Error 500: Internal Server Error\nat /api/chapters')
    })

    it('addToast with all options sets all fields correctly', () => {
        const retryFn = vi.fn()
        const goBackFn = vi.fn()

        useToastStore.getState().addToast('error', '创建失败', {
            context: '创建章节',
            actions: [
                { label: '重试', onClick: retryFn },
                { label: '返回', onClick: goBackFn },
            ],
            detail: 'Validation error: title is required',
        })

        const toast = useToastStore.getState().toasts[0]
        expect(toast.type).toBe('error')
        expect(toast.message).toBe('创建失败')
        expect(toast.duration).toBe(5000)
        expect(toast.context).toBe('创建章节')
        expect(toast.actions).toHaveLength(2)
        expect(toast.detail).toBe('Validation error: title is required')
    })
})
