import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { useToastStore, type ToastType } from '../useToastStore'

// Feature: frontend-ux-polish, Property 7: 增强 Toast 字段完整渲染
// Validates: Requirements 4.1, 4.2, 4.3

const toastTypeArb = fc.constantFrom<ToastType>('success', 'error', 'info', 'warning')
const messageArb = fc.string({ minLength: 1, maxLength: 200 })
const contextArb = fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined })
const detailArb = fc.option(fc.string({ minLength: 1, maxLength: 500 }), { nil: undefined })
const actionLabelArb = fc.string({ minLength: 1, maxLength: 50 })
const actionsArb = fc.option(
    fc.array(actionLabelArb, { minLength: 1, maxLength: 5 }).map(labels =>
        labels.map(label => ({ label, onClick: () => { } }))
    ),
    { nil: undefined }
)

beforeEach(() => {
    useToastStore.setState({ toasts: [] })
})

describe('Feature: frontend-ux-polish, Property 7: 增强 Toast 字段完整渲染', () => {
    /**
     * **Validates: Requirements 4.1, 4.2, 4.3**
     *
     * For any random combination of context/actions/detail options passed to addToast,
     * the resulting ToastItem in the store correctly contains all provided fields.
     * When options are omitted, those fields are undefined.
     */
    it('addToast with random context/actions/detail preserves all fields', () => {
        fc.assert(
            fc.property(
                toastTypeArb, messageArb, contextArb, actionsArb, detailArb,
                (type, message, context, actions, detail) => {
                    useToastStore.setState({ toasts: [] })

                    const options: Record<string, unknown> = {}
                    if (context !== undefined) options.context = context
                    if (actions !== undefined) options.actions = actions
                    if (detail !== undefined) options.detail = detail

                    const hasOptions = Object.keys(options).length > 0
                    useToastStore.getState().addToast(type, message, hasOptions ? options as any : undefined)

                    const toast = useToastStore.getState().toasts[0]
                    expect(toast.type).toBe(type)
                    expect(toast.message).toBe(message)

                    if (context !== undefined) {
                        expect(toast.context).toBe(context)
                    } else {
                        expect(toast.context).toBeUndefined()
                    }

                    if (actions !== undefined) {
                        expect(toast.actions).toHaveLength(actions.length)
                        for (let i = 0; i < actions.length; i++) {
                            expect(toast.actions![i].label).toBe(actions[i].label)
                        }
                    } else {
                        expect(toast.actions).toBeUndefined()
                    }

                    if (detail !== undefined) {
                        expect(toast.detail).toBe(detail)
                    } else {
                        expect(toast.detail).toBeUndefined()
                    }
                }
            ),
            { numRuns: 100 }
        )
    })
})
