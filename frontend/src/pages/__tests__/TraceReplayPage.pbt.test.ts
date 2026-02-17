import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { AGENT_ROLE_COLORS } from '../TraceReplayPage'

// === Smart Generators ===

/** The five known Agent roles */
const AGENT_ROLES = ['director', 'worldbuilder', 'continuity', 'stylist', 'arbiter'] as const

/** Arbitrary pair of distinct Agent roles */
const distinctRolePairArb = fc
    .uniqueArray(fc.constantFrom(...AGENT_ROLES), { minLength: 2, maxLength: 2 })
    .map(([a, b]) => [a, b] as [string, string])

// === Property Tests ===

describe('Feature: frontend-ux-overhaul, Property 8: Agent 角色视觉标识唯一性', () => {
    /**
     * **Validates: Requirements 8.4**
     *
     * For any two different Agent roles (director, worldbuilder, continuity, stylist, arbiter),
     * their corresponding visual identity colors should be different.
     */
    it('any two distinct Agent roles have different color and borderColor', () => {
        fc.assert(
            fc.property(distinctRolePairArb, ([roleA, roleB]) => {
                const styleA = AGENT_ROLE_COLORS[roleA]
                const styleB = AGENT_ROLE_COLORS[roleB]

                // Both styles must exist
                expect(styleA).toBeDefined()
                expect(styleB).toBeDefined()

                // Colors must differ
                const colorDiff = styleA.color !== styleB.color
                const borderDiff = styleA.borderColor !== styleB.borderColor

                expect(colorDiff || borderDiff).toBe(true)
            }),
            { numRuns: 100 },
        )
    })

    it('any two distinct Agent roles also have different labels', () => {
        fc.assert(
            fc.property(distinctRolePairArb, ([roleA, roleB]) => {
                const styleA = AGENT_ROLE_COLORS[roleA]
                const styleB = AGENT_ROLE_COLORS[roleB]

                expect(styleA.label).not.toBe(styleB.label)
            }),
            { numRuns: 100 },
        )
    })
})
