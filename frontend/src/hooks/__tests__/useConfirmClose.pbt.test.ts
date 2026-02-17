// Feature: frontend-ux-polish, Property 8: 模态框关闭确认行为
// Validates: Requirements 5.1, 5.4

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import * as fc from 'fast-check'
import { useConfirmClose } from '../useConfirmClose'

describe('useConfirmClose PBT', () => {
    it('Property 8: isDirty=true blocks close and shows confirm; isDirty=false calls close directly', () => {
        fc.assert(
            fc.property(fc.boolean(), (isDirty) => {
                const onClose = vi.fn()
                const { result } = renderHook(() => useConfirmClose({ isDirty }))

                act(() => {
                    result.current.confirmClose(onClose)
                })

                if (isDirty) {
                    // Should NOT call onClose, should show confirm dialog
                    expect(onClose).not.toHaveBeenCalled()
                    expect(result.current.showConfirm).toBe(true)
                } else {
                    // Should call onClose immediately, no confirm dialog
                    expect(onClose).toHaveBeenCalledTimes(1)
                    expect(result.current.showConfirm).toBe(false)
                }
            }),
            { numRuns: 100 },
        )
    })
})
