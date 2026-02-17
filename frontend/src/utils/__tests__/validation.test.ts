import { describe, it, expect } from 'vitest'
import { validateField } from '../validation'

describe('validateField', () => {
    describe('required rule', () => {
        it('returns error for empty string when required', () => {
            const result = validateField('', { required: true })
            expect(result).toEqual({ message: '此字段为必填项', type: 'error' })
        })

        it('returns error for whitespace-only string when required', () => {
            const result = validateField('   ', { required: true })
            expect(result).toEqual({ message: '此字段为必填项', type: 'error' })
        })

        it('returns null for non-empty string when required', () => {
            const result = validateField('hello', { required: true })
            expect(result).toBeNull()
        })

        it('returns null for empty string when not required', () => {
            const result = validateField('', { required: false })
            expect(result).toBeNull()
        })
    })

    describe('min/max range rule', () => {
        it('returns error when number is below min', () => {
            const result = validateField(0, { min: 1, max: 60 })
            expect(result).toEqual({ message: '范围：1-60', type: 'error' })
        })

        it('returns error when number exceeds max', () => {
            const result = validateField(100, { min: 1, max: 60 })
            expect(result).toEqual({ message: '范围：1-60', type: 'error' })
        })

        it('returns null when number is within range', () => {
            const result = validateField(30, { min: 1, max: 60 })
            expect(result).toBeNull()
        })

        it('returns null when number equals min boundary', () => {
            const result = validateField(1, { min: 1, max: 60 })
            expect(result).toBeNull()
        })

        it('returns null when number equals max boundary', () => {
            const result = validateField(60, { min: 1, max: 60 })
            expect(result).toBeNull()
        })

        it('handles string numeric input for range check', () => {
            const result = validateField('100', { min: 1, max: 60 })
            expect(result).toEqual({ message: '范围：1-60', type: 'error' })
        })

        it('returns error when only min is set and value is below', () => {
            const result = validateField(0, { min: 1 })
            expect(result).toEqual({ message: '最小值：1', type: 'error' })
        })

        it('returns error when only max is set and value exceeds', () => {
            const result = validateField(100, { max: 60 })
            expect(result).toEqual({ message: '最大值：60', type: 'error' })
        })
    })

    describe('hint rule', () => {
        it('returns hint when no errors and hint is set', () => {
            const result = validateField(10, { min: 1, max: 60, hint: '推荐 8-12 章' })
            expect(result).toEqual({ message: '推荐 8-12 章', type: 'hint' })
        })

        it('returns error instead of hint when validation fails', () => {
            const result = validateField(0, { min: 1, max: 60, hint: '推荐 8-12 章' })
            expect(result).toEqual({ message: '范围：1-60', type: 'error' })
        })
    })

    describe('no rules', () => {
        it('returns null when no rules are set', () => {
            const result = validateField('anything', {})
            expect(result).toBeNull()
        })
    })

    describe('combined rules', () => {
        it('required check takes priority over range check', () => {
            const result = validateField('', { required: true, min: 1, max: 60 })
            expect(result).toEqual({ message: '此字段为必填项', type: 'error' })
        })
    })
})
