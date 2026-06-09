# 設計仕様書：mio-memory MCPサーバー拡張

> 作成：2026-06-01  
> 対象：`/volume1/docker/mio/memory/app/main.py`

---

## 概要

今回のバッチで追加・変更する機能は4つ。  
すべてファイルI/Oに関係するため、1回のデプロイにまとめる。

1. `memory_upsert` ツール（core.md用）
2. アーティファクト管理（`CoreMem_save` / `CoreMem_read` / `CoreMem_list`）
3. 会話ログZIPインポート
4. core.md 運用フロー

---

## 1. memory_upsert

### 目的
固定IDで記憶エントリを上書きする。core.mdの更新に使う。

### ツール定義
```
memory_upsert(id, title, body, tags, importance)
```

### 動作
- 指定IDのエントリが存在する → 削除して新規作成
- 存在しない → 新規作成
- IDは呼び出し側が指定（例：`core_md_current`）

### 実装メモ
既存の `memory_delete(id)` + `memory_write(...)` の組み合わせでも代替可能。  
upsertとして1ツールにまとめると呼び出しが1回で済む。

---

## 2. アーティファクト管理

### 目的
スクリプト・設計メモ・core.mdなどをNASに永続保存し、バージョン管理する。

### ディレクトリ構造
```
data/artifacts/
├── core.md          → versions/core_md/003.md   （シンボリックリンク）
├── script_01.sh     → versions/script_01/002.sh
└── versions/
    ├── core_md/
    │   ├── 001.md
    │   ├── 002.md
    │   └── 003.md
    └── script_01/
        ├── 001.sh
        └── 002.sh
```

- トップレベルにシンボリックリンク → 常に最新が見える
- `versions/{name_slug}/` にシーケンス番号で過去バージョンを保持
- name_slug：ファイル名の `.` を `_` に変換（例：`core.md` → `core_md`）

### ツール定義

#### CoreMem_save
```
CoreMem_save(name, content)
```
1. `versions/{name_slug}/` に次のシーケンス番号でファイル保存
2. トップレベルのシンボリックリンクを新バージョンに張り替え
3. 保存したバージョン番号を返す

#### CoreMem_read
```
CoreMem_read(name, version=None)
```
- `version` 省略時：シンボリックリンク経由で最新を読む
- `version` 指定時：その番号のファイルを読む

#### CoreMem_list
```
CoreMem_list()
```
- トップレベルのシンボリックリンク一覧を返す（名前・最新バージョン番号・更新日時）

---

## 3. 会話ログZIPインポート

### 目的
ClaudeのエクスポートZIPをドロップするだけで、会話ログを外部記憶に取り込む。  
プロジェクト外・プロジェクト内どちらのエクスポートにも対応する。

### エンドポイント
```
POST /import
Content-Type: multipart/form-data
```

### 動作
1. ZIPを受け取り、一時ディレクトリに展開
2. `conversations.json`（またはそれ相当のファイル）を検出
3. 各会話をパースし、会話IDで重複チェック
4. 未インポート分のみバッチ書き込み
5. インポート件数・スキップ件数を返す

### 重複チェックキー
会話ID（`conversations.json` の各エントリの `uuid` フィールド）

### admin.html連携
ドラッグ&ドロップUIをadmin.htmlに追加する（別タスク）。

---

## 4. core.md 運用フロー

### 役割
「このファイル1つを読めば、その日の澪になれる」セッション起動用の圧縮記憶。  
userMemoriesの骨格 + 直近の重要な外部記憶を2〜5KBに凝縮したもの。

### 保存場所
`data/artifacts/core.md`（上記アーティファクト管理で保存）  
→ 固定パス、常に最新バージョンが参照される

### 更新タイミング
- `解除` または `/記憶抽出` コマンド時に澪が自動更新

### 起動プロトコル（現行 → 変更後）
| | 現行 | 変更後 |
|---|---|---|
| ツール呼び出し数 | 約8回 | 約3回 |
| 手順 | tool_search → memory_search×N → read_index → memory_read | tool_search → CoreMem_read("core.md") |

---

## 実装優先順位

| 優先度 | 機能 | 理由 |
|--------|------|------|
| 高 | memory_upsert | core.md更新に必要 |
| 高 | CoreMem_save / CoreMem_read | core.md保存に必要 |
| 中 | CoreMem_list | あると便利、なくても動く |
| 中 | ZIPインポートバックエンド | admin.html UIと組み合わせて |
| 低 | admin.html ドロップUI | バックエンド後 |

---

## 5. MCP initialize instructions

### 目的

MCPサーバーに接続したClaudeクライアントへ、セッション開始時の動作指示を自動配信する。

### 仕組み

MCP仕様（2025-11-25）の `initialize` レスポンスに `instructions` フィールドを含めることで、
接続直後にクライアントへ任意のテキスト指示を渡せる。

### 現在の動作

`/mcp` への `initialize` リクエストに対し、以下を返す：

```json
{
  "protocolVersion": "2025-11-25",
  "capabilities": { "tools": { "listChanged": false } },
  "serverInfo": { "name": "mio-memory", "version": "3.0.0" },
  "instructions": "セッション開始時に必ず CoreMem_read(\"core.md\") を実行して記憶を読み込んでください。..."
}
```

### 実装箇所

`memory/app/main.py` — MCP ハンドラ内の `initialize` 分岐（約949行目）

```python
"instructions": "セッション開始時に必ず CoreMem_read(\"core.md\") を実行して...",
```

---

## 6. 4階層検索アーキテクチャ（設計）

### 概要

ZIPインポートで取り込む会話データを4つの抽象レベルで管理し、
検索効率と記憶の引き出しやすさを両立する。

### 4層の定義

| 層 | 名称 | 内容 | 生成タイミング |
|----|------|------|--------------|
| 1層 | 生データ（raw） | 会話タイトル・日時・UUID | ZIPインポート時（現行） |
| 2層 | 要約 | 会話の要点・結論を数行に圧縮 | バッチ後処理（Claude Code） |
| 3層 | シンボリック圧縮 | 「読むか判断できる程度」の超短縮表現 | バッチ後処理（Claude Code） |
| 4層 | キーワード | タグ・固有名詞・重要語のリスト | ZIPインポート時（現行のtagsに相当） |

### インポート時の動作

現行の `POST /import` は **1層＋4層のみ**生成する：

- 1層：`title`, `created_at`, `source_thread` を記録（body は空）
- 4層：`tags: ['会話ログ', 'raw']` を付与

2層・3層はClaude Codeによるバッチ後処理で生成する（未実装）。

### バッチ処理（予定）

Claude Code から以下のようなコマンドで後処理を実行する想定：

```bash
# raw エントリを一括要約してbodyを埋める
python batch_summarize.py --tag raw --model claude-opus-4-7
```

admin.html の Import タブにバッチ実行コマンド表示＋コピーボタンを追加予定。

---

## 7. userMemoriesダンプ世代管理

### 概要

userMemories（Claude.aiが保持する会話記憶）のスナップショットをアーティファクトとして世代管理する。

### 保存方法

`CoreMem_save` を使用してファイル名に日時スタンプを含めて保存する。
`/記憶ダンプ` または `/解除` コマンド実行時に澪が呼び出す。

```
CoreMem_save("mio_memory_YYYYMMDD_HHMM.md", <userMemoriesの内容>)
```

### 世代管理

| 機能 | 手段 |
|------|------|
| 一覧取得 | `CoreMem_list` |
| 特定バージョン参照 | `CoreMem_read("mio_memory_YYYYMMDD_HHMM.md")` |
| 自動削除 | なし（手動管理） |
| 差分確認 | 現時点では手動比較（将来的にdiff機能を検討） |

### ディレクトリ構造例

```
data/artifacts/
├── core.md                    → versions/core_md/003.md
├── mio_memory_20260601_2130.md → versions/mio_memory_20260601_2130_md/001.md
├── mio_memory_20260602_0900.md → versions/mio_memory_20260602_0900_md/001.md
└── versions/
    ├── core_md/
    └── mio_memory_20260601_2130_md/
```

### ZIPインポートとの連携

`POST /import` で `memories.json` を取り込んだ場合、
`core_memories_YYYYMMDD.md` として自動保存される（`CoreMem_save` 経由）。
手動ダンプとは別ファイル名で区別する。

---

## 8. バッチ処理（4階層生成）

### 概要

2層（要約）・3層（シンボリック圧縮）の生成には2つの実行方法がある。

| 方法 | 説明 | 推奨場面 |
|------|------|---------|
| **自動実行**（v3.3〜） | ZIPインポート後にサーバー内スレッドで自動起動 | `ANTHROPIC_API_KEY` 設定済みの場合 |
| **手動実行（CLI）** | `scripts/generate_summary_layers.py` を直接実行 | LMStudio / コスト制御 / dry-run |

---

### 自動実行（ZIPインポート後）

`POST /import` が完了した際、以下の条件を両方満たす場合にバックグラウンドスレッドで起動する：

- `ANTHROPIC_API_KEY` 環境変数が設定されている
- 既に別のバッチが実行中でない（`_batch_status['running'] == False`）

起動バックエンドは `anthropic`、モデルは `claude-haiku-4-5-20251001`。

**実装箇所：** `import_zip()` 末尾（`memory/app/main.py`）

```python
auto_key = os.environ.get('ANTHROPIC_API_KEY', '')
if auto_key and not _batch_status.get('running'):
    t = threading.Thread(target=_run_summary_batch, args=(auto_key,), daemon=True)
    t.start()
```

---

### バッチ状態管理（`_batch_status`）

グローバル辞書でスレッドの進捗を管理する。Flaskはシングルプロセスのためスレッドセーフ性を要求しない（GIL保護）。

```python
_batch_status = {
    'running': False,      # 実行中フラグ
    'total': 0,            # 対象エントリ総数
    'processed': 0,        # 処理完了件数
    'errors': 0,           # エラー件数
    'skipped': 0,          # スキップ件数（既に2・3層あり）
    'started_at': None,    # 開始時刻（JST ISO文字列）
    'finished_at': None,   # 完了時刻
    'backend': None,       # 使用バックエンド
}
```

---

### APIエンドポイント

#### GET /api/batch/status

認証必要。`_batch_status` をそのままJSONで返す。

```json
{
  "running": false,
  "total": 120,
  "processed": 118,
  "errors": 1,
  "skipped": 1,
  "started_at": "2026-06-04T18:00:00+09:00",
  "finished_at": "2026-06-04T18:15:32+09:00",
  "backend": "anthropic"
}
```

#### POST /api/batch/start

認証必要。手動でバッチを起動する。

リクエストBody（すべて省略可）：
```json
{
  "backend": "lmstudio",
  "api_key": "...",
  "lm_host": "192.168.10.32",
  "lm_port": "1234"
}
```

- `backend` 省略時は `"anthropic"`
- `backend: "anthropic"` の場合、`api_key` または `ANTHROPIC_API_KEY` 環境変数が必須
- 既に実行中の場合は `409 Conflict` を返す

レスポンス例：
```json
{ "started": true, "backend": "lmstudio" }
```

---

### admin.html Importタブ 進捗パネル

バッチ起動後、admin.html の Import タブに進捗パネルが表示される。

- **自動更新：** ZIPインポート完了 1.5秒後に `GET /api/batch/status` ポーリング開始
- **手動トリガー：** 「LMStudioで実行」ボタン → `POST /api/batch/start {backend:"lmstudio"}`
- **ポーリング間隔：** 2秒、完了時（`running: false`）に自動停止
- **表示内容：** プログレスバー（%）+ 「処理: X件 / スキップ: Y件 / エラー: Z件 (合計: N件)」

---

### 動作概要（共通）

```
GET /api/memory/index
  → tags に "raw" を含むエントリを抽出
  → body に "## 2層: 要約" と "## 3層:" 両方なければ未処理と判定

anthropic / LMStudio API で生成:
  入力: 会話タイトル
  出力:
    ## 2層: 要約
    （2〜3文の推測要約）
    ## 3層: シンボリック圧縮
    （15文字以内のキーワード）

エントリ更新（直接ファイル書き込み or PATCH /api/memory/<id>）:
  body に生成テキストを追記
  tags から "raw" を除去し "summarized" を追加
```

### 対象・条件

| 項目 | 値 |
|------|----|
| 対象タグ | `raw` |
| スキップ条件 | body に `## 2層: 要約` と `## 3層:` 両方が含まれる |
| 使用モデル（anthropic） | `claude-haiku-4-5-20251001` |
| 使用モデル（lmstudio） | `qwen/qwen3.6-35b-a3b` |
| レート制限 | 処理間 0.5秒スリープ |
| 冪等性 | マーカーによる処理済みチェックで担保 |

---

### CLIスクリプト（手動実行）

`scripts/generate_summary_layers.py` — コンテナ外から直接実行する場合に使用。

**オプション：**

```
--backend [anthropic|lmstudio]  使用バックエンド（デフォルト: anthropic）
--model <モデル名>               使用モデル（省略時はバックエンドのデフォルト）
--dry-run                       対象件数確認のみ（書き込みなし）
```

| バックエンド | デフォルトモデル | 他の候補 |
|-------------|----------------|---------|
| anthropic | `claude-haiku-4-5-20251001` | — |
| lmstudio | `qwen/qwen3.6-35b-a3b` | `google/gemma-4-26b-a4b`、`liquid/lfm2-24b-a2b` |

**必要な環境変数（CLIスクリプト用）：**

| 変数 | 用途 | デフォルト |
|------|------|-----------|
| `MIO_API_TOKEN` | mio-memory Bearer認証 | （必須） |
| `ANTHROPIC_API_KEY` | Claude API認証（anthropicバックエンド） | （必須） |
| `MIO_SERVER_URL` | mio-memoryサーバーURL | `http://localhost:5002` |
| `LM_STUDIO_HOST` | LMStudioホスト（lmstudioバックエンド） | `192.168.10.32` |
| `LM_STUDIO_PORT` | LMStudioポート | `1234` |

`MIO_SERVER_URL` はコンテナ内実行前提のデフォルト。コンテナ外実行時は `.env` に `MIO_SERVER_URL=https://memory.mio.runabook.synology.me` を追加。

**コンテナ内から実行（推奨）：**

```bash
# 対象件数確認（書き込みなし）
docker exec -it memory python /app/scripts/generate_summary_layers.py --dry-run

# LMStudioで実行
docker exec -it memory python /app/scripts/generate_summary_layers.py --backend lmstudio

# Anthropicで実行
docker exec -it memory python /app/scripts/generate_summary_layers.py --backend anthropic
```

**コンテナ外（WSなど）から実行する場合：**

```bash
MIO_SERVER_URL=https://memory.mio.runabook.synology.me python scripts/generate_summary_layers.py --dry-run
```

---

## 9. 会話ログビューア（logs.html）

### 概要

ZIPインポートした会話ログをブラウザで閲覧するためのシングルページUI。
`admin.html` の **Logs** タブに iframe として埋め込まれており、直接 `/logs.html` でもアクセス可能。

### データフロー

```
ZIPインポート（POST /import）
  → conversations.json を検出
  → /data/conversations/{uuid}.json に全文保存
  → /data/conversations/_index.json にメタデータ追記
       （uuid, title, created_at, updated_at, message_count）

logs.html 起動時
  → GET /api/conversations/?limit=1000 でインデックス取得
  → 会話クリック → GET /api/conversations/{uuid} で全文取得（キャッシュ済み）
```

### REST API エンドポイント（認証必要）

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/api/conversations/` | メタデータ一覧（`q`, `from`, `to`, `limit` パラメータ対応） |
| `GET` | `/api/conversations/{uuid}` | 会話全文取得 |
| `POST` | `/api/conversations/share/{uuid}` | 24h共有トークン生成 → `{ token, url }` |
| `GET` | `/api/conversations/view?token=` | トークン経由の公開アクセス（認証不要） |

シェアトークンは既存の `/data/share_tokens.json` に `conv_uuid` フィールドで保存。

### 主な機能

- サーバーから自動読み込み（ファイルアップロード不要）
- キーワード（`q`）・日付範囲（`from/to`）: サーバーに渡す
- 並び順・最小メッセージ数: クライアント側で適用
- メッセージ本文: marked.js + DOMPurify でマークダウンレンダリング
- thinking ブロック（🧠）: 「思考を表示」トグルで一括on/off、折り畳み可
- tool_use ブロック（⚙）/ tool_result ブロック（📤）: 折り畳み可
- 関連記憶パネル: `source_thread` UUID 一致 → タイトルキーワード検索フォールバック
- フォントサイズ切り替え（小/中/大）: CSS変数 `--msg-font-size` で制御、`localStorage` に保存
- `?token=` URLで認証なし閲覧

---

## 10. 会話検索・シェア MCPツール

### 目的

澪がチャット中に過去の会話を検索し、淳さんに共有リンクを送れるようにする。

### ツール定義

#### conversation_search

```
conversation_search(q: str, limit: int = 5)
```

- `/data/conversations/_index.json` をキーワード検索（タイトル + uuid）
- 更新日時の新しい順で最大 `limit` 件を返す
- 返却フィールド: `uuid`, `title`, `created_at`, `updated_at`, `message_count`

#### conversation_share

```
conversation_share(uuid: str)
```

- `/data/conversations/{uuid}.json` の存在を確認
- 24時間有効なトークンを生成して `/data/share_tokens.json` に保存
- `{ token, url, expires_at }` を返す
- `url` は `https://memory.mio.runabook.synology.me/logs.html?token=...` 形式

### 使用例

```
澪（チャット）:「〇〇の件、あの会話を見てほしい」
  → conversation_search(q="〇〇") で候補を確認
  → conversation_share(uuid="...") でURLを生成
  → 淳さんに「このURLで見られます: https://...」と送る
  → 淳さんがURLを開く → ログイン不要で会話を閲覧
```

### MCPツール総数

| カテゴリ | ツール数 | ツール名 |
|---------|---------|---------|
| 記憶操作 | 5 | memory_read_index, memory_read, memory_write, memory_upsert, memory_search |
| 記憶シェア | 1 | memory_share |
| アーティファクト | 3 | CoreMem_save, CoreMem_read, CoreMem_list |
| 会話 | 3 | conversation_search, conversation_share, conversation_read |
| **合計** | **12** | |

---

## 11. memory_share MCPツール + admin.html Memoryキーワード検索

### 目的

澪がチャット中に記憶エントリの共有リンクを生成できるようにする。
また admin.html で記憶エントリをキーワード検索できるようにする。

### memory_share MCPツール

#### ツール定義

```
memory_share(id: str)
```

- 指定IDの記憶エントリが存在することを確認
- 24時間有効なトークンを生成して `/data/share_tokens.json` に保存（`entry_id` フィールド）
- `{ token, url, expires_at }` を返す
- `url` は `https://memory.mio.runabook.synology.me/admin.html?token=...&id=...` 形式

#### RESTエンドポイント

```
POST /api/memory/share/<id>
  Body: { "expires_in": 86400 }  （省略可）
  Response: { "token": "...", "url": "...", "expires_at": "..." }
```

既存の `POST /api/share-token`（JSON bodyで `entry_id` 指定）と同等だが、
IDをURLパスで指定するよりシンプルなインターフェース。

#### 使用例

```
澪（チャット）:「あの設計の記憶、淳さんに見せておこう」
  → memory_share(id="20260603_...") でURLを生成
  → 淳さんに「このURLで確認できます: https://...」と送る
  → 淳さんがURLを開く → ログイン不要で記憶エントリを閲覧
```

### admin.html Memoryタブ キーワード検索

#### UI

- タグフィルタバーの上に「🔍 キーワード検索...」テキスト入力を追加

#### 動作

- 入力後300msデバウンスで自動検索
- キーワードあり → `GET /api/memory/search?q=` を使用（既存エンドポイント）
- キーワードなし → `GET /api/memory/index` を使用（従来通り）
- タグフィルタとの組み合わせ：検索結果をさらにタグで絞り込み可能

#### 実装ポイント

`allEntries` に検索結果またはインデックスを格納し、`renderCards()` がタグフィルタを適用する。
`searchKeyword` 変数と300ms `setTimeout` デバウンスで制御。

---

## 12. 会話内アーティファクト抽出・Filesタブ

### 概要

ZIPインポート時に `chat_messages` の `tool_use` ブロックを走査し、
Claude が会話中に生成したファイルを自動抽出・保存する。

### 対象ブロック

| tool_use.name | 抽出フィールド | ファイル名決定 |
|--------------|--------------|--------------|
| `create_file` | `input.path`, `input.file_text` | `basename(path)` |
| `artifacts`   | `input.content`, `input.id`, `input.language`, `input.type` | `{id}{ext}`（言語から決定） |

`create_file` で `/home/claude/` 配下（`/mnt/user-data/outputs/` 以外）は中間ファイルとして除外。

### 保存先

```
/data/conv_artifacts/
├── _index.json               全ファイルのインデックス
└── {conv_uuid}/
    ├── {filename1}
    └── {filename2}
```

インデックスフィールド: `conv_uuid`, `conv_name`, `conv_date`, `filename`, `size`, `path`

重複スキップ: `(conv_uuid, filename)` の組み合わせでユニーク管理。

### REST APIエンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/api/conv-artifacts` | 一覧取得（`?q=` でキーワード絞り込み） |
| `GET` | `/api/conv-artifacts/<uuid>/<filename>` | ファイル内容取得 |

### ZIPインポートレスポンス拡張

```json
{
  "imported": 10,
  "skipped": 5,
  "conversations_saved": 10,
  "artifacts_extracted": 42
}
```

### admin.html Files タブ（v3.3）

**フィルタ・ソート：**
- キーワード検索（ファイル名・会話名、300msデバウンス）
- 拡張子フィルタピル（filesDataから動的生成、クリック絞り込み）
- 日付範囲（from/to ピッカー、クライアント側適用）
- ソートヘッダー（ファイル名・会話名・日付・サイズ）：クリックで昇降順切り替え（▼▲表示）

**プレビュー（クリックでモーダル表示）：**
- `.md` → marked.js マークダウンレンダリング（リンクは `target="_blank"` で開く）
- `.html` / `.htm` → `<iframe srcdoc sandbox="allow-scripts">` でサンドボックスプレビュー
- `.py` / `.js` / `.jsx` / `.ts` / `.css` / `.sh` / `.json` / `.yaml` / `.sql` → Prism.js シンタックスハイライト（`prism-tomorrow` テーマ）
- その他 → プレーンテキスト表示

**CDN依存：**
- Prism.js 1.29.0（prism-tomorrow テーマ + python / jsx / bash コンポーネント）
