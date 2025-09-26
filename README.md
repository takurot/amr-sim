# AMR 3台 × 6棚 通路シミュレーター (React/Canvas)

## 概要

3台のAMRが、6つの棚の間の通路を**矩形ループ**で周回する様子を可視化するシミュレーターです。
障害物（中央通路固定）は **1キー押下** に加えて、任意の HTTP エンドポイントからの指示でも ON/OFF を切り替えられます。障害物ON時は、中央系ループにいるAMRは**その周回は1回だけ通過**してから**次のラップ境界で固定の外側ループへ迂回**します。障害物OFFに戻ると、**次のラップ境界で元ルートに復帰**します。

## 主な特徴

* **通路遵守**：AMRは棚を貫通せず、上辺・下辺・左右辺の**矩形経路のみ**を移動
* **自然なルート切替**：**水平通路上のみ**切替し、**X方向スライド**＋**角→縦→角**のL字で移動（斜め無し）
* **軌跡表示**：AMR色の**線ストローク**＋**指数的フェード**で視認性を維持
* **速度スケーリング**：`SPEED_MULT` で全体速度を一括調整
* **セルフテスト内蔵**：起動時に経路・設定の妥当性を簡易確認

## デモ操作

* **1キー押下**：中央通路を障害物ON（手動トグル）

  * 中央系ループにいたAMRは“その周回は通過OK”、**次周回から**固定迂回（`leftMid/center → leftOuter`, `rightMid → rightOuter`）
* **1キー解放**：障害物OFF

  * **次周回から**元のデフォルトループへ復帰
* **サーバー応答**：`VITE_OBSTACLE_ENDPOINT` で指定したURLを1秒ごとにポーリングし、HTTP 200 + 本文`1`なら障害物ON、本文`0`または通信失敗ならOFF
* 常時：**3台のAMR**（赤/青/緑）が各ループを周回し続けます

## 画面仕様

* **背景**：黒
* **棚**：白（丸め角の矩形、6列）
* **AMR**：赤/青/緑の円（白縁取り）
* **軌跡**：AMR色（`screen`合成）、過去は徐々にフェードアウト

## 動作要件

* Node.js 18+ 推奨
* 任意のReact環境（Vite/Next.js/Craなど）

## セットアップ例（Vite + React + TypeScript）

```bash
# 新規プロジェクト
npm create vite@latest amr-sim -- --template react-ts
cd amr-sim
npm i

# src/App.tsx をこのコンポーネントに差し替えるか、
# src/index.tsx(or App.tsx)に本コンポーネントを追加して使います。
npm run dev
```

`App.tsx` 例：

```tsx
import React from 'react'
import AMRSimulator from './AMRSimulator' // ← 本ファイル名に合わせて変更

export default function App() {
  return (
    <div style={{ height: '100vh', background: '#000' }}>
      <AMRSimulator />
    </div>
  );
}
```

## 主要な設定パラメータ（コード先頭付近）

```ts
// 速度倍率（全体スケール）
const SPEED_MULT = 3;      // ← 全体速度を一括調整（例: 1, 2, 3）
const BASE_SPEED = 120;    // 基本速度(px/s)
const SPEED_JITTER = 40;   // 個体差（ばらつき）
const TRANSITION_VEL = 220 * SPEED_MULT; // 切替時の水平スライド速度(px/s) ※距離に依存しない一定速度
```

* **もっと速く/遅く**：`SPEED_MULT` を変更
* **切替スライドのみ調整**：`TRANSITION_VEL` を独立調整

## ルーティング仕様（重要）

* **中央通路が障害物ON**（1キー押下）：

  * 中央系ループ（`leftMid`, `center`, `rightMid`）にいるAMRは**今の周回は通過OK**
  * **次のラップ境界**で**固定迂回**（`leftMid/center → leftOuter`, `rightMid → rightOuter`）
* **障害物OFF**（キー解放）：

  * **次のラップ境界**で**元のデフォルトループへ復帰**
* **切替位置**：**水平通路（上辺/下辺）上でのみ**切替を発火

  * 同じYで**X方向にスライド**→角→縦→角の順に進行（斜め侵入なし）

## 実装のポイント

* **ダブルバッファ**：`trail` キャンバスで軌跡を蓄積し、フェード用に黒を薄く重ねる（`globalAlpha=0.03`）
* **線描画**：各AMRの**直前位置→現在位置**で `lineTo`、`lineCap='round'`
* **自己診断**：`runSelfTests()` でコネクタ順・矩形生成・水平辺判定・マップ妥当性をチェック
* **スナップ/インデックス**：切替完了後は**同じ水平辺の角（上=1 / 下=3）**へ向かうよう `idx` を設定し、**L字進行**を保証

## 拡張（任意）

* **外部HTTPサーバ連携（障害物状態取得）**
  標準で `POLL_ENDPOINT = import.meta.env.VITE_OBSTACLE_ENDPOINT ?? "/obstacle"` を1秒間隔でポーリングし、本文が `"1"` のとき障害物ON、`"0"` または通信失敗時はOFFになります。環境変数でエンドポイントを上書きできます（例：`.env.local` に `VITE_OBSTACLE_ENDPOINT=https://example.com/api/obstacle`）。
* **AMRごとの特性**：色別に `BASE_SPEED` や `SPEED_JITTER` を変える、半径 `RADIUS` を変えるなど
* **棚・通路配置**：`SHELF_W/H` や `SHELF_COLS`、`MARGIN_X` を調整してレイアウト変更

## 既知の制約

* 本シミュレーターは**簡易モデル**です：実際のAMR制御（速度制限、衝突回避、優先度、ジョブ割当）は未実装
* ウィンドウサイズは固定（`W/H`）。レスポンシブ対応は未実装

## テスト

* **内蔵セルフテスト（自動）**：`runSelfTests()` が起動時に走り、異常があればコンソールへ出力
  追加で必要なら、`console.assert` などの軽量アサートを増やせます。

## トラブルシューティング

* **ビルド時SyntaxError（`,` 期待や `}` 不一致）**
  → JSXの閉じタグや `return ( ... )` の対応関係を確認。末尾の余計なカンマ/波括弧に注意。
* **斜め移動/棚横切りが出る**
  → 「水平エッジでのみ切替」が効いているか確認。`horizontalRel()` と `transition` 完了後の `idx` 設定（`1`/`3`）が改変されていないか確認。
* **切替時に急加速して見える**
  → `TRANSITION_VEL` が過大でないか、距離正規化ロジックが残っているか確認。
* **軌跡が点々になる**
  → 線描画が有効化されているか（`prev` の更新と `moveTo/lineTo`）、`lineWidth` を2.0〜4.0で調整。