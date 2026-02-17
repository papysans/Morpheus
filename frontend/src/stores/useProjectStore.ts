import { create } from 'zustand'
import { api } from '../lib/api'

export const CACHE_TTL = 30_000

export interface ProjectItem {
    id: string
    name: string
    genre: string
    style: string
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

interface ProjectStore {
    projects: ProjectItem[]
    currentProject: ProjectDetail | null
    chapters: ChapterItem[]
    loading: boolean
    _projectsLastFetch: number | null
    _projectLastFetch: Record<string, number>
    _chaptersLastFetch: Record<string, number>

    fetchProjects: (options?: FetchOptions) => Promise<void>
    fetchProject: (id: string, options?: FetchOptions) => Promise<void>
    fetchChapters: (projectId: string, options?: FetchOptions) => Promise<void>
    createProject: (form: ProjectCreateForm) => Promise<string>
    deleteProject: (id: string) => Promise<void>
    invalidateCache: (scope: 'projects' | 'project' | 'chapters', id?: string) => void
}

function isCacheValid(timestamp: number | null | undefined): boolean {
    if (timestamp == null) return false
    return Date.now() - timestamp < CACHE_TTL
}

export const useProjectStore = create<ProjectStore>((set, get) => {
    let pendingRequests = 0

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

    return {
        projects: [],
        currentProject: null,
        chapters: [],
        loading: false,
        _projectsLastFetch: null,
        _projectLastFetch: {},
        _chaptersLastFetch: {},

        fetchProjects: async (options?: FetchOptions) => {
            if (!options?.force && isCacheValid(get()._projectsLastFetch)) {
                return
            }
            beginLoading()
            try {
                const response = await api.get('/projects')
                set({ projects: response.data ?? [], _projectsLastFetch: Date.now() })
            } catch (error) {
                console.error('获取项目列表失败', error)
            } finally {
                endLoading()
            }
        },

        fetchProject: async (id: string, options?: FetchOptions) => {
            if (!options?.force && isCacheValid(get()._projectLastFetch[id])) {
                return
            }
            beginLoading()
            try {
                const response = await api.get(`/projects/${id}`)
                set({
                    currentProject: response.data,
                    _projectLastFetch: { ...get()._projectLastFetch, [id]: Date.now() },
                })
            } catch (error) {
                console.error('获取项目详情失败', error)
                set({ currentProject: null })
            } finally {
                endLoading()
            }
        },

        fetchChapters: async (projectId: string, options?: FetchOptions) => {
            if (!options?.force && isCacheValid(get()._chaptersLastFetch[projectId])) {
                return
            }
            beginLoading()
            try {
                const response = await api.get(`/projects/${projectId}/chapters`)
                set({
                    chapters: response.data ?? [],
                    _chaptersLastFetch: { ...get()._chaptersLastFetch, [projectId]: Date.now() },
                })
            } catch (error) {
                console.error('获取章节列表失败', error)
                set({ chapters: [] })
            } finally {
                endLoading()
            }
        },

        createProject: async (form: ProjectCreateForm) => {
            beginLoading()
            try {
                const response = await api.post('/projects', {
                    ...form,
                    taboo_constraints: form.taboo_constraints
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                })
                const newId = String(response.data?.id ?? '')
                get().invalidateCache('projects')
                await get().fetchProjects({ force: true })
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
                try {
                    await api.delete(`/projects/${id}`)
                } catch (error: any) {
                    if (error?.response?.status === 405) {
                        await api.post(`/projects/${id}/delete`)
                    } else {
                        throw error
                    }
                }
                const { currentProject } = get()
                if (currentProject?.id === id) {
                    set({ currentProject: null, chapters: [] })
                }
                get().invalidateCache('projects')
                await get().fetchProjects({ force: true })
            } catch (error) {
                console.error('删除项目失败', error)
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
                        set({ _chaptersLastFetch: updated })
                    } else {
                        set({ _chaptersLastFetch: {} })
                    }
                    break
            }
        },
    }
})
