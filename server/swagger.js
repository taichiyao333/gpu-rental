/**
 * swagger.js — Swagger / OpenAPI 3.0 ドキュメント設定
 * /api/docs で Swagger UI を提供する
 */
'use strict';

const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi    = require('swagger-ui-express');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title       : 'GPURental + GPU Street Fighter API',
            version     : '2.0.0',
            description : `
**GPURental** — 分散GPU レンタル・管理プラットフォーム (METADATALAB.INC)

## 認証
ほとんどのエンドポイントは **Bearer JWT** が必要です。
\`\`\`
Authorization: Bearer <token>
\`\`\`
\`/api/auth/login\` でトークンを取得してください。

## GPU Street Fighter (SF)
レイドバトルと 1on1 マッチのジョブ管理エンドポイント群です。

## MRP Orchestrator
\`MRP_ORCHESTRATOR_URL\` (inference.gpurental.jp) への AI 動画処理ジョブ連携。
            `.trim(),
            contact: {
                name : 'METADATALAB.INC',
                url  : 'https://gpurental.jp',
                email: 'info@miningdatalab.com',
            },
            license: { name: 'Proprietary' },
        },
        servers: [
            { url: 'https://gpurental.jp', description: '本番環境' },
            { url: 'http://localhost:3000', description: 'ローカル開発' },
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type  : 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
            schemas: {
                User: {
                    type: 'object',
                    properties: {
                        id       : { type: 'integer', example: 1 },
                        username : { type: 'string',  example: 'taich' },
                        email    : { type: 'string',  example: 'taich@example.com' },
                        role     : { type: 'string',  enum: ['user', 'provider', 'admin'] },
                        points   : { type: 'integer', example: 5000 },
                        created_at: { type: 'string', format: 'date-time' },
                    },
                },
                SfRaidJob: {
                    type: 'object',
                    properties: {
                        id             : { type: 'integer' },
                        status         : { type: 'string', enum: ['payment_pending','paid','dispatched','running','completed','failed','cancelled'] },
                        user_id        : { type: 'integer' },
                        node_count     : { type: 'integer', example: 3 },
                        payment_method : { type: 'string', enum: ['points','stripe'] },
                        payment_amount_yen: { type: 'number', example: 1980 },
                        points_used    : { type: 'integer', example: 500 },
                        output_url     : { type: 'string', nullable: true },
                        created_at     : { type: 'string', format: 'date-time' },
                        completed_at   : { type: 'string', format: 'date-time', nullable: true },
                    },
                },
                Pod: {
                    type: 'object',
                    properties: {
                        id            : { type: 'integer' },
                        status        : { type: 'string', enum: ['creating','running','stopped','error'] },
                        provider_id   : { type: 'integer' },
                        reservation_id: { type: 'integer' },
                        workspace_path: { type: 'string' },
                        created_at    : { type: 'string', format: 'date-time' },
                    },
                },
                ErrorResponse: {
                    type: 'object',
                    properties: {
                        error  : { type: 'string', example: 'Unauthorized' },
                        message: { type: 'string', example: 'JWT token expired' },
                    },
                },
            },
        },
        security: [{ bearerAuth: [] }],
        tags: [
            { name: 'Auth',         description: '認証・ユーザー管理' },
            { name: 'SF Raid',      description: 'GPU Street Fighter — RAID バトル' },
            { name: 'SF Match',     description: 'GPU Street Fighter — 1on1 マッチ' },
            { name: 'SF Nodes',     description: 'GPU Street Fighter — エージェントノード' },
            { name: 'Pods',         description: 'GPU Pod ライフサイクル管理' },
            { name: 'Reservations', description: '予約・スケジュール管理' },
            { name: 'Points',       description: 'ポイント購入・残高' },
            { name: 'Payments',     description: '決済 (Stripe / GMO Epsilon)' },
            { name: 'Files',        description: 'ファイルアップロード・ダウンロード' },
            { name: 'Admin',        description: '管理者専用エンドポイント' },
            { name: 'Diagnostics',  description: 'システム診断・ヘルスチェック' },
        ],
    },
    apis: ['./server/routes/*.js', './server/index.js'],
};

const swaggerSpec = swaggerJsdoc(options);

/**
 * Swagger UI を Express app に登録する
 * @param {import('express').Application} app
 */
function setupSwagger(app) {
    // Swagger UI
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
        customCss: `
            .topbar { background: #0d0d14; }
            .topbar-wrapper img { content: url('/icon.svg'); height: 32px; }
            body { background: #0d0d14; color: #e8e8f0; }
            .swagger-ui .info .title { color: #6c47ff; }
        `,
        customSiteTitle: 'GPURental API Docs',
        swaggerOptions: {
            persistAuthorization: true,
            filter: true,
            tryItOutEnabled: true,
        },
    }));

    // OpenAPI JSON (機械可読)
    app.get('/api/docs.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.send(swaggerSpec);
    });

    console.log('📚 Swagger UI: /api/docs');
    console.log('📄 OpenAPI JSON: /api/docs.json');
}

module.exports = { setupSwagger, swaggerSpec };
