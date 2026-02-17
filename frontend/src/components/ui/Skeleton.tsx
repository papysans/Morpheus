interface SkeletonProps {
    variant: 'text' | 'card' | 'table-row' | 'metric-card'
    count?: number
}

export default function Skeleton({ variant, count = 1 }: SkeletonProps) {
    const items = Array.from({ length: count }, (_, i) => i)

    return (
        <>
            {items.map((i) => (
                <div key={i} className={`skeleton skeleton--${variant}`} aria-hidden="true" />
            ))}
        </>
    )
}
