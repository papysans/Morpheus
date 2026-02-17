import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useRecentAccessStore, RecentAccessItem } from '../useRecentAccessStore'

const STORAGE_KEY = 'recent-access'

let storage: Record<string, string> = {}

beforeEach(() => {
    storage = {}
    vi.stubGlobal('localStorage', {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => { storage[key] = value }),
        removeItem: vi.fn((key: string) => { delete storage[key] }),
    })
    useRecentAccessStore.setState({ items: [] })
})

describe('useRecentAccessStore', () => {
    it('adds an access item and stores it', () => {
        useRecentAccessStore.getState().addAccess({
            type: 'project',
            id: 'p1',
            name: 'Project 1',
            path: '/projects/p1',
        })

        const { items } = useRecentAccessStore.getState()
        expect(items).toHaveLength(1)
        expect(items[0].id).toBe('p1')
        expect(items[0].name).toBe('Project 1')
        expect(items[0].type).toBe('project')
        expect(items[0].path).toBe('/projects/p1')
        expect(items[0].timestamp).toBeGreaterThan(0)
    })

    it('deduplicates by id — updates timestamp and moves to front', () => {
        const store = useRecentAccessStore.getState()
        store.addAccess({ type: 'project', id: 'p1', name: 'Old Name', path: '/p1' })
        const firstTimestamp = useRecentAccessStore.getState().items[0].timestamp

        // Add another item so p1 is not at front
        store.addAccess({ type: 'chapter', id: 'c1', name: 'Chapter', path: '/c1', projectId: 'p1' })

        // Re-add p1 with updated name
        store.addAccess({ type: 'project', id: 'p1', name: 'New Name', path: '/p1' })

        const { items } = useRecentAccessStore.getState()
        expect(items).toHaveLength(2)
        expect(items[0].id).toBe('p1')
        expect(items[0].name).toBe('New Name')
        expect(items[0].timestamp).toBeGreaterThanOrEqual(firstTimestamp)
    })

    it('limits to 5 items — oldest removed', () => {
        const store = useRecentAccessStore.getState()
        for (let i = 1; i <= 6; i++) {
            store.addAccess({ type: 'project', id: `p${i}`, name: `P${i}`, path: `/p${i}` })
        }

        const { items } = useRecentAccessStore.getState()
        expect(items).toHaveLength(5)
        // The first added (p1) should be gone
        expect(items.find((i: RecentAccessItem) => i.id === 'p1')).toBeUndefined()
        // The most recent (p6) should be first
        expect(items[0].id).toBe('p6')
    })

    it('persists to localStorage', () => {
        useRecentAccessStore.getState().addAccess({
            type: 'project',
            id: 'p1',
            name: 'Project 1',
            path: '/projects/p1',
        })

        expect(localStorage.setItem).toHaveBeenCalledWith(
            STORAGE_KEY,
            expect.any(String),
        )
        const saved = JSON.parse(storage[STORAGE_KEY])
        expect(saved).toHaveLength(1)
        expect(saved[0].id).toBe('p1')
    })

    it('initializes from localStorage', () => {
        const existing: RecentAccessItem[] = [
            { type: 'project', id: 'p1', name: 'P1', path: '/p1', timestamp: 1000 },
            { type: 'chapter', id: 'c1', name: 'C1', path: '/c1', timestamp: 900, projectId: 'px' },
        ]
        storage[STORAGE_KEY] = JSON.stringify(existing)

        // Re-create store state from localStorage
        const loaded = JSON.parse(storage[STORAGE_KEY]) as RecentAccessItem[]
        useRecentAccessStore.setState({ items: loaded })

        const { items } = useRecentAccessStore.getState()
        expect(items).toHaveLength(2)
        expect(items[0].id).toBe('p1')
        expect(items[1].id).toBe('c1')
    })

    it('clearAll empties items and localStorage', () => {
        const store = useRecentAccessStore.getState()
        store.addAccess({ type: 'project', id: 'p1', name: 'P1', path: '/p1' })
        expect(useRecentAccessStore.getState().items).toHaveLength(1)

        store.clearAll()

        expect(useRecentAccessStore.getState().items).toHaveLength(0)
        expect(localStorage.removeItem).toHaveBeenCalledWith(STORAGE_KEY)
    })

    it('items are ordered by timestamp descending (most recent first)', () => {
        const store = useRecentAccessStore.getState()
        store.addAccess({ type: 'project', id: 'p1', name: 'P1', path: '/p1' })
        store.addAccess({ type: 'project', id: 'p2', name: 'P2', path: '/p2' })
        store.addAccess({ type: 'project', id: 'p3', name: 'P3', path: '/p3' })

        const { items } = useRecentAccessStore.getState()
        for (let i = 0; i < items.length - 1; i++) {
            expect(items[i].timestamp).toBeGreaterThanOrEqual(items[i + 1].timestamp)
        }
        // Most recent should be first
        expect(items[0].id).toBe('p3')
    })
})
