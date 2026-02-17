import { create } from 'zustand'

export interface RecentAccessItem {
    type: 'project' | 'chapter'
    id: string
    name: string
    path: string
    timestamp: number
    projectId?: string
}

const STORAGE_KEY = 'recent-access'
const MAX_ITEMS = 5

function loadFromStorage(): RecentAccessItem[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return []
        return JSON.parse(raw) as RecentAccessItem[]
    } catch {
        return []
    }
}

function saveToStorage(items: RecentAccessItem[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    } catch {
        // Silent fail — localStorage might be full or unavailable
    }
}

interface RecentAccessStore {
    items: RecentAccessItem[]
    addAccess: (item: Omit<RecentAccessItem, 'timestamp'>) => void
    clearAll: () => void
}

export const useRecentAccessStore = create<RecentAccessStore>((set, get) => ({
    items: loadFromStorage(),

    addAccess: (item) => {
        const now = Date.now()
        const newItem: RecentAccessItem = { ...item, timestamp: now }
        // Remove existing entry with same id, prepend new one, trim to max
        const filtered = get().items.filter(i => i.id !== item.id)
        const updated = [newItem, ...filtered].slice(0, MAX_ITEMS)
        set({ items: updated })
        saveToStorage(updated)
    },

    clearAll: () => {
        set({ items: [] })
        try {
            localStorage.removeItem(STORAGE_KEY)
        } catch {
            // Silent fail
        }
    },
}))
