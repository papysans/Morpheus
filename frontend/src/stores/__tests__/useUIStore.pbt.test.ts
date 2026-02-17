import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { useUIStore } from '../useUIStore'

// === Generators ===

/** Arbitrary boolean for initial sidebarCollapsed state */
const sidebarCollapsedArb = fc.boolean()

beforeEach(() => {
    useUIStore.setState({
        sidebarCollapsed: false,
        readingMode: false,
        shortcutHelpOpen: false,
        _savedSidebarCollapsed: null,
    })
})

describe('Feature: frontend-ux-overhaul, Property 12: 阅读模式往返', () => {
    /**
     * **Validates: Requirements 12.4**
     *
     * For any UI state, entering reading mode then exiting should restore
     * sidebarCollapsed and readingMode to their pre-entry values.
     */
    it('enterReadingMode then exitReadingMode restores original sidebarCollapsed and readingMode', () => {
        fc.assert(
            fc.property(sidebarCollapsedArb, (initialSidebarCollapsed) => {
                // Set initial state (readingMode must be false before entering)
                useUIStore.setState({
                    sidebarCollapsed: initialSidebarCollapsed,
                    readingMode: false,
                    _savedSidebarCollapsed: null,
                })

                const stateBefore = useUIStore.getState()
                expect(stateBefore.readingMode).toBe(false)
                expect(stateBefore.sidebarCollapsed).toBe(initialSidebarCollapsed)

                // Enter reading mode
                useUIStore.getState().enterReadingMode()
                const duringReading = useUIStore.getState()
                expect(duringReading.readingMode).toBe(true)
                expect(duringReading.sidebarCollapsed).toBe(true)

                // Exit reading mode
                useUIStore.getState().exitReadingMode()
                const stateAfter = useUIStore.getState()

                // sidebarCollapsed and readingMode should be restored
                expect(stateAfter.readingMode).toBe(false)
                expect(stateAfter.sidebarCollapsed).toBe(initialSidebarCollapsed)
                expect(stateAfter._savedSidebarCollapsed).toBeNull()
            }),
            { numRuns: 100 },
        )
    })

    it('toggleReadingMode twice restores original sidebarCollapsed and readingMode', () => {
        fc.assert(
            fc.property(sidebarCollapsedArb, (initialSidebarCollapsed) => {
                // Set initial state
                useUIStore.setState({
                    sidebarCollapsed: initialSidebarCollapsed,
                    readingMode: false,
                    _savedSidebarCollapsed: null,
                })

                // Toggle on (enter reading mode)
                useUIStore.getState().toggleReadingMode()
                const duringReading = useUIStore.getState()
                expect(duringReading.readingMode).toBe(true)
                expect(duringReading.sidebarCollapsed).toBe(true)

                // Toggle off (exit reading mode)
                useUIStore.getState().toggleReadingMode()
                const stateAfter = useUIStore.getState()

                // sidebarCollapsed and readingMode should be restored
                expect(stateAfter.readingMode).toBe(false)
                expect(stateAfter.sidebarCollapsed).toBe(initialSidebarCollapsed)
                expect(stateAfter._savedSidebarCollapsed).toBeNull()
            }),
            { numRuns: 100 },
        )
    })
})
