import { create } from 'zustand'

export type ActivityType = 'generate' | 'export' | 'save' | 'create' | 'delete' | 'approve' | 'error'
export type ActivityStatus = 'success' | 'error' | 'pending'

export interface ActivityRecord {
    id: string
    type: ActivityType
    description: string
    timestamp: number
    status: ActivityStatus
    retryAction?: () => void
}

const STORAGE_KEY = 'activity-records'
const MAX_RECORDS = 50

function loadFromStorage(): ActivityRecord[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw) as ActivityRecord[]
        // retryAction is not serializable, so it's lost on reload
        return parsed.map(r => ({ ...r, retryAction: undefined }))
    } catch {
        return []
    }
}

function saveToStorage(records: ActivityRecord[]) {
    try {
        // Strip retryAction before saving (not serializable)
        const serializable = records.map(({ retryAction, ...rest }) => rest)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable))
    } catch {
        // Silent fail - localStorage might be full or unavailable
    }
}

interface ActivityStore {
    records: ActivityRecord[]
    panelOpen: boolean
    addRecord: (record: Omit<ActivityRecord, 'id' | 'timestamp'>) => void
    togglePanel: () => void
    clearRecords: () => void
}

export const useActivityStore = create<ActivityStore>((set, get) => ({
    records: loadFromStorage(),
    panelOpen: false,

    addRecord: (record) => {
        const newRecord: ActivityRecord = {
            ...record,
            id: crypto.randomUUID(),
            timestamp: Date.now(),
        }
        const updated = [newRecord, ...get().records].slice(0, MAX_RECORDS)
        set({ records: updated })
        saveToStorage(updated)
    },

    togglePanel: () => {
        set((state) => ({ panelOpen: !state.panelOpen }))
    },

    clearRecords: () => {
        set({ records: [] })
        localStorage.removeItem(STORAGE_KEY)
    },
}))
