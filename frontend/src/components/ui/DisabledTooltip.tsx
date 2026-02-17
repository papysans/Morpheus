import { useState, useId } from 'react'

export interface DisabledTooltipProps {
    reason: string
    disabled: boolean
    children: React.ReactNode
    placement?: 'top' | 'bottom'
}

export default function DisabledTooltip({
    reason,
    disabled,
    children,
    placement = 'top',
}: DisabledTooltipProps) {
    const [hovered, setHovered] = useState(false)
    const tooltipId = useId()

    if (!disabled) {
        return <>{children}</>
    }

    return (
        <span
            className="disabled-tooltip-wrap"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            aria-describedby={hovered ? tooltipId : undefined}
        >
            {children}
            {hovered && (
                <span
                    id={tooltipId}
                    role="tooltip"
                    className={`disabled-tooltip disabled-tooltip--${placement}`}
                >
                    {reason}
                    <span className="disabled-tooltip__arrow" />
                </span>
            )}
        </span>
    )
}

export { DisabledTooltip }
