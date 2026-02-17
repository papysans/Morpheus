import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import DisabledTooltip from '../DisabledTooltip'

describe('DisabledTooltip', () => {
    it('renders children directly when disabled=false', () => {
        render(
            <DisabledTooltip reason="test reason" disabled={false}>
                <button>Click me</button>
            </DisabledTooltip>
        )
        expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument()
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
        // Should not have the wrapper span
        expect(document.querySelector('.disabled-tooltip-wrap')).not.toBeInTheDocument()
    })

    it('shows tooltip on hover when disabled=true', () => {
        render(
            <DisabledTooltip reason="存在 P0 冲突" disabled={true}>
                <button disabled>审批通过</button>
            </DisabledTooltip>
        )
        const wrapper = document.querySelector('.disabled-tooltip-wrap')!
        expect(wrapper).toBeInTheDocument()

        // Tooltip not visible before hover
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

        // Hover shows tooltip
        fireEvent.mouseEnter(wrapper)
        expect(screen.getByRole('tooltip')).toHaveTextContent('存在 P0 冲突')

        // Mouse leave hides tooltip
        fireEvent.mouseLeave(wrapper)
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    })

    it('does not show tooltip on hover when disabled=false', () => {
        render(
            <DisabledTooltip reason="some reason" disabled={false}>
                <button>Active</button>
            </DisabledTooltip>
        )
        // No wrapper to hover on
        expect(document.querySelector('.disabled-tooltip-wrap')).not.toBeInTheDocument()
    })

    it('applies placement=top by default', () => {
        render(
            <DisabledTooltip reason="reason" disabled={true}>
                <button disabled>Btn</button>
            </DisabledTooltip>
        )
        fireEvent.mouseEnter(document.querySelector('.disabled-tooltip-wrap')!)
        expect(screen.getByRole('tooltip')).toHaveClass('disabled-tooltip--top')
    })

    it('applies placement=bottom when specified', () => {
        render(
            <DisabledTooltip reason="reason" disabled={true} placement="bottom">
                <button disabled>Btn</button>
            </DisabledTooltip>
        )
        fireEvent.mouseEnter(document.querySelector('.disabled-tooltip-wrap')!)
        expect(screen.getByRole('tooltip')).toHaveClass('disabled-tooltip--bottom')
    })

    it('sets aria-describedby when tooltip is visible', () => {
        render(
            <DisabledTooltip reason="reason" disabled={true}>
                <button disabled>Btn</button>
            </DisabledTooltip>
        )
        const wrapper = document.querySelector('.disabled-tooltip-wrap')!

        // No aria-describedby before hover
        expect(wrapper).not.toHaveAttribute('aria-describedby')

        fireEvent.mouseEnter(wrapper)
        const tooltip = screen.getByRole('tooltip')
        expect(wrapper.getAttribute('aria-describedby')).toBe(tooltip.id)
    })

    it('renders the arrow element inside tooltip', () => {
        render(
            <DisabledTooltip reason="reason" disabled={true}>
                <button disabled>Btn</button>
            </DisabledTooltip>
        )
        fireEvent.mouseEnter(document.querySelector('.disabled-tooltip-wrap')!)
        expect(document.querySelector('.disabled-tooltip__arrow')).toBeInTheDocument()
    })
})
