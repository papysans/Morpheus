import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useActivityStore } from '../useActivityStore'

// Mock localStorage since jsdom doesn't provide a full implementation
const localStorageMock = (() => {
    let store: Record<string, string> = {}
    return {
        getItem: vi.fn((key: string) => store[key] ?? null),
        setItem: vi.fn((key: string, value: string) => { store[key] = value }),
        removeItem: vi.fn((key: string) => { delete store[key] }),
        clear: vi.fn(() => { store = {} }),
        get length() { return Object.keys(store).length },
        key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
    }
})()

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    useActivityStore.setState({ records: [], panelOpen: false })
})

describe('useActivityStore', () => {
    it('addRecord adds a record with id and timestamp', () => {
        useActivityStore.getState().addRecord({
            type: 'create',
            description: '创建章节',
            status: 'success',
        })
        const records = useActivityStore.getState().records
        expect(records).toHaveLength(1)
        expect(records[0].type).toBe('create')
        expect(records[0].description).toBe('创建章节')
        expect(records[0].id).toBeTruthy()
        expect(records[0].timestamp).toBeGreaterThan(0)
    })

    it('records are ordered newest first', () => {
        const store = useActivityStore.getState()
        store.addRecord({ type: 'create', description: '第一条', status: 'success' })
        store.addRecord({ type: 'generate', description: '第二条', status: 'success' })
        const records = useActivityStore.getState().records
        expect(records[0].description).toBe('第二条')
        expect(records[1].description).toBe('第一条')
    })

    it('enforces max 50 records', () => {
        const store = useActivityStore.getState()
        for (let i = 0; i < 55; i++) {
            store.addRecord({ type: 'create', description: `记录 ${i}`, status: 'success' })
        }
        expect(useActivityStore.getState().records).toHaveLength(50)
    })

    it('persists to localStorage', () => {
        useActivityStore.getState().addRecord({
            type: 'export',
            description: '导出整书',
            status: 'success',
        })
        const stored = JSON.parse(localStorageMock.getItem('activity-records') || '[]')
        expect(stored).toHaveLength(1)
        expect(stored[0].description).toBe('导出整书')
    })

    it('togglePanel toggles panelOpen', () => {
        expect(useActivityStore.getState().panelOpen).toBe(false)
        useActivityStore.getState().togglePanel()
        expect(useActivityStore.getState().panelOpen).toBe(true)
        useActivityStore.getState().togglePanel()
        expect(useActivityStore.getState().panelOpen).toBe(false)
    })

    it('clearRecords empties records and localStorage', () => {
        useActivityStore.getState().addRecord({
            type: 'create',
            description: '测试',
            status: 'success',
        })
        useActivityStore.getState().clearRecords()
        expect(useActivityStore.getState().records).toHaveLength(0)
        expect(localStorageMock.removeItem).toHaveBeenCalledWith('activity-records')
    })

    it('strips retryAction when saving to localStorage', () => {
        useActivityStore.getState().addRecord({
            type: 'error',
            description: '失败操作',
            status: 'error',
            retryAction: () => { },
        })
        const stored = JSON.parse(localStorageMock.getItem('activity-records') || '[]')
        expect(stored[0].retryAction).toBeUndefined()
    })
})
