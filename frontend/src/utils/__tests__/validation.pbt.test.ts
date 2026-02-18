// Feature: frontend-ux-polish, Property 2: 字段校验对无效输入返回错误
// Validates: Requirements 2.1, 2.2

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { validateField } from '../validation'

// === Smart Generators ===

/** Whitespace-only strings (empty or spaces/tabs/newlines) */
const whitespaceStringArb = fc.oneof(
    fc.constant(''),
    fc.array(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 20 })
        .map((chars) => chars.join(''))
)

/** Non-empty, non-whitespace-only strings */
const nonEmptyStringArb = fc
    .string({ minLength: 1, maxLength: 100 })
    .filter((s) => s.trim().length > 0)

/** Finite number arbitrary for range testing */
const finiteNumberArb = fc.double({
    min: -1e6,
    max: 1e6,
    noNaN: true,
    noDefaultInfinity: true,
})

/** Generate a [min, max] range where min < max */
const rangeArb = fc
    .tuple(finiteNumberArb, finiteNumberArb)
    .filter(([a, b]) => a < b)
    .map(([a, b]) => ({ min: a, max: b }))

/** Number strictly below a given min */
const belowMinArb = (min: number) =>
    fc.double({ min: min - 1e6, max: min - Number.EPSILON, noNaN: true, noDefaultInfinity: true })
        .filter((v) => v < min)

/** Number strictly above a given max */
const aboveMaxArb = (max: number) =>
    fc.double({ min: max + Number.EPSILON, max: max + 1e6, noNaN: true, noDefaultInfinity: true })
        .filter((v) => v > max)

/** Number within [min, max] inclusive */
const inRangeArb = (min: number, max: number) =>
    fc.double({ min, max, noNaN: true, noDefaultInfinity: true })

// === Property Tests ===

describe('Feature: frontend-ux-polish, Property 2: 字段校验对无效输入返回错误', () => {
    /**
     * **Validates: Requirements 2.1**
     *
     * For any required rule with empty/whitespace-only string input,
     * validateField must return a FieldError with type 'error'.
     */
    it('required rule + whitespace-only input → returns error', () => {
        fc.assert(
            fc.property(whitespaceStringArb, (value) => {
                const result = validateField(value, { required: true })
                expect(result).not.toBeNull()
                expect(result!.type).toBe('error')
                expect(result!.message).toBe('此字段为必填项')
            }),
            { numRuns: 100 },
        )
    })

    /**
     * **Validates: Requirements 2.2**
     *
     * For any numeric value below min in a [min, max] range,
     * validateField must return a FieldError with type 'error'.
     */
    it('numeric value below min → returns error', () => {
        fc.assert(
            fc.property(
                rangeArb.chain(({ min, max }) =>
                    belowMinArb(min).map((v) => ({ value: v, min, max }))
                ),
                ({ value, min, max }) => {
                    const result = validateField(value, { min, max })
                    expect(result).not.toBeNull()
                    expect(result!.type).toBe('error')
                },
            ),
            { numRuns: 100 },
        )
    })

    /**
     * **Validates: Requirements 2.2**
     *
     * For any numeric value above max in a [min, max] range,
     * validateField must return a FieldError with type 'error'.
     */
    it('numeric value above max → returns error', () => {
        fc.assert(
            fc.property(
                rangeArb.chain(({ min, max }) =>
                    aboveMaxArb(max).map((v) => ({ value: v, min, max }))
                ),
                ({ value, min, max }) => {
                    const result = validateField(value, { min, max })
                    expect(result).not.toBeNull()
                    expect(result!.type).toBe('error')
                },
            ),
            { numRuns: 100 },
        )
    })

    /**
     * **Validates: Requirements 2.1, 2.2**
     *
     * For any valid input (non-empty string for required, number in range),
     * validateField returns null or hint (never an error).
     */
    it('valid input (non-empty + in-range) → returns null or hint', () => {
        fc.assert(
            fc.property(
                rangeArb.chain(({ min, max }) =>
                    fc.record({
                        value: inRangeArb(min, max),
                        rules: fc.record({
                            required: fc.constant(true as const),
                            min: fc.constant(min),
                            max: fc.constant(max),
                            hint: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
                        }),
                    })
                ),
                ({ value, rules }) => {
                    const result = validateField(value, rules)
                    // Should be null (no error, no hint) or a hint
                    if (result !== null) {
                        expect(result.type).toBe('hint')
                    }
                },
            ),
            { numRuns: 100 },
        )
    })

    /**
     * **Validates: Requirements 2.1**
     *
     * For any non-empty string with required rule and no range rules,
     * validateField returns null (no error).
     */
    it('required rule + non-empty string → returns null or hint', () => {
        fc.assert(
            fc.property(
                nonEmptyStringArb,
                fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
                (value, hint) => {
                    const result = validateField(value, { required: true, hint })
                    if (result !== null) {
                        expect(result.type).toBe('hint')
                    }
                },
            ),
            { numRuns: 100 },
        )
    })
})
