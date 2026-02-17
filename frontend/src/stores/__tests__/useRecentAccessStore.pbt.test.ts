import { describe, it, expect, beforeEach, vi } from 'vitest'
import fc from 'fast-check'
import { useRecentAccessStore, type RecentAccessItem } from '../useRecentAccessStore'

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

const arbRecentAccessItem = fc.record({
    type: fc.oneof(fc.constant('project' as const), fc.constant('chapter' as const)),
    id: fc.string({ minLength: 1, maxLength: 20 }),
    name: fc.string({ minLength: 1, maxLength: 50 }),
    path: fc.string({ minLength: 1, maxLength: 100 }),
    projectId: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
})

describe('useRecentAccessStore property-based tests', () => {
    // Feature: frontend-ux-polish, Property 11: 最近访问列表不变量 (max 5, no duplicate ids)
    // Validates: Requirements 8.1, 8.5
    it('Property 11: items array length never exceeds 5 and has no duplicate ids after any sequence of addAccess calls', () => {
        fc.assert(
            fc.property(
                fc.array(arbRecentAccessItem, { minLength: 1, maxLength: 30 }),
                (items) => {
                    useRecentAccessStore.setState({ items: [] })
                    storage = {}

                    const store = useRecentAccessStore.getState()
                    for (const item of items) {
                        store.addAccess(item)
                    }

                    const { items: result } = useRecentAccessStore.getState()

                    // Length never exceeds 5
                    expect(result.length).toBeLessThanOrEqual(5)

                    // No duplicate ids
                    const ids = result.map(i => i.id)
                    const uniqueIds = new Set(ids)
                    expect(uniqueIds.size).toBe(ids.length)
                },
            ),
            { numRuns: 100 },
        )
    })

    // Feature: frontend-ux-polish, Property 12: 最近访问 localStorage 持久化
    // Validates: Requirements 8.5, 8.6
    it('Property 12: after addAccess, localStorage contains the added record', () => {
        fc.assert(
            fc.property(
                arbRecentAccessItem,
                (item) => {
                    useRecentAccessStore.setState({ items: [] })
                    storage = {}

                    useRecentAccessStore.getState().addAccess(item)

                    // localStorage should have been written
                    const raw = storage[STORAGE_KEY]
                    expect(raw).toBeDefined()

                    const parsed = JSON.parse(raw) as RecentAccessItem[]
                    expect(parsed.length).toBeGreaterThanOrEqual(1)

                    // The added item should be present by id
                    const found = parsed.find(i => i.id === item.id)
                    expect(found).toBeDefined()
                    expect(found!.type).toBe(item.type)
                    expect(found!.name).toBe(item.name)
                    expect(found!.path).toBe(item.path)
                },
            ),
            { numRuns: 100 },
        )
    })
})
