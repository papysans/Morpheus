const parseBool = (value: unknown, fallback: boolean): boolean => {
    if (value === undefined || value === null) return fallback
    const normalized = String(value).trim().toLowerCase()
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false
    return fallback
}

export const GRAPH_FEATURE_ENABLED = parseBool(import.meta.env.VITE_GRAPH_FEATURE_ENABLED, false)
