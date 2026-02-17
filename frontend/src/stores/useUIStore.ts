import { create } from 'zustand'

interface UIStore {
    sidebarCollapsed: boolean
    readingMode: boolean
    shortcutHelpOpen: boolean
    /** Sidebar state saved before entering reading mode, restored on exit */
    _savedSidebarCollapsed: boolean | null

    toggleSidebar: () => void
    toggleReadingMode: () => void
    enterReadingMode: () => void
    exitReadingMode: () => void
    toggleShortcutHelp: () => void
}

export const useUIStore = create<UIStore>((set) => ({
    sidebarCollapsed: false,
    readingMode: false,
    shortcutHelpOpen: false,
    _savedSidebarCollapsed: null,

    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

    toggleReadingMode: () =>
        set((s) => {
            if (s.readingMode) {
                // exiting
                return {
                    readingMode: false,
                    sidebarCollapsed: s._savedSidebarCollapsed ?? s.sidebarCollapsed,
                    _savedSidebarCollapsed: null,
                }
            }
            // entering
            return {
                readingMode: true,
                _savedSidebarCollapsed: s.sidebarCollapsed,
                sidebarCollapsed: true,
            }
        }),

    enterReadingMode: () =>
        set((s) => {
            if (s.readingMode) return s
            return {
                readingMode: true,
                _savedSidebarCollapsed: s.sidebarCollapsed,
                sidebarCollapsed: true,
            }
        }),

    exitReadingMode: () =>
        set((s) => {
            if (!s.readingMode) return s
            return {
                readingMode: false,
                sidebarCollapsed: s._savedSidebarCollapsed ?? s.sidebarCollapsed,
                _savedSidebarCollapsed: null,
            }
        }),

    toggleShortcutHelp: () => set((s) => ({ shortcutHelpOpen: !s.shortcutHelpOpen })),
}))
