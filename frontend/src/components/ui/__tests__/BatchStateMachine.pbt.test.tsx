// Feature: frontend-ux-polish, Property 9: 批量生成状态机按钮映射
// Validates: Requirements 6.2, 6.3, 6.4, 6.6

import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import BatchStateMachine from '../BatchStateMachine'
import type { BatchState } from '../BatchStateMachine'

// === Constants ===

/** Expected button labels for each BatchState */
const BUTTON_MAP: Record<BatchState, string[]> = {
    idle: [],
    generating: ['暂停', '终止'],
    paused: ['继续', '终止'],
    interrupted: ['从断点恢复', '重新开始'],
    completed: [],
}

/** All possible button labels across all states */
const ALL_BUTTONS = [...new Set(Object.values(BUTTON_MAP).flat())]

// === Smart Generators ===

const batchStateArb = fc.constantFrom<BatchState>('idle', 'generating', 'paused', 'interrupted', 'completed')

/** Generate progress where completed <= total, total >= 1 */
const progressArb = fc
    .record({
        total: fc.integer({ min: 1, max: 100 }),
        completed: fc.integer({ min: 0, max: 100 }),
    })
    .map(({ total, completed }) => ({
        total,
        completed: Math.min(completed, total),
    }))

const noop = vi.fn()

describe('Feature: frontend-ux-polish, Property 9: 批量生成状态机按钮映射', () => {
    /**
     * **Validates: Requirements 6.2, 6.3, 6.4, 6.6**
     *
     * For any BatchState, the component renders exactly the expected set of buttons.
     * States with buttons show the correct labels; states without buttons show none.
     */
    it('renders exactly the expected buttons for any BatchState', () => {
        fc.assert(
            fc.property(batchStateArb, progressArb, (state, progress) => {
                const { unmount } = render(
                    <BatchStateMachine
                        state={state}
                        progress={progress}
                        onPause={noop}
                        onResume={noop}
                        onStop={noop}
                        onRetry={noop}
                        onRestart={noop}
                    />,
                )

                const expectedButtons = BUTTON_MAP[state]

                // Verify expected buttons are present
                for (const label of expectedButtons) {
                    expect(screen.getByText(label)).toBeInTheDocument()
                }

                // Verify no unexpected buttons from other states are present
                const unexpectedButtons = ALL_BUTTONS.filter((b) => !expectedButtons.includes(b))
                for (const label of unexpectedButtons) {
                    expect(screen.queryByText(label)).not.toBeInTheDocument()
                }

                unmount()
            }),
            { numRuns: 100 },
        )
    })

    /**
     * **Validates: Requirements 6.2, 6.6**
     *
     * States with no buttons (idle, completed) should have zero button elements.
     */
    it('idle and completed states have no button elements', () => {
        const noButtonStates = fc.constantFrom<BatchState>('idle', 'completed')

        fc.assert(
            fc.property(noButtonStates, progressArb, (state, progress) => {
                const { unmount } = render(
                    <BatchStateMachine
                        state={state}
                        progress={progress}
                        onPause={noop}
                        onResume={noop}
                        onStop={noop}
                        onRetry={noop}
                        onRestart={noop}
                    />,
                )

                expect(screen.queryAllByRole('button')).toHaveLength(0)

                unmount()
            }),
            { numRuns: 100 },
        )
    })

    /**
     * **Validates: Requirements 6.2, 6.3, 6.4**
     *
     * States with buttons (generating, paused, interrupted) render exactly
     * the correct number of button elements.
     */
    it('active states render the correct number of button elements', () => {
        const activeStates = fc.constantFrom<BatchState>('generating', 'paused', 'interrupted')

        fc.assert(
            fc.property(activeStates, progressArb, (state, progress) => {
                const { unmount } = render(
                    <BatchStateMachine
                        state={state}
                        progress={progress}
                        onPause={noop}
                        onResume={noop}
                        onStop={noop}
                        onRetry={noop}
                        onRestart={noop}
                    />,
                )

                const buttons = screen.queryAllByRole('button')
                expect(buttons).toHaveLength(BUTTON_MAP[state].length)

                unmount()
            }),
            { numRuns: 100 },
        )
    })
})
