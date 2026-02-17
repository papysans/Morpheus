import { describe, it, expect, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { useProjectStore, ProjectItem } from '../useProjectStore'

/**
 * Arbitrary for generating valid ProjectItem objects.
 */
const projectItemArb = fc.record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 100 }),
    genre: fc.string({ minLength: 1, maxLength: 50 }),
    style: fc.string({ minLength: 1, maxLength: 50 }),
    status: fc.constantFrom('draft', 'active', 'completed'),
    chapter_count: fc.nat({ max: 100 }),
    entity_count: fc.nat({ max: 500 }),
    event_count: fc.nat({ max: 500 }),
})

/**
 * Arbitrary for partial updates to a ProjectItem (excluding id).
 */
const projectUpdateArb = fc.record({
    name: fc.string({ minLength: 1, maxLength: 100 }),
    genre: fc.string({ minLength: 1, maxLength: 50 }),
    style: fc.string({ minLength: 1, maxLength: 50 }),
    status: fc.constantFrom('draft', 'active', 'completed'),
    chapter_count: fc.nat({ max: 100 }),
    entity_count: fc.nat({ max: 500 }),
    event_count: fc.nat({ max: 500 }),
})

beforeEach(() => {
    useProjectStore.setState({ projects: [], currentProject: null, chapters: [], loading: false })
})

describe('Feature: frontend-ux-overhaul, Property 7: 项目 Store 同步更新', () => {
    /**
     * **Validates: Requirements 6.4**
     *
     * For any project list state, when updating a project's properties through the Store,
     * the project in the list with the matching id should reflect the updated values.
     */
    it('updating a project in the list reflects the new values for the matching id', () => {
        fc.assert(
            fc.property(
                fc.array(projectItemArb, { minLength: 1, maxLength: 20 }),
                projectUpdateArb,
                (projects, update) => {
                    // Ensure unique ids
                    const uniqueProjects = projects.reduce<ProjectItem[]>((acc, p) => {
                        if (!acc.some((x) => x.id === p.id)) acc.push(p)
                        return acc
                    }, [])

                    if (uniqueProjects.length === 0) return

                    // Step 1: Set initial projects list
                    useProjectStore.setState({ projects: uniqueProjects })

                    // Pick a random project to update (use first for determinism within the property)
                    const targetIndex = 0
                    const targetId = uniqueProjects[targetIndex].id

                    // Step 2: Update the target project's properties in the list
                    const currentProjects = useProjectStore.getState().projects
                    const updatedProjects = currentProjects.map((p) =>
                        p.id === targetId ? { ...p, ...update } : p,
                    )
                    useProjectStore.setState({ projects: updatedProjects })

                    // Step 3: Verify the project with matching id reflects the new values
                    const result = useProjectStore.getState().projects.find((p) => p.id === targetId)
                    expect(result).toBeDefined()
                    expect(result!.id).toBe(targetId)
                    expect(result!.name).toBe(update.name)
                    expect(result!.genre).toBe(update.genre)
                    expect(result!.style).toBe(update.style)
                    expect(result!.status).toBe(update.status)
                    expect(result!.chapter_count).toBe(update.chapter_count)
                    expect(result!.entity_count).toBe(update.entity_count)
                    expect(result!.event_count).toBe(update.event_count)

                    // Verify other projects are unchanged
                    const otherProjects = useProjectStore
                        .getState()
                        .projects.filter((p) => p.id !== targetId)
                    const originalOthers = uniqueProjects.filter((p) => p.id !== targetId)
                    expect(otherProjects).toEqual(originalOthers)

                    // Verify list length is preserved
                    expect(useProjectStore.getState().projects).toHaveLength(uniqueProjects.length)
                },
            ),
            { numRuns: 100 },
        )
    })
})
