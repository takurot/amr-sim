import { describe, it, expect } from 'vitest'
import {
  getLoopEdges,
  isHorizontal,
  mapProgressToLoop,
  advanceAlongEdge,
  type LoopName,
  positionFromEdge,
  segmentIntersectsShelves,
} from './edgeEngine'

describe('edgeEngine: edge definitions', () => {
  it('getLoopEdges returns 4 edges with correct orientations and chaining', () => {
    const edges = getLoopEdges('center')
    expect(edges.length).toBe(4)
    // Expected order: 0=top(H), 1=right(V), 2=bottom(H), 3=left(V)
    expect(isHorizontal(edges[0])).toBe(true)
    expect(isHorizontal(edges[1])).toBe(false)
    expect(isHorizontal(edges[2])).toBe(true)
    expect(isHorizontal(edges[3])).toBe(false)

    // next/prev consistency (clockwise)
    expect(edges[0].nextEdgeId).toBe(1)
    expect(edges[1].nextEdgeId).toBe(2)
    expect(edges[2].nextEdgeId).toBe(3)
    expect(edges[3].nextEdgeId).toBe(0)

    expect(edges[0].prevEdgeId).toBe(3)
    expect(edges[1].prevEdgeId).toBe(0)
    expect(edges[2].prevEdgeId).toBe(1)
    expect(edges[3].prevEdgeId).toBe(2)

    // lengths are positive
    for (const e of edges) {
      expect(e.length).toBeGreaterThan(0)
    }
  })
})

describe('edgeEngine: mapping progress between loops (horizontal only)', () => {
  it('preserves relative progress t when mapping between loops on the same horizontal edge', () => {
    const srcLoop: LoopName = 'center'
    const dstLoop: LoopName = 'leftOuter'
    const edges = getLoopEdges(srcLoop)
    const topEdge = edges[0]
    const s = topEdge.length * 0.3
    const { dstEdgeId, edgeS } = mapProgressToLoop(srcLoop, dstLoop, 0, s / topEdge.length)
    const dstEdges = getLoopEdges(dstLoop)
    expect(dstEdgeId).toBe(0) // top to top
    expect(edgeS).toBeCloseTo(dstEdges[0].length * 0.3, 1)
  })
})

describe('edgeEngine: advanceAlongEdge carry-over at corners', () => {
  it('carries residual absolute distance to the next edge (clockwise)', () => {
    const loop: LoopName = 'center'
    const edges = getLoopEdges(loop)
    const state = { loop, edgeId: 0, edgeDir: 1 as const, edgeS: 0 } // on top edge, moving right
    const ds = edges[0].length * 1.2
    advanceAlongEdge(state, ds)
    expect(state.edgeId).toBe(1) // moved onto right edge
    // residual distance is 20% of previous edge length, carried as-is in px
    expect(state.edgeS).toBeCloseTo(edges[0].length * 0.2, 1)
  })

  it('supports reverse direction (counter-clockwise)', () => {
    const loop: LoopName = 'center'
    const edges = getLoopEdges(loop)
    const state = { loop, edgeId: 0, edgeDir: -1 as const, edgeS: edges[0].length } // on top edge end, moving left
    const ds = edges[0].length * 0.5
    advanceAlongEdge(state, ds)
    expect(state.edgeId).toBe(0) // still on top edge
    expect(state.edgeS).toBeCloseTo(edges[0].length * 0.5, 1)
  })
})

describe('edgeEngine: positionFromEdge', () => {
  it('reconstructs coordinates from edge progress', () => {
    const loop: LoopName = 'center'
    const edges = getLoopEdges(loop)
    // top edge from minX to maxX at y=topY
    const p0 = positionFromEdge(loop, 0, 0)
    const p1 = positionFromEdge(loop, 0, edges[0].length)
    expect(p0.y).toBe(edges[0].fixedCoord)
    expect(p1.y).toBe(edges[0].fixedCoord)
    expect(p1.x).toBeGreaterThan(p0.x)

    // right edge from topY to botY at x=maxX
    const r0 = positionFromEdge(loop, 1, 0)
    const r1 = positionFromEdge(loop, 1, edges[1].length)
    expect(r0.x).toBe(edges[1].fixedCoord)
    expect(r1.x).toBe(edges[1].fixedCoord)
    expect(r1.y).toBeGreaterThan(r0.y)
  })
})

describe('edgeEngine: mapProgressToLoop bottom edge mapping', () => {
  it('maps bottom (edge 2) with preserved t', () => {
    const src: LoopName = 'center'
    const dst: LoopName = 'rightOuter'
    const t = 0.75
    const { dstEdgeId, edgeS } = mapProgressToLoop(src, dst, 2, t)
    const dstEdges = getLoopEdges(dst)
    expect(dstEdgeId).toBe(2)
    expect(edgeS).toBeCloseTo(dstEdges[2].length * t, 1)
  })
})

describe('edgeEngine: segmentIntersectsShelves', () => {
  it('detects intersection with shelf AABB region', () => {
    // 棚の中心付近を通る垂直線（第三棚 433.6 付近）
    const x = 434
    const p0 = { x, y: 0 }
    const p1 = { x, y: 640 }
    expect(segmentIntersectsShelves(p0, p1)).toBe(true)
  })

  it('returns false for a segment entirely outside shelf bands', () => {
    // segment on far left margin vertical line where no shelves exist
    const x = 10
    const p0 = { x, y: 0 }
    const p1 = { x, y: 640 }
    expect(segmentIntersectsShelves(p0, p1)).toBe(false)
  })
})


