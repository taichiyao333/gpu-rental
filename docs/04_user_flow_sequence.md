# GPU レンタルプラットフォーム - ユーザーフロー & シーケンス

## 1. ユーザー利用フロー

### 1.1 新規ユーザーフロー

```
[ポータルアクセス]
     │
     ▼
[ユーザー登録] ── メール / ユーザー名 / パスワード
     │
     ▼
[ログイン] ── JWT トークン発行
     │
     ▼
[GPU マーケットプレイス] ── GPU一覧閲覧
     │
     ├── GPU詳細確認 (スペック・価格・空き状況)
     │
     ▼
[予約カレンダー] ── 日時選択
     │
     ├── 競合チェック ── NG → 別の日時を選択
     │
     ▼
[予約確認] ── 内容確認 → [確定]
     │
     ▼
[予約完了] ── マイページに予約表示
     │
     │ ... (予約時間到達) ...
     │
     ▼
[Pod 自動起動] ── GPU割当・ワークスペース作成
     │
     ▼
[ワークスペース接続] ── ブラウザからアクセス
     │
     ├── ターミナル操作 (コマンド実行)
     ├── ファイルアップロード/ダウンロード
     ├── GPU プログラム実行
     ├── レンダリング処理
     └── GPU モニター確認
     │
     │ ... (予約終了時間) ...
     │
     ▼
[Pod 自動停止] ── 成果物保持 → ダウンロード可能
```

### 1.2 管理者フロー

```
[管理画面ログイン] ── admin ロール認証
     │
     ▼
[ダッシュボード] ── 全体概要確認
     │
     ├── GPU管理
     │   ├── ステータス変更 (available/maintenance)
     │   ├── 価格設定変更
     │   └── リアルタイム監視
     │
     ├── ユーザー管理
     │   ├── ユーザー一覧・検索
     │   ├── アカウント停止/有効化
     │   └── 利用履歴確認
     │
     ├── 予約管理
     │   ├── 全予約一覧
     │   ├── 予約承認/拒否
     │   └── 強制キャンセル
     │
     ├── アラート対応
     │   ├── 温度アラート → GPU負荷制限
     │   ├── 異常検出 → Pod強制停止
     │   └── ストレージ警告 → クリーンアップ
     │
     └── レポート確認
         ├── 利用統計グラフ
         ├── 収益レポート
         └── CSV エクスポート
```

---

## 2. 処理シーケンス図

### 2.1 予約 → Pod起動 → 利用 → 終了

```
ユーザー         予約ポータル      Backend        Scheduler       GPU/Pod
  │                  │               │               │               │
  │ POST /register   │               │               │               │
  ├─────────────────►│──────────────►│               │               │
  │ ◄────────────────┤ JWT token     │               │               │
  │                  │               │               │               │
  │ GET /gpus        │               │               │               │
  ├─────────────────►│──────────────►│               │               │
  │ ◄────────────────┤ GPU一覧+状態  │               │               │
  │                  │               │               │               │
  │ GET /calendar    │               │               │               │
  ├─────────────────►│──────────────►│               │               │
  │ ◄────────────────┤ 空き状況      │               │               │
  │                  │               │               │               │
  │ POST /reserve    │               │               │               │
  ├─────────────────►│──────────────►│               │               │
  │                  │               │ 競合チェック   │               │
  │                  │               │ 料金計算       │               │
  │                  │               │ DB登録         │               │
  │ ◄────────────────┤ 予約確定      │               │               │
  │                  │               │               │               │
  │    ═══════ 予約時間到達 ═══════  │               │               │
  │                  │               │               │               │
  │                  │               │ ◄─────────────┤               │
  │                  │               │ cron: 予約     │               │
  │                  │               │ 開始チェック   │               │
  │                  │               │               │               │
  │                  │               │ Pod作成 ──────┼──────────────►│
  │                  │               │               │  ディレクトリ  │
  │                  │               │               │  GPU割当      │
  │                  │               │               │  ポート割当   │
  │                  │               │               │               │
  │ WS: pod:ready    │               │               │               │
  │ ◄────────────────┤◄──────────────┤               │               │
  │                  │               │               │               │
  │ /workspace/:id   │               │               │               │
  ├─────────────────►│──────────────►│               │               │
  │ ◄────────────────┤ワークスペースUI│               │               │
  │                  │               │               │               │
  │ WS: terminal     │               │               │               │
  ├────────────WebSocket─────────────┼───────────────┼──────────────►│
  │ (コマンド実行)   │               │               │ (GPU処理)     │
  │ ◄───────────WebSocket────────────┼───────────────┼──────────────┤│
  │                  │               │               │               │
  │ WS: gpu:status   │               │               │               │
  │ ◄────────────────┤◄──────────────┤◄──────────────┼──────────────┤│
  │ (5秒間隔)        │               │ nvidia-smi    │               │
  │                  │               │               │               │
  │    ═══ 終了30分前 ═══            │               │               │
  │                  │               │ ◄─────────────┤               │
  │ WS: pod:warning  │               │               │               │
  │ ◄────────────────┤◄──────────────┤               │               │
  │ "残り30分です"    │               │               │               │
  │                  │               │               │               │
  │    ═══ 予約終了時間 ═══          │               │               │
  │                  │               │ ◄─────────────┤               │
  │                  │               │ Pod停止 ──────┼──────────────►│
  │                  │               │               │  GPU解放      │
  │                  │               │               │  ログ保存     │
  │                  │               │               │               │
  │ WS: pod:stopped  │               │               │               │
  │ ◄────────────────┤◄──────────────┤               │               │
  │ "セッション終了"  │               │               │               │
  │                  │               │               │               │
  │ GET /download    │               │               │               │
  ├─────────────────►│──────────────►│               │               │
  │ ◄────────────────┤ 成果物DL      │               │               │
```

### 2.2 管理者監視フロー

```
管理者            管理画面           Backend          GPU Pool
  │                  │                 │                 │
  │ GET /monitoring  │                 │                 │
  ├─────────────────►│────────────────►│                 │
  │ ◄────────────────┤ ダッシュボード   │                 │
  │                  │                 │                 │
  │ WS: connect      │                 │                 │
  ├─────WebSocket────┤────────────────►│                 │
  │                  │                 │                 │
  │                  │                 │ nvidia-smi ────►│
  │                  │                 │ ◄───────────────┤
  │ WS: gpu:status   │                 │                 │
  │ ◄────────────────┤◄────────────────┤ (5秒間隔)       │
  │                  │                 │                 │
  │                  │                 │ ══ 温度超過 ══  │
  │                  │                 │ ◄───────────────┤
  │ WS: alert:new    │                 │                 │
  │ ◄────────────────┤◄────────────────┤                 │
  │ "GPU#0: 87°C"    │                 │                 │
  │                  │                 │                 │
  │ POST /gpu/action │                 │                 │
  ├─────────────────►│ 強制停止/制限   │                 │
  │                  │────────────────►│────────────────►│
  │ ◄────────────────┤ 処理完了        │                 │
```

---

## 3. 予約ステータス遷移図

```
  ┌──────────┐     予約作成      ┌───────────┐
  │          │─────────────────►│           │
  │  (なし)  │                  │  pending  │
  │          │                  │           │
  └──────────┘                  └─────┬─────┘
                                      │
                        ┌─────────────┼─────────────┐
                        │ 確認        │ キャンセル    │
                        ▼             ▼              │
                 ┌───────────┐  ┌───────────┐       │
                 │           │  │           │       │
                 │ confirmed │  │ cancelled │       │
                 │           │  │           │       │
                 └─────┬─────┘  └───────────┘       │
                       │                             │
                       │ 予約時間到達                  │
                       ▼                             │
                 ┌───────────┐                       │
                 │           │ ─── キャンセル ────────┘
                 │  active   │
                 │           │
                 └─────┬─────┘
                       │
                       │ 予約時間終了
                       ▼
                 ┌───────────┐
                 │           │
                 │ completed │
                 │           │
                 └───────────┘
```

---

## 4. Pod ステータス遷移図

```
  予約 active 時
       │
       ▼
  ┌───────────┐
  │ creating  │ ── ディレクトリ作成・GPU割当
  └─────┬─────┘
        │ 完了
        ▼
  ┌───────────┐
  │  running  │ ── ユーザー利用可能
  └─────┬─────┘
        │
        ├── 予約終了 / 管理者停止
        ▼
  ┌───────────┐
  │ stopping  │ ── GPU解放・ログ保存
  └─────┬─────┘
        │ 完了
        ▼
  ┌───────────┐
  │  stopped  │ ── 成果物DL可能 (一定期間保持)
  └─────┬─────┘
        │ 保持期間経過
        ▼
   ┌───────────┐
   │  deleted  │ ── データ削除
   └───────────┘
```

---

## 5. GPU Street Fighter 統合フロー

### 5.1 レイドバトル (RAID BATTLE) フロー

```
ユーザー         THE LOBBY           Backend (sf.js)     MRP Orchestrator
  │                  │                     │                    │
  │ /lobby/          │                     │                    │
  ├────────────────► │                     │                    │
  │                  │                     │                    │
  │ レイドプラン選択  │                     │                    │
  │ POST /api/sf/raid│                     │                    │
  ├────────────────► │────────────────────►│                    │
  │                  │ ポイント残高チェック │                    │
  │                  │ sf_raid_jobs 作成   │                    │
  │ ◄────────────────┤ { raid_job_id, ... }│                    │
  │                  │                     │                    │
  │ 決済モーダル確認  │                     │                    │
  │ POST /api/sf/raid/confirm              │                    │
  ├────────────────► │────────────────────►│                    │
  │                  │ ポイント引き落とし   │                    │
  │                  │ MRP へジョブ配信 ──────────────────────► │
  │                  │ WS: sf:raid_confirmed                    │
  │ ◄────────────────┤                     │                    │
  │                  │                     │                    │
  │ /workspace/?raid_job={id}              │                    │
  ├────────────────────────────────────────►                    │
  │ ⚡ GPU SF タブ (自動表示)              │                    │
  │                  │     10秒ポーリング   GET /api/sf/raid/:id/receipt
  │ ◄─────────────────────────────────────── 進捗更新 ──────────┤
  │ 完了 → ダウンロードボタン表示          │                    │
```

### 5.2 1on1 マッチフロー

```
ユーザー         THE LOBBY           Backend (sf.js)     GPU Node (Agent)
  │                  │                     │                    │
  │ POST /api/sf/match                     │                    │
  ├────────────────► │────────────────────►│                    │
  │                  │ スコアリング → ノード選定                 │
  │ ◄────────────────┤ { match_id, ... }   │                    │
  │                  │                     │                    │
  │ POST /api/sf/match/:id/confirm         │                    │
  ├────────────────► │────────────────────►│                    │
  │                  │ ポイント引き落とし   │                    │
  │                  │ ジョブ送信 ──────────────────────────── ►│
  │ WS: sf:match_confirmed                 │                    │
  │ ◄────────────────┤                     │                    │
  │                  │                     │                    │
  │ /workspace/?match={id}                 │                    │
  ├──────────────────────────────────────► │                    │
  │ ⚡ GPU SF タブ (自動表示)              │                    │
  │                  │     10秒ポーリング   GET /api/sf/match/:id
  │ ◄──────────────────────────────────── 進捗更新              │
```

### 5.3 Pod 起動 → ワークスペース URL 生成フロー

```
Scheduler / User
  │
  │ POST /api/reservations/:id/start
  │        ↓
  │   createPod(reservationId)
  │        ↓
  │   pods.sf_raid_job_id / sf_match_id を DB に保存
  │        ↓
  │   getWorkspaceUrl(podId)
  │        → /workspace/?pod=1&raid_job=42  (レイドあり)
  │        → /workspace/?pod=1&match=abc123 (マッチあり)
  │        → /workspace/?pod=1             (通常)
  │        ↓
  │   WebSocket: pod:started { workspace_url }
  │        ↓
  │   ポータルの「接続」ボタンが workspace_url に変更
  │        ↓
  │   ワークスペース: URLパラメータを検出 → SF タブ自動表示
```

### 5.4 全体アーキテクチャ (統合後)

```
[ポータル /portal/]
  ├── GPU一覧・予約
  ├── ⚡ SF ウィジェット (オンラインノード/レイド状況) ← loadSfWidget()
  └── THE LOBBY ボタン

[THE LOBBY /lobby/]
  ├── 1on1 マッチタブ → /api/sf/match → /workspace/?match=
  └── レイドバトルタブ → /api/sf/raid → /workspace/?raid_job=

[ワークスペース /workspace/]
  ├── ターミナル / 接続情報 / レンダリング / Blender
  └── ⚡ GPU SF タブ (URLパラメータで自動アクティブ)
       ├── 10秒ポーリング: GET /api/sf/raid/:id/receipt
       └── 完了時: ダウンロードボタン表示

[プロバイダー /provider/]
  └── THE DOJO セクション (エージェント起動手順)

[管理画面 /admin/]
  └── SF Raid Jobs タブ: GET /api/admin/sf/raid-jobs/stats
```

---

## 6. SF Raid 決済フロー (2026-04-19 実装)

### 6.1 ポイント払いフロー

```
[THE LOBBY /lobby/]
   ユーザー: レイドプラン確定 → ポイント払いを選択
        │
        ▼
POST /api/payments/sf-raid/pay-with-points
   { sf_raid_job_id: 7 }
        │
        ├─ sf_raid_jobs.status='payment_pending' を確認
        ├─ users.point_balance >= points_needed を確認
        └─ DB トランザクション:
           ├─ users.point_balance -= pointsNeeded
           ├─ sf_raid_jobs.status = 'paid', paid_at = NOW()
           └─ point_logs INSERT (type='spend', source='raid_job')
        │
        ▼
   レスポンス: { status: 'paid', points_used: 150 }
        │
        ▼
POST /api/reservations/sf-confirm
   { sf_raid_job_id: 7, gpu_id: 3, duration_hours: 1 }
        │
        ├─ reservations INSERT (total_price=0, sf_raid_job_id=7)
        └─ sf_raid_jobs.status = 'dispatched'
        │
        ▼
   レスポンス: { workspace_url: '/workspace/?pod=pending&raid_job=7' }
        │
        ▼
[ワークスペース /workspace/?pod=pending&raid_job=7]
   initSfFromUrl() → SF ステータスパネル注入
   10秒ポーリング: GET /api/sf/raid/7
        │
        ▼ status='completed'
   ダウンロードボタン表示 (output_url or ファイルタブ)
```

### 6.2 Stripe クレジットカード払いフロー

```
[THE LOBBY]
   ユーザー: カード払いを選択
        │
        ▼
POST /api/payments/sf-raid/create-stripe-session
   { sf_raid_job_id: 7 }
        │
        ▼ Stripe Checkout Session 作成
   metadata: { sf_raid_job_id: '7', type: 'sf_raid' }
        │
        ▼ ユーザー → Stripe Checkout ページ
        │
        ▼ 決済成功
POST /api/payments/webhook (Stripe)
   event.type = 'checkout.session.completed'
   metadata.type === 'sf_raid'
        │
        ▼
   sf_raid_jobs.status = 'paid'
   (以降は 6.1 と同じ → sf-confirm → ワークスペース)
```

### 6.3 THE DOJO エージェントセットアッププロー

```
[プロバイダー]
   1. ポータル /portal/ にログイン
   2. THE DOJO セクション → エージェントトークンをコピー
        GET /api/auth/agent-token
        │ → { agent_token: 'abc123...' }
        │
   3. GPU サーバーで起動:
      node provider/agent.js --token abc123... --server https://gpurental.jp
        │
   4. 初回起動: POST /api/sf/nodes/register (X-Agent-Token: abc123...)
        │ → SF Node #5 登録完了
        │
   5. 30秒ごと: POST /api/sf/nodes/heartbeat
        │ Body: { gpu_stats: [{index:0, temp:62, util:45, ...}], rtt_ms: 3.2 }
        │ Auth: X-Agent-Token ヘッダー (authOrAgent ミドルウェア)
        │
   6. 管理画面 /admin/ → SF Nodes タブでリアルタイム確認
```

### 6.4 管理者オペレーションフロー

```
[管理画面 /admin/ → SF Raid Jobs タブ]
   loadSfRaidJobs() → GET /api/admin/sf/raid-jobs
        │
   テーブル表示 (ステータス・収益・ノード数)
        │
   dispatched/running ジョブ:
        [停止] → POST /api/admin/sf/raid-jobs/:id/cancel
                   ├─ status = 'cancelled'
                   └─ points_used > 0 → 自動返金 (point_logs.type='refund')
        │
   payment_pending ジョブ:
        [強制完了] → POST /api/admin/sf/raid-jobs/:id/force-complete
                     └─ status = 'completed', completed_at = NOW()
```


### 6.5 1on1 マッチ ポイント決済フロー

```
[THE LOBBY — 1on1 MATCH タブ]
   ユーザー: 条件入力 → 「FIND CHALLENGER」
        │
        ▼
POST /api/sf/match
   { data_size_gb, frames, vram_required_gb, realtime }
        │
        ▼ 3枚のモードカード (Speed Star / Heavy Weight / Street Fighter)
   カード選択 → selectCard('speed_star')
        │
        ▼
confirmMatch()
        │
        ├─ GET /api/points/balance      → _raidBalance
        ├─ .price-value から _matchCostYen 取得
        └─ 決済モーダル表示 (クーポン入力 / ポイント残高)
             │
             ▼ [FIGHT START]
executeMatchPayment()
        │
        ▼
POST /api/sf/match/:id/confirm
   { selected_mode: 'speed_star', coupon_code: 'XYZ' }
        │
        ├─ validateCoupon() → 割引計算
        ├─ 残高確認 → 不足時: 402 { required, balance }
        ├─ DB: point_balance -= finalCost
        ├─ point_logs INSERT (type='spend', source='match')
        ├─ sf_match_requests.status = 'confirmed'
        └─ sf_nodes.status = 'busy'
        │
        ▼
   WS: sf:match_confirmed → lobby バナー表示
        │
        ▼
   location.href = /workspace/?match=:id
   workspace initSfFromUrl() → 10秒ポーリング
```

### 6.6 管理者 SF Nodes (THE DOJO) 管理フロー

```
[管理画面 /admin/ → SF Nodes タブ]
   loadSfNodes() → GET /api/admin/sf/nodes
        │
   レスポンス: { nodes[], stats: { online, busy, offline, total_tflops } }
        │
   テーブル表示:
     各行にアクションボタン:
       [⏹] busy/idle ノード → setSfNodeStatus(id, 'offline')
                PATCH /api/admin/sf/nodes/:id/status { status: 'offline' }
       [▶] offline ノード   → setSfNodeStatus(id, 'idle')
                PATCH /api/admin/sf/nodes/:id/status { status: 'idle' }
       [🗑] ノード削除      → deleteSfNode(id, hostname)
                DELETE /api/admin/sf/nodes/:id
                ※ busy 状態は保護 (400 エラー)
        │
   [⏹ 一括オフライン] ボタン → bulkOfflineSfNodes()
        │
        ▼
POST /api/admin/sf/nodes/bulk-offline
   heartbeat タイムアウト (120秒以上) の全ノードを offline に変更
   レスポンス: { affected: N }
```
