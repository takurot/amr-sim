export type LoopName = 'leftOuter' | 'leftMid' | 'center' | 'rightMid' | 'rightOuter'

export type Edge = {
  orientation: 'horizontal' | 'vertical'
  fixedCoord: number
  from: number
  to: number
  length: number
  nextEdgeId: number
  prevEdgeId: number
}

// 画面設計と棚配置はApp.tsx準拠
const W = 1024
const H = 640
const SHELF_W = 120
const SHELF_H = 300
const CY = Math.floor(H * 0.55)
const SHELF_COLS = 6
const MARGIN_X = 60
const usableW = W - MARGIN_X * 2
const gapBetween = (usableW - SHELF_COLS * SHELF_W) / (SHELF_COLS - 1)
const SHELF_XS = new Array(SHELF_COLS)
  .fill(0)
  .map((_, i) => MARGIN_X + i * (SHELF_W + gapBetween) + SHELF_W / 2)
const AISLE_CENTER_XS = new Array(SHELF_COLS - 1)
  .fill(0)
  .map((_, i) => (SHELF_XS[i] + SHELF_XS[i + 1]) / 2)

const CONNECTORS = [
  { name: 'leftOuter', x: AISLE_CENTER_XS[0] },
  { name: 'leftMid', x: AISLE_CENTER_XS[1] },
  { name: 'center', x: AISLE_CENTER_XS[2] },
  { name: 'rightMid', x: AISLE_CENTER_XS[3] },
  { name: 'rightOuter', x: AISLE_CENTER_XS[4] },
] as const

type ConnectorName = (typeof CONNECTORS)[number]['name']

const PAIRS: Record<LoopName, [ConnectorName, ConnectorName]> = {
  leftOuter: ['leftOuter', 'leftMid'],
  leftMid: ['leftMid', 'center'],
  center: ['center', 'rightMid'],
  rightMid: ['rightMid', 'center'],
  rightOuter: ['rightMid', 'rightOuter'],
}

function xOf(name: ConnectorName) { return CONNECTORS.find(c => c.name === name)!.x }

function topBottomY() {
  const topY = CY - SHELF_H / 2 - 60
  const botY = CY + SHELF_H / 2 + 60
  return { topY, botY }
}

export function getLoopEdges(loop: LoopName): Edge[] {
  const [a, b] = PAIRS[loop]
  const x1 = xOf(a)
  const x2 = xOf(b)
  const { topY, botY } = topBottomY()

  const top: Edge = {
    orientation: 'horizontal', fixedCoord: topY,
    from: Math.min(x1, x2), to: Math.max(x1, x2),
    length: Math.abs(x2 - x1), nextEdgeId: 1, prevEdgeId: 3,
  }
  const right: Edge = {
    orientation: 'vertical', fixedCoord: Math.max(x1, x2),
    from: topY, to: botY,
    length: Math.abs(botY - topY), nextEdgeId: 2, prevEdgeId: 0,
  }
  const bottom: Edge = {
    orientation: 'horizontal', fixedCoord: botY,
    from: Math.max(x1, x2), to: Math.min(x1, x2),
    length: Math.abs(x2 - x1), nextEdgeId: 3, prevEdgeId: 1,
  }
  const left: Edge = {
    orientation: 'vertical', fixedCoord: Math.min(x1, x2),
    from: botY, to: topY,
    length: Math.abs(botY - topY), nextEdgeId: 0, prevEdgeId: 2,
  }
  return [top, right, bottom, left]
}

export function isHorizontal(e: Edge) { return e.orientation === 'horizontal' }

export function mapProgressToLoop(srcLoop: LoopName, dstLoop: LoopName, edgeId: number, t: number): { dstEdgeId: number, edgeS: number } {
  const srcEdges = getLoopEdges(srcLoop)
  if (!isHorizontal(srcEdges[edgeId])) throw new Error('mapping only allowed on horizontal edges')
  const dstEdges = getLoopEdges(dstLoop)
  const dstEdgeId = edgeId // top->top(0), bottom->bottom(2)
  const length = dstEdges[dstEdgeId].length
  const edgeS = Math.max(0, Math.min(1, t)) * length
  return { dstEdgeId, edgeS }
}

export function advanceAlongEdge(state: { loop: LoopName, edgeId: number, edgeDir: 1 | -1, edgeS: number }, ds: number): void {
  let remaining = Math.max(0, ds)
  while (remaining > 0) {
    const edges = getLoopEdges(state.loop)
    const edge = edges[state.edgeId]
    const s = state.edgeS
    const forward = state.edgeDir === 1
    const toEnd = forward ? (edge.length - s) : s
    if (remaining <= toEnd) {
      state.edgeS = forward ? (s + remaining) : (s - remaining)
      remaining = 0
    } else {
      // consume to the corner
      state.edgeS = forward ? edge.length : 0
      remaining -= toEnd
      // step to next edge
      state.edgeId = forward ? edge.nextEdgeId : edge.prevEdgeId
      // set starting s on new edge
      const newEdge = edges[state.edgeId]
      state.edgeS = forward ? 0 : newEdge.length
    }
  }
}

export function positionFromEdge(loop: LoopName, edgeId: number, edgeS: number): { x: number, y: number } {
  const e = getLoopEdges(loop)[edgeId]
  const s = Math.max(0, Math.min(e.length, edgeS))
  if (e.orientation === 'horizontal') {
    const dir = e.to >= e.from ? 1 : -1
    const x = e.from + dir * s
    return { x, y: e.fixedCoord }
  } else {
    const dir = e.to >= e.from ? 1 : -1
    const y = e.from + dir * s
    return { x: e.fixedCoord, y }
  }
}

// AABB 群（棚）と線分の交差（粗いガード）
export function segmentIntersectsShelves(p0: { x: number, y: number }, p1: { x: number, y: number }): boolean {
  // 棚矩形: 中心 x=SHELF_XS[i], y=CY, 幅=SHELF_W, 高さ=SHELF_H
  const rects = SHELF_XS.map((cx) => ({
    left: cx - SHELF_W / 2,
    right: cx + SHELF_W / 2,
    top: CY - SHELF_H / 2,
    bottom: CY + SHELF_H / 2,
  }))

  // 線分とAABB交差（Liang–Barsky風の簡易判定）
  const x0 = p0.x, y0 = p0.y, x1 = p1.x, y1 = p1.y
  for (const r of rects) {
    const dx = x1 - x0
    const dy = y1 - y0
    let t0 = 0
    let t1 = 1
    const clip = (p: number, q: number) => {
      if (p === 0) return q < 0 ? false : true
      const t = q / p
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t }
      else { if (t < t0) return false; if (t < t1) t1 = t }
      return true
    }
    if (
      clip(-dx, x0 - r.left) &&
      clip(dx, r.right - x0) &&
      clip(-dy, y0 - r.top) &&
      clip(dy, r.bottom - y0)
    ) {
      if (t0 <= t1 && !(t1 < 0 || t0 > 1)) return true
    }
  }
  return false
}


