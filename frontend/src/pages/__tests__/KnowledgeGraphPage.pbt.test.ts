import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
    ENTITY_STYLES,
    getHighlightSets,
    sortEventsByChapter,
    buildGraphEdges,
    type EventEdge,
    type EntityNode,
} from '../KnowledgeGraphPage'
import type { Edge } from 'reactflow'

// === Smart Generators ===

/** The three known entity types */
const ENTITY_TYPES = ['character', 'location', 'item'] as const

/** Arbitrary pair of distinct entity types */
const distinctEntityTypePairArb = fc
    .uniqueArray(fc.constantFrom(...ENTITY_TYPES), { minLength: 2, maxLength: 2 })
    .map(([a, b]) => [a, b] as [string, string])

/** Unique string id */
const nodeIdArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0)

/** Generate a ReactFlow Edge with given source and target */
function edgeArb(sourceArb: fc.Arbitrary<string>, targetArb: fc.Arbitrary<string>): fc.Arbitrary<Edge> {
    return fc.record({
        id: fc.uuid(),
        source: sourceArb,
        target: targetArb,
    })
}

/** Generate a list of edges among a set of node ids */
const graphArb = fc
    .uniqueArray(nodeIdArb, { minLength: 1, maxLength: 15, comparator: (a, b) => a === b })
    .chain((nodeIds) => {
        // Pick a clicked node from the set
        return fc.record({
            nodeIds: fc.constant(nodeIds),
            clickedNode: fc.constantFrom(...nodeIds),
            edges: fc.array(
                edgeArb(fc.constantFrom(...nodeIds), fc.constantFrom(...nodeIds)),
                { minLength: 0, maxLength: 20 },
            ),
        })
    })

/** Arbitrary EventEdge */
const eventEdgeArb: fc.Arbitrary<EventEdge> = fc.record({
    event_id: fc.uuid(),
    subject: fc.string({ minLength: 1, maxLength: 20 }),
    relation: fc.string({ minLength: 1, maxLength: 20 }),
    object: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
    chapter: fc.integer({ min: 0, max: 9999 }),
    description: fc.string({ minLength: 0, maxLength: 100 }),
})

/** List of events (possibly empty) */
const eventListArb = fc.array(eventEdgeArb, { minLength: 0, maxLength: 30 })

// === Property Tests ===

describe('Feature: frontend-ux-overhaul, Property 9: 实体类型视觉标识唯一性', () => {
    /**
     * **Validates: Requirements 9.2**
     *
     * For any two different entity types (character, location, item),
     * their corresponding node styles should be different.
     */
    it('any two distinct entity types have different styles (color, borderColor, shape)', () => {
        fc.assert(
            fc.property(distinctEntityTypePairArb, ([typeA, typeB]) => {
                const styleA = ENTITY_STYLES[typeA]
                const styleB = ENTITY_STYLES[typeB]

                // Both styles must exist
                expect(styleA).toBeDefined()
                expect(styleB).toBeDefined()

                // At least one visual property must differ (in practice all differ)
                const colorDiff = styleA.color !== styleB.color
                const borderDiff = styleA.borderColor !== styleB.borderColor
                const shapeDiff = styleA.shape !== styleB.shape

                expect(colorDiff || borderDiff || shapeDiff).toBe(true)
            }),
            { numRuns: 100 },
        )
    })
})

describe('Feature: frontend-ux-overhaul, Property 10: 节点点击高亮正确邻接', () => {
    /**
     * **Validates: Requirements 9.4**
     *
     * For any node in the knowledge graph, clicking that node should highlight
     * exactly the edges directly connected to it, and the highlighted node set
     * should be exactly the other endpoints of those edges plus the clicked node itself.
     */
    it('highlighted edges are exactly those incident to clicked node, highlighted nodes are their endpoints plus clicked node', () => {
        fc.assert(
            fc.property(graphArb, ({ clickedNode, edges }) => {
                const { highlightedNodeIds, highlightedEdgeIds } = getHighlightSets(clickedNode, edges)

                // Compute expected sets manually
                const expectedEdgeIds = new Set<string>()
                const expectedNodeIds = new Set<string>([clickedNode])

                for (const edge of edges) {
                    if (edge.source === clickedNode || edge.target === clickedNode) {
                        expectedEdgeIds.add(edge.id)
                        expectedNodeIds.add(edge.source)
                        expectedNodeIds.add(edge.target)
                    }
                }

                // Highlighted edges should be exactly the incident edges
                expect(highlightedEdgeIds).toEqual(expectedEdgeIds)

                // Highlighted nodes should be exactly endpoints + clicked node
                expect(highlightedNodeIds).toEqual(expectedNodeIds)
            }),
            { numRuns: 100 },
        )
    })

    it('clicked node is always in the highlighted set even with no edges', () => {
        fc.assert(
            fc.property(nodeIdArb, (nodeId) => {
                const { highlightedNodeIds, highlightedEdgeIds } = getHighlightSets(nodeId, [])

                expect(highlightedNodeIds.has(nodeId)).toBe(true)
                expect(highlightedNodeIds.size).toBe(1)
                expect(highlightedEdgeIds.size).toBe(0)
            }),
            { numRuns: 100 },
        )
    })
})

describe('Feature: frontend-ux-overhaul, Property 11: 事件时间线排序', () => {
    /**
     * **Validates: Requirements 9.5**
     *
     * For any event list, events in the timeline view should be sorted
     * by chapter field in ascending order.
     */
    it('sorted events have chapters in non-decreasing order', () => {
        fc.assert(
            fc.property(eventListArb, (events) => {
                const sorted = sortEventsByChapter(events)

                // Length preserved
                expect(sorted).toHaveLength(events.length)

                // Ascending chapter order
                for (let i = 1; i < sorted.length; i++) {
                    expect(sorted[i].chapter).toBeGreaterThanOrEqual(sorted[i - 1].chapter)
                }
            }),
            { numRuns: 100 },
        )
    })

    it('sorting does not mutate the original array', () => {
        fc.assert(
            fc.property(eventListArb, (events) => {
                const originalChapters = events.map((e) => e.chapter)
                sortEventsByChapter(events)
                const afterChapters = events.map((e) => e.chapter)

                expect(afterChapters).toEqual(originalChapters)
            }),
            { numRuns: 100 },
        )
    })

    it('sorted output is a permutation of the input (same elements)', () => {
        fc.assert(
            fc.property(eventListArb, (events) => {
                const sorted = sortEventsByChapter(events)

                // Same event_ids (as multiset)
                const inputIds = events.map((e) => e.event_id).sort()
                const sortedIds = sorted.map((e) => e.event_id).sort()
                expect(sortedIds).toEqual(inputIds)
            }),
            { numRuns: 100 },
        )
    })
})


// === Property 1 Generators ===

/** Generate an EntityNode with a given name */
function entityNodeArb(name: string): fc.Arbitrary<EntityNode> {
    return fc.record({
        entity_id: fc.uuid(),
        entity_type: fc.constantFrom('character', 'location', 'item'),
        name: fc.constant(name),
        attrs: fc.constant({}),
        first_seen_chapter: fc.integer({ min: 1, max: 100 }),
        last_seen_chapter: fc.integer({ min: 1, max: 100 }),
    })
}

/** Generate a list of entities with unique names, and events that reference those names */
const entitiesAndEventsArb = fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0), {
        minLength: 2,
        maxLength: 10,
        comparator: (a, b) => a === b,
    })
    .chain((names) => {
        const entitiesArb = fc.tuple(...names.map((n) => entityNodeArb(n)))
        const eventsArb = fc.array(
            fc.record({
                event_id: fc.uuid(),
                subject: fc.constantFrom(...names),
                relation: fc.string({ minLength: 1, maxLength: 20 }),
                object: fc.constantFrom(...names),
                chapter: fc.integer({ min: 1, max: 100 }),
                description: fc.string({ minLength: 0, maxLength: 50 }),
            }),
            { minLength: 1, maxLength: 20 },
        )
        return fc.record({
            entities: entitiesArb,
            events: eventsArb,
        })
    })

// === Dark theme values that must NOT appear ===
const DARK_THEME_VALUES = [
    'rgba(255, 255, 255, 0.2)',
    '#e8edf5',
    'rgba(38, 38, 40,',
]

// === Property 1 Tests ===

describe('Feature: frontend-visual-consistency, Property 1: 图谱边样式一致性', () => {
    /**
     * **Validates: Requirements 2.1, 2.4**
     *
     * For any entity list and event list, buildGraphEdges should produce edges
     * that use bright theme stroke color (based on --glass-border value) and
     * label styles (--text-secondary text color, bright background), with NO
     * dark theme hardcoded values.
     */
    it('all edges use bright theme stroke, label, and marker styles', () => {
        fc.assert(
            fc.property(entitiesAndEventsArb, ({ entities, events }) => {
                const edges = buildGraphEdges(events, entities)

                for (const edge of edges) {
                    // a. edge.style.stroke === 'rgba(102, 124, 164, 0.3)'
                    expect((edge.style as Record<string, unknown>)?.stroke).toBe('rgba(102, 124, 164, 0.3)')

                    // b. edge.style.strokeWidth === 1.5
                    expect((edge.style as Record<string, unknown>)?.strokeWidth).toBe(1.5)

                    // c. edge.labelStyle.fill === '#5a6e8d'
                    expect((edge.labelStyle as Record<string, unknown>)?.fill).toBe('#5a6e8d')

                    // d. edge.labelBgStyle.fill === 'rgba(255, 255, 255, 0.9)'
                    expect((edge.labelBgStyle as Record<string, unknown>)?.fill).toBe('rgba(255, 255, 255, 0.9)')

                    // e. edge.markerEnd.color === 'rgba(102, 124, 164, 0.3)'
                    expect((edge.markerEnd as Record<string, unknown>)?.color).toBe('rgba(102, 124, 164, 0.3)')
                }
            }),
            { numRuns: 100 },
        )
    })

    it('no dark theme hardcoded values appear in any edge style', () => {
        fc.assert(
            fc.property(entitiesAndEventsArb, ({ entities, events }) => {
                const edges = buildGraphEdges(events, entities)

                for (const edge of edges) {
                    const styleValues = [
                        (edge.style as Record<string, unknown>)?.stroke,
                        (edge.labelStyle as Record<string, unknown>)?.fill,
                        (edge.labelBgStyle as Record<string, unknown>)?.fill,
                        (edge.markerEnd as Record<string, unknown>)?.color,
                    ]
                        .filter(Boolean)
                        .map(String)

                    for (const val of styleValues) {
                        for (const dark of DARK_THEME_VALUES) {
                            expect(val.includes(dark)).toBe(false)
                        }
                    }
                }
            }),
            { numRuns: 100 },
        )
    })
})
