import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import Skeleton from '../Skeleton'

describe('Skeleton component', () => {
    it('renders a single skeleton by default', () => {
        const { container } = render(<Skeleton variant="text" />)
        expect(container.querySelectorAll('.skeleton')).toHaveLength(1)
    })

    it('renders multiple skeletons when count is provided', () => {
        const { container } = render(<Skeleton variant="card" count={3} />)
        expect(container.querySelectorAll('.skeleton--card')).toHaveLength(3)
    })

    it.each(['text', 'card', 'table-row', 'metric-card'] as const)(
        'applies correct CSS class for variant "%s"',
        (variant) => {
            const { container } = render(<Skeleton variant={variant} />)
            expect(container.querySelector(`.skeleton--${variant}`)).toBeTruthy()
        }
    )

    it('sets aria-hidden on skeleton elements', () => {
        const { container } = render(<Skeleton variant="text" />)
        expect(container.querySelector('.skeleton')?.getAttribute('aria-hidden')).toBe('true')
    })
})
