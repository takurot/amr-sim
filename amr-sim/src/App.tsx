import { useEffect, useRef } from "react";
import { getLoopEdges, positionFromEdge, advanceAlongEdge, isHorizontal, mapProgressToLoop, segmentIntersectsShelves } from "./edgeEngine";

// === CONFIG ===
// 障害物は固定（中央通路の真ん中）。キー「1」押下中のみ有効。

// 速度倍率（全体スケール）
const SPEED_MULT = 3;      // ← ここを 1,2,3... に変えるだけで全体速度を調整
const BASE_SPEED = 120;    // 単位: px/s（倍率適用前）
const SPEED_JITTER = 40;   // 個体差（±ランダム）
// ルート切替の水平スライドは距離に依存しない“px/s”で一定速度にする
const TRANSITION_VEL = 220 * SPEED_MULT; // px/s

const W = 1024;
const H = 640;
const SHELF_W = 120;
const SHELF_H = 300;
const CY = Math.floor(H * 0.55);

const SHELF_COLS = 6;
const MARGIN_X = 60;
const usableW = W - MARGIN_X * 2;
const gapBetween = (usableW - SHELF_COLS * SHELF_W) / (SHELF_COLS - 1);
const SHELF_XS = new Array(SHELF_COLS)
  .fill(0)
  .map((_, i) => MARGIN_X + i * (SHELF_W + gapBetween) + SHELF_W / 2);

const AISLE_CENTER_XS = new Array(SHELF_COLS - 1)
  .fill(0)
  .map((_, i) => (SHELF_XS[i] + SHELF_XS[i + 1]) / 2);

const CONNECTORS = [
  { name: "leftOuter", x: AISLE_CENTER_XS[0] },
  { name: "leftMid", x: AISLE_CENTER_XS[1] },
  { name: "center", x: AISLE_CENTER_XS[2] },
  { name: "rightMid", x: AISLE_CENTER_XS[3] },
  { name: "rightOuter", x: AISLE_CENTER_XS[4] },
] as const;

type ConnectorName = (typeof CONNECTORS)[number]["name"];

type LoopName = "leftOuter" | "leftMid" | "center" | "rightMid" | "rightOuter";

const ROBOTS = [
  { color: "#ff0000" },
  { color: "#00a2ff" },
  { color: "#00ff66" },
];

const RADIUS = 12;
const OBSTACLE_RADIUS = 28;
const USE_EDGE_ENGINE = (import.meta.env.VITE_EDGE_ENGINE ?? '1') !== '0';

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function clamp(v:number,a:number,b:number){ return Math.max(a, Math.min(b, v)); }

function segmentIntersectsCircle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  const abx = bx - ax;
  const aby = by - ay;
  const lab2 = abx * abx + aby * aby;
  if (lab2 === 0) {
    return Math.hypot(ax - cx, ay - cy) <= radius;
  }
  const t = clamp(((cx - ax) * abx + (cy - ay) * aby) / lab2, 0, 1);
  const px = ax + abx * t;
  const py = ay + aby * t;
  return Math.hypot(px - cx, py - cy) <= radius;
}

function isCentralLoop(loop: LoopName) {
  return loop === "leftMid" || loop === "center" || loop === "rightMid";
}

const PAIRS: Record<LoopName, [ConnectorName, ConnectorName]> = {
  leftOuter: ["leftOuter", "leftMid"],
  leftMid: ["leftMid", "center"],
  center: ["center", "rightMid"],
  rightMid: ["rightMid", "center"],
  rightOuter: ["rightMid", "rightOuter"],
};

function xOf(name: ConnectorName) { return CONNECTORS.find((c) => c.name === name)!.x; }

function makeLoopWaypoints(loopName: LoopName) {
  const [a, b] = PAIRS[loopName];
  const x1 = xOf(a), x2 = xOf(b);
  const topY = CY - SHELF_H / 2 - 60; // 上連絡路
  const botY = CY + SHELF_H / 2 + 60; // 下連絡路
  return [
    { x: x1, y: topY },  // 0 左上
    { x: x2, y: topY },  // 1 右上
    { x: x2, y: botY },  // 2 右下
    { x: x1, y: botY },  // 3 左下
  ];
}

const DETOUR_MAP: Record<LoopName, LoopName> = {
  leftOuter: "leftOuter",
  leftMid: "leftOuter",
  center: "leftOuter",
  rightMid: "rightOuter",
  rightOuter: "rightOuter",
};
function chooseDetourFor(defaultLoop: LoopName): LoopName { return DETOUR_MAP[defaultLoop]; }

// 現在の水平エッジ上に居るかと、その相対位置t(0..1)を返す
function horizontalRel(loop: LoopName, pos:{x:number;y:number}, targetIdx:number){
  const path = makeLoopWaypoints(loop);
  const topY = path[0].y, botY = path[2].y; const x1=path[0].x, x2=path[1].x;
  const eps = 1.0; // 1px 以内で水平エッジとみなす
  const onTop = (targetIdx === 1 || targetIdx === 0) && Math.abs(pos.y - topY) < eps;
  if (onTop){
    const t = clamp((pos.x - x1) / (x2 - x1), 0, 1);
    return { edge:"top" as const, t, y: topY, from:x1, to:x2 };
  }
  const onBottom = (targetIdx === 3 || targetIdx === 2) && Math.abs(pos.y - botY) < eps;
  if (onBottom){
    const t = clamp((pos.x - x1) / (x2 - x1), 0, 1);
    return { edge:"bottom" as const, t, y: botY, from:x2, to:x1 };
  }
  return null;
}

// --- 簡易セルフテスト（実行コスト小） ---
function runSelfTests() {
  const errs: string[] = [];
  if (CONNECTORS.length !== 5) errs.push("CONNECTORS length should be 5");
  const names = CONNECTORS.map(c=>c.name).join(',');
  if (names !== 'leftOuter,leftMid,center,rightMid,rightOuter') errs.push("connector order mismatch");
  const pts = makeLoopWaypoints('center');
  if (pts.length !== 4) errs.push("waypoints length != 4");
  const hr = horizontalRel('leftMid', {x: pts[0].x, y: pts[0].y}, 1);
  if (!hr || hr.edge !== 'top') errs.push("horizontalRel top edge failed");
  // 追加テスト：DETOUR_MAP の妥当性
  (Object.keys(DETOUR_MAP) as LoopName[]).forEach(k => { if (!(DETOUR_MAP[k] in PAIRS)) errs.push('detour map invalid: '+k); });
  if (BASE_SPEED <= 0) errs.push('BASE_SPEED must be > 0');
  if (errs.length) console.error('[AMR self-tests] FAILED:', errs); else console.log('[AMR self-tests] OK');
}

const POLL_ENDPOINT = import.meta.env.VITE_OBSTACLE_ENDPOINT ?? "/obstacle";
const POLL_INTERVAL_MS = 1000;

export default function AMRSimulator() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailRef = useRef<HTMLCanvasElement | null>(null);
  const debugHoldRef = useRef(false);
  const obstacleServerRef = useRef(false);
  const obstacleTriggeredRef = useRef(false);

  // キー入力（1で障害ON/OFF）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "1") debugHoldRef.current = true; };
    const onKeyUp   = (e: KeyboardEvent) => { if (e.key === "1") debugHoldRef.current = false; };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); };
  }, []);

  // サーバーから障害物状態を取得して参照を更新
  useEffect(() => {
    let mounted = true;

    async function pollOnce() {
      try {
        const res = await fetch(POLL_ENDPOINT, { cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const text = await res.text();
        if (!mounted) return;
        obstacleServerRef.current = text.trim() === "1";
      } catch (err) {
        if (!mounted) return;
        obstacleServerRef.current = false;
        console.warn("[AMR] obstacle polling failed", err);
      }
      if (!debugHoldRef.current && !obstacleServerRef.current) {
        obstacleTriggeredRef.current = false;
      }
    }

    pollOnce();
    const id = setInterval(pollOnce, POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const cv = canvasRef.current!;
    const ctx = cv.getContext("2d")!;

    // オーバーレイ用キャンバスは DOM には挿入せず、オフスクリーンで生成
    const trail = document.createElement("canvas");
    trail.width = W;
    trail.height = H;
    trailRef.current = trail;
    const tctx = trail.getContext("2d")!;

    cv.width = W;
    cv.height = H;

    runSelfTests();

    type Bot = {
      color: string;
      pos: { x: number; y: number };
      prev: { x: number; y: number }; // 直前位置（線分描画用）
      speed: number;
      path: { x: number; y: number }[];
      idx: number;              // 次に目指す頂点のインデックス（0..3）
      loop: LoopName;
      defaultLoop: LoopName;
      lastIdx: number;          // ラップ判定
      reroutePending?: boolean; // 水平エッジに入ったら迂回開始
      restorePending?: boolean; // 水平エッジに入ったら復帰開始
      transition?: { to: LoopName; edge: 'top'|'bottom'; startX:number; targetX:number; y:number; progress: number };
      justPushed?: boolean; // 障害物ON時に押し出されたばかりか
      // Edge Engine 状態
      edgeId?: number;   // 0..3
      edgeDir?: 1 | -1;  // 時計=1 / 反時計=-1
      edgeS?: number;    // 0..length
      justSwitched?: boolean;
      edgeTransition?: { toLoop: LoopName; dstEdgeId: number; dstEdgeS: number; startX: number; targetX: number; y: number; progress: number };
      obstacleGrace?: number; // 衝突直後の数フレームは再衝突チェックをスキップ
    };

    const pickStart: LoopName[] = ["leftMid", "center", "rightMid"];

    function setEdgeDirAwayFromCenter(b: Bot) {
      const edges = getLoopEdges(b.loop);
      const e = edges[b.edgeId!];
      const paramDir = e.to >= e.from ? 1 : -1; // +1: 座標はs増加で増える
      if (e.orientation === 'horizontal') {
        const wantIncrease = b.pos.x >= xOf('center'); // 中心より右 → さらに右へ
        b.edgeDir = wantIncrease ? (paramDir === 1 ? 1 : -1) : (paramDir === 1 ? -1 : 1);
      } else {
        const wantIncrease = b.pos.y >= CY; // 中心より下 → さらに下へ
        b.edgeDir = wantIncrease ? (paramDir === 1 ? 1 : -1) : (paramDir === 1 ? -1 : 1);
      }
    }
    const bots: Bot[] = ROBOTS.map((r, i) => {
      const loop = pickStart[i % pickStart.length];
      const path = makeLoopWaypoints(loop);
      const bot: Bot = {
        color: r.color,
        pos: { x: path[0].x, y: path[0].y },
        prev: { x: path[0].x, y: path[0].y },
        speed: (BASE_SPEED + Math.random() * SPEED_JITTER) * SPEED_MULT,
        path,
        idx: 1,
        loop,
        defaultLoop: loop,
        lastIdx: 1,
      };
      if (USE_EDGE_ENGINE) {
        bot.edgeId = 0;     // 上辺
        bot.edgeDir = 1;    // 右方向（時計回り）
        bot.edgeS = 0;      // 左端スタート
        const p = positionFromEdge(loop, bot.edgeId, bot.edgeS);
        bot.pos = { x: p.x, y: p.y };
        bot.prev = { x: p.x, y: p.y };
      }
      return bot;
    });

    let last = performance.now();
    let prevActive = false;

    function step(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      const active = debugHoldRef.current || obstacleServerRef.current;

      // 押下を開始したフレームで grace をリセット
      if (active && !prevActive) {
        obstacleTriggeredRef.current = false;
        const centerX = xOf("center");
        const centerY = CY;
        
        for (const b of bots) { 
          b.restorePending = false;
          if (isCentralLoop(b.loop)) {
            if (USE_EDGE_ENGINE) {
              // Edge Engine: 中心から遠ざかる向きに調整し、微小に逃がす
              b.reroutePending = true;
              setEdgeDirAwayFromCenter(b);
              advanceAlongEdge(b as any, 8);
              const pNew = positionFromEdge(b.loop, b.edgeId!, b.edgeS!);
              b.pos = { x: pNew.x, y: pNew.y };
              b.justPushed = true;
              b.obstacleGrace = Math.max(b.obstacleGrace ?? 0, 6);
            } else {
              // 旧ロジック
              const dist = Math.hypot(b.pos.x - centerX, b.pos.y - centerY);
              if (dist <= OBSTACLE_RADIUS) {
                const target = b.path[b.idx];
                const movingUp = target.y < b.pos.y;
                b.pos.y += movingUp ? 15 : -15;
                b.justPushed = true;
              }
              b.reroutePending = true;
              const prevIdx = (b.idx - 1 + b.path.length) % b.path.length;
              b.idx = prevIdx;
              b.lastIdx = prevIdx;
            }
          } else {
            b.reroutePending = false;
          }
        }
      }

      // 障害物OFF時、デフォルトループへ復帰予約（Edge Engine）
      if (USE_EDGE_ENGINE && !active) {
        for (const b of bots) {
          if (b.loop !== b.defaultLoop) {
            b.restorePending = true;
            b.reroutePending = false;
          }
        }
      }

      // --- トレイルをフェード ---
      tctx.save(); tctx.globalCompositeOperation = "source-over"; tctx.globalAlpha = 0.03; tctx.fillStyle = "#000"; tctx.fillRect(0, 0, W, H); tctx.restore();

      // --- 各ボットを更新 ---
      for (const b of bots) {
        // 線分の始点
        const oldX = b.pos.x, oldY = b.pos.y;

        if (USE_EDGE_ENGINE) {
          // Edge Engine: エッジ上の1次元運動 + 切替は水平スライド演出
          const before = { loop: b.loop, edgeId: b.edgeId!, edgeDir: b.edgeDir!, edgeS: b.edgeS! };

          // 既に水平スライド中なら継続
          if (b.edgeTransition) {
            const p = b.edgeTransition;
            const len = Math.max(1, Math.abs(p.targetX - p.startX));
            p.progress = clamp(p.progress + (TRANSITION_VEL / len) * dt, 0, 1);
            b.pos = { x: lerp(p.startX, p.targetX, p.progress), y: p.y };
            if (p.progress >= 1) {
              // 切替確定
              b.loop = p.toLoop;
              b.edgeId = p.dstEdgeId;
              b.edgeS = p.dstEdgeS;
              b.edgeTransition = undefined;
              b.justSwitched = true;
            }
          } else {
            // 通常前進
            const ds = b.speed * dt;
            advanceAlongEdge(b as any, ds);

            // 予約済みの切替（水平エッジのみ）
            const edgesNow = getLoopEdges(b.loop);
            const e = edgesNow[b.edgeId!];
            if (isHorizontal(e)) {
              if (b.reroutePending) {
                const to = chooseDetourFor(b.defaultLoop);
                if (to !== b.loop) {
                  const tRel = e.length === 0 ? 0 : (b.edgeS! / e.length);
                  const { dstEdgeId, edgeS } = mapProgressToLoop(b.loop, to, b.edgeId!, tRel);
                  const dstEdges = getLoopEdges(to);
                  const dst = dstEdges[dstEdgeId];
                  const start = positionFromEdge(b.loop, b.edgeId!, b.edgeS!);
                  const targetX = dst.from <= dst.to ? (dst.from + tRel * dst.length) : (dst.from - tRel * dst.length);
                  b.edgeTransition = { toLoop: to, dstEdgeId, dstEdgeS: edgeS, startX: start.x, targetX, y: e.fixedCoord, progress: 0 };
                  b.reroutePending = false;
                } else {
                  b.reroutePending = false;
                }
              } else if (b.restorePending && !active) {
                const to = b.defaultLoop;
                const tRel = e.length === 0 ? 0 : (b.edgeS! / e.length);
                const { dstEdgeId, edgeS } = mapProgressToLoop(b.loop, to, b.edgeId!, tRel);
                const dstEdges = getLoopEdges(to);
                const dst = dstEdges[dstEdgeId];
                const start = positionFromEdge(b.loop, b.edgeId!, b.edgeS!);
                const targetX = dst.from <= dst.to ? (dst.from + tRel * dst.length) : (dst.from - tRel * dst.length);
                b.edgeTransition = { toLoop: to, dstEdgeId, dstEdgeS: edgeS, startX: start.x, targetX, y: e.fixedCoord, progress: 0 };
                b.restorePending = false;
              }
            }

            // 新しい座標へ反映（スライド開始していなければ）
            if (!b.edgeTransition) {
              const pNew = positionFromEdge(b.loop, b.edgeId!, b.edgeS!);
              const newX = pNew.x, newY = pNew.y;
              // 円形障害物ヒットチェック（中央系ループのみ）
              let collided = false;
              if (active && isCentralLoop(b.loop) && !(b.obstacleGrace && b.obstacleGrace > 0)) {
                const centerX = xOf("center");
                const centerY = CY;
                const hitObstacle = segmentIntersectsCircle(
                  oldX, oldY, newX, newY,
                  centerX, centerY, OBSTACLE_RADIUS,
                );
                const inObstacleZone = Math.hypot(newX - centerX, newY - centerY) <= OBSTACLE_RADIUS;
                if ((hitObstacle || inObstacleZone) && !b.justPushed) {
                  // ロールバックして逆走、迂回予約
                  b.loop = before.loop;
                  b.edgeId = before.edgeId;
                  b.edgeS = before.edgeS;
                  setEdgeDirAwayFromCenter(b);
                  // 微小逃がし
                  advanceAlongEdge(b as any, 8);
                  b.reroutePending = true;
                  b.restorePending = false;
                  b.justPushed = true;
                  b.obstacleGrace = 3; // 次の3フレームは再判定をスキップ
                  collided = true;
                  if (!obstacleTriggeredRef.current) {
                    obstacleTriggeredRef.current = true;
                    for (const ob of bots) {
                      if (isCentralLoop(ob.loop) && !ob.reroutePending) {
                        ob.reroutePending = true;
                        ob.restorePending = false;
                      }
                    }
                  }
                }
              }

              if (!collided && segmentIntersectsShelves({ x: oldX, y: oldY }, { x: newX, y: newY })) {
                b.loop = before.loop;
                b.edgeId = before.edgeId;
                b.edgeDir = before.edgeDir;
                b.edgeS = before.edgeS;
              } else {
                b.pos = { x: newX, y: newY };
              }
            }
          }
        } else {
          // 旧ロジック: 角-頂点ベクトル移動
          // 1) ルート横移動トランジション中はXのみ補間（水平通路上）。斜め禁止。
          if (b.transition) {
            const p = b.transition;
            const len = Math.max(1, Math.abs(p.targetX - p.startX));
            b.transition.progress = clamp(b.transition.progress + (TRANSITION_VEL / len) * dt, 0, 1);
            b.pos = { x: lerp(p.startX, p.targetX, b.transition.progress), y: p.y };
            if (b.transition.progress >= 1) {
              b.loop = p.to; b.path = makeLoopWaypoints(p.to);
              b.idx = (p.edge === 'top') ? 1 : 3;
              b.transition = undefined;
            }
          } else {
            // 2) 通常の矩形周回
            const target = b.path[b.idx];
            const dx = target.x - b.pos.x;
            const dy = target.y - b.pos.y;
            const v = b.speed * dt;
            const d = Math.hypot(dx, dy);
            if (d <= v) {
              b.pos = { x: target.x, y: target.y };
              if (isCentralLoop(b.loop) && b.reroutePending) {
                b.idx = (b.idx - 1 + b.path.length) % b.path.length;
              } else {
                b.idx = (b.idx + 1) % b.path.length;
              }
            } else {
              b.pos.x += dx / d * v;
              b.pos.y += dy / d * v;
            }
          }
        }

        // ラップ境界検出（旧ロジックのみ）
        if (!USE_EDGE_ENGINE) {
          const wrapped = b.lastIdx > b.idx; b.lastIdx = b.idx;
          if (wrapped) {
            if (active && isCentralLoop(b.loop)) {
              b.reroutePending = true;
            } else if (!active) {
              if (b.loop !== b.defaultLoop) { 
                b.restorePending = true; 
                b.reroutePending = false; 
              }
            }
          }
        }

        // 障害物との衝突・侵入チェック（中央ループのみ）
        const centerX = xOf("center");
        const centerY = CY;
        
        if (!USE_EDGE_ENGINE && active && isCentralLoop(b.loop)) {
          // 移動軌跡での衝突チェック
          const hitObstacle = segmentIntersectsCircle(
            oldX,
            oldY,
            b.pos.x,
            b.pos.y,
            centerX,
            centerY,
            OBSTACLE_RADIUS,
          );
          
          // 現在位置での障害物圏内チェック
          const inObstacleZone = Math.hypot(b.pos.x - centerX, b.pos.y - centerY) <= OBSTACLE_RADIUS;
          
          if ((hitObstacle || inObstacleZone) && !b.justPushed) {
            // 衝突時は直前位置に戻し、逆方向に向かう
            b.pos = { x: oldX, y: oldY };
            b.idx = (b.idx - 1 + b.path.length) % b.path.length;
            
            // 迂回フラグを設定
            if (!b.reroutePending) {
              b.reroutePending = true;
              b.restorePending = false;
            }
            
            // 初回衝突時のみ他AMRに迂回情報を共有
            if (!obstacleTriggeredRef.current) {
              obstacleTriggeredRef.current = true;
              for (const ob of bots) {
                if (isCentralLoop(ob.loop) && !ob.reroutePending) {
                  ob.reroutePending = true;
                  ob.restorePending = false;
                }
              }
            }
          }
        }


        // 3) 予約済みの切替を実行（旧ロジック 水平エッジ上でのみ）
        if (!USE_EDGE_ENGINE && !b.transition) {
          const rel = horizontalRel(b.loop, b.pos, b.idx);
          if (rel) {
            if (b.reroutePending) {
              // 迂回処理
              const to = chooseDetourFor(b.defaultLoop);
              if (to !== b.loop) {
                const newPath = makeLoopWaypoints(to);
                const targetX = rel.edge === 'top'
                  ? newPath[0].x
                  : newPath[2].x;
                b.transition = { to, edge: rel.edge, startX: b.pos.x, targetX, y: rel.y, progress: 0 };
                b.reroutePending = false;
                b.idx = rel.edge === 'top' ? 0 : 2;
              } else {
                b.reroutePending = false;
              }
            } else if (b.restorePending && !active) {
              // 復帰処理（障害物がOFFの時のみ）
              const to = b.defaultLoop;
              const newPath = makeLoopWaypoints(to);
              const targetX = (rel.edge === 'top')
                ? lerp(newPath[0].x, newPath[1].x, rel.t)
                : lerp(newPath[2].x, newPath[3].x, rel.t);
              b.transition = { to, edge: rel.edge, startX: b.pos.x, targetX, y: rel.y, progress: 0 };
              b.restorePending = false;
            }
          }
        }

        // 4) 軌跡（線分で描画：点々を解消）
        const newX = b.pos.x, newY = b.pos.y;
        const skipTrail = USE_EDGE_ENGINE && b.justSwitched;
        if (!skipTrail && Math.hypot(newX - oldX, newY - oldY) > 0.1) {
          tctx.save();
          tctx.globalCompositeOperation = 'screen';
          tctx.globalAlpha = 0.95;
          tctx.beginPath();
          tctx.moveTo(oldX, oldY);
          tctx.lineTo(newX, newY);
          tctx.lineWidth = 3.0;
          tctx.lineCap = 'round';
          tctx.strokeStyle = b.color;
          tctx.stroke();
          tctx.restore();
        }
        b.prev = { x: newX, y: newY };
        b.justPushed = false; // フレームの最後でフラグをリセット
        if (USE_EDGE_ENGINE && b.obstacleGrace && b.obstacleGrace > 0) b.obstacleGrace -= 1;
        if (USE_EDGE_ENGINE) b.justSwitched = false;
      }

      // 背景・障害物
      ctx.save(); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); ctx.restore();
      ctx.save(); ctx.fillStyle = "#fff"; for (const x of SHELF_XS) { const left = x - SHELF_W / 2, top = CY - SHELF_H / 2; ctx.fillRect(left, top, SHELF_W, SHELF_H); } ctx.restore();
      if (active) { const cx = xOf("center"), cy = CY; ctx.save(); ctx.fillStyle = "#ffd54a"; ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }

      // 合成とAMR本体
      ctx.drawImage(trail, 0, 0);
      for (const b of bots) { ctx.save(); ctx.fillStyle = b.color; ctx.beginPath(); ctx.arc(b.pos.x, b.pos.y, RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }

      // UI
      ctx.save(); ctx.font = "14px monospace"; ctx.fillStyle = "#9aa4"; ctx.fillText(`Hold '1': obstacle ON | Switch only on horizontal edge (no diagonal) | vel-limited switch | ${SPEED_MULT}× speed`, 16, 24); ctx.restore();

      prevActive = active;
      requestAnimationFrame(step);
    }

    requestAnimationFrame(step);
  }, []);

  return (
    <div className="flex h-full w-full items-center justify-center bg-black">
      <canvas
        ref={canvasRef}
        className="block"
        width={W}
        height={H}
        style={{ width: W, height: H }}
      />
    </div>
  );
}
