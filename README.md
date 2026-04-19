# ⚡ GPURental + GPU Street Fighter (THE LOBBY)

**RTX A4500 をはじめとするGPUを個人・企業で時間貸しするGPUクラウドプラットフォーム、および GPU同士を「戦わせる」分散GPU競技処理システム「GPU Street Fighter」を統合した次世代サービス。**

> 余っているGPUをマーケットに出して収益化したり、AI開発・Blenderレンダリング・動画変換をクラウドGPUで実行。さらに「THE LOBBY」から複数GPUによるレイドバトルや1on1マッチを仕掛け、GPU コンピューティングパワーを競い合わせる全く新しいプラットフォームです。

**🌐 サービスURL**: [https://gpurental.jp](https://gpurental.jp)

---

## ✨ 主な機能

### 1. 👥 ユーザー（借りる人）向け
- **時間単位レンタル**: RTX A6000 / RTX 4090 / A4500 などのGPUを時間単位で低コスト利用。
- **Webワークスペース**: Pod 起動後、ブラウザ上でターミナル・ファイル管理・GPU モニタリングが完結。
- **⚡ GPU Street Fighter**: THE LOBBY からレイドバトル／1on1 マッチを発注し、ワークスペースで進捗をリアルタイム追跡。
- **クーポン・ポイント払い**: クーポン割引 + 独自ポイント制。Stripe Checkout / GMO Epsilon デュアル決済。
- **Blender & レンダリング**: FFmpeg NVENC クラウドレンダリング・Blender ジョブ発注。

### 2. 🖥️ プロバイダー（貸す人）向け
- **余剰GPUの収益化**: エージェント (`THE DOJO`) を起動するだけでプラットフォームに自動登録。
- **GPU Street Fighter ノード参加**: SF マッチのワーカーとして参加し、ボーナス収益 (×1.15) を獲得。
- **エージェント自動セットアップ**: `npm install & node agent.js` 一発でハートビート・ベンチマーク計測・GPU 情報送信が自動設定。
- **Stripe Connect 出金**: ウォレット残高を銀行口座へ出金申請。

### 3. 🛡️ 管理者（プラットフォーム運営）向け
- **ダッシュボード**: 売上 KPI・GPU 稼働率・予約状況をリアルタイム監視。
- **SF Raid Jobs 管理**: レイドジョブの状態・支払額・ノード配分をテーブルで一元管理。
- **ヘルスモニター**: Stripe Webhook 未着・ゾンビプロセス・ディスク空き容量を自動検出。
- **クーポン管理**: admin UI から % / 固定額クーポンを発行・無効化。
- **ポイントボーナス付与**: ユーザーへの個別ポイント即時付与・履歴管理。

### 4. ⚡ GPU Street Fighter (THE LOBBY)
- **RAID BATTLE**: 最大50ノードによる分散処理。ポイントで発注 → MRP Orchestrator が各ノードへジョブ配信 → 完了後ダウンロード。
- **1on1 MATCH**: 2ノードが同一タスクを競い、速い方が勝利。スコアリング (TFLOPS / RTT / 稼働率) でノードを自動選定。
- **THE REFEREE (バックエンド)**: マッチング・ポイント精算・ジョブ配信・ノード状態管理を担う SF 専用 API (`/api/sf/*`)。
- **リアルタイム進捗**: ワークスペース起動 URL に `?raid_job=ID` / `?match=ID` が付与され、自動で SF ステータスパネルが表示される。

---

## 🏗 アーキテクチャ

```text
┌──────────────────────────────────────────────────────────────────────┐
│              https://gpurental.jp (Cloudflare Tunnel)                │
│   Stripe Webhook ──► /api/payments/webhook                           │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                    ┌───────────▼────────────┐
                    │   Express + Socket.io   │  :3000
                    │   Node.js 中央サーバー  │
                    └──┬───────┬───────┬─────┘
                       │       │       │
             ┌─────────▼┐   ┌──▼──┐  ┌▼──────────────┐
             │ sql.js DB │   │GPU  │  │ Scheduler      │
             │ platform  │   │Mgr  │  │ (cron/auto-pod)│
             │ .db       │   └─────┘  └───────────────┘
             └──────────┘
                   │
    ┌──────────────┼───────────────────────────┐
    │              │                           │
┌───▼────┐  ┌──────▼──────┐         ┌─────────▼────────┐
│Portal  │  │THE LOBBY     │         │Provider Agent     │
│/portal/│  │/lobby/       │         │(THE DOJO)         │
│        │  │⚡ SF Match   │         │node agent.js      │
│        │  │⚡ SF Raid    │         │→ heartbeat / bench│
└────────┘  └─────────────┘         └──────────────────┘
    │               │
┌───▼────────────────▼──┐
│  Workspace /workspace/ │
│  • Terminal (PTY)      │
│  • File Manager        │
│  • GPU Monitor         │
│  • ⚡ SF Status Panel  │  ← ?raid_job= / ?match= URL param
└───────────────────────┘
```

### 🛠 技術スタック
| レイヤー | 技術 | 用途 |
|---------|------|------|
| Backend Core | Node.js + Express 4 + Socket.io | API・WebSocket |
| Database | **sql.js** (pure JS SQLite) | スキーマ・データ永続化 |
| GPU Monitor | nvidia-smi CLI / WebGL (client) | リアルタイムGPU計測 |
| Media | FFmpeg NVENC | 動画エンコード・Blender |
| Auth | JWT + bcrypt | 認証・認可 |
| Payments | Stripe Checkout / GMO Epsilon | 決済 |
| Frontend | Vanilla HTML/JS/CSS | 全画面 (レスポンシブ・ダークテーマ) |
| Infrastructure | PM2 / Cloudflare Tunnel | プロセス管理・外部公開 |

---

## 📁 ディレクトリ構成

```
gpu-platform/
├── server/
│   ├── index.js                # エントリポイント・ルート登録
│   ├── config.js               # 全設定 (SF設定ブロック含む)
│   ├── db/
│   │   ├── database.js         # sql.js ラッパー (sync API エミュレート)
│   │   └── migrations.js       # テーブル作成 + SF カラム自動追加
│   ├── middleware/
│   │   ├── auth.js             # JWT 認証ミドルウェア
│   │   └── rateLimit.js        # レート制限
│   ├── routes/
│   │   ├── auth.js             # 認証 API
│   │   ├── gpus.js             # GPU 一覧・統計 (パブリック)
│   │   ├── reservations.js     # 予約 + SF ID 連携
│   │   ├── pods.js             # Pod 管理
│   │   ├── sf.js               # ⚡ GPU SF 全 API (THE REFEREE)
│   │   ├── payments.js         # 決済 (Stripe)
│   │   ├── coupons.js          # クーポン管理
│   │   ├── points.js           # ポイント購入
│   │   ├── files.js            # ファイル API
│   │   ├── render.js           # FFmpeg レンダリング
│   │   ├── blender.js          # Blender ジョブ
│   │   ├── admin.js            # 管理者 API
│   │   └── providers.js        # プロバイダー登録
│   └── services/
│       ├── gpuManager.js       # GPU 検出・監視
│       ├── podManager.js       # Pod 作成 + getWorkspaceUrl() SF 連携
│       ├── scheduler.js        # 自動 Pod 起動/停止
│       ├── backup.js           # 日次 DB バックアップ
│       └── tunnelRelay.js      # SSH トンネルリレー
├── public/
│   ├── portal/                 # ポータル (GPU 一覧・予約・⚡ SF ウィジェット)
│   ├── lobby/                  # ⚡ THE LOBBY (SF マッチ・レイド発注)
│   ├── workspace/              # ワークスペース (ターミナル・⚡ SF パネル自動表示)
│   ├── provider/               # プロバイダー (THE DOJO セクション)
│   ├── admin/                  # 管理ダッシュボード (SF Raid Jobs タブ)
│   └── maintenance.html        # メンテナンスページ
├── scripts/
│   ├── migrate_sf_columns.js   # SF カラム手動マイグレーション (sql.js使用)
│   └── check_api.ps1           # API 疎通確認 PowerShell スクリプト
├── docs/                       # ドキュメント群
├── check_status.js             # DB ヘルスチェック (SF + Platform)
├── start.bat                   # 起動ランチャー (Node確認・.env自動生成)
├── tunnel.bat                  # Cloudflare Tunnel 管理
├── package.json                # npm scripts (check/migrate/backup 等)
└── .env                        # 環境変数
```

---

## 🚀 クイックスタート

### 1. セットアップ

```bash
# 依存インストール
npm install

# .env 作成 (.env.example をコピー)
copy .env.example .env
# .env を編集して JWT_SECRET 等を設定
```

**`.env` 最小構成:**
```env
PORT=3000
JWT_SECRET=your-strong-secret-change-this
NODE_ENV=development
STORAGE_PATH=C:/gpu-rental-main/data
DB_PATH=C:/gpu-rental-main/data/db/platform.db
```

### 2. 起動

```bash
# start.bat をダブルクリック (推奨)

# または直接起動
npm start          # 本番
npm run dev        # 開発 (nodemon)
```

起動後のURL一覧:
| URL | 説明 |
|-----|------|
| http://localhost:3000/portal/ | ポータル (GPU 検索・予約) |
| http://localhost:3000/lobby/ | ⚡ THE LOBBY (SF 発注) |
| http://localhost:3000/workspace/ | ワークスペース |
| http://localhost:3000/provider/ | プロバイダー登録 |
| http://localhost:3000/admin/ | 管理ダッシュボード |
| http://localhost:3000/api/sf/stats/public | SF 統計 (no auth) |

### 3. 診断・確認

```bash
npm run check            # DB ヘルスチェック (platform + SF)
npm run check:sf         # SF のみ
npm run check:api        # API 疎通確認 (サーバー起動中に実行)
npm run check:api:sf     # SF API のみ確認
npm run migrate:sf       # SF カラム手動マイグレーション
```

> **Note**: SF カラム (`pods.sf_raid_job_id` 等) はサーバー起動時に `runMigrations()` が自動追加します。手動実行は不要です。

---

## 🔑 主要 API 早見表

### GPU SF (THE REFEREE) — `/api/sf/*`

| Method | Endpoint | 認証 | 説明 |
|--------|----------|------|------|
| GET | `/api/sf/stats/public` | 不要 | SF 公開統計 (ウィジェット用) |
| POST | `/api/sf/match` | 要 | 1on1 マッチリクエスト作成 |
| POST | `/api/sf/match/:id/confirm` | 要 | マッチ確定・ポイント決済 |
| GET | `/api/sf/match/:id` | 要 | マッチ状態取得 |
| POST | `/api/sf/raid` | 要 | レイドバトル計画作成 |
| POST | `/api/sf/raid/confirm` | 要 | レイド確定・ポイント決済 |
| GET | `/api/sf/raid/:id` | 要 | レイドジョブ状態取得 |
| POST | `/api/sf/agent/heartbeat` | 要 | ノードハートビート |
| POST | `/api/sf/agent/benchmark` | 要 | ベンチマーク送信 |
| GET | `/api/admin/sf/raid-jobs` | admin | レイドジョブ一覧 |

### WebSocket イベント
| イベント | 方向 | 説明 |
|---------|------|------|
| `pod:started` | S→C | Pod 起動完了 (`workspace_url` に SF params 含む) |
| `sf:raid_confirmed` | S→C | レイド確定通知 |
| `sf:match_confirmed` | S→C | マッチ確定通知 |
| `gpu:stats` | S→C | GPU リアルタイム統計 (5秒間隔) |
| `terminal:data` | 双方向 | PTY ターミナル入出力 |

---

## ⚡ GPU Street Fighter フロー

```
ユーザー → THE LOBBY → /api/sf/raid (or /match) → ポイント決済
    → Pod 起動 → workspace_url に ?raid_job=ID 付与
    → ワークスペース自動遷移 → SF ステータスパネル表示 (10秒ポーリング)
    → 完了 → ダウンロードボタン表示
```

---

## 🗂 環境変数 一覧

| 変数名 | デフォルト | 説明 |
|--------|----------|------|
| `PORT` | 3000 | サーバーポート |
| `JWT_SECRET` | (必須) | JWT 署名シークレット |
| `NODE_ENV` | development | 環境 |
| `DB_PATH` | C:/gpu-rental-main/data/db/platform.db | DB ファイルパス |
| `STORAGE_PATH` | C:/gpu-rental-main/data | ユーザーデータ保存先 |
| `STRIPE_SECRET_KEY` | - | Stripe シークレットキー |
| `STRIPE_WEBHOOK_SECRET` | - | Stripe Webhook 署名シークレット |
| `CLOUDFLARE_TUNNEL_TOKEN` | - | Named Tunnel トークン |
| `SF_POINT_RATE` | 1 | 1 ポイント = N 円 |
| `SF_NODE_HEARTBEAT_TIMEOUT` | 120000 | ノードオフライン判定 (ms) |
| `SF_BONUS_MULTIPLIER` | 1.15 | SF ノード収益ボーナス倍率 |
| `MRP_ORCHESTRATOR_URL` | http://localhost:7860 | MRP Orchestrator 接続先 |

---

## 📋 npm scripts

| コマンド | 説明 |
|---------|------|
| `npm start` | 本番起動 |
| `npm run dev` | 開発 (nodemon) |
| `npm run setup` | DB 初期マイグレーション |
| `npm run migrate:sf` | SF カラム手動マイグレーション |
| `npm run check` | プラットフォーム全体ヘルスチェック |
| `npm run check:sf` | SF 関連のみチェック |
| `npm run check:full` | 詳細チェック (最近のレコード含む) |
| `npm run check:api` | API エンドポイント疎通確認 |
| `npm run check:api:sf` | SF API 疎通確認のみ |
| `npm run backup` | DB 手動バックアップ |

---

© 2026 GPURental by METADATALAB.INC. All Rights Reserved.
