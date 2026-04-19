# GPU レンタルプラットフォーム + GPU Street Fighter — プロジェクト概要

## ドキュメント情報

| 項目 | 内容 |
|------|------|
| プロジェクト名 | GPURental + GPU Street Fighter (THE LOBBY) |
| 会社 | METADATALAB.INC |
| 最終更新 | 2026-04-19 |
| バージョン | 2.0 |
| ステータス | **本番稼働中** |
| 本番URL | https://gpurental.jp |

---

## 1. プロジェクト概要

### 1.1 目的
RTX A4500 をはじめとするローカルGPUを GPURental プラットフォームを通じて外部に貸し出すシステム。  
さらに「GPU Street Fighter (THE LOBBY/THE DOJO/THE REFEREE)」として、GPU コンピューティングパワーを競技処理 (レイドバトル・1on1 マッチ) に活用する拡張機能を統合する。

### 1.2 主要機能
| # | 機能 | 画面 |
|---|------|------|
| 1 | GPU レンタル (時間単位) | ポータル `/portal/` |
| 2 | ウェブワークスペース (ターミナル・ファイル・GPU監視) | `/workspace/` |
| 3 | ⚡ GPU Street Fighter — RAID BATTLE | THE LOBBY `/lobby/` |
| 4 | ⚡ GPU Street Fighter — 1on1 MATCH | THE LOBBY `/lobby/` |
| 5 | プロバイダー登録・THE DOJO エージェント | `/provider/` |
| 6 | 管理者ダッシュボード・SF Raid Jobs 管理 | `/admin/` |
| 7 | ポイント購入・クーポン・Stripe 決済 | API |
| 8 | Blender クラウドレンダリング | ワークスペース |

### 1.3 対象ユーザー
- **エンドユーザー**: AI 開発者・クリエイター・GPU 計算を必要とする人
- **プロバイダー**: 自宅・オフィスの遊休 GPU を収益化したい人
- **管理者**: METADATALAB.INC 運営チーム

---

## 2. システムアーキテクチャ

### 2.1 全体構成図

```
外部ユーザー (HTTPS)
       │
       ▼
Cloudflare Tunnel (trycloudflare.com または Named Tunnel)
       │
       ├──► /portal/          ポータル (GPU 一覧・予約・SF ウィジェット)
       ├──► /lobby/           ⚡ THE LOBBY (SF マッチ・レイド発注)
       ├──► /workspace/       ワークスペース (PTY・ファイル・⚡ SF パネル)
       ├──► /provider/        プロバイダー (THE DOJO セットアップ)
       ├──► /admin/           管理ダッシュボード
       │
       ▼
 Node.js Backend (Express + Socket.io) :3000
       │
       ├── /api/auth/*         JWT 認証
       ├── /api/gpus/*         GPU 一覧・統計
       ├── /api/reservations/* 予約 + SF ID 連携
       ├── /api/sf/*           ⚡ THE REFEREE (SF 全 API)
       ├── /api/payments/*     Stripe 決済
       ├── /api/coupons/*      クーポン
       ├── /api/points/*       ポイント購入
       ├── /api/files/*        ファイル API
       ├── /api/render/*       FFmpeg レンダリング
       ├── /api/blender/*      Blender ジョブ
       └── /api/admin/*        管理者 API
              │
    ┌─────────┼──────────────────┐
    ▼         ▼                  ▼
 sql.js DB  GPU Manager        Scheduler
 (SQLite)   (nvidia-smi)       (cron / auto-pod)

プロバイダー
  └── node agent.js (THE DOJO)
        └── POST /api/sf/agent/heartbeat
        └── POST /api/sf/agent/benchmark
```

### 2.2 GPU Street Fighter エンドツーエンドフロー

```
ユーザー             THE LOBBY          THE REFEREE (sf.js)     THE DOJO (agent)
  │                    │                      │                       │
  │ POST /api/sf/raid  │                      │                       │
  ├───────────────────►│─────────────────────►│                       │
  │                    │ ポイント残高確認       │                       │
  │◄───────────────────┤ { raid_job_id }       │                       │
  │                    │                      │                       │
  │ POST /raid/confirm │                      │                       │
  ├───────────────────►│─────────────────────►│                       │
  │                    │ ポイント引き落とし     │                       │
  │                    │ MRP ジョブ配信────────────────────────────── ►│
  │ WS: sf:raid_confirmed                     │                       │
  │◄───────────────────┤                      │                       │
  │                    │                      │                       │
  │ /workspace/?raid_job={id}                 │                       │
  │──────────────────────────────────────────►│                       │
  │ ⚡ SF ステータスパネル自動表示              │                       │
  │  (10秒ポーリング) GET /api/sf/raid/:id    │                       │
  │  完了 → ダウンロードボタン表示             │                       │
```

---

## 3. 技術スタック

| レイヤー | 技術 | 備考 |
|---------|------|------|
| フロントエンド | Vanilla HTML5 + CSS + JavaScript | 全画面。ダークテーマ・レスポンシブ |
| バックエンド | Node.js v18+ + Express 4 + Socket.io | 単一プロセス |
| データベース | **sql.js** (pure-JS SQLite ラッパー) | ネイティブビルド不要 |
| GPU 検出 | nvidia-smi CLI + WebGL (クライアント側) | ハイブリッド検出 |
| ターミナル | xterm.js + node-pty | PTY によるリアルタイム |
| レンダリング | FFmpeg NVENC / Blender CLI | クラウド GPU 利用 |
| 認証 | JWT + bcrypt | 8h 期限 |
| 決済 | Stripe Checkout + GMO Epsilon | デュアル |
| インフラ | PM2 + Cloudflare Tunnel | プロセス管理・外部公開 |
| バックアップ | DB 日次自動エクスポート (services/backup.js) | 7世代保存 |

---

## 4. ディレクトリ構成

```
gpu-platform/
├── server/
│   ├── index.js                  # エントリポイント・起動バナー
│   ├── config.js                 # 設定 (SF セクション含む)
│   ├── db/
│   │   ├── database.js           # sql.js ラッパー (sync API エミュレート)
│   │   └── migrations.js         # CREATE TABLE + ALTER TABLE (SF カラム自動追加)
│   ├── middleware/
│   │   ├── auth.js               # JWT 認証ミドルウェア
│   │   └── rateLimit.js
│   ├── routes/
│   │   ├── auth.js               # 認証 API
│   │   ├── gpus.js               # GPU 一覧・統計 (パブリック)
│   │   ├── reservations.js       # 予約 API (sf_raid_job_id / sf_match_id 連携)
│   │   ├── pods.js               # Pod 管理
│   │   ├── sf.js                 # ⚡ GPU SF 全 API (THE REFEREE)
│   │   ├── payments.js           # Stripe 決済
│   │   ├── coupons.js            # クーポン (validateCoupon ヘルパーも)
│   │   ├── points.js             # ポイント購入 (GMO Epsilon)
│   │   ├── files.js              # ファイル API
│   │   ├── render.js             # FFmpeg レンダリング
│   │   ├── blender.js            # Blender ジョブ
│   │   ├── admin.js              # 管理者 API (SF Raid Jobs /api/admin/sf/*)
│   │   └── providers.js          # プロバイダー登録
│   └── services/
│       ├── gpuManager.js         # GPU 検出・監視
│       ├── podManager.js         # Pod 作成 + getWorkspaceUrl() SF URL 生成
│       ├── scheduler.js          # 自動 Pod 起動/停止
│       ├── terminal.js           # PTY アタッチ
│       ├── backup.js             # DB 日次バックアップ
│       └── tunnelRelay.js        # SSH トンネルリレー
├── public/
│   ├── portal/                   # ポータル (SF ウィジェット搭載)
│   │   ├── index.html
│   │   ├── style.css             # @keyframes pulse / sfWidgetIn 含む
│   │   └── app.js                # loadSfWidget() 30秒ポーリング
│   ├── lobby/                    # ⚡ THE LOBBY
│   │   ├── index.html
│   │   └── app.js
│   ├── workspace/                # ワークスペース
│   │   ├── index.html
│   │   └── app.js                # initSfFromUrl() URL パラメータ検出
│   ├── provider/                 # プロバイダー (THE DOJO セクション)
│   │   ├── index.html
│   │   └── app.js
│   ├── admin/                    # 管理ダッシュボード
│   │   ├── index.html
│   │   └── app.js
│   └── maintenance.html          # メンテナンスページ
├── scripts/
│   ├── migrate_sf_columns.js     # SF カラム手動マイグレーション (sql.js使用)
│   └── check_api.ps1             # API 疎通確認 PowerShell スクリプト
├── docs/
│   ├── 01_project_overview.md    # (本ファイル)
│   ├── 02_api_reference.md       # API 詳細
│   ├── 03_database_schema.md     # DB スキーマ
│   └── 04_user_flow_sequence.md  # ユーザーフロー・SF 統合フロー
├── check_status.js               # DB ヘルスチェック (SF + Platform)
├── start.bat                     # 起動ランチャー
├── tunnel.bat                    # Cloudflare Tunnel 管理
├── package.json
├── .env
└── .env.example

F:/gpu-rental-main/data/           # ストレージ (DB_PATH / STORAGE_PATH)
├── db/platform.db                 # SQLite DB ファイル
├── users/{userId}/                # ユーザースペース
│   ├── workspace/
│   ├── uploads/
│   └── outputs/
└── backups/                       # 日次 DB バックアップ
```

---

## 5. データベーススキーマ (主要テーブル)

### 通常プラットフォーム
| テーブル | 説明 |
|---------|------|
| `users` | ユーザー (role: user/admin/provider) |
| `gpu_nodes` | GPU ノード登録 |
| `reservations` | 予約 (`sf_raid_job_id`, `sf_match_id` カラム追加済) |
| `pods` | アクティブ Pod (`sf_raid_job_id`, `sf_match_id` カラム追加済) |
| `usage_logs` | 利用ログ・コスト |
| `point_purchases` | ポイント購入履歴 |
| `point_logs` | ポイント消費ログ (`source='raid_job'` etc.) |
| `coupons` / `coupon_uses` | クーポン管理 |

### GPU Street Fighter
| テーブル | 説明 |
|---------|------|
| `sf_nodes` | SF ノード登録 (user_id, gpu_specs, status, last_seen) |
| `sf_benchmarks` | ベンチマーク計測値 (fp32_tflops, upload/download_mbps etc.) |
| `sf_match_requests` | 1on1 マッチリクエスト (cards_json, selected_mode) |
| `sf_raid_jobs` | レイドバトルジョブ (payment_amount_yen, points_used, status) |

---

## 6. 重要な設計パターン

### 6.1 sql.js ラッパー
```js
// database.js が better-sqlite3 互換の同期 API を提供
const { getDb, initDb, saveToDisk } = require('./server/db/database');
await initDb();
const db = getDb();
db.prepare('SELECT ...').all();   // better-sqlite3 と同じ API
db.exec('ALTER TABLE ...');
saveToDisk();  // 3秒間隔の自動保存もあり
```

### 6.2 SF URL 連携パターン
```
[THE LOBBY] → POST /api/sf/raid/confirm → Pod 起動
→ podManager.getWorkspaceUrl(podId) → /workspace/?pod=1&raid_job=42
→ WebSocket pod:started { workspace_url }
→ portal/app.js: pod:started で workspace_url へリダイレクト
→ workspace/app.js: initSfFromUrl() → SF ステータスパネル表示 + 10秒ポーリング
```

### 6.3 マイグレーション自動実行
```js
// server/index.js → runMigrations() がサーバー起動時に毎回実行
// migrations.js 末尾で SF カラムを try/catch で安全に追加
['ALTER TABLE pods ADD COLUMN sf_raid_job_id INTEGER', ...].forEach(sql => {
    try { db.exec(sql); } catch (_) { /* 既存スキップ */ }
});
```

---

## 7. 今後の開発ステップ

| # | タスク | 優先度 | ステータス |
|---|--------|-------|--------|
| 1 | **MRP Orchestrator 本番接続**: `.env` に `MRP_ORCHESTRATOR_URL` を設定、実際のノード配信ロジックへ切替 | 高 | 🔄 残作業 |
| 2 | **PostgreSQL 移行**: `migrate_to_postgres.py` による本番 DB 移行 | 低 | 🔄 残作業 |

### ✅ 完了済み機能
| タスク | 実装ファイル |
|--------|------|
| THE REFEREE 全 API (raid/match/nodes/heartbeat/benchmark) | `server/routes/sf.js` |
| THE LOBBY 全 UI (RAID/1on1/決済モーダル/クーポン) | `public/lobby/` |
| THE DOJO エージェント (heartbeat/register/benchmark) | `provider/agent.js` |
| ワークスペース SF ステータスパネル + DL UI | `public/workspace/app.js` |
| クーポン × SF 決済対応 (RAID + 1on1 共) | `server/routes/sf.js`, `payments.js` |
| Admin THE DOJO Nodes 管理 UI | `public/admin/app.js`, `server/routes/admin.js` |
| Stripe Webhook SF Raid ケース追加 | `server/routes/stripe.js` |
| sql.js point_logs スキーマ導入 | `server/db/migrations.js` |
| 法的表記 (tokushoho) + ドキュメント 最終化 | `public/tokushoho/`, `docs/` |

---

© 2026 GPURental by METADATALAB.INC. All Rights Reserved.
