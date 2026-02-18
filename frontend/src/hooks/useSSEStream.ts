import { useCallback, useRef } from 'react'
import { useStreamStore, type StreamChapter, type StreamSection, type GenerationForm } from '../stores/useStreamStore'

export interface UseSSEStreamOptions {
    projectId: string
    form: GenerationForm
    onChapterStart?: (chapter: StreamChapter) => void
    onChapterDone?: (chapter: StreamChapter) => void
    onError?: (error: string) => void
    onComplete?: () => void
}

/* ── helpers ─────────────────────────────────────────── */

function upsertSection(
    sections: StreamSection[],
    chapterId: string,
    chapterNumber: number,
    title: string,
    patch: Partial<StreamSection>,
): StreamSection[] {
    const idx = sections.findIndex((s) => s.chapterId === chapterId)
    if (idx < 0) {
        return [
            ...sections,
            { chapterId, chapterNumber, title, body: patch.body ?? '', waiting: patch.waiting ?? true },
        ]
    }
    const next = [...sections]
    next[idx] = { ...next[idx], chapterNumber, title, ...patch }
    return next
}

/**
 * Parse an SSE byte-stream into discrete events.
 * Uses ReadableStream (fetch POST — EventSource only supports GET).
 */
async function consumeSse(
    response: Response,
    onEvent: (eventName: string, payload: unknown) => void,
    signal: AbortSignal,
) {
    if (!response.body) return
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
        if (signal.aborted) {
            await reader.cancel()
            break
        }
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''

        for (const frame of frames) {
            const lines = frame.split('\n').map((l) => l.trim()).filter(Boolean)
            if (lines.length === 0) continue
            let eventName = 'message'
            const dataLines: string[] = []
            for (const line of lines) {
                if (line.startsWith('event:')) eventName = line.slice(6).trim()
                else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            }
            const raw = dataLines.join('\n')
            if (!raw) continue
            let payload: unknown = raw
            try { payload = JSON.parse(raw) } catch { payload = { raw } }
            onEvent(eventName, payload)
        }
    }
}

/* ── chunk buffering (batches rapid SSE chunks into fewer React renders) ── */

interface ChunkBuffer {
    chapterId: string
    chapterNumber: number
    title?: string
    chunks: string[]
}

/* ── hook ─────────────────────────────────────────────── */

export function useSSEStream() {
    const {
        generating,
        setGenerating,
        setSections,
        setChapters,
        appendLog,
        setError,
    } = useStreamStore()

    const abortRef = useRef<AbortController | null>(null)
    const chunkBuffers = useRef<Record<string, ChunkBuffer>>({})
    const flushTimer = useRef<number | null>(null)

    /* ── buffer helpers ── */

    const clearBuffers = () => {
        chunkBuffers.current = {}
        if (flushTimer.current !== null) {
            window.clearTimeout(flushTimer.current)
            flushTimer.current = null
        }
    }

    const flushBuffers = () => {
        if (flushTimer.current !== null) {
            window.clearTimeout(flushTimer.current)
            flushTimer.current = null
        }
        const pending = chunkBuffers.current
        const ids = Object.keys(pending)
        if (ids.length === 0) return

        setSections((prev) => {
            let next = prev
            for (const id of ids) {
                const buf = pending[id]
                if (!buf || buf.chunks.length === 0) continue
                const delta = buf.chunks.join('')
                buf.chunks = []
                const existing = next.find((s) => s.chapterId === id)
                const title = existing?.title || buf.title || `章节${buf.chapterNumber}`
                next = upsertSection(next, id, buf.chapterNumber, title, {
                    body: `${existing?.body || ''}${delta}`,
                    waiting: false,
                })
            }
            return next
        })
    }

    const scheduleFlush = () => {
        if (flushTimer.current !== null) return
        flushTimer.current = window.setTimeout(() => {
            flushTimer.current = null
            flushBuffers()
        }, 25)
    }

    /* ── SSE event dispatcher ── */

    const handleEvent = (
        eventName: string,
        payload: any,
        opts: UseSSEStreamOptions,
    ) => {
        if (eventName === 'heartbeat') return

        if (eventName === 'chapter_start') {
            const chapterId = String(payload.chapter_id || `chapter-${payload.chapter_number}`)
            const chapterNumber = Number(payload.chapter_number) || 0
            const title = String(payload.title || `章节${chapterNumber}`)
            appendLog(`开始第 ${chapterNumber} 章：${title}`)
            chunkBuffers.current[chapterId] = { chapterId, chapterNumber, title, chunks: [] }
            setSections((prev) => upsertSection(prev, chapterId, chapterNumber, title, { waiting: true }))
            opts.onChapterStart?.({
                id: chapterId,
                chapter_number: chapterNumber,
                title,
                status: 'generating',
                word_count: 0,
                p0_count: 0,
            })
            return
        }

        if (eventName === 'chunk' || eventName === 'chapter_chunk') {
            const chapterNumber = Number(payload.chapter_number) || 0
            const chapterId = String(payload.chapter_id || `chapter-${chapterNumber}`)
            const chunk = String(payload.chunk || '')
            const buf = chunkBuffers.current[chapterId] || {
                chapterId,
                chapterNumber,
                title: `章节${chapterNumber}`,
                chunks: [],
            }
            buf.chapterNumber = chapterNumber
            if (typeof payload.title === 'string' && payload.title.trim()) buf.title = payload.title
            buf.chunks.push(chunk)
            chunkBuffers.current[chapterId] = buf
            scheduleFlush()
            return
        }

        if (eventName === 'chapter_replace') {
            flushBuffers()
            const chapterNumber = Number(payload.chapter_number) || 0
            const chapterId = String(payload.chapter_id || `chapter-${chapterNumber}`)
            const title = String(payload.title || `章节${chapterNumber}`)
            const body = String(payload.body || '')
            setSections((prev) => upsertSection(prev, chapterId, chapterNumber, title, { body, waiting: false }))
            appendLog(`第 ${chapterNumber} 章内容已用最终稿回填`)
            return
        }

        if (eventName === 'chapter_done') {
            flushBuffers()
            const ch: StreamChapter = {
                id: payload.id,
                chapter_number: payload.chapter_number,
                title: payload.title,
                status: payload.status,
                word_count: payload.word_count,
                p0_count: payload.p0_count,
            }
            appendLog(`第 ${ch.chapter_number} 章完成（${ch.word_count} 字，P0=${ch.p0_count}）`)
            setChapters((prev) => [...prev, ch])
            setSections((prev) =>
                upsertSection(
                    prev,
                    String(ch.id || `chapter-${ch.chapter_number}`),
                    ch.chapter_number,
                    ch.title,
                    { waiting: false },
                ),
            )
            opts.onChapterDone?.(ch)
            return
        }

        if (eventName === 'log') {
            appendLog(String(payload.message || payload.raw || ''))
            return
        }

        if (eventName === 'error') {
            flushBuffers()
            const detail = String(payload.detail || '未知错误')
            setError(detail)
            appendLog(`生成失败：${detail}`)
            opts.onError?.(detail)
            return
        }

        if (eventName === 'done') {
            flushBuffers()
            appendLog(
                `整本生成结束：共 ${payload.generated_chapters} 章，用时 ${Number(payload.elapsed_s || 0).toFixed(2)}s`,
            )
            opts.onComplete?.()
            return
        }

        // Forward other events as logs
        appendLog(`事件 ${eventName}`)
    }

    /* ── public API ── */

    const start = useCallback(async (opts: UseSSEStreamOptions) => {
        if (generating) return

        // Reset state
        setGenerating(true)
        setError(null)
        setSections([])
        setChapters(() => [])
        clearBuffers()
        appendLog('开始流式生成')

        const controller = new AbortController()
        abortRef.current = controller

        try {
            const res = await fetch(`/api/projects/${opts.projectId}/one-shot-book/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...opts.form,
                    prompt: opts.form.prompt.trim(),
                }),
                signal: controller.signal,
            })

            if (!res.ok) {
                const text = await res.text()
                throw new Error(text || `HTTP ${res.status}`)
            }

            await consumeSse(
                res,
                (eventName, payload) => handleEvent(eventName, payload, opts),
                controller.signal,
            )
        } catch (err: any) {
            flushBuffers()
            if (controller.signal.aborted) {
                appendLog('任务已手动终止')
            } else {
                const detail = err?.message || '流式任务异常'
                setError(detail)
                appendLog(`生成中断：${detail}`)
                opts.onError?.(detail)
            }
        } finally {
            flushBuffers()
            clearBuffers()
            setGenerating(false)
            abortRef.current = null
        }
    }, [generating, setGenerating, setError, setSections, setChapters, appendLog])

    const stop = useCallback(() => {
        abortRef.current?.abort()
    }, [])

    return { start, stop, generating }
}
