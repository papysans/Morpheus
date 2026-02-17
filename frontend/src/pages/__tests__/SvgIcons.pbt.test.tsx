import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { render } from '@testing-library/react'
import { IconBookOpen as ChapterIconBookOpen } from '../ChapterWorkbenchPage'
import { IconReplay } from '../TraceReplayPage'
import { IconBookOpen as WritingIconBookOpen } from '../WritingConsolePage'

/**
 * Feature: frontend-visual-consistency, Property 3: SVG 图标规格一致性
 *
 * Validates: Requirements 5.4
 *
 * For any SVG icon component used to replace emoji, its width and height
 * should be 18, and strokeWidth should be 1.8, matching Sidebar icons.
 */

const ALL_ICONS: Array<{ name: string; Component: React.FC }> = [
    { name: 'ChapterWorkbenchPage/IconBookOpen', Component: ChapterIconBookOpen },
    { name: 'TraceReplayPage/IconReplay', Component: IconReplay },
    { name: 'WritingConsolePage/IconBookOpen', Component: WritingIconBookOpen },
]

describe('Feature: frontend-visual-consistency, Property 3: SVG 图标规格一致性', () => {
    /**
     * **Validates: Requirements 5.4**
     *
     * For any SVG icon component used to replace emoji, the rendered SVG element
     * must have width="18", height="18", and stroke-width="1.8".
     */
    it('all emoji-replacement SVG icons have width=18, height=18, stroke-width=1.8', () => {
        fc.assert(
            fc.property(
                fc.constantFrom(...ALL_ICONS),
                ({ name, Component }) => {
                    const { container } = render(<Component />)
                    const svg = container.querySelector('svg')

                    expect(svg, `${name}: should render an <svg> element`).not.toBeNull()
                    expect(svg!.getAttribute('width')).toBe('18')
                    expect(svg!.getAttribute('height')).toBe('18')
                    expect(svg!.getAttribute('stroke-width')).toBe('1.8')
                },
            ),
            { numRuns: 100 },
        )
    })
})
