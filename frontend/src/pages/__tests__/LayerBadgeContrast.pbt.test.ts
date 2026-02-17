import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'

// === WCAG Contrast Ratio Helpers ===

/**
 * Convert a hex color string (e.g. "#1f9f61") to [R, G, B] in 0-255 range.
 */
function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '')
    return [
        parseInt(h.substring(0, 2), 16),
        parseInt(h.substring(2, 4), 16),
        parseInt(h.substring(4, 6), 16),
    ]
}

/**
 * Calculate relative luminance per WCAG 2.x (sRGB linearization).
 * https://www.w3.org/TR/WCAG20/#relativeluminancedef
 */
function relativeLuminance(hex: string): number {
    const [r, g, b] = hexToRgb(hex).map((c) => {
        const s = c / 255
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Calculate WCAG contrast ratio between two hex colors.
 * Returns a value >= 1 (lighter / darker).
 */
function contrastRatio(hex1: string, hex2: string): number {
    const l1 = relativeLuminance(hex1)
    const l2 = relativeLuminance(hex2)
    const lighter = Math.max(l1, l2)
    const darker = Math.min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)
}

// === Layer badge color mapping (from index.css) ===

const LAYER_BADGE_COLORS: Record<string, string> = {
    L1: '#15794a', // green (darkened for WCAG AA compliance)
    L2: '#1e6ba8', // blue (darkened for WCAG AA compliance)
    L3: '#8c5a15', // orange/amber (darkened for WCAG AA compliance)
}

/** Page background from the design system */
const PAGE_BACKGROUND = '#f6f9ff'

/** WCAG AA minimum contrast ratio for normal text */
const WCAG_AA_MIN = 4.5

// === Property Tests ===

describe('Feature: frontend-visual-consistency, Property 2: 层级标签对比度', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * For all layer values (L1, L2, L3), the corresponding badge text color
     * on the page background (#f6f9ff) should meet WCAG AA minimum contrast
     * ratio of 4.5:1.
     */
    it('all layer badge text colors meet WCAG AA contrast ratio (>= 4.5:1) against page background', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('L1', 'L2', 'L3'),
                (layer) => {
                    const textColor = LAYER_BADGE_COLORS[layer]
                    expect(textColor).toBeDefined()

                    const ratio = contrastRatio(textColor, PAGE_BACKGROUND)

                    // WCAG AA requires >= 4.5:1 for normal text
                    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_MIN)
                },
            ),
            { numRuns: 100 },
        )
    })

    it('contrast ratio calculation is symmetric (order of colors does not matter)', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('L1', 'L2', 'L3'),
                (layer) => {
                    const textColor = LAYER_BADGE_COLORS[layer]
                    const ratio1 = contrastRatio(textColor, PAGE_BACKGROUND)
                    const ratio2 = contrastRatio(PAGE_BACKGROUND, textColor)

                    expect(ratio1).toBeCloseTo(ratio2, 10)
                },
            ),
            { numRuns: 100 },
        )
    })

    it('all layer badge text colors produce contrast ratio >= 1 (sanity check)', () => {
        fc.assert(
            fc.property(
                fc.constantFrom('L1', 'L2', 'L3'),
                (layer) => {
                    const textColor = LAYER_BADGE_COLORS[layer]
                    const ratio = contrastRatio(textColor, PAGE_BACKGROUND)

                    // Contrast ratio is always >= 1 by definition
                    expect(ratio).toBeGreaterThanOrEqual(1)
                },
            ),
            { numRuns: 100 },
        )
    })
})
