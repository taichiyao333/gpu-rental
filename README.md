# ⚡ GPURental (GPU Rental Platform)

**RTX 4090 / A4500 をはじめ、様々なGPUやノートPCを個人・企業で時間貸し（シェア）する次世代GPUクラウドプラットフォーム**

> 余っている自宅・オフィスのGPUを外部に貸し出して自動で報酬を受け取ったり、外出先のノートPCからクラウド上の高性能GPUを時間単位でレンタルして、AI開発・画像生成・Blenderの重いレンダリングをサクサク実行できるシステムです。

**🌐 サービスURL**: [https://gpurental.jp](https://gpurental.jp)

---

## ✨ 主な機能

### 1. 👥 ユーザー（借りる人）向け
- **時間単位レンタル**: デスクトップ向けの RTX A6000 / RTX 4090 から、ノートPC向けの RTX 4090 / 4080 Laptop GPUシリーズまで、必要なスペックのGPUを1時間あたり数百円の低コストで手軽にデプロイ。
- **Web専用ワークスペース**: 予約時間になると専用のDocker Podが立ち上がり、ブラウザ上で操作できる**Webターミナル**や**Code-Server**（ブラウザ版VSCode）が利用可能。
- **ポイント決済・クレジットカード決済**: 独自のポイント制を利用したわかりやすい課金システム。Stripe Checkout および GMO Epsilon のデュアル決済エンジンをフルサポート。
- **Blender＆クラウドレンダリング**: ユーザーからFFmpegの動画変換ジョブやBlenderの重いレンダリング処理をクラウドサーバーのGPUへ投げる「自動レンダリングAPI機能」を搭載。
- **AI・MCP連携 (Agentic)**: クライアント/Blender側にMCP (Message Control Protocol) 風コマンドソケットサーバーを統合し、LLMエージェント（Antigravity）からの外部操作を可能にするインターフェースを内包。

### 2. 🖥️ プロバイダー（貸す人）向け
- **余剰リソースの収益化**: アイドル状態のパソコンをプロバイダーエージェントに繋ぐだけで、プラットフォームの提供カタログに自動登録され、貸し出された分だけ収益（GPURental収益分配率）が発生。
- **Stripe Connect 対応・出金管理**: プロバイダー自身のアカウント上でStripe Connectに連携することで、獲得した収益（ウォレット残高）を口座へ容易に出金振込可能。
- **環境の自動隔離**: 貸し出し中はセキュアなDockerコンテナの中に隔離されるため、ホストPCの設定やデータを汚される心配はありません。
- **マイページ（プロバイダーUI）**: リアルタイムでマシンの稼働状況や累積報酬額を確認可能。

### 3. 🛡️ 管理者（プラットフォーム運営）向け
- **全体管理ダッシュボード**: 売上KPI、GPUマシンの稼働率、予約状況などを1つの画面で一元管理。
- **リアルタイム・ヘルスモニター**: WebSocketを通じたリアルタイム通信と、`health-check.js` ベースの診断により、ページをリロードすることなく各ノードのCPU/VRAM/温度やStripe Webhookの未着エラー、サーバーのディスク空き容量を監視。
- **柔軟なポイント付与（API対応）**: ユーザーへの個別ボーナスポイントの即時付与・履歴管理。
- **RunPod価格監視・競合比較（APIスクレイピング）**: 外部大手GPUクラウド（RunPod等）の提供価格を定期的に自動取得し、自社プラットフォームの適正価格をUI上で比較・ワンクリック適用。

---

## 🏗 アーキテクチャ

```text
┌─────────────────────────────────────────────────────────────────┐
│             インターネット ( https://gpurental.jp )              │
│ Stripe / GMO Epsilon Webhook  ← Cloudflare API Gateway          │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │  Express + Socket.io  │
                    │ Node.js 中央サーバー  │
                    └─┬───────┬───────┬─────┘
                      │       │       │
            ┌─────────▼┐  ┌───▼───┐ ┌─▼─────────┐
            │SQLite DB │  │GPU    │ │Scheduler  │
            │(Local)   │  │Manager│ │(Cron/Bat) │
            └──────────┘  └───────┘ └───────────┘
```

### 🛠 技術スタック
- **Backend Core**: Node.js + Express 4 + Socket.io (WebSocketによるリアルタイム通信)
- **Database**: SQLite (better-sqlite3)
- **Resource Monitor**: nvidia-smi リアルタイムポーリング / Docker API
- **Media Processing**: FFmpeg による分散H.264/H.265クラウドレンダリング
- **Authentication**: JWT (JSON Web Token) + bcrypt
- **Payments**: Stripe Checkout / Stripe Connect / GMO Epsilon
- **Frontend**: Vanilla HTML/JS + Modern CSS (レスポンシブなダークテーマ)
- **Infrastructure**: PM2 / Cloudflare Tunnel（セキュアな外部公開）

---

## 🚀 開発とデプロイ

### 環境変数の設定
プロジェクトルートに `.env` を作成し、以下を設定します。
```env
PORT=3000
JWT_SECRET=your_jwt_strong_secret
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
ADMIN_PASSWORD=your_admin_password
```

### 起動方法
```bash
npm install
npm start
```
起動後、ブラウザで `http://localhost:3000/admin/` にアクセスし設定を開始します。

※ **注記**: SQLiteファイルは `data/` トおよび `server/db/gpu_rental.db` 等に自動生成・マイグレーションされます。

---
© 2026 GPURental by METADATALAB.INC. All Rights Reserved.
