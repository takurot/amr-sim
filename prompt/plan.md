## AMR シミュレータ 実装計画（spec.md 準拠）

### 目的（再掲）
- エッジ上の1次元運動へモデル化し、斜め移動を構造的に排除
- ループ切替（迂回/復帰）を水平エッジ上の原子的操作として実装
- 描画時の棚横切り線を防ぐ（分割描画/スキップ）
- フェイルセーフで棚交差を常に不許可
- 自己診断/プロパティテストで回帰を抑止

### 影響範囲（主に `amr-sim/src/App.tsx`）
- `Bot` 型の内部状態拡張（`edgeId`, `edgeDir`, `edgeS`, `justSwitched`）
- ルート定義/取得ヘルパの追加（ループ → エッジ表現）
- 通常移動ループ（`step`）の更新ロジック差し替え（ベクトル移動→エッジ進捗）
- 切替ロジック（迂回/復帰）の水平エッジ限定・原子化
- 障害物押し戻し/逆走の正規化（エッジ法線方向のみ）
- スナップ/数値安定化、トレイル分割、棚交差フェイルセーフ
- `runSelfTests` 拡張

### データ構造
- ループ→エッジ表現
  - `getLoopEdges(loop: LoopName) => Edge[]`
  - `Edge`:
    - `orientation: 'horizontal' | 'vertical'`
    - `fixedCoord: number`  // y（水平）or x（垂直）
    - `from: number`        // 可動軸の開始座標
    - `to: number`          // 可動軸の終了座標
    - `length: number`      // `Math.abs(to-from)`
    - `nextEdgeId: number`  // 時計回り
    - `prevEdgeId: number`  // 反時計回り
- `Bot` 拡張
  - `edgeId: number`          // 現在のエッジ（0..3）
  - `edgeDir: 1 | -1`         // 進行方向（時計=1/反時計=-1）
  - `edgeS: number`           // エッジ内の走行距離 0..length
  - `justSwitched?: boolean`  // 切替直後 1 フレーム

### ヘルパ関数（追加）
- `getEdge(loop: LoopName, edgeId: number): Edge`
- `projectToEdge(pos, loop, edgeId): { edgeS, edgeDir }`  // 既存座標→最寄りの該当エッジ進捗へ投影
- `advanceAlongEdge(bot: Bot, ds: number): void`          // `edgeS += ds`、角で原子的に次エッジへ繰り越し
- `positionFromEdge(loop, edgeId, edgeS): {x,y}`          // 表示用の座標復元（固定軸+可動軸）
- `mapProgressToLoop(srcLoop, dstLoop, edgeId, t): { dstEdgeId, edgeS }`  // 水平エッジ間で進捗 t を保って写像
- `isHorizontal(edge): boolean`
- `segmentIntersectsShelves(p0, p1): boolean`             // AABB 高速交差（複数棚）

### 実装ステップ
1. ループのエッジ定義を追加
   - `makeLoopWaypoints` は残しつつ、`getLoopEdges`/`getEdge` を新設
   - 既存描画/初期化に影響しないユーティリティとして用意

2. `Bot` 型拡張と初期化
   - 既存の `pos, idx, path, loop` を利用して、初期 `edgeId/edgeS/edgeDir` を導出（上辺スタート前提で簡易導出可）
   - 以後、移動は `edge*` 状態を正にとる

3. 通常移動ロジックの差し替え
   - `dx/dy` ベクトルによる移動を廃し、`advanceAlongEdge(bot, v*dt)` に一本化
   - 角に到達した残余距離は次エッジに繰り越し（原子的切替）
   - 毎フレーム末に `positionFromEdge` で `pos` を再算出し、固定軸を厳密化（スナップ）

4. 迂回/復帰の実装
   - トリガーは現行フラグを踏襲（`reroutePending`, `restorePending`）
   - 実行条件: 現在の `edge` が水平のみ許可。垂直なら角到達まで保留
   - 手順:
     1) `t = edgeS / length` を算出
     2) `dstLoop = chooseDetourFor(defaultLoop)` または `defaultLoop`（復帰）
     3) `mapProgressToLoop` で対応水平エッジへ写像（`edgeDir` は維持）
     4) `loop, edgeId, edgeS` を原子的に更新し `justSwitched = true`

5. 障害物押し戻し/逆走の正規化
   - 押し戻しは現在エッジ法線方向のみ（水平→±y, 垂直→±x）に微小移動し、直後に `projectToEdge` で再投影
   - 逆走は `edgeDir *= -1` で表現（`idx` の巻き戻しを廃止）

6. トレイル描画の分割/抑制
   - `justSwitched` のフレームはトレイル接続をスキップ、または「旧座標→切替点」「切替点→新座標」の二分割描画
   - 切替点は水平エッジ上の現在 `x` と `fixedCoord` を用いて算出

7. フェイルセーフ: 棚交差ガード
   - 毎フレーム `oldPos→newPos` の線分と棚 AABB を交差判定
   - 交差なら更新をロールバックし、角待ち/水平待ちへフォールバック

8. スナップ/数値安定化
   - `epsilon = 0.5px` で固定軸のズレを丸め
   - 累積誤差は `edgeS` の clamp と `positionFromEdge` で吸収

9. 自己診断とテスト
   - `runSelfTests` に以下を追加
     - 任意ステップで `pos` が必ずエッジ上（固定軸一致）
     - 切替時に進捗 `t` が保存される
   - プロパティテスト（軽量擬似）
     - ランダムな ON/OFF トグル列で棚交差が常に false

10. ログ/可視化/パフォーマンス
    - `console.debug` を一時追加（切替/角越え/押し戻し）
    - 60fps 維持を確認後、過剰ログは削除

### コード変更ポイント（ガイド）
- `type Bot` の更新（`App.tsx`）
- `horizontalRel` 相当は `getEdge`/`isHorizontal`/`mapProgressToLoop` で代替
- `step()` 内：
  - 通常移動: `advanceAlongEdge`
  - 切替: 条件チェック→原子的に `loop/edgeId/edgeS/edgeDir` 更新
  - 押し戻し/逆走: 法線方向移動→`projectToEdge`
  - トレイル: `justSwitched` で分割/抑制、末尾で false に戻す
  - フェイルセーフ: 棚交差判定→ロールバック

### ロールアウト方針
- 環境変数 `VITE_EDGE_ENGINE=1` で新ロジックを有効化
- 既定は新ロジックON（必要なら切替可能）
- 機能フラグ削除は安定確認後

### 受け入れ基準
- どのタイミングで障害物を ON/OFF しても、トレイル/実座標が棚を横切らない
- ループ切替は水平エッジ上のみ発生し、相対進捗が保存される
- 10000 ステップ走行で固定軸の最大ズレ < 0.25px、fps は現行同等

### リスクと緩和
- 残余距離の繰り越しバグ → ユニット化した `advanceAlongEdge` の単体テスト
- 切替点の対応付けミス → `mapProgressToLoop` の双方向性テスト
- 可視化のギャップ → 分割描画 or 1フレーム抑制で吸収


