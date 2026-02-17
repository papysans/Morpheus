import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import * as fc from 'fast-check'
import { useAutoSave } from '../useAutoSave'

// Feature: frontend-ux-polish, Property 10: 自动保存往返一致性
// Validates: Requirements 7.1, 7.3

// Mock localStorage since jsdom doesn't provide a full implementation
const localStorageMock = (() => {
    let store: Record<string, string> = {}
    return {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => { store[key] = value }),
        removeItem: vi.fn((key: string) => { delete store[key] }),
        clear: vi.fn(() => { store = {} }),
    }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

describe('useAutoSave - Property-Based Tests', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        localStorageMock.clear()
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    const contentArb = fc.string({ minLength: 1, maxLength: 500 })
    const keyArb = fc.string({ minLength: 1, maxLength: 50 }).map(
        s => 'draft-' + s.replace(/[^a-zA-Z0-9]/g, 'x'),
    )

    it('Property 10: after debounce fires, hasDraft is true and restoreDraft returns original content', () => {
        fc.assert(
            fc.property(contentArb, keyArb, (content, key) => {
                // Clean slate for each iteration
                localStorageMock.clear()
                vi.clearAllMocks()

                const { result, rerender } = renderHook(
                    ({ k, c }) => useAutoSave({ key: k, content: c }),
                    { initialProps: { k: key, c: '' } },
                )

                // Set content to trigger debounced save
                rerender({ k: key, c: content })

                // Advance past debounce (default 2000ms)
                act(() => { vi.advanceTimersByTime(2000) })

                // hasDraft should be true after save
                expect(result.current.hasDraft).toBe(true)

                // restoreDraft should return the exact original content
                let restored = ''
                act(() => {
                    restored = result.current.restoreDraft()
                })
                expect(restored).toBe(content)

                // Cleanup: discard draft and unmount
                act(() => { result.current.discardDraft() })
            }),
            { numRuns: 100 },
        )
    })
})
