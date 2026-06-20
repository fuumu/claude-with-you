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
# {"status":"ok","version":"3.47","mcp_tool_count":19}
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

---

### 管理画面（admin.html）

`https://your-domain/admin.html` にアクセス。API トークンでログイン。

| タブ | 機能 |
|------|------|
| **Memory** | 記憶エントリの一覧・キーワード検索・詳細表示・編集・削除 |
| **CoreMem** | UserCoreMemory（NASファイルストア）一覧・内容プレビュー・削除 |
| **Import** | ZIP ファイルアップロード・上書きモード・要約バッチ進捗 |
| **Files** | 会話から抽出したファイル一覧・拡張子フィルタ・日付範囲・プレビュー |
| **Inbox** | チャット↔コード間のメッセージ一覧・既読管理・詳細表示 |
| **Logs** | 会話ログ一覧・キーワード検索・日付フィルタ・メッセージ全文表示 |
| **Oplog** | 操作ログ（create/update/delete の監査証跡） |
| **Friends** | お友達システム管理（申請承認・アクセス権限付与・利用状況確認） |

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
       full_body（省略可, bool — trueで従来どおりbody全文を返す）
返値: {results: [...], total: N, has_more: bool, server_time: "..."}
※ 階層検索（v3.17, symbolic追加 v3.41）: 1次=インデックスのみ（title+tags+keywords＋3層symbolic）→ 2次=2層要約 → 3次=全文
※ 各ヒットは body の代わりに summary（2層要約）を返す。match_layer（keyword/symbolic/summary/full）付き
※ 全文が必要なときは memory_read で個別取得するか full_body=true を指定
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

---

## REST API リファレンス

全エンドポイントに `Authorization: Bearer YOUR_TOKEN` ヘッダーが必要。

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/memory/index` | エントリ一覧 |
| GET | `/api/memory/search?q=...` | キーワード検索 |
| GET | `/api/memory/hsearch?q=...` | 階層検索（keywords+symbolic→summary→full body、match_layer/summary/symbolic 付き） |
| GET | `/api/memories/symbolic` | 全エントリの 3層シンボリック圧縮一覧（`{id, title, symbolic}`、空は除外・v3.42） |
| POST | `/api/memory/reindex` | index.json を全エントリから再構築（層再生成後の明示反映・v3.46） |
| GET | `/api/export` | CoreMem＋ExtMemory のバックアップ ZIP（読み取り専用・最新スナップショット・v3.46） |
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

| ファイル | 内容 |
|---------|------|
| [MEMORY_CUSTOMIZATION.ja.md](MEMORY_CUSTOMIZATION.ja.md) | **記憶の運用ガイド（必読）** — 3層構造・テンプレート・「根っこ」の定義方法 |
| [docs/mio_memory_overview.ja.md](docs/mio_memory_overview.ja.md) | mio-memory の概要 — 何ができるか・誰向けか |
| [docs/memory_search_guide.ja.md](docs/memory_search_guide.ja.md) | 検索戦略ガイド — 4層の使い分け・カスタマイズ |
| [docs/design.ja.md](docs/design.ja.md) | MCP サーバー拡張設計仕様 |
| [docs/setup.ja.md](docs/setup.ja.md) | NAS → GitHub → WS の初回セットアップ手順 |
| [docs/talk-and-build.ja.md](docs/talk-and-build.ja.md) | claude.ai × Claude Code の役割分担ワークフロー |
| [docs/friend-system.ja.md](docs/friend-system.ja.md) | お友達システムの仕組み・登録フロー |
| [docs/data_structure.ja.md](docs/data_structure.ja.md) | Claude エクスポート ZIP のデータ構造仕様 |

※ 各ドキュメントは日本語版（`*.ja.md`・正）と英語版（`*.md`）の対で管理する。

---

## ロードマップ

**近く実装予定**
- UI 配布パッケージ（`config.js` + ビルドスクリプト）
- Tailscale 設定（出張中のリモートアクセス用）

**設計フェーズ**
- SysMemory ダンプの世代管理
- mio-memory の Claude Code 直接認証

**実装済み（v3.9〜v3.47）**
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
│   └── memory_search_guide.ja.md / memory_search_guide.md
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
