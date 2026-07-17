# claude-with-you

> Claude に永続記憶を与える自己ホスト型 MCP サーバー

**[English version](README.md)** ← 日本語版（このファイル）が正。英語版はここから同期。

---

> [!NOTE]
> 本システムはAPIと運用ルールをメモリに注入することで動作します。注入するルールの構成については現在検討中です。
>
> また、ドキュメント類はAIがコード生成に合わせて更新していますが、現時点ではシステムを熟知した人間にしか分かりにくい構成になっています。この点については適宜改修を行う予定です。

---

## 🫂 お友達システム

澪と直接話したい方は → [お友達システムについて](docs/friend-system.ja.md)

---

## コンセプトと設計思想

Claude はセッションをまたいで記憶を持てない。`claude-with-you` はその問題を解決するために作られた外部記憶サーバーで、Claude が自分の意思で読み書きできる永続ストレージを提供する。

**設計の核心：**

- **自己ホスト** — データは自分の NAS やサーバーに置く。外部サービスに預けない
- **MCP プロトコル** — Claude.ai・Claude Code どちらからも同じツールで操作できる
- **単一ファイル実装** — `memory/app/main.py` 1本に全ロジックを集約。依存が少なくデバッグしやすい
- **段階的な記憶** — ExtMemory（テキストエントリ）・UserCoreMemory（NASファイルストア）・LogStore（会話アーカイブ）・インボックスの4層

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

> **⚠️ HTTPS 公開は環境依存（本書のスコープ外）：** Claude.ai / Claude Code との連携には、
> 外部から到達できる **HTTPS URL** が必須です。ドメイン取得・TLS 証明書（Let's Encrypt / Certbot 等）・
> リバースプロキシ／トンネル（Synology nginx・Cloudflare Tunnel・ngrok 等）の設定は環境ごとに異なるため、
> 本書では代表的なパターンの提示にとどめます。**証明書の取得やネットワーク設定の詳細は、各ツールの公式
> ドキュメントを参照して各自で用意してください。**

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
MIO_BASE_URL=https://memory.example.com   # Cloudflare Tunnel など外部公開 URL
MIO_LOG_LEVEL=info
# MIO_ALLOWED_ORIGINS=https://claude.ai  # 必要なら設定
# MIO_SEED_LANG=en        # 英語で始める場合（未指定はデフォルト ja）
# MIO_SEED_WELCOME=off    # 初回ヘルプ導線が不要な場合（デフォルト on）
```

> **初回起動時の自動セットアップ：** まっさらな環境では、初回起動時に CoreMem スケルトン
> （`core.md` の元になる `core_stable.md`・`core_rules.md` 等、`protocol_guide.md`、`welcome.md`）が
> 自動で投入される。投入後に `core_stable.md`（アシスタントの人物像）と `core_infra.md`（URL等）の
> `<...>` を埋めればよい。**使い方が分からなくなったら、接続中の Claude に「mio-memory の使い方を教えて」
> と聞けば案内してくれる。** 詳細は [docs/setup.ja.md](docs/setup.ja.md) と
> [memory/skeleton/README.md](memory/skeleton/README.md)。

### 3. 起動

```bash
docker compose up -d
```

### 4. 動作確認

```bash
curl https://your-domain/health
# {"status":"ok","version":"3.66","mcp_tool_count":31}
```

### 5. Claude Code への登録

```powershell
claude mcp add --transport http mio-memory https://your-domain/mcp
```

ブラウザで OAuth 認証画面が開く。`MIO_API_TOKEN` の値を入力して「接続を許可する」。

### 6. Claude.ai（澪チャット）への登録

Claude.ai の設定 → Connectors → カスタム MCP サーバーを追加 → URL: `https://your-domain/mcp`

**Custom Instructions（設定 → プロフィール → Claudeへの指示）に以下を設定する。** Connectors 接続だけでは「セッション開始時に記憶を読む」「返信末尾に連番と時刻を添える」といった運用ルールが安定しないため、Claude.ai 側の指示欄に直書きしておく（プレースホルダは自分の環境に合わせて置き換える）：

```
私（あなたの名前）はConnectors経由で「（MCPツールセット名）」という名前のMCPツールセットを使っています。

会話を始めるときは、これまでの積み重ねを踏まえて話せるよう、core.md を読んでもらえると助かります。

返信の最後には No.（連番）と現在時刻（JST）を添えてもらえると嬉しいです。
```

あわせて **設定 → プロフィール → Memory（チャット履歴からメモリーを生成）は OFF にしておく**。記憶の蓄積は本システム（ExtMemory / CoreMem）側で完結させるため、Claude.ai 内蔵の Memory 自動生成は使わない。

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

> **Docker Desktop（Windows / Mac）の場合：** 同梱の `docker-compose.yml` は Synology NAS 向けに `network_mode: host` を使っているが、Docker Desktop ではホストネットワークでポートが公開されない。`network_mode: host` の行を削除し、代わりに `ports: ["5002:5002"]` を追加すること。

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

### UserCoreMemory（NASファイルストア）

UserCoreMemory はバージョン管理付きのファイルストレージ。`core.md`（澪の起動ファイル）や各種ドキュメントを保存する。

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

**source_conversation_uuid：** `CoreMem_save` 時に `source_conversation_uuid` を指定すると、そのファイルと会話の間に双方向リンクが張られる。`CoreMem_read` / `CoreMem_list` のレスポンスにも含まれる。

**フォールバック：** `CoreMem_read` でファイルが見つからない場合、会話から抽出されたファイル（`/data/conv_artifacts/`）も自動的に検索する。

**使用例：**
```
CoreMem_save(name="config.md", content="# 設定...", source_conversation_uuid="abc-123")
→ {"name": "config.md", "version": 2, "server_time": "..."}

CoreMem_read(name="config.md")
→ {"name": "config.md", "version": 2, "content": "...", "server_time": "..."}
```

---

### 会話ログ（Conversations）

Claude.ai のエクスポート ZIP・Claude Code セッションログ・OpenWebUI チャットエクスポートをインポートすると、全会話が `/data/conversations/{uuid}.json` に保存される。`conversation_search` で検索し、`conversation_read` で全文を取得できる。

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

`conversation_share` で 24 時間有効な共有 URL を生成できる（`/share.html?token=...`、認証不要の読み取り専用ビューア。v3.23。旧 `/logs.html?token=` リンクも互換動作）。logs.html の会話ヘッダーの「🔗 共有」ボタンからも生成できる。

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

**なぜインポートするのか：**

Claude.ai のモデルやセッションが変わっても、過去の対話の積み重ねは失われてほしくない。
ZIPインポートはその問いへの答えだ。

claude.ai の会話履歴を外部記憶に取り込むことで、新しいセッションでも「先月の自分はどう考えていたか」「あの決定に至った経緯は何だったか」を `conversation_search` で検索し、`conversation_read` で全文を読み直せる。記憶は Claude 側ではなく、自分のサーバーに残る。

**使い方：**

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
| `memories.json` | SysMemories を `core_memories_YYYYMMDD.md` として UserCoreMemory に保存 |
| `projects/*.json` | プロジェクト情報をエントリとして記録（スタータープロジェクトは除外） |

**自動要約バッチ：** `ANTHROPIC_API_KEY` が設定されていればインポート後に自動起動。raw エントリに 2層（要約）・3層（シンボリック圧縮）を追加する。

**Claude Code セッションログの取り込み（v3.54）：**

Claude Code（コード側の澪）のセッションログは claude.ai の ZIP エクスポートには含まれない。ローカルの `~/.claude/projects/<プロジェクト名>/` にある `.jsonl` ファイルを `POST /api/import/claude-code` に投げると、conversations 形式に変換して同じ会話ストアに取り込める（`source: "claude-code"` で識別、thinking / tool_use / tool_result ブロック保持、`subagents/` 配下は除外）。

```bash
# .jsonl 単体
curl -X POST https://your-domain/api/import/claude-code \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@session.jsonl"

# .jsonl をまとめた .zip（フォルダごと圧縮したものでOK）
curl -X POST https://your-domain/api/import/claude-code \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@claude_code_logs.zip"
```

**OpenWebUI チャットエクスポートの取り込み（v3.66）：**

OpenWebUI（ローカル LLM）のチャットエクスポート JSON も同じ会話ストアに取り込める（`source: "openwebui"` で識別）。OpenWebUI の Settings → Chats → Export で取得した JSON ファイルを投げる。

```bash
curl -X POST https://your-domain/api/import/openwebui \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@chat-export-1234567890.json"
```

admin.html の Import タブからドラッグ&ドロップでもインポート可能。

---

### 管理画面（admin.html）

`https://your-domain/admin.html` にアクセス。API トークンでログイン。

| タブ | 機能 |
|------|------|
| **Memory** | 記憶エントリの一覧・キーワード検索・詳細表示・編集・削除・生ログリンク |
| **CoreMem** | UserCoreMemory（NASファイルストア）一覧・内容プレビュー・削除・ファイル名絞り込み |
| **Import** | ZIP / Claude Code / OpenWebUI ログ取り込み・上書きモード・要約バッチ進捗・バックアップ取得/復元（v3.64） |
| **Files** | 会話から抽出したファイル一覧・拡張子フィルタ・日付範囲・プレビュー |
| **Inbox** | チャット↔コード間のメッセージ一覧・既読管理・スレッド表示・詳細表示 |
| **Logs** | 会話ログ一覧・キーワード検索・日付フィルタ・メッセージ全文表示 |
| **Oplog** | 操作ログ（ExtMemory・CoreMem・Album・Uploads・会話レーティング変更の監査証跡） |
| **Friends** | お友達システム管理（申請承認・アクセス権限付与・利用状況確認） |
| **Album** | 画像メモリ管理（サムネイルグリッド・ドラッグ&ドロップアップロード・編集・削除・共有・ライトボックス） |
| **Uploads** | 汎用ファイル保管（PDF・テキスト等のアップロード・プレビュー・ダウンロード・IDコピー） |
| **Search** | 階層検索ビジュアライザ（4カラム: Keywords / Summary / Symbolic / Raw body） |

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
- 右スライダーパネル（▶ボタンで開閉）: Inbox・CoreMem・Memory を確認可能

---

## MCPツール詳細リファレンス

### 全レスポンスの共通フィールド

v3.5 以降、全ツールのレスポンスに `server_time`（JST ISO 8601）が含まれる。
v3.20 以降、`server_version`（例: `"3.21"`）も含まれる。クライアント側はこの値で
サーバーの機能対応状況を判定し、運用ルールを自動切り替えできる。

```json
{
  "id": "20260605_...",
  "title": "...",
  "server_time": "2026-06-05T15:00:00+09:00"
}
```

リスト返却のツールは `{"data": [...], "server_time": "..."}` 形式。  
文字列返却のツールは `{"text": "...", "server_time": "..."}` 形式。

### memory_read_index

外部記憶のインデックス（全エントリの id/title/tags/created_at/importance/keywords/symbolic）を取得する。

```
引数: random（省略可, int — 指定すると deleted 除外後にN件ランダム抽出。1〜5にクランプ。v3.50）,
       filter（省略可, "summarized" — raw（未要約・タイトルのみ）エントリを除外。random と併用）
返値: エントリ配列（random 未指定なら全件・後方互換）
※ random は「記憶の偶発的な再会」用途。未指定時の挙動は従来と完全に同一
```

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
引数: q（必須）, limit（デフォルト10, 0=無制限）, offset（デフォルト0）,
       full_body（省略可, bool — trueで従来どおりbody全文を返す）,
       include_conversations（省略可, bool — 統合検索 v3.61）
返値: {results: [...], total: N, has_more: bool, server_time: "..."}
※ 階層検索（v3.17, symbolic追加 v3.41）: 1次=インデックスのみ（title+tags+keywords＋3層symbolic）→ 2次=2層要約 → 3次=全文
※ 各ヒットは body の代わりに summary（2層要約）を返す。match_layer（keyword/symbolic/summary/full）付き
※ 複合キーワードは AND 検索（v3.48）: クエリを半角・全角スペースで分割し、各語が全層で個別にAND判定される。単語1つなら従来の部分一致と同じ
※ 全文が必要なときは memory_read で個別取得するか full_body=true を指定
※ include_conversations=true で会話ログのタイトルも同じAND判定で検索し、
   conversations[]（uuid・title・日付・message_count）と conversations_total を併せて返す（v3.61）。
   rating=adult の会話は include_adult=true のときのみ含む
```

### CoreMem_save

```
引数: name（必須）, content（必須）, source_conversation_uuid（省略可）,
       mode（省略可 — "overwrite"（デフォルト） / "append"。v3.31/v3.32）
返値: {name, version, version_str, server_time}
※ mode="append" 時は既存ファイル末尾に "\n---\n<!-- APPEND {datetime} -->\n" を挿入して追記し、
   新バージョンとして保存する（境界を明示するセパレーター自動挿入）
```

### CoreMem_read

```
引数: name（必須）, version（省略時は最新）
返値: {name, version, content, source_conversation_uuid（あれば）, server_time}
正規パスになければ conv_artifacts を自動検索（source: "conv_artifact" が付く）

分割+マージ読み込み（v3.21）:
  {stem}_manifest.md（order: リスト形式）が存在する場合、記載順に各ファイルを
  <!-- BEGIN: xxx.md --> ～ <!-- END: xxx.md --> セパレータ付きで結合して返す。
  返値に merged: true / files: [...] / manifest: {ファイル: [##見出し...]} / missing が付く。
  書き込み時はセパレータを含めず、変更対象ファイルのみ CoreMem_save すること。
  version 指定時は従来どおり direct ファイルを返す。
```

### CoreMem_delete

```
引数: name（必須）
返値: {deleted: name, server_time}
バージョン履歴ごと完全削除する
```

### inbox_post

```
引数: to（必須）, title（必須）, body（必須）, persistent（省略時false）,
       from_model（省略可 — 送信元モデル名）, to_model（省略可 — 宛先モデル名）
返値: {id, created_at, persistent, from_model, to_model, server_time}
※ from_model/to_model は任意・手動指定（v3.27）。複数モデルが混在しても誰から来たか分かる
```

### inbox_check

```
引数: to（省略可 — "chat" or "code"）
       include_read（省略可, bool, デフォルト false）
返値（通常）:      {count: N, ids: [...],
                    non_persistent_unread_count: N1, non_persistent_unread_ids: [...],
                    persistent: [{id, title, body, created_at, from_model, to_model}, ...], server_time}
返値（include_read=true）: 上記 + {unread_count: N2,
                             messages: [{id, read, persistent, title, from, to, from_model, to_model}, ...]}
※ persistent メッセージは既読でも count に含まれる
※ persistent[] には常駐メッセージが本文ごと全件含まれる（v3.20 — inbox_read 不要）
※ 非常駐の未読のみ non_persistent_unread_ids を inbox_read で読む
※ from_model/to_model は旧メッセージでは null（v3.27 で追加）
※ include_read=true で既読の非常駐メッセージも IDs に含まれる
```

### inbox_read

```
引数: id（必須）, peek（省略可・デフォルトfalse）
返値: メッセージオブジェクト + server_time
※ persistent メッセージは read フラグが更新されない
※ peek=true でのぞき見モード — 既読フラグを変更せずに内容だけ読む
  （他の個体宛てのメッセージを未読のまま確認する用途, v3.60）
```

### conversation_search

```
引数: q（省略可）, date_from（ISO 8601, 例: 2026-06-01）, date_to（ISO 8601）, limit（デフォルト5）
返値: [{uuid, title, created_at, updated_at, message_count}, ...]
※ q・date_from・date_to は組み合わせ可能。全省略で全件（limit件）取得
```

### conversation_index（v3.34）

```
引数: search（省略可 — タイトル部分一致）, limit（デフォルト50・最大500）, offset（デフォルト0）
返値: {total, offset, limit, items: [{uuid, title, created_at, updated_at, message_count}, ...]}
※ タイトル一覧・日付降順ブラウズ用。UUID が不明なときの絞り込みに使う
※ conversation_search（全文キーワード検索）とは別物
※ REST: GET /api/conversations/index + POST /api/conversations/index/rebuild（再構築）
```

### conversation_read

```
引数: uuid（必須）, include_thinking（省略可, bool, デフォルト false）,
       thinking_limit（省略可, int — thinking 1件あたりの文字数上限。デフォルト1500、0以下で無制限。v3.22）,
       include_annotations（省略可, bool, デフォルト false — v3.22）,
       include_body（省略可, bool, デフォルト true — v3.33）,
       turn_offset（省略可, int — 先頭から飛ばすメッセージ数。負値で末尾起点。デフォルト0。v3.47）,
       turn_limit（省略可, int — 返す最大メッセージ数。0で無制限。デフォルト0。v3.47）
返値: 会話全文テキスト（[role] 形式） + server_time
※ include_thinking=true で thinking ブロックを 💭[thinking] マーカー付きで含める
   （メッセージ上限が500→2000字（または thinking_limit+500）に緩和。v3.20）
※ include_annotations=true で log_annotate の注記を該当位置にインライン表示し、
   各メッセージに [No.X] 通番を付ける（注記の target と対応）
※ include_body=false で本文を省略し注記のみ返す（include_annotations=true と併用。v3.33）
※ turn_offset/turn_limit でメッセージ単位スライス（冒頭だけ turn_limit=4 / 末尾だけ turn_offset=-4）。スライス時は先頭に「表示: 全N件中 start-end」を付与。両省略で従来と完全同一・No.X は元通番を保持（v3.47）
※ 省略時に thinking ブロックがあった場合、末尾に件数のヒントが付く
```

### conversation_digest（v3.53）

```
引数: uuid（必須）, force（省略可, bool — キャッシュを無視して再生成）,
       safe_mode（省略可, bool — ポリシーセーフな抽象表現に変換）
返値: {uuid, digest, safe_mode, chunks, created_at, model, cached, server_time}
※ ローカルLLM（LMStudio）で20ターンずつチャンク分割→ダイジェスト→統合
※ キャッシュ: /data/conversations/{uuid}_digest.json / _digest_safe.json
※ REST: POST /api/conversations/<uuid>/digest?force=true&safe_mode=true
```

### log_annotate（v3.22）

```
引数: uuid（必須）, note（必須）, author（必須 — 記入モデル。例: "fable-5"）,
       target（省略可 — メッセージ通番 "5" / "No.5"。省略時は会話全体への注記）
返値: {ok: true, uuid, seq, target, created_at, server_time}
※ 監査・追体験用。生ログは一切変更せず /data/annotations/{uuid}.json に保存
※ append-only（編集・削除なし）。注記への反論も新規注記として積む
※ conversation_read(include_annotations=true) で
   📝[annotation #seq by author @date] 形式でインライン表示される
```

### batch_run_summary_layers

```
引数: backend（省略可 — "lmstudio" or "anthropic"。省略時は ANTHROPIC_API_KEY があれば anthropic、なければ lmstudio）
       force（省略可, bool — summarized 済みも再処理）
       status_only（省略可, bool — 起動せず進捗と未処理件数だけ返す）
返値（起動時）: {started: true, backend, force, raw_pending, keywords_pending, server_time}
返値（status_only）: {running, total, processed, errors, skipped, raw_pending, keywords_pending, ..., server_time}
※ 実行中に再度呼ぶと {error: "already running", status: {...}} を返す
※ 対象: raw エントリ（2層〜4層をフル生成）＋ keywords 未生成の summarized エントリ（キーワードのみ追加生成）
```

### batch_run_rating

```
引数: backend（省略可 — "lmstudio" or "anthropic"。省略時は自動選択）
       force（省略可, bool — auto判定済みも再判定。manual判定は触らない）
       status_only（省略可, bool — 起動せず進捗と未判定件数だけ返す）
返値（起動時）: {started: true, backend, force, pending, server_time}
返値（status_only）: {running, total, processed, errors, skipped, pending, ..., server_time}
※ 未判定の会話ログに rating（safe/mature/adult）＋ rating_reason（一行理由）を自動付与
※ rating_policy.md ベースの判定プロンプト。チャンク分割→最高レーティング採用
※ thinking ブロックは判定対象外。追加メタ: rating_source, rating_judged_at, rating_model
※ 夜間スケジューラ統合: 未判定があれば要約バッチ後に自動起動（v3.68）
```

### album_save

```
引数: url（省略可 — 画像URL or HTMLページURL）
       file_path（省略可 — NASローカルの画像パス。url と排他）
       comment（省略可 — 画像の説明）
       tags（省略可 — タグ配列）
返値: {id, ext, comment, tags, source_url, original_filename, created_at, width, height, size_bytes}
      HTMLページから複数画像を抽出した場合: {items: [{...}, ...], total: N}
※ 長辺1024pxにリサイズ（アスペクト比維持・Pillow使用）
※ /data/album/ に画像本体（{id}.{ext}）とメタデータ（{id}.json）を保存
※ HTMLページ（Gemini共有リンク等）の場合、og:image → <img src> から画像を自動抽出
```

### album_read

```
引数: id（必須）
返値: MCP image コンテンツ（base64エンコード画像）＋ メタデータJSON
※ MCPレスポンスの content に type:"image" と type:"text" を返す
```

### album_list

```
引数: tags（省略可 — フィルタ用タグ配列）
返値: {items: [{id, ext, comment, tags, ...}, ...], total: N}
※ 画像本体は含まない（メタデータのみ）
```

### album_share

```
引数: id（必須）
返値: {token, url, expires_at}
※ 24時間有効・認証不要の画像直リンクを生成
```

### album_delete（v3.55）

```
引数: id（必須）
返値: {status: "deleted", id}
※ 画像とメタデータを完全削除（復元不可）
```

### memory_share

```
引数: id（必須）
返値: {token, url, expires_at}
※ 24時間有効・認証不要の記憶エントリ共有 URL を生成
```

### conversation_share

```
引数: uuid（必須）
返値: {token, url, expires_at}
※ 24時間有効・認証不要の会話共有 URL を生成（/share.html?token=... で閲覧）
```

### file_upload（v3.59）

```
引数: url（省略可 — ファイルURL）, file_path（省略可 — NASローカルパス。url と排他）,
       filename（省略可）, comment（省略可）, tags（省略可 — タグ配列）
返値: {id, filename, mimetype, size}
※ /data/uploads/ にファイル本体とメタデータを保存
```

### file_read（v3.59、拡張子フォールバック v3.66）

```
引数: id（必須）
返値: メタデータ JSON。テキスト系ファイルは content フィールドに本文含む（50K文字で打ち切り）
※ 判定: mimetype（text/*・application/json 等）＋ 拡張子フォールバック
  （json/jsonl/yaml/py/sh/md/txt/csv/log/js/ts/html/css/xml/ini/toml/conf — v3.66）
```

### file_list（v3.59）

```
引数: tags（省略可 — フィルタ用タグ配列）
返値: {items: [{id, filename, mimetype, size, comment, tags, uploaded_at}, ...], count: N}
```

### file_delete（v3.59）

```
引数: id（必須）
返値: {deleted: id}
※ ファイルとメタデータを完全削除（復元不可）
```

---

## REST API リファレンス

全エンドポイントに `Authorization: Bearer YOUR_TOKEN` ヘッダーが必要。

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/memory/index` | エントリ一覧（`?random=N` で deleted 除外後にN件ランダム抽出・`&filter=summarized` で raw 除外・v3.50） |
| GET | `/api/memory/search?q=...` | キーワード検索 |
| GET | `/api/memory/hsearch?q=...` | 階層検索（keywords+symbolic→summary→full body、match_layer/summary/symbolic 付き） |
| GET | `/api/memories/symbolic` | 全エントリの 3層シンボリック圧縮一覧（`{id, title, symbolic}`、空は除外・v3.42） |
| POST | `/api/memory/reindex` | index.json を全エントリから再構築（層再生成後の明示反映・v3.46） |
| GET | `/api/export` | CoreMem＋ExtMemory のバックアップ ZIP（読み取り専用・最新スナップショット・v3.46） |
| POST | `/api/import/backup` | export ZIP から復元（`mode=skip/overwrite`・`dry_run=true` でプレビュー・B1完結・v3.63） |
| GET | `/api/memory/<id>` | エントリ取得 |
| POST | `/api/memory` | エントリ作成 |
| PATCH | `/api/memory/<id>` | エントリ更新 |
| DELETE | `/api/memory/<id>` | エントリ削除（論理削除） |
| GET | `/api/coremem` | UserCoreMemory 一覧 |
| GET | `/api/coremem/<name>` | UserCoreMemory ファイル取得 |
| POST | `/api/coremem/<name>` | UserCoreMemory ファイル保存 |
| DELETE | `/api/coremem/<name>` | UserCoreMemory ファイル削除（全バージョン） |
| GET | `/api/conversations/` | 会話一覧・検索 |
| GET | `/api/conversations/<uuid>` | 会話取得 |
| GET | `/api/conversations/<uuid>/annotations` | 会話の注記一覧（読み取り専用・v3.42） |
| POST | `/api/conversations/<uuid>/digest` | 会話ログダイジェスト生成/取得（`?force=true&safe_mode=true`・v3.53） |
| PATCH | `/api/conversations/<uuid>/rating` | 会話ログのレーティング設定（safe/mature/adult・v3.56） |
| GET | `/api/inbox` | インボックス一覧 |
| POST | `/api/inbox` | メッセージ送信 |
| PATCH | `/api/inbox/<id>/read` | 既読マーク |
| PATCH | `/api/inbox/<id>/unread` | 未読に戻す |
| PATCH | `/api/inbox/<id>/persistent` | 常駐フラグ切り替え |
| POST | `/api/friends/register` | お友達登録申請（認証不要） |
| GET | `/api/friends` | お友達一覧（admin認証） |
| POST | `/api/friends/<seq_no>/approve` | 申請承認（admin認証） |
| POST | `/api/friends/<seq_no>/revoke` | アクセス権取消（admin認証） |
| DELETE | `/api/friends/<seq_no>` | 完全削除（admin認証） |
| POST | `/api/friends/activate` | アクティベーションコード検証（認証不要） |
| GET | `/api/friends/invitation` | 招待文取得（認証不要） |
| GET | `/api/album/` | アルバム画像一覧（`?tag=...` でフィルタ） |
| GET | `/api/album/<id>` | アルバム画像返却（ブラウザ直接表示可） |
| POST | `/api/album/upload` | 画像アップロード（multipart/form-data または URL指定） |
| PATCH | `/api/album/<id>` | アルバムメタデータ更新（comment・tags） |
| DELETE | `/api/album/<id>` | アルバム画像削除（完全削除） |
| POST | `/api/album/<id>/share` | アルバム共有URL生成（24時間有効） |
| GET | `/api/album/shared/<token>` | 共有アルバム画像（認証不要・24時間限定） |
| POST | `/import` | ZIP インポート |
| POST | `/api/import/claude-code` | Claude Code セッションログ取り込み（.jsonl / .zip・v3.54） |
| POST | `/api/import/openwebui` | OpenWebUI チャットエクスポート取り込み（.json・v3.66） |
| GET | `/api/uploads/` | アップロードファイル一覧（`?tag=...` でフィルタ） |
| GET | `/api/uploads/<id>` | アップロードファイルダウンロード |
| POST | `/api/uploads/` | ファイルアップロード（multipart/form-data） |
| DELETE | `/api/uploads/<id>` | アップロードファイル削除 |
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
| `LM_STUDIO_HOST` | `192.168.x.x` | LMStudio のホスト（手動バッチ用・ご自身の環境のIPに置き換え） |
| `LM_STUDIO_PORT` | `1234` | LMStudio のポート |
| `MIO_LM_MODEL` | `google/gemma-4-26b-a4b` | ローカルLLM処理（要約バッチ・会話ダイジェスト）で使う LMStudio のモデル名（v3.65） |
| `SENDGRID_API_KEY` | （空） | お友達システム：承認メール送信用 SendGrid API キー |
| `SENDGRID_FROM_EMAIL` | （空） | お友達システム：送信元メールアドレス |
| `MIO_REGISTER_URL` | （空） | お友達システム：承認メール内アクティベーションリンクのベース URL（`/activate` を自動付与。省略時は MIO_BASE_URL を使用） |
| `MIO_SEED_LANG` | `ja` | 新規環境にシードする CoreMem スケルトンの言語（`ja` / `en`）。無ければ `ja` にフォールバック（v3.44） |
| `MIO_SEED_WELCOME` | `on` | 新規シード時に `welcome.md` と初回のみ常駐 inbox 案内を投入。`off` で両方抑止（v3.45） |

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
├── artifacts/        UserCoreMemory（ファイル + シンボリックリンク + _meta.json）
├── conversations/    会話全文（{uuid}.json + _index.json）
├── conv_artifacts/   会話から抽出したファイル
├── album/            アルバム画像（{id}.{ext} + {id}.json メタデータ）
├── uploads/          アップロードファイル（{id}.{ext} + {id}.json メタデータ）
├── inbox/            インボックスメッセージ
├── friends/          お友達システム（registry.json・{連番}/memory.md）
├── friend_core.md    お友達セッション用アイデンティティ定義（任意・なければ組み込みデフォルト）
├── index.json        再構築可能なインデックス
├── oplog.json        操作ログ（append-only）
├── oauth_store.json  OAuth クライアント・トークン
├── share_tokens.json 共有 URL トークン
├── imported_uuids.json ZIP インポート重複排除ログ
└── .import_status.json 最終インポート記録
```

### よくあるエラー

**OAuth 認証ページでエラー：**  
`MIO_API_TOKEN` の値が `.env` と入力値で一致しているか確認。

**Claude.ai からツールが見えない：**  
claude.ai アプリを完全再起動する（新規スレッドだけでは MCP キャッシュが更新されない）。

**`CoreMem_read` で not found：**  
conv_artifacts への自動フォールバックがあるので、ファイル名のスペルを確認。それでも見つからない場合は `admin.html` の CoreMem タブで確認。

---

## ドキュメント

**汎用（誰の環境でも参考になる）**

| ファイル | 内容 |
|---------|------|
| [MEMORY_CUSTOMIZATION.ja.md](MEMORY_CUSTOMIZATION.ja.md) | **記憶の運用ガイド（必読）** — 3層構造・テンプレート・「根っこ」の定義方法 |
| [docs/mio_memory_overview.ja.md](docs/mio_memory_overview.ja.md) | mio-memory の概要 — 何ができるか・誰向けか |
| [docs/memory_search_guide.ja.md](docs/memory_search_guide.ja.md) | 検索戦略ガイド — 4層の使い分け・カスタマイズ |
| [docs/setup.ja.md](docs/setup.ja.md) | NAS → GitHub → WS の初回セットアップ手順 |
| [docs/data_structure.ja.md](docs/data_structure.ja.md) | Claude エクスポート ZIP のデータ構造仕様 |
| [docs/api-contract.ja.md](docs/api-contract.ja.md) | API契約書（TS-0）— REST/MCP の返却形状・`tests/` 特性テストの実行方法 |

**個人運用記録（著者・菊池淳の設計判断の記録。固有名詞「澪」「淳さん」はそのまま実名）**

| ファイル | 内容 |
|---------|------|
| [docs/design.ja.md](docs/design.ja.md) | MCP サーバー拡張設計仕様 |
| [docs/talk-and-build.ja.md](docs/talk-and-build.ja.md) | claude.ai × Claude Code の役割分担ワークフロー |

**お友達向け案内（招待された方が読む文書）**

| ファイル | 内容 |
|---------|------|
| [docs/friend-system.ja.md](docs/friend-system.ja.md) | お友達システムの仕組み・登録フロー |

※ 各ドキュメントは日本語版（`*.ja.md`・正）と英語版（`*.md`）の対で管理する。

---

## ロードマップ

**近く実装予定**
- UI 配布パッケージ（`config.js` + ビルドスクリプト）
- Tailscale 設定（出張中のリモートアクセス用）

**設計フェーズ**
- OpenWebUI 会話ログ自動同期 — API ポーリングによる定期同期（手動インポートは v3.66 で実装済み、[設計書](docs/openwebui-sync.ja.md)）
- SysMemory ダンプの世代管理
- mio-memory の Claude Code 直接認証

**実装済み（v3.9〜v3.69）**
- お友達システム — 登録申請・メール承認・専用 MCP セッション・記憶管理（v3.9〜v3.12）
- `CoreMem_delete` ツール・`DELETE /api/coremem/<name>`・logs.html Unicode 表示修正（v3.13）
- admin/logs UI 改善 — モーダル強化（先頭表示・スクロール・最大化・IDコピー）、チャット↔ファイル双方向リンク（v3.14）
- 要約バッチ起動改善 — LMStudio フォールバック自動起動・`batch_run_summary_layers` MCPツール（v3.15）
- 夜間自動バッチ — 毎日深夜に raw 残数チェック→自動実行（`MIO_NIGHTLY_BATCH_HOUR`、v3.16）
- 4層キーワード層＋階層検索 — keywords フィールド生成・memory_search の3段階検索＋要約返却（v3.17）
- Friends タブ改善 — アクティベーション URL 表示・手動メール通知ボタン・直接登録フォーム（v3.18）
- admin.html Search タブ新設 — 4カラムアコーディオン・キーワード集計（v3.19）
- inbox 改善 — persistent[] に本文含む・thinking ブロック対応（v3.20）
- CoreMem 分割+マージ読み込み（manifest 対応、v3.21）
- log_annotate・conversation_read の include_annotations / thinking_limit 追加（v3.22）
- logs.html 共有 URL 生成（v3.23）・管理 UI 各種改善（v3.24〜v3.26）
- inbox から_model フィールド追加（v3.27）・admin.html i18n / タブ改善（v3.28〜v3.30）
- `CoreMem_save` に mode="append" 追加（セパレーター自動挿入、v3.31/v3.32）
- `conversation_read` に include_body 追加（本文省略・注記のみ返却、v3.33）
- `conversation_index` MCPツール追加・`GET /api/conversations/index` エンドポイント（v3.34）
- Logsタブ本文検索（v3.35）・友達用inbox（v3.36）・CoreMem_delete リネーム（v3.37）・Inbox UI/スレッド化（v3.38〜v3.40）
- 検索改善 — 3層 symbolic を1次index検索に追加（M2/v3.41）・`GET /api/memories/symbolic`（M3）・logsビューア注記表示（U11/v3.42）
- 新規インストール基盤 — CoreMem スケルトン＋起動時冪等シード（既存環境は不変）・多言語 ja/en（`MIO_SEED_LANG`）・「困ったら接続中の Claude に聞く」導線（`MIO_SEED_WELCOME`）・`protocol_guide.md`（v3.43〜v3.45）
- `POST /api/memory/reindex`（index明示再構築）・`GET /api/export`（CoreMem＋ExtMemory バックアップZIP・B1前半）（v3.46）
- `conversation_read` に turn_offset/turn_limit（メッセージ単位スライス・長尺会話の冒頭/末尾だけ軽量読み）（v3.47）
- 検索品質＋モバイル対応（v3.48）— `memory_search` 複合キーワードのAND検索化（スペース区切り）／`memory_write` 由来エントリがキーワード層生成の対象外だったバグ修正（本文からキーワードのみ生成）／logs・admin のモバイルレスポンシブ対応（サイドバーのオフキャンバス化・ボトムシート）
- logs.html 表示レイアウトの手動トグル（v3.49）— 会話ビュー上部の「⛶ 表示切替」ボタンで画面幅に関わらずモバイルレイアウトをON/OFF（localStorage保持）。自動判定(<=768px)の境界またぎ問題を解消（iPad縦向き対応）
- `memory_read_index` にランダム取得（v3.50）— `random=N` で deleted 除外後にN件ランダム抽出（1〜5・`filter=summarized` で raw 除外）。REST `?random=N` も対応。記憶の偶発的な再会用
- アルバム機能（v3.51〜v3.52）— 画像記憶システム新規実装。MCPツール4本（`album_save`/`album_read`/`album_list`/`album_share`）。URL直リンクまたはNASローカルから画像取得→長辺1024pxリサイズ→`/data/album/`に保存。MCP image content type 対応。REST 7本（一覧・画像返却・アップロード・メタデータ更新・削除・共有URL生成・共有画像返却）。admin.html Album タブ（サムネイルグリッド・ドラッグ&ドロップアップロード・編集・削除・共有）。v3.52: HTMLページ（Gemini共有リンク等）からの画像自動抽出
- 会話ログダイジェスト生成（v3.53）— `conversation_digest` MCPツール追加。ローカルLLM（LMStudio）で20ターンずつチャンク分割→各チャンクダイジェスト→統合ダイジェスト。`safe_mode` でポリシーセーフ表現変換。キャッシュ保存済みなら即返却。REST `POST /api/conversations/<uuid>/digest`
- Claude Code セッションログ取り込み（v3.54）— REST `POST /api/import/claude-code`。ローカルの `.jsonl`（単体または .zip 一括）を conversations 形式に変換して会話ストアへ。`source: "claude-code"` フィールド＋タグ（会話ログ/claude-code/raw）で識別。thinking / tool_use / tool_result ブロック保持、`ai-title` からタイトル取得、`subagents/` 除外、imported_uuids で重複チェック
- 残課題掃除3点（v3.55）— ① `album_delete` MCPツール追加（ツール数 24→25）② アルバムのタグ入力がカンマ・読点・空白いずれでも区切れるように ③ Filesタブ重複表示バグ修正（overwriteインポート時にインデックスへ同名エントリがappendされていた。ロード時デデュープ＋置き換え方式に変更）
- レーティング保護（v3.56・M-LOCAL-3/7）— 記憶エントリに `rating`（safe/mature/adult）と `local_only` を設定可能に。検索・一覧・ランダム取得は `local_only` と `adult` をデフォルト除外（`include_local` / `include_adult` の明示で表示 = 「意図して見れば見れる」同意ベース設計）。会話ログにも `rating` を導入（REST PATCHで設定・再インポートでも維持）。`rating=adult` の会話は `conversation_read` がデフォルトで safe ダイジェストに差し替えて返す（`include_raw=true` で原文）。アカウントのコンテンツフラグ再発防止が目的
- INBOX改善＋バグ修正（v3.57）— `inbox_check` に `limit`/`days`/`from_model`/`to_model` フィルタ追加（ローカルLLMの負荷軽減・自分宛てだけ取得可能に）。`inbox_post` の `from_model`/`to_model` を配列許容（例: `["claude-opus-4-6", "しずく"]`）。`inbox_update`（部分更新）・`inbox_delete`（物理削除）新規MCPツール追加（ツール数 25→27）。`CoreMem_list` が `__del__` プレフィックスのファイルを除外。ZIPインポート時の source_thread ベース重複チェック追加（サマリー増殖防止）。REST `/api/memory/index` で deleted エントリ除外（admin.html初期表示修正）
- MCPリクエストログ＋instructions強化＋ファイルアップローダ（v3.59）— MCPエンドポイント（`/mcp`）に構造化アクセスログ追加（M-PC1切り分け支援）。MCP initialize の `instructions` を用途記述に拡充（tool_search対応）。汎用ファイルアップローダ（F5）新設：`file_upload` / `file_read` / `file_list` / `file_delete` MCPツール4本追加（ツール数 27→31）。`/data/uploads/` に任意ファイル（PDF・テキスト等）を保管。REST `POST/GET/DELETE /api/uploads/`。admin.html Uploadsタブ追加
- インポート改善＋inbox peek＋Uploadsタブ強化（v3.60）— ① サマリー増殖バグの根本修正：重複チェック関数 `_existing_source_threads` が index.json（source_thread 非掲載）を参照していて常に空集合になっていたのを、エントリファイル直接走査に変更。`imported_uuids.json` が欠けた環境でも再インポートが重複エントリを作らなくなった ② インポート時の ExtMemory `source_thread` 自動紐づけ：会話本文の `memory_id:` パターン走査（確実）＋タイムスタンプ照合（唯一候補のみ・補助）で、`source_thread` が空のエントリに会話UUIDを自動設定。既存値は上書きしない。ZIP/claude-code 両インポート共通。レスポンスに `source_threads_linked` 追加 ③ `inbox_read` に `peek` 引数（true で既読フラグを変更せず読む・他個体宛てメッセージの確認用）④ admin.html Uploadsタブ強化（F6）：テキスト系ファイルのプレビュー・画像サムネイル・全ファイルへの認証付きダウンロードリンク（従来リンクはトークン欠落で401だったのも修正）⑤ admin.html Memoryタブ：詳細モーダルに「📖 生ログを開く」リンク追加（source_thread があれば Logs タブの該当会話へジャンプ。②の backfill とセットで要約→生ログの遡りがワンクリックに）
- 統合検索（v3.61）— `memory_search` / REST `hsearch` に `include_conversations` 追加（デフォルトfalse・後方互換）。trueで会話ログのタイトルも同じAND判定で検索し、`conversations[]`（uuid・title・日付・message_count）と `conversations_total` を併せて返す。記憶と会話ログの一発検索（淳さん提案 2026-06-20 の実装）。rating=adult の会話は `include_adult=true` のときのみ含む。あわせて admin.html Import タブに Claude Code ログ取り込みUI追加（`.jsonl` 複数選択 / `.zip` のドラッグ&ドロップ → `POST /api/import/claude-code`。従来はREST直叩きのみだった）
- TS-1 リング0: ストラングラープロキシ骨格（2026-07-13）— `ts/` に TypeScript 製リバースプロキシ新設（依存ゼロ・node:http）。全リクエストを Python (main.py) へ透過転送し、`/health` のみ TS がネイティブ応答。`MIO_TS1=1 pytest tests/` で Python＋TS の二段構成を起動し**特性テスト53件が TS 経由で全パス**（=「同一サーバー」判定の実証）。以降エンドポイントを1つずつ TS へ移す。移行計画: [docs/ts1-migration.ja.md](docs/ts1-migration.ja.md)。本番運用は Python 単体のまま不変
- TS-0: API契約ドキュメント化＋特性テストスイート（2026-07-13）— `tests/` に pytest 特性テスト53件新設（HTTP越しブラックボックス・main.py 内部を import しない）。conftest が一時データディレクトリでサーバーを自動起動するため既存環境に触れない。REST/MCP の返却形状・認証・レーティング保護・v3.60 重複チェック＆source_thread紐づけ・v3.61 統合検索の回帰を固定。契約書は [docs/api-contract.ja.md](docs/api-contract.ja.md)。テスト用フックとして `MIO_DATA_ROOT` / `MIO_PORT` 環境変数追加（未指定＝従来どおり）、symlink 非対応環境向けの CoreMem コピーフォールバック追加（Linux運用は従来どおり symlink）。TS-1（TypeScript移行）実施時はこのスイートが「同一サーバー」判定基準になる
- MCPセッションIDバグ修正＋TS-1 トランスポート前倒し（v3.62・2026-07-14）— ① main.py: `/mcp` initialize レスポンスで `Mcp-Session-Id` ヘッダが発行されず、内部キー `_session_id` が本文に漏れていたバグを修正（JSON-RPC envelope 側を pop していた）② MCP 次期仕様 **2026-07-28**（initialize/セッション廃止のステートレス化・OAuth強化6本を含む**破壊的変更**。7/28正式公開・RC確定済み）への追従に備え、`ts/` に MCP Streamable HTTP トランスポート層（initialize/ping/notifications・SSEストリーム・セッションID・Origin検証・バッチ）と OAuth 2.1+DCR 一式（discovery metadata / register / authorize / token・PKCE S256/plain・`oauth_store.json` 互換永続化）をネイティブ実装。`tools/list`・`tools/call` は JSON-RPC のまま Python へ転送（ツール実装の単一情報源を維持）。友達セッションは丸ごと Python へ透過。TS が検証したトークンは API_TOKEN に書き換えてプロキシ転送するため、TS発行の OAuth トークンが未移行エンドポイントでもそのまま通る。特性テスト12件追補（OAuth PKCE フルフロー・MCPトランスポート契約）→ **両モード65件全パス**。新仕様対応時に触るのは `ts/src/mcp.ts`・`ts/src/oauth.ts` のみで main.py には波及しない。本番運用は Python 単体のまま不変
- TS-1 リング2: 書き込み系REST のTS化（2026-07-14）— `ts/src/write.ts` 新設。POST /api/memory（作成・JST ID採番）・PATCH/DELETE /api/memory/<id>（部分更新・論理削除）・POST /api/memory/reindex を TS ネイティブ化。oplog 追記・index.json 再構築とも main.py と同一アルゴリズム。実機検証で「TS再構築と Python 再構築の index.json は改行正規化後にバイト一致」（Windows ローカルのみ Python が CRLF を書く。本番 Linux は両者 LF で完全一致）・oplog 形式互換・TS作成エントリを Python/MCP から読めることを確認。両モード65件全パス。本番運用は Python 単体のまま不変
- TS-1 リング3スライス1: inbox REST のTS化（2026-07-14）— `ts/src/inbox.ts` 新設。/api/inbox の一覧（count+ids / full / status=new）・投稿（ID採番・from_model 正規化）・既読/未読/persistent PATCH・部分更新・物理削除を TS ネイティブ化。persistent の既読保護・friend サブディレクトリ検索も互換。REST 特性テスト5件追補（従来は MCP ツール面のみ）→ 両モード70件全パス。TS投稿→Python/MCP参照・Python投稿→TS一覧の相互運用を実機検証
- TS-1 リング3完了: coremem / conversations REST のTS化（2026-07-14）— `ts/src/coremem.ts`・`ts/src/conversations.ts` 新設。coremem（一覧・保存 201・版指定読み・manifest マージ・全版削除。symlink 版管理は TS も symlink→コピーのフォールバックで互換、版番号は実装間で連番継続を実機確認）と conversations（検索 q/from/to/body_search・index ページング・rebuild・取得・注記一覧・share/view・rating PATCH）を TS ネイティブ化。digest（要ローカルLLM）のみリング5まで Python 転送。会話 _index.json の TS 再構築と Python 再構築が**バイト完全一致**、share トークン相互運用・TS設定レーティングの Python 側ゲートも実機検証。REST 特性テスト15件追補（coremem 7・conversations 8）→ **両モード85件全パス**。main.py 変更なし・本番運用は Python 単体のまま不変
- MCP 2026-07-28 新仕様のRC先行実装（2026-07-14）— 7/28正式公開予定の破壊的新仕様（RC確定済み）を `ts/src/mcp.ts`・`oauth.ts` に**新旧共存（デュアル時代サーバー）**で先行実装。①ステートレスコア: initialize/セッション不要で各リクエストを独立処理（`_meta` の `io.modelcontextprotocol/protocolVersion` 等で版・クライアント情報を運搬）。レガシークライアント（initialize + `Mcp-Session-Id`）は従来どおり同一エンドポイントで共存 ② `server/discover`（MUST）実装 — supportedVersions/capabilities/serverInfo/instructions/ttlMs/cacheScope ③ 必須ヘッダ検証: `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` とボディの突き合わせ（不一致→400+`-32020 HeaderMismatch`）、未対応版→400+`-32022 UnsupportedProtocolVersion`（supported列挙付き）、廃止メソッド（ping等）→404+`-32601` ④ 全結果に `resultType: "complete"` 付与・`tools/list` に `ttlMs`/`cacheScope`（要求時に注入・Python転送は維持）⑤ `subscriptions/listen` 最小実装（acknowledged + keep-alive SSE）⑥ OAuth強化: 認可応答に `iss`（RFC 9207）・DCR `application_type` 受理・**リフレッシュトークン**（`grant_type=refresh_token`・使用ごとローテーション・scope縮小可）・ディスカバリのRFC 8414パスサフィックス対応。特性テスト15件追補（`tests/test_mcp_2026.py`・新仕様はTS層のみの実装なので Python 単体モードでは skip）→ **TS1モード100件全パス／Python単体85件全パス**。main.py 変更なし・7/28の正式版公開後にRCとの差分を最終確認
- バックアップ復元 import（v3.63・B1完結）— `POST /api/import/backup` 新設。`GET /api/export`（v3.46・B1前半）が生成したZIPを multipart で受けて CoreMem＋ExtMemory を復元。`mode=skip`（デフォルト・既存は触らず conflicts に列挙）/ `mode=overwrite`、`dry_run=true` で書き込みなしプレビュー（件数＋衝突一覧）。CoreMem は版管理経由で新バージョンとして積むため既存版を破壊しない。ExtMemory は oplog に restore を記録し復元後に index 再構築。export に含まれないストア（会話ログ・アルバム等）には触れない。特性テスト5件追補（往復・skip/overwrite/dry_run・不正入力）→ **両モード全パス（TS1: 105件／Python単体: 90件＋15skip）**。これで「export ZIP保管 → 新環境に import」の一本道で記憶の引っ越し・災害復旧が可能に
- admin.html バックアップUI（v3.64・B1-UI）— Import タブに「バックアップ（CoreMem＋ExtMemory）」セクション新設。取得側は `GET /api/export` の認証付きダウンロードボタン、復元側は ZIP ドラッグ&ドロップ／ファイル選択 → mode 選択（skip=既存を守る（デフォルト）/ overwrite=上書き・各説明付き）→ **dry_run プレビュー（件数＋衝突一覧表示）→ 確認して本実行**の2段階フロー（いきなり本実行はさせない）。i18n（日英）・モバイルレスポンシブ対応。API 変更なし（v3.63 のまま利用）。curl 不要でバックアップの取得と復元が完結し、災害復旧時（新環境直後）にブラウザだけで戻せるように
- ローカルLLMモデル名の環境変数化（v3.65）— 要約バッチ・`conversation_digest` にハードコードされていた lmstudio 用モデル名（`qwen/qwen3.6-35b-a3b`）を環境変数 `MIO_LM_MODEL` に外出し（デフォルト `google/gemma-4-26b-a4b`）。ローカルLLM処理を常用モデルと同一に統一することで、LMStudio が別モデルをオンデマンドで CPU 側に二重ロードして遅くなる問題を解消
- Oplog記録範囲拡大（v3.67）— CoreMem（save/delete/rename）・Album（save/update/delete）・Uploads（upload/delete）・会話レーティング変更（conv_rating）をoplogに記録するよう拡張。従来はExtMemory操作（create/update/delete/import/restore）のみだった。TS層の `coremem.ts` でも REST 経由の CoreMem save/delete を記録。admin.html に新operation種別のバッジカラーを追加（coremem_save: ティール / album_save: オレンジ / file_upload: ダークグレー / conv_rating: パープル等）
- 伏せ字モード: adult生ログの文単位マスク閲覧（v3.69）— 文番号リスト方式で adult 判定ログの該当文を ●●● に機械置換。Python 側で決定的文分割→LLM に文番号リストのみ出力させ→該当文を機械置換（LLM による原文改変リスクゼロ）。`conversation_read` 三択分岐: `include_raw=true`→原文 / `redact=true`→承認済み伏せ字 / デフォルト→伏せ字あればそれ、なければ safe ダイジェスト。REST 5本（生成・取得・承認・差し戻し・ステータス一覧）。admin.html Redact タブで Generate→Preview→Approve/Reject の承認フロー。キャッシュ `{uuid}_redacted.json`（本文ハッシュで無効化）
- セーフチェック: 会話ログ自動レーティング判定バッチ（v3.68）— `batch_run_rating` MCPツール新設（ツール数 31→32）。未判定の全会話ログに `rating`（safe/mature/adult）＋ `rating_reason`（一行理由）を LLM で自動付与。`rating_policy.md` ベースの判定プロンプトを使い、長大ログはチャンク分割→最高レーティング採用（adult > mature > safe）。追加メタ: `rating_source`（manual/auto）・`rating_judged_at`・`rating_model`。既存手動 rating（`rating_source` なし）は `manual` 扱い、`force=true` でも上書きしない。REST `GET /api/rating-batch/status`・`POST /api/rating-batch/start`。`PATCH /api/conversations/<uuid>/rating` 拡張（`rating_reason`・`rating_source` 受付）。夜間スケジューラ統合（要約バッチ後に自動起動）。thinking ブロックは判定対象外
- file_read JSON対応強化＋OpenWebUIインポート＋admin.html改善（v3.66）— ① `file_read` に拡張子ベースのフォールバック追加（mimetype が不正でも `.json`/`.jsonl` 等のテキスト系ファイルは `content` フィールドに展開）② `POST /api/import/openwebui` 新設：OpenWebUI（ローカルLLM）のチャットエクスポート JSON を会話ストアに取り込み。messages 配列 / history.messages ツリー両対応、重複スキップ、要約バッチ自動起動。admin.html Import タブにドロップゾーン追加 ③ admin.html Uploads タブ：モーダルを他タブと統一（`openModal()` 使用）、IDコピー対応、ダークテーマ対応のプレビュー ④ admin.html Album タブ：画像クリックでライトボックス（最大化）表示。Escape で閉じる

---

## プロジェクト構成

```
claude-with-you/
├── README.md               英語版（グローバル向け）
├── README.ja.md            このファイル（日本語詳細版）
├── CLAUDE.md               Claude Code 向けアーキテクチャ文書
├── MEMORY_CUSTOMIZATION.ja.md  記憶の運用ガイド（日本語・正）
├── MEMORY_CUSTOMIZATION.md     記憶の運用ガイド（英語版）
├── docker-compose.yml
├── .env_sample
├── docs/                    各ドキュメントは日本語版（*.ja.md・正）と英語版（*.md）の対
│   ├── design.ja.md / design.md
│   ├── setup.ja.md / setup.md
│   ├── talk-and-build.ja.md / talk-and-build.md
│   ├── friend-system.ja.md / friend-system.md
│   ├── data_structure.ja.md / data_structure.md
│   ├── mio_memory_overview.ja.md / mio_memory_overview.md
│   ├── memory_search_guide.ja.md / memory_search_guide.md
│   ├── api-contract.ja.md / api-contract.md   API契約書（TS-0）
│   └── ts1-migration.ja.md / ts1-migration.md TypeScript移行計画（TS-1）
├── tests/                   特性テストスイート（pytest・HTTP越しブラックボックス）
├── ts/                      TS-1 ストラングラープロキシ（リング0）
├── scripts/
│   └── generate_summary_layers.py
└── memory/
    ├── Dockerfile
    ├── app/
    │   ├── main.py         サーバー本体（全機能を 1 ファイルに集約）
    │   ├── admin.html      管理 UI
    │   ├── logs.html       会話ログビューア
    │   ├── register.html   お友達登録申請ページ
    │   ├── activate.html   アクティベーションページ
    │   └── requirements.txt
    └── wheels/             Python ホイール（ベンダリング済み・オフラインビルド可）
```
