import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAutoSave } from '../useAutoSave'

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

describe('useAutoSave', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        localStorageMock.clear()
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('saves content to localStorage after debounce', () => {
        const { rerender } = renderHook(
            ({ content }) => useAutoSave({ key: 'test-draft', content }),
            { initialProps: { content: '' } },
        )

        rerender({ content: 'Hello world' })

        // Before debounce fires, nothing saved
        expect(localStorageMock.setItem).not.toHaveBeenCalled()

        // Advance past debounce (default 2000ms)
        act(() => { vi.advanceTimersByTime(2000) })

        expect(localStorageMock.setItem).toHaveBeenCalled()
        const stored = JSON.parse(localStorageMock.getItem('test-draft')!)
        expect(stored.content).toBe('Hello world')
        expect(stored.timestamp).toBeTypeOf('number')
    })

    it('detects existing draft on mount (hasDraft = true)', () => {
        localStorageMock.setItem('test-draft', JSON.stringify({ content: 'saved draft', timestamp: Date.now() }))
        vi.clearAllMocks()

        const { result } = renderHook(() =>
            useAutoSave({ key: 'test-draft', content: '' }),
        )

        expect(result.current.hasDraft).toBe(true)
        expect(result.current.draftContent).toBe('saved draft')
        expect(result.current.draftTimestamp).toBeTypeOf('number')
    })

    it('returns null when no draft exists (hasDraft = false)', () => {
        const { result } = renderHook(() =>
            useAutoSave({ key: 'test-draft', content: '' }),
        )

        expect(result.current.hasDraft).toBe(false)
        expect(result.current.draftContent).toBeNull()
        expect(result.current.draftTimestamp).toBeNull()
    })

    it('restoreDraft returns saved content', () => {
        localStorageMock.setItem('test-draft', JSON.stringify({ content: 'my draft', timestamp: 1000 }))
        vi.clearAllMocks()

        const { result } = renderHook(() =>
            useAutoSave({ key: 'test-draft', content: '' }),
        )

        let restored: string = ''
        act(() => {
            restored = result.current.restoreDraft()
        })
        expect(restored).toBe('my draft')
    })

    it('discardDraft removes from localStorage', () => {
        localStorageMock.setItem('test-draft', JSON.stringify({ content: 'draft', timestamp: 1000 }))
        vi.clearAllMocks()

        const { result } = renderHook(() =>
            useAutoSave({ key: 'test-draft', content: '' }),
        )

        expect(result.current.hasDraft).toBe(true)

        act(() => { result.current.discardDraft() })

        expect(localStorageMock.removeItem).toHaveBeenCalledWith('test-draft')
        expect(result.current.hasDraft).toBe(false)
    })

    it('clearDraft removes from localStorage', () => {
        localStorageMock.setItem('test-draft', JSON.stringify({ content: 'draft', timestamp: 1000 }))
        vi.clearAllMocks()

        const { result } = renderHook(() =>
            useAutoSave({ key: 'test-draft', content: '' }),
        )

        act(() => { result.current.clearDraft() })

        expect(localStorageMock.removeItem).toHaveBeenCalledWith('test-draft')
        expect(result.current.hasDraft).toBe(false)
    })

    it('does not save empty content', () => {
        const { rerender } = renderHook(
            ({ content }) => useAutoSave({ key: 'test-draft', content }),
            { initialProps: { content: '' } },
        )

        rerender({ content: '' })
        act(() => { vi.advanceTimersByTime(2000) })

        expect(localStorageMock.getItem('test-draft')).toBeNull()
    })

    it('calls onSaved callback after auto-save', () => {
        const onSaved = vi.fn()
        const { rerender } = renderHook(
            ({ content }) => useAutoSave({ key: 'test-draft', content, onSaved }),
            { initialProps: { content: '' } },
        )

        rerender({ content: 'some content' })
        act(() => { vi.advanceTimersByTime(2000) })

        expect(onSaved).toHaveBeenCalledTimes(1)
    })

    it('updates lastSaved after auto-save', () => {
        const { result, rerender } = renderHook(
            ({ content }) => useAutoSave({ key: 'test-draft', content }),
            { initialProps: { content: '' } },
        )

        expect(result.current.lastSaved).toBeNull()

        rerender({ content: 'updated' })
        act(() => { vi.advanceTimersByTime(2000) })

        expect(result.current.lastSaved).toBeTypeOf('number')
    })

    it('respects custom debounceMs', () => {
        const { rerender } = renderHook(
            ({ content }) => useAutoSave({ key: 'test-draft', content, debounceMs: 500 }),
            { initialProps: { content: '' } },
        )

        rerender({ content: 'fast save' })

        // Not saved yet at 400ms
        act(() => { vi.advanceTimersByTime(400) })
        expect(localStorageMock.getItem('test-draft')).toBeNull()

        // Saved at 500ms
        act(() => { vi.advanceTimersByTime(100) })
        const stored = JSON.parse(localStorageMock.getItem('test-draft')!)
        expect(stored.content).toBe('fast save')
    })

    it('debounces rapid content changes', () => {
        const { rerender } = renderHook(
            ({ content }) => useAutoSave({ key: 'test-draft', content }),
            { initialProps: { content: '' } },
        )

        rerender({ content: 'a' })
        act(() => { vi.advanceTimersByTime(500) })
        rerender({ content: 'ab' })
        act(() => { vi.advanceTimersByTime(500) })
        rerender({ content: 'abc' })
        act(() => { vi.advanceTimersByTime(2000) })

        const stored = JSON.parse(localStorageMock.getItem('test-draft')!)
        expect(stored.content).toBe('abc')
    })
})
