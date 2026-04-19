# GPU レンタルプラットフォーム - 実装フェーズ詳細

## フェーズ一覧

| # | フェーズ | 概要 |
|---|---------|------|
| 0 | 環境確認・準備 | 必須ソフトウェアの確認・インストール |
| 1 | 基盤構築 | サーバー, DB, 認証, GPU検出 |
| 2 | WEB予約システム | GPU一覧, 予約カレンダー, 予約管理 |
| 3 | Pod管理 + ワークスペース | ユーザー環境構築, Webターミナル, ファイル管理 |
| 4 | 管理者ダッシュボード | リアルタイム監視, アラート, レポート |
| 5 | 外部公開 + セキュリティ | Cloudflare Tunnel, セキュリティ対策 |

---

## Phase 0: 環境確認・準備

### 概要
開発に必要なソフトウェア・ハードウェアの確認とセットアップ。

### 作業内容

| # | タスク | 詳細 |
|---|--------|------|
| 0.1 | Node.js確認 | v18以上推奨、npmバージョン確認 |
| 0.2 | NVIDIA GPU確認 | nvidia-smi コマンドで搭載GPU確認 |
| 0.3 | FFmpegインストール | NVENC対応ビルド (GPU対応版) |
| 0.4 | Redis確認 | ジョブキュー用 (代替: BullMQのメモリモード) |
| 0.5 | Cloudflared確認 | 外部公開用CLIツール |
| 0.6 | F:ドライブ確認 | ストレージ領域の空き容量確認 |

### 前提条件チェックリスト

```
□ Node.js v18+
□ npm v9+
□ NVIDIA GPU (nvidia-smi で確認可能)
□ NVIDIA ドライバー最新版
□ FFmpeg (NVENC対応)
□ Git
□ F:ドライブ アクセス可能 & 十分な空き容量
```

---

## Phase 1: 基盤構築

### 概要
サーバーフレームワーク、データベース、認証、GPU検出の基盤を構築する。

### Step 1.1: プロジェクト初期化

```
作業内容:
├── package.json 作成 (npm init)
├── 依存パッケージインストール
│   ├── express            - Webフレームワーク
│   ├── socket.io          - WebSocket
│   ├── better-sqlite3     - SQLiteデータベース
│   ├── jsonwebtoken       - JWT認証
│   ├── bcryptjs           - パスワードハッシュ
│   ├── multer             - ファイルアップロード
│   ├── node-cron          - スケジューラ
│   ├── cors               - CORS設定
│   ├── dotenv             - 環境変数
│   ├── helmet             - セキュリティヘッダー
│   ├── express-rate-limit  - レート制限
│   ├── node-pty           - ターミナルエミュレータ
│   └── uuid               - 一意ID生成
├── Express サーバー基本構成
├── .env 設定ファイル
└── ディレクトリ構造作成
```

### Step 1.2: データベース構築

```
作業内容:
├── SQLite データベース初期化
├── テーブル作成 (マイグレーション)
│   ├── users
│   ├── gpus
│   ├── reservations
│   ├── pods
│   ├── usage_logs
│   └── alerts
├── 初期データ投入
│   └── 管理者アカウント作成
└── データアクセス層 (DAL) 作成
```

### Step 1.3: 認証システム

```
作業内容:
├── ユーザー登録 API
│   ├── 入力バリデーション
│   ├── パスワードハッシュ化 (bcrypt)
│   └── ユーザーDB登録
├── ログイン API
│   ├── 認証情報検証
│   ├── JWT トークン発行
│   └── リフレッシュトークン
├── 認証ミドルウェア
│   ├── JWT検証
│   ├── ロールチェック (user/admin)
│   └── トークンリフレッシュ
└── セッション管理
```

### Step 1.4: GPU検出・管理モジュール

```
作業内容:
├── nvidia-smi コマンド実行
│   └── XML/CSV パース
├── GPU情報取得
│   ├── GPU名
│   ├── VRAM (空き/合計)
│   ├── GPU使用率
│   ├── 温度
│   ├── 電力使用量
│   ├── ドライバーバージョン
│   └── 実行中プロセス
├── DB への GPU 自動登録
├── 定期監視ループ (5秒間隔)
│   └── WebSocket で状態配信
└── GPU ステータス管理
    ├── available (利用可能)
    ├── rented (レンタル中)
    └── maintenance (メンテナンス)
```

---

## Phase 2: WEB予約システム

### 概要
ユーザーがGPUを閲覧・選択・予約するためのWebポータルを構築。

### Step 2.1: GPU マーケットプレイス画面

```
UI構成:
├── GPU カード一覧表示
│   ├── GPU名・画像
│   ├── スペック (VRAM, TDP)
│   ├── 現在の状態 (空き/使用中)
│   ├── 時間単価
│   ├── リアルタイム負荷メーター
│   └── [予約する] ボタン
├── フィルター・ソート
│   ├── VRAM容量
│   ├── 価格
│   └── 空き状況
└── GPU詳細モーダル
    ├── 完全スペック一覧
    ├── 利用可能時間帯
    └── レビュー/評価
```

### Step 2.2: 予約カレンダー

```
UI構成:
├── カレンダービュー
│   ├── 月表示
│   ├── 週表示
│   ├── 日表示
│   └── 空き状況カラー表示
│       ├── 🟢 緑 = 空き
│       ├── 🟡 黄 = 一部予約あり
│       └── 🔴 赤 = 予約済み
├── 時間帯選択UI
│   ├── 開始日時ピッカー
│   ├── 終了日時ピッカー
│   ├── 利用時間計算表示
│   └── 料金自動計算
├── 予約フォーム
│   ├── GPU選択
│   ├── 利用目的
│   ├── 備考
│   └── 利用規約同意
└── 予約確認画面
    ├── 予約内容サマリー
    ├── 合計料金
    └── 確定ボタン

バックエンド:
├── 予約作成 API
│   ├── 日時バリデーション
│   ├── 競合チェック (ダブルブッキング防止)
│   ├── 料金計算
│   └── DB登録
├── 予約一覧 API
├── 予約変更 API
└── 予約キャンセル API
```

### Step 2.3: マイページ

```
UI構成:
├── アクティブ予約一覧
│   ├── ステータス表示
│   ├── 残り時間
│   ├── [ワークスペースに接続] ボタン
│   └── [キャンセル] ボタン
├── 予約履歴
│   ├── 過去の利用一覧
│   ├── 利用時間合計
│   └── 合計料金
├── アカウント設定
│   ├── プロフィール編集
│   ├── パスワード変更
│   └── 通知設定
└── 利用統計
    ├── 月間利用時間
    └── 月間利用料金
```

---

## Phase 3: Pod管理 + ユーザーワークスペース

### 概要
予約に基づいてユーザーの隔離環境(Pod)を作成・管理し、Webブラウザから操作可能にする。

### Step 3.1: Pod ライフサイクル管理

```
作業内容:
├── Pod 作成
│   ├── ユーザー専用ディレクトリ作成
│   │   F:/gpu-rental/users/{userId}/
│   │   ├── workspace/ (作業領域)
│   │   ├── uploads/   (アップロード)
│   │   └── outputs/   (出力)
│   ├── GPU割り当て (CUDA_VISIBLE_DEVICES 設定)
│   ├── ポート割り当て
│   └── DB登録
├── Pod 自動起動 (予約時間到達時)
│   └── node-cron スケジューラで管理
├── Pod 自動停止 (予約時間終了時)
│   ├── ユーザーへ事前通知 (30分前, 5分前)
│   ├── GPU解放
│   └── 利用ログ記録
├── Pod 手動操作
│   ├── 管理者による強制停止
│   └── ユーザーによる延長リクエスト
└── Pod 削除
    ├── ワークスペースデータ保持期間設定
    └── 定期クリーンアップ
```

### Step 3.2: ユーザーワークスペース UI

```
UI構成:
├── Web Terminal (xterm.js + node-pty)
│   ├── PowerShell / CMD 接続
│   ├── 画面サイズ自動調整
│   ├── コピー&ペースト対応
│   ├── カラー出力対応
│   └── 接続状態インジケーター
├── ファイルマネージャー
│   ├── ツリービュー表示
│   ├── ドラッグ&ドロップ アップロード
│   ├── マルチファイルダウンロード
│   ├── ファイル作成・削除・リネーム
│   ├── テキストファイルエディタ
│   └── 画像/動画プレビュー
├── GPU モニター (リアルタイム)
│   ├── 使用率ゲージ
│   ├── VRAM使用量バー
│   ├── 温度表示
│   ├── 時系列グラフ (Chart.js)
│   └── 実行中プロセス一覧
├── セッション情報パネル
│   ├── 残り時間カウントダウン
│   ├── 累計利用料金
│   ├── [延長する] ボタン
│   └── [終了する] ボタン
└── レンダリング機能 (Premiere Pro風)
    ├── 出力フォーマット選択
    ├── 解像度・FPS設定
    ├── コーデック設定 (H.264/HEVC/ProRes)
    ├── ビットレート設定 (CBR/VBR)
    ├── オーディオ設定
    ├── NVENC品質プリセット
    └── レンダリング実行 & 進捗表示
```

---

## Phase 4: 管理者ダッシュボード

### 概要
プラットフォーム全体をリアルタイムに監視・管理する管理画面を構築。

### Step 4.1: ダッシュボード概要画面

```
UI構成:
├── KPI カード
│   ├── アクティブPod数
│   ├── 待機GPU数
│   ├── 本日収益
│   ├── 月間収益
│   ├── 総ユーザー数
│   └── GPU稼働率
├── GPU ステータス一覧テーブル
│   ├── GPU名
│   ├── 状態 (稼働/待機/メンテ)
│   ├── 利用ユーザー
│   ├── 温度
│   ├── VRAM使用量
│   ├── 開始時刻
│   ├── 残り時間
│   └── アクションボタン
└── リアルタイム更新 (5秒間隔)
```

### Step 4.2: GPU管理画面

```
UI構成:
├── GPU詳細カード
│   ├── スペック表示
│   ├── ステータス変更 (available/maintenance)
│   ├── 価格設定変更
│   └── 利用履歴
├── 温度・負荷・VRAMの時系列グラフ
├── GPU利用率ヒートマップ (24h x 7days)
└── メンテナンススケジュール
```

### Step 4.3: ユーザー管理画面

```
UI構成:
├── ユーザー一覧テーブル
│   ├── ユーザー名
│   ├── アカウント状態
│   ├── 登録日
│   ├── 最終ログイン
│   ├── 利用回数
│   └── 累計利用料金
├── ユーザー詳細
│   ├── 予約履歴
│   ├── 利用ログ
│   └── アカウント操作 (停止/有効化)
└── ユーザー検索・フィルター
```

### Step 4.4: アラートシステム

```
作業内容:
├── アラート条件設定
│   ├── GPU温度閾値 (デフォルト85°C)
│   ├── GPU応答タイムアウト
│   ├── ストレージ容量警告 (80%/90%)
│   ├── 予約終了リマインダー (30分/5分前)
│   └── 異常プロセス検出
├── アラート通知
│   ├── ダッシュボード上表示
│   ├── WebSocket リアルタイム通知
│   └── サウンド通知 (重要度高)
├── アラート履歴
│   ├── 一覧表示
│   ├── フィルター (種別/重要度)
│   └── 解決済みマーク
└── 自動対応
    ├── 温度超過 → GPU負荷制限
    └── 長時間無操作 → ユーザーへ通知
```

### Step 4.5: レポート・統計

```
UI構成:
├── 日次/週次/月次 利用統計
│   ├── GPU稼働時間
│   ├── ユーザー数推移
│   └── 収益推移グラフ
├── GPU別稼働率ランキング
├── ユーザー利用頻度ランキング
└── CSV エクスポート機能
```

---

## Phase 5: 外部公開 + セキュリティ

### 概要
Cloudflare Tunnelで安全にローカル環境を外部公開し、セキュリティ対策を施す。

### Step 5.1: Cloudflare Tunnel セットアップ

```
作業内容:
├── cloudflared インストール
├── Cloudflare アカウント設定
├── トンネル作成
│   ├── ポータル用 (*.trycloudflare.com)
│   ├── ワークスペース用
│   └── 管理画面用 (アクセス制限付き)
├── config.yml 設定
└── 自動起動設定 (Windowsサービス)
```

### Step 5.2: セキュリティ対策

```
作業内容:
├── HTTPS 強制 (Cloudflare側で対応)
├── レート制限
│   ├── API: 100 req/min
│   ├── ログイン: 5 req/min
│   └── ファイルアップロード: 10 req/min
├── 入力バリデーション (全API)
├── ファイルアップロード制限
│   ├── 最大サイズ: 10GB
│   └── 許可フォーマット制限
├── CORS 設定
├── Helmet (セキュリティヘッダー)
├── Pod間ファイルシステム隔離
├── GPU リソース隔離 (CUDA_VISIBLE_DEVICES)
├── 管理画面 IP制限
└── アクセスログ記録
```

---

## Phase 6: GPU Street Fighter 統合 ✅ COMPLETED (2026-04-18〜19)

### 概要
GPU同士を競い合わせる「GPU Street Fighter」システムをプラットフォームに統合。
THE LOBBY (発注UI) · THE REFEREE (API) · THE DOJO (プロバイダーエージェント) の三層構成。

### Step 6.1: THE REFEREE — バックエンド API ✅

```
実装内容:
├── server/routes/sf.js                 ← SF専用 Express Router (createSfRouter(io))
│   ├── POST /api/sf/match              ← 1on1マッチリクエスト作成 + スコアリング
│   ├── POST /api/sf/match/:id/confirm  ← マッチ確定 + ポイント決済
│   ├── GET  /api/sf/match/:id          ← マッチ状態ポーリング
│   ├── POST /api/sf/raid               ← レイドバトル計画作成 (buildRaidPlan)
│   ├── POST /api/sf/raid/confirm       ← レイドジョブ登録 (payment_pending状態)
│   ├── GET  /api/sf/raid/:id           ← レイドジョブ状態ポーリング
│   ├── GET  /api/sf/stats/public       ← SF公開統計 (認証不要)
│   ├── POST /api/sf/nodes/register     ← エージェント初回登録 (X-Agent-Token)
│   └── POST /api/sf/nodes/heartbeat    ← GPU統計ハートビート (30秒周期)
├── DB マイグレーション自動適用:
│   ├── sf_raid_jobs   (id/user_id/status/payment_method/points_used/stripe_payment_id...)
│   ├── sf_nodes       (id/hostname/fp32_tflops/rtt_ms/status/last_seen...)
│   ├── sf_match_requests (id/user_id/status/selected_mode/node_scores_json...)
│   ├── point_logs     (id/type/amount/source/note...)
│   └── ALTER TABLE pods/reservations ADD COLUMN sf_raid_job_id/sf_match_id
└── server/config.js に SF ブロック追加
    (maxRaidNodes=50, matchTimeout=24h, nodeHeartbeatTimeout=2m, bonusMultiplier=1.15)
```

### Step 6.2: THE DOJO — プロバイダーエージェント ✅

```
実装内容:
├── provider/agent.js                   ← ヘッドレスエージェント本体
│   ├── 初回起動: POST /api/sf/nodes/register
│   ├── 30秒ハートビート: POST /api/sf/nodes/heartbeat
│   │   └── nvidia-smiで GPU stats収集 (util/temp/VRAM)
│   ├── agent_state.json 永続化 (node_id保持)
│   └── 未登録時: X-Agent-Token でユーザー照合
├── server/routes/auth.js に追加:
│   ├── GET  /api/auth/agent-token      ← トークン取得 (プロバイダー)
│   └── POST /api/auth/agent-token/regenerate ← 再生成
├── server/middleware/auth.js に追加:
│   ├── agentTokenMiddleware            ← X-Agent-Token 認証
│   └── authOrAgent                    ← JWT or agent-token の OR 認証
├── package.json: npm run agent / npm run agent:dev
└── public/portal/ THE DOJO セクション (トークン表示/コピー/再生成 UI)
```

### Step 6.3: 決済統合 ✅

```
実装内容:
├── server/routes/payments.js に SF 決済エンドポイント追加:
│   ├── POST /api/payments/sf-raid/pay-with-points
│   │   ├── coupon_code (任意) → validateCoupon() でポイント割引
│   │   ├── DB トランザクション: point_balance -= N, status='paid'
│   │   └── coupon_uses + point_logs 記録
│   └── POST /api/payments/sf-raid/create-stripe-session
│       ├── coupon_code (任意) → amountYen に割引適用 (最低50円)
│       ├── Stripe Checkout Session 作成
│       └── metadata: { sf_raid_job_id, type:'sf_raid', coupon_id }
├── Stripe Webhook: metadata.type==='sf_raid' 分岐追加
│   └── 決済完了時: sf_raid_jobs.status='paid' + coupon_uses記録
├── server/routes/reservations.js: POST /api/reservations/sf-confirm
│   └── レイドジョブ→予約→workspace_url 自動生成
└── server/routes/coupons.js: router.validateCoupon エクスポート
```

### Step 6.4: ノード選択 & MRP 連携 ✅

```
実装内容:
├── server/services/gpuManager.js に追加:
│   ├── selectSfNodesForRaid(count)
│   │   └── sf_nodes WHERE status='idle' ORDER BY rtt_ms, fp32_tflops DESC
│   ├── dispatchSfRaidJob(raidJobId)
│   │   ├── ノード選択 → sf_raid_jobs.status='running'
│   │   ├── MRP_ORCHESTRATOR_URL 設定時 → POST {url}/api/sf/dispatch
│   │   └── 未設定時 (開発) → setTimeout で 30秒後にシミュレーション完了
│   └── watchdogDispatchPaidJobs()
│       └── status='paid' のジョブを全件ディスパッチ試行
├── server/index.js: 起動5秒後から30秒周期でwatchdog起動
└── server/services/scheduler.js: SF ノードオフライン検出スイープ (30秒)
    └── status='online'/'busy' + last_seen > 30秒前 → 'offline' + match cancel
```

### Step 6.5: フロントエンド UI ✅

```
実装内容:
├── public/lobby/index.html             ← THE LOBBY 決済 UI 完全実装
│   ├── confirmRaid(): レイドジョブ作成 + ポイント残高確認 + モーダル表示
│   ├── applyCoupon(): /api/coupons/validate でプレビュー更新
│   ├── 決済方法トグル: ポイント / 💳 Stripe カード
│   ├── executeRaidPayment(): 新フロー (pay-with-points / create-stripe-session)
│   └── Stripe 完了リダイレクト検出 (?sf_payment=success)
├── public/admin/index.html + app.js    ← SF Raid Jobs 管理タブ
│   ├── loadSfRaidJobs(): GET /api/admin/sf/raid-jobs
│   ├── cancelSfRaidJob(): POST /api/admin/sf/raid-jobs/:id/cancel (自動返金)
│   └── forceSfRaidComplete(): POST /api/admin/sf/raid-jobs/:id/force-complete
├── public/workspace/style.css         ← SF専用スタイル追加
│   (sfWidgetIn / sfPulse / sf-badge / sf-status-badge / sf-progress)
└── public/portal/index.html + app.js  ← THE DOJO エージェントトークン管理 UI
```

### Step 6.6: 設定・ドキュメント ✅

```
実装内容:
├── .env                SF変数全追加
│   (SF_POINT_RATE / SF_NODE_HEARTBEAT_TIMEOUT / SF_RAID_DISPATCH_TIMEOUT /
│    SF_BONUS_MULTIPLIER / SF_STATS_CACHE_TTL / SF_RAID_MAX_NODES /
│    SF_MATCH_TIMEOUT_MS / MRP_ORCHESTRATOR_URL コメントアウト)
├── README.md           SF フロー説明・env表・npm-scripts表 更新
├── docs/03_effort_estimation.md   セッション完了ノート追加
└── docs/04_user_flow_sequence.md  セクション6 追加
    (SF決済フロー / THE DOJOセットアップ / 管理者オペレーション)
```

### 残タスク (Phase 7)

| # | タスク | 優先度 | 備考 |
|---|--------|--------|------|
| 7.1 | PostgreSQL 移行 | 低 | 本番スケール時に実施 |
| 7.2 | MRP Orchestrator 本番接続 | 中 | MRP_ORCHESTRATOR_URL を設定するだけで有効化 |
| 7.3 | SF 結果ダウンロード UI (workspace) | 中 | sf_raid_jobs.output_url 完成後に対応 |
| 7.4 | 1on1 マッチ ポイント決済 UI | 中 | confirmMatch() にも pay-with-points フロー追加 |

