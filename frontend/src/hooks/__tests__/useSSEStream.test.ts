import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSSEStream } from '../useSSEStream'
import { useStreamStore } from '../../stores/useStreamStore'

/* ── helpers ── */

/** Build a fake ReadableStream from SSE frame strings. */
function makeSseResponse(frames: string[], ok = true): Response {
    const encoder = new TextEncoder()
    let idx = 0
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (idx < frames.length) {
                controller.enqueue(encoder.encode(frames[idx]))
                idx++
            } else {
                controller.close()
            }
        },
    })
    return {
        ok,
        status: ok ? 200 : 500,
        body: stream,
        text: async () => 'error body',
    } as unknown as Response
}

function sseFrame(event: string, data: object | string): string {
    const d = typeof data === 'string' ? data : JSON.stringify(data)
    return `event: ${event}\ndata: ${d}\n\n`
}

beforeEach(() => {
    useStreamStore.setState({
        generating: false,
        sections: [],
        chapters: [],
        logs: [],
        error: null,
    })
    vi.restoreAllMocks()
})

describe('useSSEStream', () => {
    it('returns generating=false initially', () => {
        const { result } = renderHook(() => useSSEStream())
        expect(result.current.generating).toBe(false)
        expect(typeof result.current.start).toBe('function')
        expect(typeof result.current.stop).toBe('function')
    })

    it('processes chapter_start, chunk, chapter_done events and calls callbacks', async () => {
        const onChapterStart = vi.fn()
        const onChapterDone = vi.fn()
        const onComplete = vi.fn()

        const frames = [
            sseFrame('chapter_start', { chapter_id: 'ch-1', chapter_number: 1, title: '序章' }),
            sseFrame('chapter_chunk', { chapter_id: 'ch-1', chapter_number: 1, chunk: '从前有座山' }),
            sseFrame('chapter_done', {
                id: 'ch-1', chapter_number: 1, title: '序章',
                status: 'done', word_count: 100, p0_count: 0,
            }),
            sseFrame('done', { generated_chapters: 1, elapsed_s: 2.5 }),
        ]

        const fakeResponse = makeSseResponse(frames)
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fakeResponse)

        const { result } = renderHook(() => useSSEStream())

        await act(async () => {
            await result.current.start({
                projectId: 'proj-1',
                form: {
                    prompt: '写一本小说',
                    mode: 'studio',
                    scope: 'volume',
                    chapter_count: 1,
                    words_per_chapter: 1600,
                    auto_approve: true,
                },
                onChapterStart,
                onChapterDone,
                onComplete,
            })
        })

        // After stream completes, generating should be false
        expect(result.current.generating).toBe(false)

        // Callbacks should have been called
        expect(onChapterStart).toHaveBeenCalledTimes(1)
        expect(onChapterStart).toHaveBeenCalledWith(
            expect.objectContaining({ chapter_number: 1, title: '序章' }),
        )
        expect(onChapterDone).toHaveBeenCalledTimes(1)
        expect(onChapterDone).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'ch-1', word_count: 100 }),
        )
        expect(onComplete).toHaveBeenCalledTimes(1)

        // Store should have the chapter
        const store = useStreamStore.getState()
        expect(store.chapters).toHaveLength(1)
        expect(store.chapters[0].id).toBe('ch-1')
        expect(store.error).toBeNull()
    })

    it('handles error events and calls onError callback', async () => {
        const onError = vi.fn()

        const frames = [
            sseFrame('error', { detail: '模型超时' }),
        ]

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeSseResponse(frames))

        const { result } = renderHook(() => useSSEStream())

        await act(async () => {
            await result.current.start({
                projectId: 'proj-1',
                form: {
                    prompt: '写一本小说',
                    mode: 'studio',
                    scope: 'volume',
                    chapter_count: 1,
                    words_per_chapter: 1600,
                    auto_approve: true,
                },
                onError,
            })
        })

        expect(onError).toHaveBeenCalledWith('模型超时')
        expect(useStreamStore.getState().error).toBe('模型超时')
    })

    it('applies chapter_replace as final body after streamed chunks', async () => {
        const frames = [
            sseFrame('chapter_start', { chapter_id: 'ch-2', chapter_number: 2, title: '第二章' }),
            sseFrame('chapter_chunk', { chapter_id: 'ch-2', chapter_number: 2, chunk: '半截初稿' }),
            sseFrame('chapter_replace', { chapter_id: 'ch-2', chapter_number: 2, title: '第二章', body: '这是完整终稿' }),
            sseFrame('chapter_done', {
                id: 'ch-2', chapter_number: 2, title: '第二章',
                status: 'done', word_count: 222, p0_count: 0,
            }),
            sseFrame('done', { generated_chapters: 1, elapsed_s: 1.2 }),
        ]

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeSseResponse(frames))

        const { result } = renderHook(() => useSSEStream())

        await act(async () => {
            await result.current.start({
                projectId: 'proj-2',
                form: {
                    prompt: '写一本小说',
                    mode: 'studio',
                    scope: 'volume',
                    chapter_count: 1,
                    words_per_chapter: 1600,
                    auto_approve: true,
                },
            })
        })

        const section = useStreamStore.getState().sections.find((s) => s.chapterId === 'ch-2')
        expect(section?.body).toBe('这是完整终稿')
        expect(section?.waiting).toBe(false)
    })

    it('handles HTTP error responses', async () => {
        const onError = vi.fn()

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            makeSseResponse([], false),
        )

        const { result } = renderHook(() => useSSEStream())

        await act(async () => {
            await result.current.start({
                projectId: 'proj-1',
                form: {
                    prompt: '写一本小说',
                    mode: 'studio',
                    scope: 'volume',
                    chapter_count: 1,
                    words_per_chapter: 1600,
                    auto_approve: true,
                },
                onError,
            })
        })

        expect(useStreamStore.getState().error).toBeTruthy()
        expect(result.current.generating).toBe(false)
    })

    it('stop() aborts the stream and resets generating', async () => {
        // Create a stream that waits for abort
        const stream = new ReadableStream<Uint8Array>({
            start() { /* never pushes data */ },
            cancel() { /* cancelled on abort */ },
        })
        const fakeResponse = { ok: true, status: 200, body: stream } as unknown as Response

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(fakeResponse)

        const { result } = renderHook(() => useSSEStream())

        let startPromise: Promise<void>
        act(() => {
            startPromise = result.current.start({
                projectId: 'proj-1',
                form: {
                    prompt: '写一本小说',
                    mode: 'studio',
                    scope: 'volume',
                    chapter_count: 1,
                    words_per_chapter: 1600,
                    auto_approve: true,
                },
            })
        })

        // Stop the stream
        act(() => {
            result.current.stop()
        })

        await act(async () => {
            await startPromise!
        })

        // After stop, generating should be false and no SSE error should be set
        expect(result.current.generating).toBe(false)
        expect(useStreamStore.getState().error).toBeNull()
    })
})
