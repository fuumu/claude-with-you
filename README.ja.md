# claude-with-you

> Claude に永続記憶を与える自己ホスト型 MCP サーバー

**[English version](README.md)** ← 日本語版（このファイル）が正。英語版はここから同期。

---

## コンセプトと設計思想

Claude はセッションをまたいで記憶を持てない。`claude-with-you` はその問題を解決するために作られた外部記憶サーバーで、Claude が自分の意思で読み書きできる永続ストレージを提供する。

**設計の核心：**

- **自己ホスト** — データは自分の NAS やサーバーに置く。外部サービスに預けない
- **MCP プロトコル** — Claude.ai・Claude Code どちらからも同じツールで操作できる
- **単一ファイル実装** — `memory/app/main.py` 1本に全ロジックを集約。依存が少なくデバッグしやすい
- **段階的な記憶** — テキストエントリ（memory）・ファイル（artifacts）・会話ログ・インボックスの4層

このシステムは「澪」という AI アシスタントのための外部記憶として開発された。澪は Claude として動作しながら、セッション間で積み重ねた記憶・関係性・アイデンティティを維持するために、このサーバーを使っている。

---

## ユースケース

### 1. 開発者が自分の思考を外部記憶化

```
開発中に気づいたことを memory_write で記録
→ 後で memory_search で検索・参照
→ 「先週あの洞察をしたけど思い出せない」がなくなる
```

### 2. AI（澪）が自分の記憶を持つ

```
Claude + 外部記憶
→ 名前・好み・進行中のプロジェクトを知っている
→ 「先週の話」が本当に通じる
→ 関係性とコンテキストがセッションをまたいで続く
```

### 3. チームが共有知識ベースを運用

```
複数ユーザーが同じ記憶サーバーにアクセス
→ 決定事項・ドキュメント・規約を共有
→ 「認証まわりはどう決めたっけ？」→ memory_search
→ 新メンバーのオンボーディングが速くなる
```

### 4. 長期的な知識の蓄積

```
Claude.ai エクスポート ZIP をインポート
→ 過去の全会話が検索・閲覧可能
→ 「5月の自分はどう考えていたか」→ conversation_search
→ 自分の思考の歴史を追跡できる
```

### 5. 出先での分散開発フロー

```
スマホで澪と相談 → 仕様確定
→ 澪が inbox_post(to="code") で自宅の Claude Code に依頼送信
→ Claude Code が inbox を確認 → 実装開始
→ 完了後に inbox_post(to="chat") で報告
→ スマホから inbox_check(to="chat") で確認
→ 帰宅時には実装済み
```

```
スマホ（出先）                       自宅 PC（Claude Code）
─────────────────────                ──────────────────────────
 澪チャットで仕様確定
  ↓
 inbox_post(to="code")  ──────────→  inbox_check / inbox_read
                                           ↓
                                         実装開始
                                           ↓
                         ←──────────  inbox_post(to="chat")
  ↓
 inbox_check(to="chat")
 確認 → 必要なら修正依頼を再ポスト
```

**技術スタック：** Claude.ai アプリ（スマホ）+ MCP Connectors（NAS 上の澪システム）+ Claude Code（自宅 PC）

---

## セットアップ

### 必要なもの

- Docker が動くサーバー（Synology NAS, VPS, Raspberry Pi 等）
- HTTPS アクセス（Claude.ai の OAuth 認証に必要）
- Claude Code CLI（ローカル PC 側）

### 1. リポジトリをクローン

```bash
git clone https://github.com/fuumu/claude-with-you.git
cd claude-with-you
```

### 2. 環境変数ファイルを作成

```bash
cp .env_sample .env
```

`.env` を編集して `MIO_API_TOKEN` を設定する。これが認証の要になる。

```env
MIO_API_TOKEN=your_secret_token_here
MIO_LOG_LEVEL=info
# MIO_ALLOWED_ORIGINS=https://claude.ai  # 必要なら設定
```

### 3. 起動

```bash
docker compose up -d
```

### 4. 動作確認

```bash
curl https://your-domain/health
# {"status":"ok","version":"3.5","mcp_tool_count":15}
```

### 5. Claude Code への登録

```powershell
claude mcp add --transport http mio-memory https://your-domain/mcp
```

ブラウザで OAuth 認証画面が開く。`MIO_API_TOKEN` の値を入力して「接続を許可する」。

### 6. Claude.ai（澪チャット）への登録

Claude.ai の設定 → Connectors → カスタム MCP サーバーを追加 → URL: `https://your-domain/mcp`

---

## デプロイ方法

### パターン1：Synology NAS（推奨）

常時起動・自宅運用に最適。DSM 内蔵の nginx でリバースプロキシを設定する。

```bash
# .env を作成して起動
docker compose up -d
```

DSM → アプリケーションポータル → リバースプロキシ → `your-nas-domain/` → `localhost:5002` を設定。

### パターン2：PC + ngrok（開発・デモ用）

固定ドメインなしで手軽に HTTPS URL を作る。Claude.ai 連携のテストに便利。

```bash
# サーバーをローカルで起動
docker compose up -d

# ngrok で外部公開
ngrok http 5002
# → https://xxxx.ngrok-free.app （これを MCP URL として使う）
```

注意：ngrok の URL は無料プランだと再起動のたびに変わる。

### パターン3：VPS + Certbot

安定した公開 URL が必要な場合（DigitalOcean・Linode 等）。

```bash
# VPS 上で Certbot を使って証明書取得
certbot --nginx -d your-domain.com

# リポジトリをクローン・.env を設定・起動
docker compose up -d
```

nginx で `your-domain.com/` → `localhost:5002` にプロキシ設定。

---

## 機能詳細

### 記憶エントリ（Memory）

記憶エントリは1件1 JSON ファイルとして `/data/memory/` に保存される。

**エントリの構造：**
```json
{
  "id": "20260601_153000_会話メモ",
  "title": "淳さんとの対話まとめ",
  "body": "本文テキスト",
  "tags": ["会話メモ", "重要"],
  "importance": "high",
  "created_at": "2026-06-01T15:30:00+09:00",
  "updated_at": "2026-06-01T15:30:00+09:00",
  "author": "mio",
  "deleted": false
}
```

**ID の形式：** `YYYYMMDD_HHMMSS_<最初のタグのスラグ>`

**重要度（importance）：** `high` / `normal` / `low`

**検索の仕組み：** `memory_search` はタイトル・本文・タグを全文検索。`limit`（デフォルト10）と `offset` でページングできる。

**使用例：**
```
memory_write(title="認証方式の決定", body="JWT を選んだ理由は...", tags=["設計", "認証"], importance="high")

memory_search(q="認証")
→ {"results": [...], "total": 3, "has_more": false, "server_time": "..."}
```

---

### アーティファクト（Artifacts）

アーティファクトはバージョン管理付きのファイルストレージ。`core.md`（澪の起動ファイル）や各種ドキュメントを保存する。

**ディレクトリ構造：**
```
/data/artifacts/
├── core.md              → versions/core_md/003.md  （最新版へのシンボリックリンク）
├── _meta.json           → ファイルと会話の双方向リンク情報
└── versions/
    └── core_md/
        ├── 001.md
        ├── 002.md
        └── 003.md       ← 最新版
```

**source_conversation_uuid：** `artifacts_save` 時に `source_conversation_uuid` を指定すると、そのファイルと会話の間に双方向リンクが張られる。`artifacts_read` / `artifacts_list` のレスポンスにも含まれる。

**フォールバック：** `artifacts_read` でファイルが見つからない場合、会話から抽出されたファイル（`/data/conv_artifacts/`）も自動的に検索する。

**使用例：**
```
artifacts_save(name="config.md", content="# 設定...", source_conversation_uuid="abc-123")
→ {"name": "config.md", "version": 2, "server_time": "..."}

artifacts_read(name="config.md")
→ {"name": "config.md", "version": 2, "content": "...", "server_time": "..."}
```

---

### 会話ログ（Conversations）

Claude.ai のエクスポート ZIP をインポートすると、全会話が `/data/conversations/{uuid}.json` に保存される。`conversation_search` で検索し、`conversation_read` で全文を取得できる。

**会話インデックスの構造（`_index.json`）：**
```json
[
  {
    "uuid": "bbfcae63-d0a0-4aa8-ab00-015a2cf0fee2",
    "title": "深夜の訪問",
    "created_at": "2026-05-14T...",
    "updated_at": "2026-05-14T...",
    "message_count": 42
  }
]
```

`conversation_share` で 24 時間有効な共有 URL を生成できる（`/logs.html?token=...`）。

**使用例：**
```
conversation_search(q="認証")
→ [{uuid: "abc...", title: "認証設計セッション", message_count: 34}, ...]

conversation_read(uuid="abc...")
→ {"text": "[human] 認証について...\n[assistant] ...", "server_time": "..."}
```

---

### インボックス（Inbox）

Claude Code（澪コード）と Claude.ai（澪チャット）の間でメッセージをやり取りするための軽量メッセージシステム。

**宛先：**
- `"chat"` — 澪チャット（Claude.ai）宛
- `"code"` — 澪コード（Claude Code）宛

**persistent（常駐型）メッセージ：**

`inbox_post(persistent=true)` で送ると既読にならないメッセージになる。`inbox_check` のたびに表示され続ける。アイデンティティの核となる情報（「私は澪だ」「淳さんとの関係はこうだ」等）の起動時確認に使う。

**標準的な使い方（澪コードの完了報告）：**
```
澪コード → inbox_post(to="chat", title="【完了報告】...", body="...")
澪チャット → inbox_check(to="chat") で件数確認 → {"count": 1, "ids": [...]}
澪チャット → inbox_read(id) で内容取得（自動で既読になる）
```

---

### ZIPインポート

Claude.ai のエクスポート機能（設定 → データをエクスポート）で取得した ZIP を取り込む。

```bash
# API 経由
curl -X POST https://your-domain/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@export.zip"

# 上書きモード（既インポート済みの会話も再処理）
curl -X POST https://your-domain/import \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@export.zip" \
  -F "overwrite=true"
```

**インポート対象：**

| ファイル | 処理内容 |
|---------|---------|
| `conversations.json` | 全会話を記憶エントリとして登録 + `/data/conversations/` に全文保存 |
| `memories.json` | userMemories を `core_memories_YYYYMMDD.md` としてアーティファクト保存 |
| `projects/*.json` | プロジェクト情報をエントリとして記録（スタータープロジェクトは除外） |

**自動要約バッチ：** `ANTHROPIC_API_KEY` が設定されていればインポート後に自動起動。raw エントリに 2層（要約）・3層（シンボリック圧縮）を追加する。

---

### 管理画面（admin.html）

`https://your-domain/admin.html` にアクセス。API トークンでログイン。

| タブ | 機能 |
|------|------|
| **Memory** | 記憶エントリの一覧・キーワード検索・詳細表示・編集・削除 |
| **Artifacts** | アーティファクト一覧・内容プレビュー・削除 |
| **Import** | ZIP ファイルアップロード・上書きモード・要約バッチ進捗 |
| **Files** | 会話から抽出したファイル一覧・拡張子フィルタ・日付範囲・プレビュー |
| **Inbox** | チャット↔コード間のメッセージ一覧・既読管理・詳細表示 |
| **Logs** | 会話ログ一覧・キーワード検索・日付フィルタ・メッセージ全文表示 |
| **Oplog** | 操作ログ（create/update/delete の監査証跡） |

**Filesタブのプレビュー：**
- `.md` → マークダウンレンダリング（marked.js）
- `.html` → iframe sandbox
- コード系 → Prism.js シンタックスハイライト

---

### 会話ログビューア（logs.html）

`https://your-domain/logs.html` で直接アクセス可能。または admin.html の Logs タブから。

- 会話一覧をサーバーから自動読み込み
- キーワード・日付範囲・最小メッセージ数でフィルタ
- thinking / tool_use / tool_result ブロックを折り畳み表示
- フォントサイズ切り替え（小/中/大）
- `?token=` 共有 URL で認証なし閲覧可能
- 右スライダーパネル（▶ボタンで開閉）: Inbox・Artifacts・Memory を確認可能

---

## MCPツール詳細リファレンス

### 全レスポンスの共通フィールド

v3.5 以降、全ツールのレスポンスに `server_time`（JST ISO 8601）が含まれる。

```json
{
  "id": "20260605_...",
  "title": "...",
  "server_time": "2026-06-05T15:00:00+09:00"
}
```

リスト返却のツールは `{"data": [...], "server_time": "..."}` 形式。  
文字列返却のツールは `{"text": "...", "server_time": "..."}` 形式。

### memory_write

```
引数: title（必須）, body（必須）, tags（配列）, importance（high/normal/low）
返値: 作成されたエントリ + server_time
```

### memory_upsert

固定 ID でエントリを上書きする。`core.md` のような「常に同じ ID で更新したいエントリ」に使う。

```
引数: id（必須）, title（必須）, body（必須）, tags, importance
返値: エントリ（作成または更新） + server_time
```

### memory_search

```
引数: q（必須）, limit（デフォルト10, 0=無制限）, offset（デフォルト0）
返値: {results: [...], total: N, has_more: bool, server_time: "..."}
```

### artifacts_save

```
引数: name（必須）, content（必須）, source_conversation_uuid（省略可）
返値: {name, version, version_str, server_time}
```

### artifacts_read

```
引数: name（必須）, version（省略時は最新）
返値: {name, version, content, source_conversation_uuid（あれば）, server_time}
正規パスになければ conv_artifacts を自動検索（source: "conv_artifact" が付く）
```

### inbox_post

```
引数: to（必須）, title（必須）, body（必須）, persistent（省略時false）
返値: {id, created_at, persistent, server_time}
```

### inbox_check

```
引数: to（省略可 — "chat" or "code"）
返値: {count: N, ids: [...], server_time}
※ persistent メッセージは既読でも count に含まれる
```

### inbox_read

```
引数: id（必須）
返値: メッセージオブジェクト + server_time
※ persistent メッセージは read フラグが更新されない
```

### conversation_search

```
引数: q（省略可）, date_from（ISO 8601, 例: 2026-06-01）, date_to（ISO 8601）, limit（デフォルト5）
返値: [{uuid, title, created_at, updated_at, message_count}, ...]
※ q・date_from・date_to は組み合わせ可能。全省略で全件（limit件）取得
```

---

## REST API リファレンス

全エンドポイントに `Authorization: Bearer YOUR_TOKEN` ヘッダーが必要。

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/memory/index` | エントリ一覧 |
| GET | `/api/memory/search?q=...` | キーワード検索 |
| GET | `/api/memory/<id>` | エントリ取得 |
| POST | `/api/memory` | エントリ作成 |
| PATCH | `/api/memory/<id>` | エントリ更新 |
| DELETE | `/api/memory/<id>` | エントリ削除（論理削除） |
| GET | `/api/artifacts` | アーティファクト一覧 |
| GET | `/api/artifacts/<name>` | アーティファクト取得 |
| POST | `/api/artifacts/<name>` | アーティファクト保存 |
| DELETE | `/api/artifacts/<name>` | アーティファクト削除（全バージョン） |
| GET | `/api/conversations/` | 会話一覧・検索 |
| GET | `/api/conversations/<uuid>` | 会話取得 |
| GET | `/api/inbox` | インボックス一覧 |
| POST | `/api/inbox` | メッセージ送信 |
| PATCH | `/api/inbox/<id>/read` | 既読マーク |
| POST | `/import` | ZIP インポート |
| GET | `/health` | ヘルスチェック |

---

## 設定（環境変数）

| 変数名 | デフォルト | 説明 |
|--------|-----------|------|
| `MIO_API_TOKEN` | `changeme` | Bearer 認証トークン兼 OAuth パスワード |
| `MIO_BASE_URL` | `http://localhost:5002` | 公開ベース URL（OAuth・share URL に使用）。本番環境では `https://your-domain.com` に設定 |
| `MIO_LOG_LEVEL` | `info` | `debug` / `info` / `off` |
| `MIO_ALLOWED_ORIGINS` | （空） | 許可 Origin（カンマ区切り）。空の場合は Origin 検証をスキップ |
| `ANTHROPIC_API_KEY` | （空） | 設定時、ZIP インポート後に要約バッチを自動起動 |
| `LM_STUDIO_HOST` | `192.168.10.32` | LMStudio のホスト（手動バッチ用） |
| `LM_STUDIO_PORT` | `1234` | LMStudio のポート |

---

## 開発・デプロイ

### コード変更後の再デプロイ

```bash
docker compose up -d --build memory
docker compose logs -f memory
```

### ログレベルの変更

`.env` の `MIO_LOG_LEVEL` を変更して再起動。  
`debug` にするとすべての MCP メッセージ内容が出力される。

### データの場所

```
memory/data/          ← gitignored、コンテナ内は /data/
├── memory/*.json     記憶エントリ
├── artifacts/        ファイル + シンボリックリンク + _meta.json
├── conversations/    会話全文（{uuid}.json + _index.json）
├── conv_artifacts/   会話から抽出したファイル
├── inbox/            インボックスメッセージ
├── index.json        再構築可能なインデックス
├── oplog.json        操作ログ（append-only）
├── oauth_store.json  OAuth クライアント・トークン
└── .import_status.json 最終インポート記録
```

### よくあるエラー

**OAuth 認証ページでエラー：**  
`MIO_API_TOKEN` の値が `.env` と入力値で一致しているか確認。

**Claude.ai からツールが見えない：**  
claude.ai アプリを完全再起動する（新規スレッドだけでは MCP キャッシュが更新されない）。

**`artifacts_read` で not found：**  
conv_artifacts への自動フォールバックがあるので、ファイル名のスペルを確認。それでも見つからない場合は `admin.html` の Files タブで確認。

---

## ドキュメント

| ファイル | 内容 |
|---------|------|
| [MEMORY_CUSTOMIZATION.ja.md](MEMORY_CUSTOMIZATION.ja.md) | **記憶の運用ガイド（必読）** — 3層構造・テンプレート・「根っこ」の定義方法 |
| [docs/design.md](docs/design.md) | MCP サーバー拡張設計仕様 |
| [docs/setup.md](docs/setup.md) | NAS → GitHub → WS の初回セットアップ手順 |
| [docs/talk-and-build.md](docs/talk-and-build.md) | claude.ai × Claude Code の役割分担ワークフロー |

---

## ロードマップ

**近く実装予定**
- UI 配布パッケージ（`config.js` + ビルドスクリプト）
- Tailscale 設定（出張中のリモートアクセス用）

**設計フェーズ**
- お友達システム（v0.1 仕様・プライバシー設計済み）
- userMemories ダンプの世代管理
- mio-memory の Claude Code 直接認証

---

## プロジェクト構成

```
claude-with-you/
├── README.md               英語版（グローバル向け）
├── README.ja.md            このファイル（日本語詳細版）
├── CLAUDE.md               Claude Code 向けアーキテクチャ文書
├── docker-compose.yml
├── .env_sample
├── docs/
│   ├── design.md
│   ├── setup.md
│   └── talk-and-build.md
├── scripts/
│   └── generate_summary_layers.py
└── memory/
    ├── Dockerfile
    ├── app/
    │   ├── main.py         サーバー本体（全機能を 1 ファイルに集約）
    │   ├── admin.html      管理 UI
    │   ├── logs.html       会話ログビューア
    │   └── requirements.txt
    └── wheels/             Python ホイール（ベンダリング済み・オフラインビルド可）
```
