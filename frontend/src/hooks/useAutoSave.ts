import { useState, useEffect, useCallback, useRef } from 'react'

export interface UseAutoSaveOptions {
    key: string
    content: string
    debounceMs?: number
    onSaved?: () => void
}

export interface UseAutoSaveReturn {
    hasDraft: boolean
    draftContent: string | null
    draftTimestamp: number | null
    restoreDraft: () => string
    discardDraft: () => void
    clearDraft: () => void
    lastSaved: number | null
}

interface DraftData {
    content: string
    timestamp: number
}

function readDraft(key: string): DraftData | null {
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const data = JSON.parse(raw) as DraftData
        if (data.content && typeof data.content === 'string' && typeof data.timestamp === 'number') {
            return data
        }
        return null
    } catch {
        return null
    }
}

function writeDraft(key: string, content: string): number {
    const timestamp = Date.now()
    try {
        localStorage.setItem(key, JSON.stringify({ content, timestamp }))
    } catch {
        // localStorage full or unavailable — silent fail
    }
    return timestamp
}

function removeDraft(key: string): void {
    try {
        localStorage.removeItem(key)
    } catch {
        // silent fail
    }
}

export function useAutoSave(options: UseAutoSaveOptions): UseAutoSaveReturn {
    const { key, content, debounceMs = 2000, onSaved } = options

    const [draft, setDraft] = useState<DraftData | null>(() => readDraft(key))
    const [lastSaved, setLastSaved] = useState<number | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const onSavedRef = useRef(onSaved)
    onSavedRef.current = onSaved

    // Debounced auto-save effect
    useEffect(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current)
            timerRef.current = null
        }

        if (!content) return

        timerRef.current = setTimeout(() => {
            const ts = writeDraft(key, content)
            setLastSaved(ts)
            setDraft({ content, timestamp: ts })
            onSavedRef.current?.()
        }, debounceMs)

        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current)
                timerRef.current = null
            }
        }
    }, [key, content, debounceMs])

    const restoreDraft = useCallback((): string => {
        const d = readDraft(key)
        return d?.content ?? ''
    }, [key])

    const discardDraft = useCallback(() => {
        removeDraft(key)
        setDraft(null)
    }, [key])

    const clearDraft = useCallback(() => {
        removeDraft(key)
        setDraft(null)
    }, [key])

    return {
        hasDraft: draft !== null,
        draftContent: draft?.content ?? null,
        draftTimestamp: draft?.timestamp ?? null,
        restoreDraft,
        discardDraft,
        clearDraft,
        lastSaved,
    }
}
