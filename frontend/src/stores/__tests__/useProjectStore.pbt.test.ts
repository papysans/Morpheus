import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fc from 'fast-check'
import { useProjectStore, CACHE_TTL } from '../useProjectStore'

vi.mock('../../lib/api', () => ({
    api: {
        get: vi.fn().mockResolvedValue({ data: [] }),
        post: vi.fn().mockResolvedValue({ data: {} }),
        delete: vi.fn().mockResolvedValue({ data: {} }),
    },
}))

import { api } from '../../lib/api'

const mockedGet = vi.mocked(api.get)

function resetStore() {
    useProjectStore.setState({
        projects: [],
        currentProject: null,
        chapters: [],
        loading: false,
        _projectsLastFetch: null,
        _projectLastFetch: {},
        _chaptersLastFetch: {},
    })
}

describe('useProjectStore cache property-based tests', () => {
    beforeEach(() => {
        vi.useFakeTimers({ now: 1000000 })
        resetStore()
        mockedGet.mockReset()
        mockedGet.mockResolvedValue({ data: [] })
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    // Feature: frontend-ux-polish, Property 13: 请求缓存 TTL 机制
    // Validates: Requirements 13.1, 13.3
    it('Property 13: within CACHE_TTL repeated non-force fetches do not trigger API calls; after TTL they do', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.uuid(),
                async (projectId) => {
                    resetStore()
                    mockedGet.mockReset()
                    mockedGet.mockResolvedValue({ data: [] })

                    // --- fetchProjects ---
                    await useProjectStore.getState().fetchProjects()
                    expect(mockedGet).toHaveBeenCalledTimes(1)

                    // Within TTL: no additional call
                    await useProjectStore.getState().fetchProjects()
                    expect(mockedGet).toHaveBeenCalledTimes(1)

                    // After TTL: triggers new call
                    vi.advanceTimersByTime(CACHE_TTL + 1)
                    await useProjectStore.getState().fetchProjects()
                    expect(mockedGet).toHaveBeenCalledTimes(2)

                    // --- fetchProject ---
                    mockedGet.mockReset()
                    mockedGet.mockResolvedValue({ data: { id: projectId } })

                    await useProjectStore.getState().fetchProject(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(1)

                    await useProjectStore.getState().fetchProject(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(1)

                    vi.advanceTimersByTime(CACHE_TTL + 1)
                    await useProjectStore.getState().fetchProject(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(2)

                    // --- fetchChapters ---
                    mockedGet.mockReset()
                    mockedGet.mockResolvedValue({ data: [] })

                    await useProjectStore.getState().fetchChapters(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(1)

                    await useProjectStore.getState().fetchChapters(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(1)

                    vi.advanceTimersByTime(CACHE_TTL + 1)
                    await useProjectStore.getState().fetchChapters(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(2)
                },
            ),
            { numRuns: 100 },
        )
    })

    // Feature: frontend-ux-polish, Property 14: 缓存失效机制
    // Validates: Requirements 13.4
    it('Property 14: after invalidateCache, next fetch triggers API call even within TTL', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.uuid(),
                async (projectId) => {
                    resetStore()
                    mockedGet.mockReset()
                    mockedGet.mockResolvedValue({ data: [] })

                    // --- scope: projects ---
                    await useProjectStore.getState().fetchProjects()
                    expect(mockedGet).toHaveBeenCalledTimes(1)

                    useProjectStore.getState().invalidateCache('projects')
                    await useProjectStore.getState().fetchProjects()
                    expect(mockedGet).toHaveBeenCalledTimes(2)

                    // --- scope: project ---
                    mockedGet.mockReset()
                    mockedGet.mockResolvedValue({ data: { id: projectId } })

                    await useProjectStore.getState().fetchProject(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(1)

                    useProjectStore.getState().invalidateCache('project', projectId)
                    await useProjectStore.getState().fetchProject(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(2)

                    // --- scope: chapters ---
                    mockedGet.mockReset()
                    mockedGet.mockResolvedValue({ data: [] })

                    await useProjectStore.getState().fetchChapters(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(1)

                    useProjectStore.getState().invalidateCache('chapters', projectId)
                    await useProjectStore.getState().fetchChapters(projectId)
                    expect(mockedGet).toHaveBeenCalledTimes(2)
                },
            ),
            { numRuns: 100 },
        )
    })
})
