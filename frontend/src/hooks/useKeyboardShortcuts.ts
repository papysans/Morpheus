import { useEffect } from 'react'

export interface ShortcutDef {
    key: string        // e.g. 'mod+enter', 'mod+e', 'escape'
    label: string      // 中文描述
    handler: () => void
    scope?: string     // 作用域，如 'chapter', 'global'
}

const isMac =
    typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)

/**
 * Parse a shortcut key string like 'mod+enter' into its parts.
 * 'mod' maps to Meta on Mac, Control on others.
 */
export function parseShortcut(key: string): {
    modKey: boolean
    shiftKey: boolean
    altKey: boolean
    targetKey: string
} {
    const parts = key.toLowerCase().split('+')
    let modKey = false
    let shiftKey = false
    let altKey = false
    let targetKey = ''

    for (const part of parts) {
        switch (part) {
            case 'mod':
                modKey = true
                break
            case 'shift':
                shiftKey = true
                break
            case 'alt':
                altKey = true
                break
            default:
                targetKey = part
        }
    }

    return { modKey, shiftKey, altKey, targetKey }
}

/** Normalise KeyboardEvent.key to a comparable lowercase string. */
function normaliseEventKey(e: KeyboardEvent): string {
    const k = e.key.toLowerCase()
    if (k === 'enter') return 'enter'
    if (k === 'escape') return 'escape'
    if (k === '/') return '/'
    return k
}

function matchesShortcut(e: KeyboardEvent, parsed: ReturnType<typeof parseShortcut>): boolean {
    const modPressed = isMac ? e.metaKey : e.ctrlKey
    if (parsed.modKey && !modPressed) return false
    if (!parsed.modKey && modPressed) return false
    if (parsed.shiftKey !== e.shiftKey) return false
    if (parsed.altKey !== e.altKey) return false
    return normaliseEventKey(e) === parsed.targetKey
}

/**
 * Register keyboard shortcuts. Automatically adds/removes keydown listener.
 * Supports 'mod+key' format where 'mod' = Cmd on Mac, Ctrl on others.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutDef[]): void {
    useEffect(() => {
        if (!shortcuts.length) return

        const parsed = shortcuts.map((s) => ({
            ...parseShortcut(s.key),
            handler: s.handler,
        }))

        function handleKeyDown(e: KeyboardEvent) {
            // Skip if user is typing in an input/textarea/contenteditable
            const target = e.target as HTMLElement | null
            if (
                target &&
                (target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable)
            ) {
                // Still allow Escape in inputs
                if (e.key !== 'Escape') return
            }

            for (const shortcut of parsed) {
                if (matchesShortcut(e, shortcut)) {
                    e.preventDefault()
                    e.stopPropagation()
                    shortcut.handler()
                    return
                }
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [shortcuts])
}
