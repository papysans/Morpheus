export interface FieldError {
    message: string
    type: 'error' | 'hint'
}

export type ValidationRule = {
    required?: boolean
    min?: number
    max?: number
    hint?: string
}

export function validateField(
    value: string | number,
    rules: ValidationRule
): FieldError | null {
    const strValue = typeof value === 'string' ? value : String(value)

    // Required check: empty or whitespace-only string
    if (rules.required && strValue.trim() === '') {
        return { message: '此字段为必填项', type: 'error' }
    }

    // Range check for numeric values
    if (rules.min !== undefined || rules.max !== undefined) {
        const numValue = typeof value === 'number' ? value : Number(value)

        if (!isNaN(numValue)) {
            const min = rules.min
            const max = rules.max

            if (min !== undefined && max !== undefined) {
                if (numValue < min || numValue > max) {
                    return { message: `范围：${min}-${max}`, type: 'error' }
                }
            } else if (min !== undefined && numValue < min) {
                return { message: `最小值：${min}`, type: 'error' }
            } else if (max !== undefined && numValue > max) {
                return { message: `最大值：${max}`, type: 'error' }
            }
        }
    }

    // Hint (only when no error)
    if (rules.hint) {
        return { message: rules.hint, type: 'hint' }
    }

    return null
}
