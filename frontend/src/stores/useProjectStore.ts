import { create } from 'zustand'
import { api } from '../lib/api'

export const CACHE_TTL = 30_000

export interface ProjectItem {
    id: string
    name: string
    genre: string
    style: string
    template_id?: string
    status: string
    chapter_count: number
    entity_count: number
    event_count: number
    created_at?: string
}

export interface ProjectDetail extends ProjectItem {
    target_length: number
}

export interface ProjectCreateForm {
    name: string
    genre: string
    style: string
    template_id?: string
    target_length: number
    taboo_constraints: string
}

export interface ChapterItem {
    id: string
    chapter_number: number
    title: string
    goal: string
    status: string
    word_count: number
    conflict_count: number
}

interface FetchOptions {
    force?: boolean
}

export interface BatchDeleteProjectsResult {
    requested_count: number
    deleted_count: number
    missing_count: number
    failed_count: number
    deleted_ids: string[]
    missing_ids: string[]
    failed_ids: string[]
}

interface ProjectStore {
    projects: ProjectItem[]
    currentProject: ProjectDetail | null
    chapters: ChapterItem[]
    loading: boolean
    projectsError: string | null
    projectError: string | null
    chaptersError: string | null
    _projectsLastFetch: number | null
    _projectLastFetch: Record<string, number>
    _chaptersLastFetch: Record<string, number>
    _chaptersProjectId: string | null

    fetchProjects: (options?: FetchOptions) => Promise<void>
    fetchProject: (id: string, options?: FetchOptions) => Promise<void>
    fetchChapters: (projectId: string, options?: FetchOptions) => Promise<void>
    createProject: (form: ProjectCreateForm) => Promise<string>
    deleteProject: (id: string) => Promise<void>
    deleteProjects: (ids: string[]) => Promise<BatchDeleteProjectsResult>
    invalidateCache: (scope: 'projects' | 'project' | 'chapters', id?: string) => void
}

function isCacheValid(timestamp: number | null | undefined): boolean {
    if (timestamp == null) return false
    return Date.now() - timestamp < CACHE_TTL
}

function normalizeRequestError(error: unknown, fallback: string): string {
    const e = error as any
    if (e?.code === 'ECONNABORTED' || /timeout/i.test(String(e?.message || ''))) {
        return '请求超时：后端可能正在生成中，请稍后重试'
    }
    const detail = e?.response?.data?.detail
    if (typeof detail === 'string' && detail.trim()) {
        return detail.trim()
    }
    return fallback
}

function normalizeProjectIds(ids: string[]): string[] {
    return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))]
}

export const useProjectStore = create<ProjectStore>((set, get) => {
    let pendingRequests = 0
    let latestProjectRequestToken = 0
    let latestProjectRequestId: string | null = null
    let latestChaptersRequestToken = 0
    let latestChaptersProjectId: string | null = null

    function beginLoading() {
        pendingRequests += 1
        if (pendingRequests === 1) {
            set({ loading: true })
        }
    }

    function endLoading() {
        pendingRequests = Math.max(0, pendingRequests - 1)
        if (pendingRequests === 0) {
            set({ loading: false })
        }
    }

    function applyDeletedProjectIds(ids: string[]) {
        const uniqueIds = normalizeProjectIds(ids)
        if (uniqueIds.length === 0) return
        const idSet = new Set(uniqueIds)
        const state = get()

        const nextProjectLastFetch = { ...state._projectLastFetch }
        const nextChapterLastFetch = { ...state._chaptersLastFetch }
        for (const id of uniqueIds) {
            delete nextProjectLastFetch[id]
            delete nextChapterLastFetch[id]
        }

        const removedCurrentProject = state.currentProject ? idSet.has(state.currentProject.id) : false
        const removedChaptersProject = state._chaptersProjectId ? idSet.has(state._chaptersProjectId) : false
        set({
            projects: state.projects.filter((project) => !idSet.has(project.id)),
            currentProject: removedCurrentProject ? null : state.currentProject,
            chapters: removedChaptersProject ? [] : state.chapters,
            _chaptersProjectId: removedChaptersProject ? null : state._chaptersProjectId,
            _projectLastFetch: nextProjectLastFetch,
            _chaptersLastFetch: nextChapterLastFetch,
            _projectsLastFetch: Date.now(),
            projectsError: null,
        })
    }

    async function deleteProjectRequest(id: string): Promise<'deleted' | 'missing'> {
        try {
            await api.delete(`/projects/${id}`)
            return 'deleted'
        } catch (error: any) {
            if (error?.response?.status === 404) {
                return 'missing'
            }
            if (error?.response?.status === 405) {
                try {
                    await api.post(`/projects/${id}/delete`)
                    return 'deleted'
                } catch (compatError: any) {
                    if (compatError?.response?.status === 404) {
                        return 'missing'
                    }
                    throw compatError
                }
            }
            throw error
        }
    }

    return {
        projects: [],
        currentProject: null,
        chapters: [],
        loading: false,
        projectsError: null,
        projectError: null,
        chaptersError: null,
        _projectsLastFetch: null,
        _projectLastFetch: {},
        _chaptersLastFetch: {},
        _chaptersProjectId: null,

        fetchProjects: async (options?: FetchOptions) => {
            if (!options?.force && isCacheValid(get()._projectsLastFetch)) {
                return
            }
            beginLoading()
            set({ projectsError: null })
            try {
                const response = await api.get('/projects')
                set({
                    projects: response.data ?? [],
                    _projectsLastFetch: Date.now(),
                    projectsError: null,
                })
            } catch (error) {
                console.error('获取项目列表失败', error)
                set({
                    projectsError: normalizeRequestError(error, '加载项目列表失败，请稍后重试'),
                })
            } finally {
                endLoading()
            }
        },

        fetchProject: async (id: string, options?: FetchOptions) => {
            if (
                !options?.force &&
                isCacheValid(get()._projectLastFetch[id]) &&
                get().currentProject?.id === id
            ) {
                return
            }
            const requestToken = ++latestProjectRequestToken
            latestProjectRequestId = id
            beginLoading()
            set({ projectError: null })
            try {
                const response = await api.get(`/projects/${id}`)
                const shouldApply =
                    requestToken === latestProjectRequestToken &&
                    latestProjectRequestId === id
                set({
                    currentProject: shouldApply ? response.data : get().currentProject,
                    _projectLastFetch: { ...get()._projectLastFetch, [id]: Date.now() },
                    projectError: shouldApply ? null : get().projectError,
                })
            } catch (error) {
                console.error('获取项目详情失败', error)
                const shouldApply =
                    requestToken === latestProjectRequestToken &&
                    latestProjectRequestId === id
                if (shouldApply) {
                    set({
                        currentProject: null,
                        projectError: normalizeRequestError(error, '加载项目概览失败，请稍后重试'),
                    })
                }
            } finally {
                endLoading()
            }
        },

        fetchChapters: async (projectId: string, options?: FetchOptions) => {
            if (
                !options?.force &&
                isCacheValid(get()._chaptersLastFetch[projectId]) &&
                get()._chaptersProjectId === projectId
            ) {
                return
            }
            const requestToken = ++latestChaptersRequestToken
            latestChaptersProjectId = projectId
            beginLoading()
            set({ chaptersError: null })
            try {
                const response = await api.get(`/projects/${projectId}/chapters`)
                const shouldApply =
                    requestToken === latestChaptersRequestToken &&
                    latestChaptersProjectId === projectId
                set({
                    chapters: shouldApply ? response.data ?? [] : get().chapters,
                    _chaptersLastFetch: { ...get()._chaptersLastFetch, [projectId]: Date.now() },
                    _chaptersProjectId: shouldApply ? projectId : get()._chaptersProjectId,
                    chaptersError: shouldApply ? null : get().chaptersError,
                })
            } catch (error) {
                console.error('获取章节列表失败', error)
                const shouldApply =
                    requestToken === latestChaptersRequestToken &&
                    latestChaptersProjectId === projectId
                if (shouldApply) {
                    set({
                        chapters: [],
                        _chaptersProjectId: projectId,
                        chaptersError: normalizeRequestError(error, '加载章节列表失败，请稍后重试'),
                    })
                }
            } finally {
                endLoading()
            }
        },

        createProject: async (form: ProjectCreateForm) => {
            beginLoading()
            try {
                const response = await api.post('/projects', {
                    ...form,
                    template_id: form.template_id || undefined,
                    taboo_constraints: form.taboo_constraints
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                })
                const payload = response.data ?? {}
                const newId = String(payload.id ?? '')
                if (newId) {
                    const optimisticProject: ProjectItem = {
                        id: newId,
                        name: form.name.trim(),
                        genre: form.genre.trim(),
                        style: form.style.trim(),
                        template_id: form.template_id?.trim() || undefined,
                        status: String(payload.status ?? 'init'),
                        chapter_count: 0,
                        entity_count: 0,
                        event_count: 0,
                        created_at:
                            typeof payload.created_at === 'string'
                                ? payload.created_at
                                : new Date().toISOString(),
                    }
                    set((state) => ({
                        projects: [
                            optimisticProject,
                            ...state.projects.filter((item) => item.id !== newId),
                        ],
                        _projectsLastFetch: Date.now(),
                        projectsError: null,
                    }))
                }
                void get().fetchProjects({ force: true })
                return newId
            } catch (error) {
                console.error('创建项目失败', error)
                throw error
            } finally {
                endLoading()
            }
        },

        deleteProject: async (id: string) => {
            beginLoading()
            try {
                const status = await deleteProjectRequest(id)
                if (status !== 'missing') {
                    applyDeletedProjectIds([id])
                }
                void get().fetchProjects({ force: true })
            } catch (error) {
                console.error('删除项目失败', error)
                throw error
            } finally {
                endLoading()
            }
        },

        deleteProjects: async (ids: string[]) => {
            const uniqueIds = normalizeProjectIds(ids)
            const result: BatchDeleteProjectsResult = {
                requested_count: uniqueIds.length,
                deleted_count: 0,
                missing_count: 0,
                failed_count: 0,
                deleted_ids: [],
                missing_ids: [],
                failed_ids: [],
            }
            if (uniqueIds.length === 0) {
                return result
            }

            beginLoading()
            try {
                let payload: any = null
                let shouldFallbackSequential = false
                try {
                    const response = await api.delete('/projects', {
                        data: { project_ids: uniqueIds },
                    })
                    payload = response.data ?? null
                } catch {
                    try {
                        const response = await api.post('/projects/batch-delete', {
                            project_ids: uniqueIds,
                        })
                        payload = response.data ?? null
                    } catch {
                        shouldFallbackSequential = true
                    }
                }

                if (payload && !shouldFallbackSequential) {
                    result.deleted_ids = (payload.deleted ?? [])
                        .map((item: any) => String(item?.project_id || '').trim())
                        .filter(Boolean)
                    result.missing_ids = (payload.missing ?? [])
                        .map((item: any) => String(item?.project_id || '').trim())
                        .filter(Boolean)
                    result.failed_ids = (payload.failed ?? [])
                        .map((item: any) => String(item?.project_id || '').trim())
                        .filter(Boolean)
                }

                if (!payload || shouldFallbackSequential) {
                    for (const id of uniqueIds) {
                        try {
                            const status = await deleteProjectRequest(id)
                            if (status === 'deleted') {
                                result.deleted_ids.push(id)
                            } else {
                                result.missing_ids.push(id)
                            }
                        } catch {
                            result.failed_ids.push(id)
                        }
                    }
                }

                result.deleted_ids = normalizeProjectIds(result.deleted_ids)
                result.missing_ids = normalizeProjectIds(result.missing_ids)
                result.failed_ids = normalizeProjectIds(result.failed_ids)
                result.deleted_count = result.deleted_ids.length
                result.missing_count = result.missing_ids.length
                result.failed_count = result.failed_ids.length

                applyDeletedProjectIds([...result.deleted_ids, ...result.missing_ids])
                void get().fetchProjects({ force: true })
                return result
            } catch (error) {
                console.error('批量删除项目失败', error)
                throw error
            } finally {
                endLoading()
            }
        },

        invalidateCache: (scope: 'projects' | 'project' | 'chapters', id?: string) => {
            switch (scope) {
                case 'projects':
                    set({ _projectsLastFetch: null })
                    break
                case 'project':
                    if (id) {
                        const updated = { ...get()._projectLastFetch }
                        delete updated[id]
                        set({ _projectLastFetch: updated })
                    } else {
                        set({ _projectLastFetch: {} })
                    }
                    break
                case 'chapters':
                    if (id) {
                        const updated = { ...get()._chaptersLastFetch }
                        delete updated[id]
                        set({
                            _chaptersLastFetch: updated,
                            _chaptersProjectId:
                                get()._chaptersProjectId === id ? null : get()._chaptersProjectId,
                        })
                    } else {
                        set({ _chaptersLastFetch: {}, _chaptersProjectId: null })
                    }
                    break
            }
        },
    }
})
