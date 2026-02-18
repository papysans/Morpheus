import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '../useProjectStore'
import { api } from '../../lib/api'

vi.mock('../../lib/api', () => ({
    api: {
        get: vi.fn(),
        post: vi.fn(),
        delete: vi.fn(),
    },
}))

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

const mockedGet = vi.mocked(api.get)
const mockedPost = vi.mocked(api.post)
const mockedDelete = vi.mocked(api.delete)

function resetStore() {
    useProjectStore.setState({
        projects: [],
        currentProject: null,
        chapters: [],
        loading: false,
        _projectsLastFetch: null,
        _projectLastFetch: {},
        _chaptersLastFetch: {},
        _chaptersProjectId: null,
    })
}

describe('useProjectStore request ordering', () => {
    beforeEach(() => {
        mockedGet.mockReset()
        mockedPost.mockReset()
        mockedDelete.mockReset()
        resetStore()
    })

    it('ignores stale fetchProject response that resolves after a newer request', async () => {
        const a = deferred<any>()
        const b = deferred<any>()

        mockedGet.mockImplementation((url: string) => {
            if (url === '/projects/a') return a.promise
            if (url === '/projects/b') return b.promise
            throw new Error(`unexpected url: ${url}`)
        })

        const pa = useProjectStore.getState().fetchProject('a')
        const pb = useProjectStore.getState().fetchProject('b')

        b.resolve({
            data: {
                id: 'b',
                name: 'Project B',
                genre: '科幻',
                style: '冷峻现实主义',
                status: 'active',
                target_length: 300000,
                chapter_count: 0,
                entity_count: 0,
                event_count: 0,
            },
        })
        await pb
        expect(useProjectStore.getState().currentProject?.id).toBe('b')

        a.resolve({
            data: {
                id: 'a',
                name: 'Project A',
                genre: '奇幻',
                style: '冷峻现实主义',
                status: 'active',
                target_length: 300000,
                chapter_count: 0,
                entity_count: 0,
                event_count: 0,
            },
        })
        await pa
        expect(useProjectStore.getState().currentProject?.id).toBe('b')
    })

    it('ignores stale fetchChapters response that resolves after a newer request', async () => {
        const a = deferred<any>()
        const b = deferred<any>()

        mockedGet.mockImplementation((url: string) => {
            if (url === '/projects/a/chapters') return a.promise
            if (url === '/projects/b/chapters') return b.promise
            throw new Error(`unexpected url: ${url}`)
        })

        const pa = useProjectStore.getState().fetchChapters('a')
        const pb = useProjectStore.getState().fetchChapters('b')

        b.resolve({
            data: [
                {
                    id: 'b-1',
                    chapter_number: 1,
                    title: 'B1',
                    goal: 'goal',
                    status: 'draft',
                    word_count: 100,
                    conflict_count: 0,
                },
            ],
        })
        await pb
        expect(useProjectStore.getState()._chaptersProjectId).toBe('b')
        expect(useProjectStore.getState().chapters[0]?.id).toBe('b-1')

        a.resolve({
            data: [
                {
                    id: 'a-1',
                    chapter_number: 1,
                    title: 'A1',
                    goal: 'goal',
                    status: 'draft',
                    word_count: 100,
                    conflict_count: 0,
                },
            ],
        })
        await pa
        expect(useProjectStore.getState()._chaptersProjectId).toBe('b')
        expect(useProjectStore.getState().chapters[0]?.id).toBe('b-1')
    })

    it('does not skip fetchProject when timestamp cache exists but current project is another id', async () => {
        useProjectStore.setState({
            currentProject: {
                id: 'a',
                name: 'Project A',
                genre: '奇幻',
                style: '冷峻现实主义',
                status: 'active',
                chapter_count: 1,
                entity_count: 1,
                event_count: 1,
                target_length: 300000,
            },
            _projectLastFetch: {
                a: Date.now(),
                b: Date.now(),
            },
        })

        mockedGet.mockResolvedValue({
            data: {
                id: 'b',
                name: 'Project B',
                genre: '科幻',
                style: '冷峻现实主义',
                status: 'active',
                chapter_count: 2,
                entity_count: 2,
                event_count: 2,
                target_length: 320000,
            },
        })

        await useProjectStore.getState().fetchProject('b')
        expect(mockedGet).toHaveBeenCalledTimes(1)
        expect(useProjectStore.getState().currentProject?.id).toBe('b')
    })

    it('keeps optimistic project after create succeeds but refresh request times out', async () => {
        mockedPost.mockResolvedValue({
            data: {
                id: 'new-project',
                status: 'init',
                created_at: '2026-02-17T00:00:00Z',
            },
        } as any)
        mockedGet.mockRejectedValue({
            code: 'ECONNABORTED',
            message: 'timeout exceeded',
        } as any)

        const createdId = await useProjectStore.getState().createProject({
            name: '新项目',
            genre: '测试题材',
            style: '测试文风',
            target_length: 300000,
            taboo_constraints: '',
        })

        expect(createdId).toBe('new-project')
        expect(useProjectStore.getState().projects.some((p) => p.id === 'new-project')).toBe(true)
    })

    it('keeps local delete result when delete succeeds but refresh request times out', async () => {
        useProjectStore.setState({
            projects: [
                {
                    id: 'p1',
                    name: '待删除',
                    genre: '奇幻',
                    style: '冷峻',
                    status: 'init',
                    chapter_count: 0,
                    entity_count: 0,
                    event_count: 0,
                },
                {
                    id: 'p2',
                    name: '保留项',
                    genre: '科幻',
                    style: '冷峻',
                    status: 'init',
                    chapter_count: 0,
                    entity_count: 0,
                    event_count: 0,
                },
            ],
            currentProject: {
                id: 'p1',
                name: '待删除',
                genre: '奇幻',
                style: '冷峻',
                status: 'init',
                chapter_count: 0,
                entity_count: 0,
                event_count: 0,
                target_length: 300000,
            },
            chapters: [
                {
                    id: 'c1',
                    chapter_number: 1,
                    title: '第一章',
                    goal: '目标',
                    status: 'draft',
                    word_count: 0,
                    conflict_count: 0,
                },
            ],
            _chaptersProjectId: 'p1',
        } as any)

        mockedDelete.mockResolvedValue({ data: { status: 'deleted' } } as any)
        mockedGet.mockRejectedValue({
            code: 'ECONNABORTED',
            message: 'timeout exceeded',
        } as any)

        await useProjectStore.getState().deleteProject('p1')

        expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(['p2'])
        expect(useProjectStore.getState().currentProject).toBeNull()
        expect(useProjectStore.getState().chapters).toEqual([])
    })

    it('batch deletes projects via DELETE /projects endpoint', async () => {
        useProjectStore.setState({
            projects: [
                {
                    id: 'p1',
                    name: 'A',
                    genre: '奇幻',
                    style: '冷峻',
                    status: 'init',
                    chapter_count: 0,
                    entity_count: 0,
                    event_count: 0,
                },
                {
                    id: 'p2',
                    name: 'B',
                    genre: '科幻',
                    style: '冷峻',
                    status: 'init',
                    chapter_count: 0,
                    entity_count: 0,
                    event_count: 0,
                },
            ],
        } as any)
        mockedDelete.mockResolvedValueOnce({
            data: {
                requested_count: 2,
                deleted_count: 2,
                missing_count: 0,
                failed_count: 0,
                deleted: [{ project_id: 'p1' }, { project_id: 'p2' }],
                missing: [],
                failed: [],
            },
        } as any)
        mockedGet.mockResolvedValue({ data: [] } as any)

        const result = await useProjectStore.getState().deleteProjects(['p1', 'p2'])

        expect(mockedDelete).toHaveBeenCalledWith('/projects', {
            data: { project_ids: ['p1', 'p2'] },
        })
        expect(result.deleted_ids).toEqual(['p1', 'p2'])
        expect(useProjectStore.getState().projects).toEqual([])
    })

    it('falls back to POST /projects/batch-delete when DELETE is not allowed', async () => {
        useProjectStore.setState({
            projects: [
                {
                    id: 'p1',
                    name: 'A',
                    genre: '奇幻',
                    style: '冷峻',
                    status: 'init',
                    chapter_count: 0,
                    entity_count: 0,
                    event_count: 0,
                },
            ],
        } as any)
        mockedDelete.mockRejectedValueOnce({ response: { status: 405 } } as any)
        mockedPost.mockResolvedValueOnce({
            data: {
                requested_count: 1,
                deleted_count: 1,
                missing_count: 0,
                failed_count: 0,
                deleted: [{ project_id: 'p1' }],
                missing: [],
                failed: [],
            },
        } as any)
        mockedGet.mockResolvedValue({ data: [] } as any)

        const result = await useProjectStore.getState().deleteProjects(['p1'])

        expect(mockedPost).toHaveBeenCalledWith('/projects/batch-delete', {
            project_ids: ['p1'],
        })
        expect(result.deleted_count).toBe(1)
        expect(useProjectStore.getState().projects).toEqual([])
    })

    it('falls back to sequential deletion when batch endpoints are unavailable', async () => {
        useProjectStore.setState({
            projects: [
                {
                    id: 'p1',
                    name: 'A',
                    genre: '奇幻',
                    style: '冷峻',
                    status: 'init',
                    chapter_count: 0,
                    entity_count: 0,
                    event_count: 0,
                },
                {
                    id: 'p2',
                    name: 'B',
                    genre: '科幻',
                    style: '冷峻',
                    status: 'init',
                    chapter_count: 0,
                    entity_count: 0,
                    event_count: 0,
                },
            ],
        } as any)
        mockedDelete.mockRejectedValueOnce({ response: { status: 405 } } as any)
        mockedPost.mockRejectedValueOnce({ response: { status: 405 } } as any)
        mockedDelete.mockResolvedValueOnce({ data: { status: 'deleted' } } as any)
        mockedDelete.mockResolvedValueOnce({ data: { status: 'deleted' } } as any)
        mockedGet.mockResolvedValue({ data: [] } as any)

        const result = await useProjectStore.getState().deleteProjects(['p1', 'p2'])

        expect(result.deleted_count).toBe(2)
        expect(result.failed_count).toBe(0)
        expect(useProjectStore.getState().projects).toEqual([])
    })
})
