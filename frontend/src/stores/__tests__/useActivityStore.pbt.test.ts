import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fc from 'fast-check'
import { useActivityStore, type ActivityType, type ActivityStatus } from '../useActivityStore'

// Feature: frontend-ux-polish, Property 3: 操作历史记录上限不变量
// Feature: frontend-ux-polish, Property 5: 操作历史 localStorage 往返一致性
// Validates: Requirements 3.2, 3.4

// Mock localStorage
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

const activityTypeArb = fc.constantFrom<ActivityType>('generate', 'export', 'save', 'create', 'delete', 'approve', 'error')
const activityStatusArb = fc.constantFrom<ActivityStatus>('success', 'error', 'pending')
const descriptionArb = fc.string({ minLength: 1, maxLength: 100 })

const recordArb = fc.record({
    type: activityTypeArb,
    description: descriptionArb,
    status: activityStatusArb,
})

beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    useActivityStore.setState({ records: [], panelOpen: false })
})

describe('Feature: frontend-ux-polish, Property 3: 操作历史记录上限不变量', () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For any sequence of addRecord calls, the records array length
     * never exceeds 50 and records are ordered by timestamp descending.
     */
    it('records length never exceeds 50 and are ordered by timestamp descending', () => {
        fc.assert(
            fc.property(
                fc.array(recordArb, { minLength: 1, maxLength: 80 }),
                (records) => {
                    useActivityStore.setState({ records: [], panelOpen: false })
                    localStorageMock.clear()

                    for (const record of records) {
                        useActivityStore.getState().addRecord(record)
                    }

                    const storeRecords = useActivityStore.getState().records

                    // Length never exceeds 50
                    expect(storeRecords.length).toBeLessThanOrEqual(50)

                    // Ordered by timestamp descending (newest first)
                    for (let i = 1; i < storeRecords.length; i++) {
                        expect(storeRecords[i - 1].timestamp).toBeGreaterThanOrEqual(storeRecords[i].timestamp)
                    }
                }
            ),
            { numRuns: 100 }
        )
    })
})

describe('Feature: frontend-ux-polish, Property 5: 操作历史 localStorage 往返一致性', () => {
    /**
     * **Validates: Requirements 3.4**
     *
     * For any activity record, after calling addRecord the localStorage
     * should contain that record with matching id and description.
     */
    it('addRecord persists record to localStorage with matching id and description', () => {
        fc.assert(
            fc.property(recordArb, (record) => {
                useActivityStore.setState({ records: [], panelOpen: false })
                localStorageMock.clear()

                useActivityStore.getState().addRecord(record)

                const stored = JSON.parse(localStorageMock.getItem('activity-records') || '[]')
                const storeRecords = useActivityStore.getState().records

                // localStorage should contain the record
                expect(stored.length).toBeGreaterThan(0)

                // The record in localStorage should match the one in the store
                const storeRecord = storeRecords[0]
                const storedRecord = stored[0]

                expect(storedRecord.id).toBe(storeRecord.id)
                expect(storedRecord.description).toBe(record.description)
                expect(storedRecord.type).toBe(record.type)
                expect(storedRecord.status).toBe(record.status)
            }),
            { numRuns: 100 }
        )
    })
})
