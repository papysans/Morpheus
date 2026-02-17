// Feature: frontend-ux-polish, Property 1: 禁用按钮悬停显示原因
// Validates: Requirements 1.1

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import DisabledTooltip from '../DisabledTooltip'

// === Smart Generators ===

/** Non-empty reason string (filter out empty/whitespace-only) */
const reasonArb = fc
    .string({ minLength: 1, maxLength: 200 })
    .filter((s) => s.trim().length > 0)

describe('Feature: frontend-ux-polish, Property 1: 禁用按钮悬停显示原因', () => {
    /**
     * **Validates: Requirements 1.1**
     *
     * For any DisabledTooltip with disabled=true and a non-empty reason,
     * hovering the wrapper should reveal a tooltip containing the reason text.
     */
    it('disabled=true + hover shows tooltip with reason text', () => {
        fc.assert(
            fc.property(reasonArb, (reason) => {
                const { unmount } = render(
                    <DisabledTooltip reason={reason} disabled={true}>
                        <button disabled>Test</button>
                    </DisabledTooltip>,
                )

                const wrapper = document.querySelector('.disabled-tooltip-wrap')!
                expect(wrapper).toBeInTheDocument()

                // Before hover: no tooltip
                expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

                // Hover: tooltip appears with reason text
                fireEvent.mouseEnter(wrapper)
                const tooltip = screen.getByRole('tooltip')
                expect(tooltip.textContent).toContain(reason)

                unmount()
            }),
            { numRuns: 100 },
        )
    })

    /**
     * **Validates: Requirements 1.1**
     *
     * For any DisabledTooltip with disabled=false, no tooltip wrapper
     * (.disabled-tooltip-wrap) should exist in the DOM at all.
     */
    it('disabled=false renders no tooltip wrapper', () => {
        fc.assert(
            fc.property(reasonArb, (reason) => {
                const { unmount } = render(
                    <DisabledTooltip reason={reason} disabled={false}>
                        <button>Test</button>
                    </DisabledTooltip>,
                )

                // No wrapper element should exist
                expect(document.querySelector('.disabled-tooltip-wrap')).not.toBeInTheDocument()
                // No tooltip should exist
                expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

                unmount()
            }),
            { numRuns: 100 },
        )
    })
})
