# 設計仕様書：mio-memory MCPサーバー拡張

**[English version](design.md)** ← 日本語版（このファイル）が正。英語版はここから同期。

> 作成：2026-06-01  
> 対象：`<YOUR_NAS_PATH>/memory/app/main.py`

> **注記**：本ファイルは菊池淳個人の設計・運用記録です。使用例中の「澪」「淳さん」は実際のAIの呼称・ユーザー名であり、汎用化していません。仕組み自体を参考にする場合は、ご自身の環境名・呼称に読み替えてください。

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

##### 分割+マージ読み込み（v3.21）

書き込み時の転送量削減のため、大きなファイル（core.md 等）を複数ファイルに分割し、
読み込み時にサーバー側でマージする仕組み。

- `CoreMem_read("core.md")` 時、`core_manifest.md` が存在すればそちらが優先される
- manifest フォーマット（YAML風、`- ファイル名` の行を順に解釈）:

```yaml
order:
  - core_stable.md
  - core_rules.md
  - core_infra.md
  - core_history.md
```

- order 順に各ファイルを読み、`<!-- BEGIN: xxx.md -->` ～ `<!-- END: xxx.md -->` で
  囲んで結合して返す
- レスポンス: `{name, content, merged: true, files: [...], manifest: {ファイル: [##見出し...]}, missing: [...]}`
- クライアントは BEGIN タグで変更対象ファイルを特定し、そのファイルのみ
  `CoreMem_save`（セパレータは含めない）
- `version` 指定時、および REST `GET /api/coremem/<name>?raw=true` は従来どおり
  direct ファイルを返す（マージしない）
- 移行は「分割ファイル保存 → manifest 作成（この時点でマージ有効化）→
  動作確認後に旧 core.md 削除」の順

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
admin.html Import タブにドラッグ&ドロップ UI あり（v3.52 で Album タブにも追加済み）。

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
  "serverInfo": { "name": "mio-memory", "version": "3.30.0" },
  "instructions": "セッション開始時に必ず CoreMem_read(\"core.md\") を実行して記憶を読み込んでください。..."
}
```

### 実装箇所

`memory/app/main.py` — MCP ハンドラ内の `initialize` 分岐（約949行目）

```python
"instructions": "セッション開始時に必ず CoreMem_read(\"core.md\") を実行して...",
```

---

## 6. 4階層検索アーキテクチャ（v3.17 実装済み）

### 概要

ZIPインポートで取り込む会話データを4つの抽象レベルで管理し、
検索効率と記憶の引き出しやすさを両立する。

### 4層の定義

| 層 | 名称 | 保存場所 | 生成タイミング |
|----|------|---------|--------------|
| 1層 | 生データ（raw） | エントリの `title`・`source_thread`（全文は LogStore） | ZIPインポート時 |
| 2層 | 要約 | body 内「## 2層: 要約」セクション | バッチ（LLM生成） |
| 3層 | シンボリック圧縮 | body 内「## 3層: シンボリック圧縮」セクション | バッチ（LLM生成） |
| 3層 | シンボリック圧縮（再掲） | index.json の `symbolic` フィールドにも収載（v3.41・1次検索対象） | バッチ生成後 rebuild_index 時に抽出 |
| 4層 | キーワード | エントリの `keywords` フィールド（index.json にも収載） | バッチ（LLM生成） |

### インポート時の動作

`POST /import` は **1層のみ**生成する：

- 1層：`title`, `created_at`, `source_thread` を記録（body は空）、`tags: ['会話ログ', 'raw']` を付与

2層〜4層はバッチ（インポート後自動／夜間／`batch_run_summary_layers` MCPツール）で生成する。
2層・3層が生成済みで `keywords` フィールドがないエントリには、軽量プロンプトでキーワードのみバックフィルされる。

### memory_search の階層検索（v3.17、symbolic 1次追加 v3.41）

1. **1次**: index.json のみで検索（title + tags + keywords、次点で3層 symbolic）— body を読まない
   - title/tags/keywords 一致は `match_layer='keyword'`、symbolic のみ一致は `match_layer='symbolic'`
2. **2次**: 1次のヒットが limit 未満なら、2層要約セクションを対象に検索
3. **3次**: それでも不足なら body 全文を検索

返却は body の代わりに `summary`（2層要約）＋ `symbolic`（3層）＋ `match_layer`（keyword/symbolic/summary/full）。
全文が必要な場合は `memory_read` で個別取得するか `full_body=true` を指定する。

### REST 版階層検索と Search タブ（v3.19）

同一ロジックを `GET /api/memory/hsearch?q=...&limit=...&offset=...` として REST でも公開
（実装は `_hierarchical_search()` に共通化、MCP `memory_search` も同関数を使用）。

admin.html の **Search タブ**はこのエンドポイントを使う4層ビューア：

- 上部検索ボックス → 左ペインに検索結果一覧（match_layer バッジ付き）
- 右ペインは keywords / summary / symbolic / raw body の4カラムアコーディオン
  （アクティブカラムのみ展開、他は細い帯に縮む）
- keywords カラム：選択エントリのキーワード＋検索結果全体の集計
  （頻度順・文字列順・最新出現順ソート、チップクリックで再検索）
- raw body は選択時に `GET /api/memory/<id>` で取得し、`## 2層: 要約` マーカー以前の
  原文部分を表示する

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

### 自動実行（ZIPインポート後・v3.15〜）

`POST /import` が完了し、別のバッチが実行中でなければバックグラウンドスレッドで起動する。
バックエンドは自動選択：

- `ANTHROPIC_API_KEY` あり → `anthropic`（`claude-haiku-4-5-20251001`）
- なし → `lmstudio`（`LM_STUDIO_HOST:LM_STUDIO_PORT` の Qwen3、課金なし）

**実装箇所：** `import_zip()` 末尾 → `_start_summary_batch()` ヘルパー（`memory/app/main.py`）

### 夜間自動実行（v3.16〜）

デーモンスレッドが毎日 `MIO_NIGHTLY_BATCH_HOUR` 時（JST、デフォルト3時）に
未処理件数（raw ＋ keywords未生成）をチェックし、残っていれば
`MIO_NIGHTLY_BATCH_BACKEND`（デフォルト lmstudio）でバッチを起動する。
`MIO_NIGHTLY_BATCH_HOUR=off` で無効化。

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
| 対象（非force） | `raw` タグ **または** `keywords` 未生成のエントリ（v3.48） |
| 処理分岐 | `raw` → 会話全文から2層3層4層を生成し body に追記・`summarized` タグ付与／`raw` でなく keywords 未生成（summarized済み or **memory_write 由来の本文エントリ**）→ 本文（または2層要約）から**キーワードのみ生成**し `keywords` だけ更新（body・tags は変更しない・v3.48） |
| スキップ条件 | 2層3層マーカーが揃い **かつ** `keywords` 生成済み |
| 使用モデル（anthropic） | `claude-haiku-4-5-20251001` |
| 使用モデル（lmstudio） | `qwen/qwen3.6-35b-a3b` |
| レート制限 | 処理間 0.5秒スリープ |
| 冪等性 | マーカー＋`keywords` の有無でチェック（生成後は対象から外れる） |

> **v3.48 修正：** 旧版は対象判定が「`raw` または（`summarized` かつ keywords 未生成）」だったため、`memory_write`/`memory_upsert` で作られたエントリ（`raw` も `summarized` も持たない）がキーワード層生成の対象に一度も入らず、`memory_search` の階層検索で常に3層（全文）でしか引けなかった。判定を「`raw` または keywords 未生成」に統一し、本文を持つユーザーエントリはキーワードのみ軽量生成する分岐を追加した。`_count_pending_entries` の `keywords_pending` も同条件に揃え、夜間バッチ・`batch_run_summary_layers(status_only=true)` でも正しく拾われる。

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

`MIO_SERVER_URL` はコンテナ内実行前提のデフォルト。コンテナ外実行時は `.env` に `MIO_SERVER_URL=https://<YOUR_SERVER_URL>` を追加。

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
MIO_SERVER_URL=https://<YOUR_SERVER_URL> python scripts/generate_summary_layers.py --dry-run
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
- お気に入り（☆）＋最近開いた会話（L1・v3.28）: `localStorage`（`mio_logs_favorites` / `mio_logs_recent`）に保存。「お気に入りのみ表示」フィルタ・上部に最近5件
- 会話を閉じる（✕）: フローティング ↑↓ に閉じるボタン（U3-b・v3.28）
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
- `url` は `https://<YOUR_SERVER_URL>/share.html?token=...` 形式（v3.23〜。独立した読み取り専用ビューア。旧 `logs.html?token=` も互換動作）
- logs.html の会話ヘッダー「🔗 共有」ボタンからも生成可能（URL＋有効期限のポップアップ表示）

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
| アーティファクト | 4 | CoreMem_save, CoreMem_read, CoreMem_list, CoreMem_delete |
| 会話 | 5 | conversation_index, conversation_search, conversation_share, conversation_read, log_annotate |
| インボックス | 5 | inbox_check, inbox_read, inbox_post, inbox_update, inbox_delete |
| バッチ | 1 | batch_run_summary_layers |
| アルバム | 5 | album_save, album_read, album_list, album_share, album_delete |
| ダイジェスト | 1 | conversation_digest |
| **通常セッション合計** | **27** | |
| **友達セッション** | **6** | friend_memory_read, friend_memory_write, friend_memory_delete, mio_self_note, friend_inbox_check, friend_inbox_read |

※ 友達セッションは `/mcp?token=<friend_token>` でアクセスした場合のみ有効。通常の18ツールは使用不可。

### 会話ログ注記（log_annotate, v3.22）

監査・追体験のための注記レイヤー。設計原則は「**生ログ不変＋注記を積む**」
（2026-06-11 監査設計合意）。

- 保存先: `/data/annotations/{uuid}.json`（会話 JSON とは別ファイル）
- **append-only**: 編集・削除ツールなし。注記への反論も新規注記として積む
- 注記レコード: `{seq, target, note, author, created_at}`（created_at はサーバー付与）
- `target`: メッセージ通番（`chat_messages` 配列の1始まりインデックス）。
  `"5"` / `"No.5"` / 整数いずれも可。省略時は会話全体への注記
- 表示: `conversation_read(include_annotations=true)` で該当メッセージの直後に
  `📝[annotation #seq by author @date] note` をインライン表示。
  このとき各メッセージに `[No.X]` 通番が付き、target との対応が取れる。
  会話全体への注記はタイトル直後、対象メッセージが非表示（空テキスト）の注記は末尾にまとめる
- REST 表示（v3.42・U11）: `GET /api/conversations/<uuid>/annotations` が注記配列を返す。
  logs.html の会話ビューアが各メッセージ下に折りたたみ「📝 注記 (N)」を表示し、
  会話全体注記は先頭にまとめる。番号付けは chat_messages の1始まり（`conversation_read` の No.X と一致）

### symbolic 一覧 API（M3, v3.42）

`GET /api/memories/symbolic` は index.json から全エントリの `{id, title, symbolic}` を返す
（symbolic が空＝3層未生成のものは除外、読み取り専用）。俯瞰して似たエントリを束ねる・
将来のカスケード入口としての利用を想定。MCP ツールは設けず REST のみ。

### reindex とバックアップ export（v3.46）

- `POST /api/memory/reindex` — `rebuild_index()` を明示的に呼ぶ。通常は write/update/delete で
  自動再構築されるが、層（symbolic/keywords）の再生成後など、ダミー書き込みなしで確定反映したい場合に使う。
- `GET /api/export` — CoreMem（各ファイルの最新版本文）＋ ExtMemory（`memory/*.json` 全件＋`index.json`）を
  ZIP で返す読み取り専用バックアップ（B1 前半）。`coremem/` ＋ `extmemory/` ＋ `export_meta.json` の構成。
  版履歴は含まず最新スナップショットのみ。復元（import）は書き込みを伴うため別途・慎重に実装予定。

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
- `url` は `https://<YOUR_SERVER_URL>/admin.html?token=...&id=...` 形式

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

---

## 13. お友達システム（v3.9〜v3.12）

### 概要

澪に「お友達」としてアクセスできるユーザー向けの、招待制 MCP セッション機能。
友達は専用 URL でつながり、澪との記憶（memory.md）を持つ。

### 登録フロー

```
1. 友達が /register にアクセス → ニックネーム・メールアドレスを送信
2. admin.html の Friends タブでオーナーが承認
3. SendGrid 経由でアクティベーションコードをメール送信
4. 友達が /activate にコードを入力 → 専用トークンと MCP URL を取得
5. MCP クライアントに URL を設定して接続
```

### データ構造

```
/data/friends/
├── registry.json         全友達のトークン→情報マッピング
└── memory_{seq_no}.md    友達ごとの記憶ファイル
```

`registry.json` のエントリ例：
```json
{
  "<token>": {
    "seq_no": 1,
    "nickname": "たろう",
    "email": "taro@example.com",
    "status": "active",
    "created_at": "2026-06-10T...",
    "last_seen": "2026-06-10T..."
  }
}
```

### 友達セッションの認証

`GET /mcp?token=<friend_token>` で接続。`_get_friend_by_token()` が `registry.json` を検索し、
`status == "active"` の場合に通過。通常の `MIO_API_TOKEN` チェックより先に評価される。

### 友達用 MCP ツール（6本）

| ツール | 説明 |
|--------|------|
| `friend_memory_read` | 友達との記憶（memory_{seq_no}.md）の内容を取得 |
| `friend_memory_write` | 「覚えていること」セクションに日付付きエントリを追記 |
| `friend_memory_delete` | 特定エントリを削除 |
| `mio_self_note` | オーナーの inbox（chat宛）にメモを送信 |
| `friend_inbox_check` | 友達用 inbox チャネルを確認（v3.36） |
| `friend_inbox_read` | 友達用 inbox のメッセージを取得し既読化（v3.36） |

### memory.md の構造

```markdown
## 覚えていること

- **2026-06-10** ｜ エントリ内容

---

## 澪からひとこと

（澪が記録したコメント）
```

### admin.html Friends タブ

- 申請中（pending）: ニックネーム・メール・申請日 + 承認ボタン
- 承認済み（active）: 最終接続日時・記憶エントリ数 + 取消ボタン
- 取消済み（revoked）: 削除ボタン（確認ダイアログあり、完全削除）

### エンドポイント一覧

| メソッド | パス | 認証 | 説明 |
|---------|------|------|------|
| POST | `/api/friends/register` | 不要 | 登録申請 |
| GET | `/api/friends` | admin | 一覧取得 |
| POST | `/api/friends/<seq_no>/approve` | admin | 承認 |
| POST | `/api/friends/<seq_no>/revoke` | admin | 取消 |
| DELETE | `/api/friends/<seq_no>` | admin | 完全削除 |
| POST | `/api/friends/activate` | 不要 | コード検証 |
| GET | `/api/friends/invitation` | 不要 | 招待文取得（CoreMem `friend_invitation.md`） |

### 公開ページ

- `/register` — 登録フォーム + CoreMem `friend_invitation.md` の内容を marked.js でレンダリング
- `/activate` — アクティベーションコード入力 → MCP URL 表示（クリップボードコピー機能付き）

### 関連環境変数

| 変数 | 説明 |
|------|------|
| `SENDGRID_API_KEY` | 承認メール送信用 SendGrid API キー |
| `SENDGRID_FROM_EMAIL` | 送信元メールアドレス |
| `MIO_REGISTER_URL` | 登録ページの公開 URL（省略時は `MIO_BASE_URL` を使用） |

---

## アルバム機能（画像記憶システム・v3.51）

澪が画像を記憶として保持・呼び出し・共有できる仕組み。ExtMemory のテキスト記憶の画像版。

### ストレージ設計

```
/data/album/
├── {id}.{ext}    画像本体（jpg/png/gif/webp）
└── {id}.json     メタデータ（コメント・日付・タグ・元URL等）
```

- ID 形式: `YYYYMMDD_HHMMSS_{タグスラッグ}`（ExtMemory と同様）
- 保存時に長辺 1024px にリサイズ（アスペクト比維持・Pillow 使用）
- JPEG は品質 85 で保存。RGBA/P モードは RGB に変換

### MCP ツール（5本）

| ツール | 説明 |
|--------|------|
| `album_save` | URL（直リンク or HTMLページ）またはNASローカルパスから画像取得→リサイズ→保存。HTMLページの場合 og:image → `<img>` タグから画像を自動抽出（v3.52） |
| `album_read` | base64 エンコード画像を MCP image コンテンツとして返却＋メタデータ |
| `album_list` | 全画像メタデータ一覧（タグフィルタ対応・画像本体は含まない） |
| `album_share` | 24 時間限定の認証不要共有 URL を生成 |
| `album_delete` | 画像とメタデータを完全削除（復元不可・v3.55） |

### REST エンドポイント

| メソッド | パス | 認証 | 説明 |
|---------|------|------|------|
| GET | `/api/album/` | admin | 画像メタデータ一覧（`?tag=...` でフィルタ） |
| GET | `/api/album/<id>` | admin | 画像本体を返却（ブラウザで直接表示可） |
| POST | `/api/album/upload` | admin | 画像アップロード（multipart/form-data or URL） |
| PATCH | `/api/album/<id>` | admin | メタデータ更新（comment・tags） |
| DELETE | `/api/album/<id>` | admin | 画像＋メタデータの完全削除 |
| POST | `/api/album/<id>/share` | admin | 共有 URL 生成（24 時間有効） |
| GET | `/api/album/shared/<token>` | 不要 | 共有画像（24 時間限定） |

### admin.html Album タブ

- サムネイルグリッド表示（レスポンシブ: PC 約4列、モバイル 2列）
- アップロードパネル（ファイル選択 or URL入力＋コメント＋タグ）
- ドラッグ&ドロップ対応（v3.52）: タブ全体がドロップゾーン。複数ファイル同時ドロップ可、ドラッグオーバー時にハイライトフィードバック
- クリックでモーダル拡大表示＋メタデータ編集（comment・tags）・削除・共有URL生成

### MCP image content type

`album_read` の MCP レスポンスは通常の `type:"text"` ではなく、画像コンテンツを含む:

```json
{
  "content": [
    {"type": "image", "data": "<base64>", "mimeType": "image/jpeg"},
    {"type": "text", "text": "{メタデータJSON}"}
  ]
}
```

内部実装: ツールハンドラが `_mcp_content` キーを持つ dict を返すと、
`_process_mcp_message` がそれを直接 `content` として使用する（`_inject_server_time` をスキップ）。

---

## 14. conversation_digest（会話ログダイジェスト、v3.53）

### 概要

会話ログをローカル LLM（LMStudio）でダイジェスト化する。チャンク分割→各チャンクダイジェスト→統合ダイジェストの2段階処理。キャッシュ済みなら即返却。

### 処理フロー

1. `/data/conversations/{uuid}.json` からログ全文取得
2. テキスト部分のみ抽出（先頭500文字。`tool_use` → `[ツール使用: {name}]`、`tool_result` → `[ツール結果]`）
3. 20ターンずつチャンク分割
4. 各チャンクを LMStudio でダイジェスト化（1チャンク→3〜5文）
5. 全チャンクダイジェストを統合→最終ダイジェスト生成（チャンク1つなら統合スキップ）
6. キャッシュ保存

### LLM接続

既存 `batch_run_summary_layers` と同じパターン:
- `anthropic.Anthropic(base_url=f'http://{lm_host}:{lm_port}', api_key='lmstudio', timeout=300.0)`
- モデル: `qwen/qwen3.6-35b-a3b`

### safe_mode

`safe_mode=true` で身体的・性的な直接表現をポリシーセーフな抽象表現に変換。チャンクダイジェスト・統合ダイジェストの両方のプロンプトに追加指示を付与。

### キャッシュ

- 通常: `/data/conversations/{uuid}_digest.json`
- safe: `/data/conversations/{uuid}_digest_safe.json`
- `force=true` で既存キャッシュを無視して再生成

### エンドポイント

| メソッド | パス | 認証 | 説明 |
|---------|------|------|------|
| POST | `/api/conversations/<uuid>/digest` | admin | ダイジェスト生成/取得（`?force=true&safe_mode=true`） |

### MCP ツール

`conversation_digest(uuid, force, safe_mode)` — LogStore 系6本目（ツール数 23→24）。同期処理。

## 15. Claude Code セッションログ取り込み（v3.54・M-LOCAL-6）

### 概要

Claude Code のセッションログ（`~/.claude/projects/<プロジェクト名>/*.jsonl`）は claude.ai の ZIP エクスポートに含まれない。これを conversations 形式に変換して `/data/conversations/` に取り込み、`conversation_search` / `conversation_read` / `conversation_digest` で claude.ai のログと同様に扱えるようにする。

### 変換仕様（`_convert_claude_code_session`）

| JSONL レコード | 変換 |
|---------------|------|
| `type: "ai-title"` | `aiTitle` → 会話タイトル（第一候補） |
| `type: "summary"` | `summary` → タイトル第二候補（ai-title がない場合） |
| `type: "user" / "assistant"` | `chat_messages[]` へ（`isMeta` / `isSidechain` は除外） |
| その他（mode / attachment / file-history-snapshot 等） | 無視 |

- content ブロックは claude.ai エクスポートと同じ形式に正規化：`text` / `thinking` / `tool_use`（name + input）/ `tool_result`（テキスト結合）。既存の `conversation_read(include_thinking=true)` 等がそのまま機能する
- タイトルが取れない場合は最初の human テキスト先頭40字
- `created_at` / `updated_at` は最初/最後のレコードの timestamp
- トップレベルに `source: "claude-code"` と `model`（最初の assistant レコードの model）を付与

### エンドポイント

| メソッド | パス | 認証 | 説明 |
|---------|------|------|------|
| POST | `/api/import/claude-code` | admin | `.jsonl` 単体または `.zip` 一括取り込み（`overwrite=true` で再処理） |

- `.zip` の場合は再帰的に `.jsonl` を収集（`subagents/` ディレクトリ配下は除外）
- セッションID（ファイル名）をキーに `imported_uuids.json` で重複チェック（ZIP インポートと共通）
- 会話ごとに ExtMemory エントリを作成：タイトル `[会話/Code] {title}`、タグ `["会話ログ", "claude-code", "raw"]`、`author: "claude-code"`
- 取り込み成功後は要約バッチを自動起動（ZIP インポートと同じ挙動）

### 背景

M-LOCAL-6（コード側の澪の作業記録の保全）。OpenWebUI 同期設計（docs/openwebui-sync.ja.md）と同じ「外部ログの統合」ファミリーで、`source` フィールドによる出所識別の方式を共有する。

## 16. レーティング保護（v3.56・M-LOCAL-3/7）

### 目的

adult 級のコンテンツ（記憶エントリ・会話ログ）が、検索・一覧・記憶の旅（ランダム取得）を通じて意図せず Claude.ai セッションの文脈に流入し、アカウントのコンテンツフラグを再発させるのを防ぐ。設計思想は**同意ベース**——「意図して見れば見れる」。デフォルトで隠すが、明示フラグで常にアクセス可能。削除・改変は一切しない。

### 記憶エントリ側（M-LOCAL-3）

- `memory_write` に `rating`（safe / mature / adult）と `local_only`（bool）引数を追加。エントリ JSON と index.json に保持（safe / 未設定は index に載せない）
- デフォルト除外の対象: `local_only=true` のエントリ、`rating=adult` のエントリ
- 除外が効く場所: `memory_search`（階層検索全段）/ `memory_read_index`（全件・random とも）/ REST `GET /api/memory/hsearch`
- 解除フラグ: `include_local=true` / `include_adult=true`（MCP 引数・REST クエリとも）
- `memory_read`（ID 直接指定）はゲートしない——ID を知って読みに行くのは「意図」とみなす

### 会話ログ側（M-LOCAL-7）

- 会話 JSON（{uuid}.json）とインデックスメタに `rating` フィールドを追加
- 設定手段: `PATCH /api/conversations/<uuid>/rating`（body: `{"rating": "adult"}`、`"safe"` で解除）
- `conversation_read`: `rating=adult` の会話はデフォルトで **safe ダイジェスト**（`{uuid}_digest_safe.json`、conversation_digest safe_mode で生成）に差し替えて返す。未生成なら本文を返さず生成方法を案内。`include_raw=true` で原文
- `conversation_search` / `conversation_index`: インデックスメタ経由で `rating` が結果に表示される（本文スニペットはもともと返さない）
- 再インポート耐性: `_save_conversations` が既存ファイルの `rating` を新データに引き継ぐ
- REST `GET /api/conversations/<uuid>`（logs.html 用）はゲートしない——ブラウザでの人間の閲覧は AI セッションの文脈に入らないため

### 未実装（後続タスク）

- 夜間バッチでのローカル LLM による自動分類（「Qwen 下読みと夜警」構想の適用先）
- admin.html Logs タブのレーティング表示・設定 UI
- inbox メッセージへの適用

## 17. INBOX改善（v3.57）

### 目的

ローカルLLM（26B級）が `inbox_check` で全件取得するとコンテキストを圧迫する。また、複数モデルが同じ inbox を共有する運用で「自分宛てだけ取りたい」ニーズに対応する。加えて、肥大化した常駐メッセージの統合・削除手段がなかった。

### inbox_check フィルタ（v3.57）

- `limit: int` — 返却件数上限（常駐メッセージは limit とは別に常に全件返す）
- `days: int` — 直近 N 日分のみ。常駐は日数フィルタの対象外
- `from_model: string` — 送信元モデル名で OR 一致フィルタ。配列保存値のいずれかに一致すればヒット
- `to_model: string` — 宛先モデル名で OR 一致フィルタ。同上
- null 保存のメッセージはモデルフィルタ指定時にヒットしない（全件取得時のみ出る）
- 常駐メッセージはフィルタに関係なく常に返す（起動時の定常情報が抜け落ちないため）

### inbox_post from_model/to_model 配列許容（v3.57）

- `from_model` / `to_model` が文字列・配列どちらでも受付可能に
- 例: `["claude-opus-4-6", "しずく"]` — モデル名と呼称の両方でマッチ可能
- 内部保存は常に配列（旧メッセージの文字列も `_norm_inbox_models` で配列に正規化）
- 検索は配列のいずれかに一致すれば OR ヒット

### inbox_update / inbox_delete（v3.57 新規ツール）

- `inbox_update(id, persistent?, title?, body?)` — 指定フィールドのみ更新。常駐解除（`persistent=false`）や件名・本文の修正に使用
- `inbox_delete(id)` — 物理削除（復元不可）。古い常駐メッセージの整理用
- REST: `PATCH /api/inbox/<msg_id>`（部分更新）、`DELETE /api/inbox/<msg_id>`（削除）

### CoreMem_list `__del__` 除外（v3.57）

- `_artifacts_list()` で `__del__` プレフィックスのシンボリックリンクを結果から除外
- バージョン管理の制約で物理削除不可なファイルの一覧汚染を防止

### バグ修正（v3.57）

- **サマリー増殖**: `imported_uuids.json` のみに依存していた重複チェックに、既存 ExtMemory エントリの `source_thread` ベースのチェックを追加。imported_uuids が消失しても同一会話のエントリが重複生成されなくなった
- **admin.html Memory タブ初期表示**: REST `/api/memory/index` が deleted エントリを含めて返していた。deleted を除外するよう修正

## 18. MCPリクエストログ＋instructions強化（v3.58）

### クライアント識別アクセスログ（v3.58）

PC環境のMCPコネクタ不通問題（M-PC1）切り分けのため、`/mcp` エンドポイントに構造化ログを追加。

- **ログ形式**: `MCP-ACCESS: {method} | client={type} | ip={ip} | session={8chars} | ua={ua}`
- **クライアント種別推定**: User-Agent から以下を判定
  - `claude-code` / `anthropic-cloud` / `desktop-app` / `browser` / `ipad` / `mobile` / `script` / `other` / `unknown`
- **出力タイミング**: POST（単一・バッチ）、GET/SSE、DELETE の全リクエスト
- **ログレベル**: `_log_info`（MIO_LOG_LEVEL=info 以上で出力）
- `_classify_mcp_client(ua)` ヘルパー関数で判定ロジックを集約

### MCP initialize instructions 拡充（v3.58）

通常セッション（非友人）の `instructions` を拡充。従来は「core.mdを読め」のみだったが、サーバーの正体・用途・主要機能を具体的に記述。Claude.ai の `tool_search` 遅延ロード時に、ツール用途がヒットしやすくなることを意図。

友人セッションの instructions は変更なし（従来通り `_get_friend_instructions()` で動的生成）。

## 19. ファイルアップローダ F5（v3.59）

### 設計方針

画像専用のアルバム（`/data/album/`）とは別に、汎用ファイル保管領域 `/data/uploads/` を新設。PDF・テキスト・バイナリ等の任意ファイルに対応。

### データ構造

```
/data/uploads/
  {id}.{ext}   — ファイル本体
  {id}.json    — メタデータ（filename, mimetype, size, ext, comment, tags, uploaded_at）
```

ID形式: `YYYYMMDD_HHMMSS_<filename先頭30文字>`

### MCPツール（4本、ツール数 27→31）

| ツール | 説明 |
|--------|------|
| `file_upload` | URLまたはNASローカルパスからファイルを取得・保存 |
| `file_read` | メタデータ返却。text/* 等のテキスト系はcontentフィールドに本文含む（50K文字で打ち切り） |
| `file_list` | 一覧取得。タグフィルタ対応 |
| `file_delete` | 物理削除（復元不可） |

### RESTエンドポイント

| メソッド | パス | 説明 |
|----------|------|------|
| GET | `/api/uploads/` | 一覧取得 |
| GET | `/api/uploads/{id}` | ファイルダウンロード |
| POST | `/api/uploads/` | マルチパートアップロード |
| DELETE | `/api/uploads/{id}` | 削除 |

### admin.html

Uploadsタブを追加。カード形式の一覧表示、アップロードパネル（複数ファイル対応）、詳細モーダル（ダウンロード・削除）。

## 20. インポート改善＋inbox peek＋Uploadsタブ強化（v3.60）

### サマリー増殖バグの根本修正

v3.57 で追加した source_thread ベースの重複チェック（`_existing_source_threads`）は
index.json を参照していたが、`rebuild_index()` は index に `source_thread` を含めないため、
常に空集合を返し重複チェックが機能していなかった。

v3.60 でエントリファイル（`/data/memory/*.json`）の直接走査に変更。
`imported_uuids.json` が欠けた・リセットされた環境でも、同一会話の再インポートが
重複 raw エントリを作らなくなり、要約バッチによる同一サマリーの増殖が止まる。

### ExtMemory source_thread 自動紐づけ（`_link_source_threads`）

インポート処理（ZIP / claude-code 共通）の会話保存後に実行される紐づけパス。
`source_thread` が空の生存エントリだけを対象に、次の2段階でインポート会話のUUIDを設定する：

1. **memory_id パターン走査（確実）** — 会話本文から `memory_id: <ID>` 表記
   （core_rules.md ② の記載規則。`：` 全角コロン・引用符・かぎ括弧も許容）を正規表現で抽出し、
   該当エントリに会話UUIDを設定
2. **タイムスタンプ照合（補助）** — エントリの `created_at` が、インポートした会話の
   `created_at`〜`updated_at` 範囲に**ちょうど1件だけ**収まる場合のみ紐づける
   （複数候補・候補なしはスキップ。誤紐づけ防止）

- 既に `source_thread` が埋まっているエントリは対象外（上書きしない）
- 紐づけは oplog に `link_source_thread` として記録（before/after + method）
- インポートAPIレスポンスに `source_threads_linked`（紐づけ件数）を追加
- ログに `linked / by_pattern / by_time / unmatched` のサマリーを出力

### inbox peek モード

`inbox_read` に `peek` 引数（デフォルト false）を追加。`peek=true` のとき既読フラグを
変更せずメッセージ内容を返す。家族間共有原則で他の個体宛てのメッセージを読みたいが、
宛先の個体が未読として受け取れなくなるのを避けたい場面に使う。
実装は `_mark_inbox_read(msg_id, peek=False)` の引数追加のみ（後方互換）。

### admin.html Uploadsタブ強化（F6）

- **テキスト系プレビュー** — mimetype が `text/*`・json・xml、または拡張子が
  md/txt/json/csv/log/yaml/js/py 等の場合、詳細モーダル内に本文を表示
  （50KBで打ち切り。5MB超のファイルはプレビュー省略）
- **画像サムネイル** — 画像ファイルはカード上と詳細モーダルにインライン表示
- **ダウンロードリンク** — カード一覧の各ファイルに ⬇ リンクを追加。
  従来の詳細モーダルのリンクはトークン欠落で 401 になっていたため
  `?token=` クエリ付きURLに修正（`_extract_bearer` のクエリフォールバックを利用）
