import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardShortcuts, parseShortcut, type ShortcutDef } from '../useKeyboardShortcuts'

/* ── helpers ── */

function fireKey(opts: {
    key: string
    metaKey?: boolean
    ctrlKey?: boolean
    shiftKey?: boolean
    altKey?: boolean
    target?: HTMLElement
}) {
    const event = new KeyboardEvent('keydown', {
        key: opts.key,
        metaKey: opts.metaKey ?? false,
        ctrlKey: opts.ctrlKey ?? false,
        shiftKey: opts.shiftKey ?? false,
        altKey: opts.altKey ?? false,
        bubbles: true,
        cancelable: true,
    })
    // Override target if provided
    if (opts.target) {
        Object.defineProperty(event, 'target', { value: opts.target })
    }
    window.dispatchEvent(event)
    return event
}

let originalPlatform: PropertyDescriptor | undefined

beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform')
})

afterEach(() => {
    if (originalPlatform) {
        Object.defineProperty(navigator, 'platform', originalPlatform)
    } else {
        // Reset to default jsdom value
        Object.defineProperty(navigator, 'platform', {
            value: '',
            configurable: true,
        })
    }
})

/* ── parseShortcut tests ── */

describe('parseShortcut', () => {
    it('parses mod+enter', () => {
        const result = parseShortcut('mod+enter')
        expect(result).toEqual({
            modKey: true,
            shiftKey: false,
            altKey: false,
            targetKey: 'enter',
        })
    })

    it('parses escape (no modifiers)', () => {
        const result = parseShortcut('escape')
        expect(result).toEqual({
            modKey: false,
            shiftKey: false,
            altKey: false,
            targetKey: 'escape',
        })
    })

    it('parses mod+shift+s', () => {
        const result = parseShortcut('mod+shift+s')
        expect(result).toEqual({
            modKey: true,
            shiftKey: true,
            altKey: false,
            targetKey: 's',
        })
    })

    it('parses mod+/', () => {
        const result = parseShortcut('mod+/')
        expect(result).toEqual({
            modKey: true,
            shiftKey: false,
            altKey: false,
            targetKey: '/',
        })
    })
})

/* ── useKeyboardShortcuts hook tests ── */

describe('useKeyboardShortcuts', () => {
    it('calls handler when matching key is pressed (Ctrl on non-Mac)', () => {
        // jsdom platform is empty string → non-Mac → uses ctrlKey
        const handler = vi.fn()
        const shortcuts: ShortcutDef[] = [
            { key: 'mod+e', label: '导出', handler },
        ]

        renderHook(() => useKeyboardShortcuts(shortcuts))

        fireKey({ key: 'e', ctrlKey: true })
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('calls handler for escape without modifiers', () => {
        const handler = vi.fn()
        const shortcuts: ShortcutDef[] = [
            { key: 'escape', label: '关闭', handler },
        ]

        renderHook(() => useKeyboardShortcuts(shortcuts))

        fireKey({ key: 'Escape' })
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('does not call handler when wrong modifier is used', () => {
        const handler = vi.fn()
        const shortcuts: ShortcutDef[] = [
            { key: 'mod+s', label: '保存', handler },
        ]

        renderHook(() => useKeyboardShortcuts(shortcuts))

        // Press 's' without any modifier
        fireKey({ key: 's' })
        expect(handler).not.toHaveBeenCalled()

        // Press 's' with alt instead of ctrl
        fireKey({ key: 's', altKey: true })
        expect(handler).not.toHaveBeenCalled()
    })

    it('does not fire for non-Escape keys when target is an input', () => {
        const handler = vi.fn()
        const shortcuts: ShortcutDef[] = [
            { key: 'mod+s', label: '保存', handler },
        ]

        renderHook(() => useKeyboardShortcuts(shortcuts))

        const input = document.createElement('input')
        fireKey({ key: 's', ctrlKey: true, target: input })
        expect(handler).not.toHaveBeenCalled()
    })

    it('still fires Escape when target is an input', () => {
        const handler = vi.fn()
        const shortcuts: ShortcutDef[] = [
            { key: 'escape', label: '关闭', handler },
        ]

        renderHook(() => useKeyboardShortcuts(shortcuts))

        const input = document.createElement('input')
        fireKey({ key: 'Escape', target: input })
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('still fires Escape when target is a textarea', () => {
        const handler = vi.fn()
        const shortcuts: ShortcutDef[] = [
            { key: 'escape', label: '关闭', handler },
        ]

        renderHook(() => useKeyboardShortcuts(shortcuts))

        const textarea = document.createElement('textarea')
        fireKey({ key: 'Escape', target: textarea })
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('cleans up listener on unmount', () => {
        const handler = vi.fn()
        const shortcuts: ShortcutDef[] = [
            { key: 'escape', label: '关闭', handler },
        ]

        const { unmount } = renderHook(() => useKeyboardShortcuts(shortcuts))
        unmount()

        fireKey({ key: 'Escape' })
        expect(handler).not.toHaveBeenCalled()
    })

    it('handles mod+enter shortcut', () => {
        const handler = vi.fn()
        const shortcuts: ShortcutDef[] = [
            { key: 'mod+enter', label: '主操作', handler },
        ]

        renderHook(() => useKeyboardShortcuts(shortcuts))

        fireKey({ key: 'Enter', ctrlKey: true })
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('handles mod+/ shortcut', () => {
        const handler = vi.fn()
        const shortcuts: ShortcutDef[] = [
            { key: 'mod+/', label: '帮助', handler },
        ]

        renderHook(() => useKeyboardShortcuts(shortcuts))

        fireKey({ key: '/', ctrlKey: true })
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('does nothing with empty shortcuts array', () => {
        // Should not throw
        const { unmount } = renderHook(() => useKeyboardShortcuts([]))
        unmount()
    })

    it('supports multiple shortcuts simultaneously', () => {
        const saveHandler = vi.fn()
        const exportHandler = vi.fn()
        const escapeHandler = vi.fn()

        const shortcuts: ShortcutDef[] = [
            { key: 'mod+s', label: '保存', handler: saveHandler },
            { key: 'mod+e', label: '导出', handler: exportHandler },
            { key: 'escape', label: '关闭', handler: escapeHandler },
        ]

        renderHook(() => useKeyboardShortcuts(shortcuts))

        fireKey({ key: 's', ctrlKey: true })
        fireKey({ key: 'e', ctrlKey: true })
        fireKey({ key: 'Escape' })

        expect(saveHandler).toHaveBeenCalledTimes(1)
        expect(exportHandler).toHaveBeenCalledTimes(1)
        expect(escapeHandler).toHaveBeenCalledTimes(1)
    })
})
