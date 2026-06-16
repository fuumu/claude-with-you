# protocol_guide.md — MCPツール運用ガイド（mio-memory v3.42 / 全19本）

*新規セッションがこれ一枚でMCPツールの使い方が分かる参照ドキュメント。*
*このファイルは install 非依存（ツール機構は全 mio-memory 共通）。固有の起動ルール・呼称は `core_rules.md` を参照。*

---

## 0. 全体像 — 4つのストア + 1つのバッチ

mio-memory は**4種のストア**を MCP ツールで操作する。データの性質で使い分ける。

| ストア | 正式名 | 実体 | 性質 |
|--------|--------|------|------|
| **ExtMemory** | 外部記憶（KVストア） | `/data/memory/{id}.json` ＋ `index.json` | 大量・追記型。会話メモ・知識。階層検索対象 |
| **UserCoreMemory** | CoreMem | `/data/artifacts/`（バージョン管理＋シンボリックリンク） | 少数・上書き型。アイデンティティ・ルール・TODO |
| **LogStore** | 会話アーカイブ | `/data/conversations/` ＋ `/data/annotations/` | 不変ログ＋append-only注記。ZIPインポート由来 |
| **inbox** | 軽量メッセージング | `/data/inbox/` | セッション間の伝言。chat/code/friend チャネル |

加えて **batch**（要約レイヤー生成）が ExtMemory を裏で育てる。

---

## 1. ツール一覧（5系統・全19本）

| # | ツール | 系統 | 一行用途 | コスト感 |
|---|--------|------|---------|---------|
| 1 | `memory_read_index` | ExtMemory | 記憶インデックス全取得 | 軽 |
| 2 | `memory_read` | ExtMemory | ID指定で1エントリ取得 | 軽 |
| 3 | `memory_write` | ExtMemory | 新規エントリ書き込み | 中（index再構築） |
| 4 | `memory_upsert` | ExtMemory | 固定IDで上書き/新規 | 中（index再構築） |
| 5 | `memory_search` | ExtMemory | 階層キーワード検索 | 軽〜中 |
| 6 | `memory_share` | ExtMemory | エントリの24h共有URL | 軽 |
| 7 | `CoreMem_save` | UserCoreMemory | ファイル保存（overwrite/append） | 軽 |
| 8 | `CoreMem_read` | UserCoreMemory | ファイル読み込み（manifestマージ対応） | 軽〜中 |
| 9 | `CoreMem_list` | UserCoreMemory | ファイル一覧 | 軽 |
| 10 | `CoreMem_delete` | UserCoreMemory | 削除 or リネーム（src/dst） | 軽 |
| 11 | `conversation_index` | LogStore | 会話タイトル一覧（日付降順） | 軽 |
| 12 | `conversation_search` | LogStore | 会話をキーワード/日付で検索 | 軽 |
| 13 | `conversation_read` | LogStore | 会話本文を取得 | 中 |
| 14 | `conversation_share` | LogStore | 会話の24h共有URL | 軽 |
| 15 | `log_annotate` | LogStore | 会話に注記を積む（append-only） | 軽 |
| 16 | `inbox_check` | inbox | 未読件数＋常駐本文（軽量） | 軽 |
| 17 | `inbox_read` | inbox | 1件取得して既読化 | 軽 |
| 18 | `inbox_post` | inbox | メッセージ送信 | 軽 |
| 19 | `batch_run_summary_layers` | batch | 要約レイヤー生成バッチ起動 | **重**（LLM・非同期） |

※ 友達セッション（`/mcp?token=<friend_token>`）では別途6本が出る。本ガイドは通常セッション19本が対象。

---

## 2. 各ツール詳細

### ExtMemory（記憶KVストア・6本）

**`memory_read_index`** — 引数なし。全エントリの軽量メタ（id/title/tags/created_at/importance/keywords/symbolic）。**軽**。

**`memory_read`** — `id`(必須)。1エントリの全文（body含む）。**軽**。

**`memory_write`** — `title`(必須)・`body`(必須)・`tags`・`importance`(high/normal/low)。ID形式 `YYYYMMDD_HHMMSS_<先頭タグ>`。**返り値の `id` を必ずチャットに記録**。コスト=**中**（index 全再構築）。

**`memory_upsert`** — `id`(必須)・`title`(必須)・`body`(必須)。固定IDで上書き（無ければ新規）。コスト=**中**。

**`memory_search`** — `q`(必須)・`limit`(既定10,0=無制限)・`offset`・`full_body`。**階層検索**：1次=index（title+tags+keywords+3層symbolic）→ 2次=要約 → 3次=全文。返り値は `summary`＋`symbolic`、各ヒットに `match_layer`（keyword/symbolic/summary/full）。全文は `full_body=true` か `memory_read`。**軽〜中**。

**`memory_share`** — `id`(必須)。24h共有URL。**軽**。

### UserCoreMemory（CoreMem・4本）

**`CoreMem_save`** — `name`(必須)・`content`(必須)・`mode`("overwrite"既定/"append")。バージョン管理付き。**軽**。

**`CoreMem_read`** — `name`(必須)・`version`(任意)。`{stem}_manifest.md` があれば分割をマージ返却。⚠️ 書き込みはマージ全文でなく**個別分割ファイル**へ。**軽〜中**。

**`CoreMem_list`** — 引数なし。名前・最新version・更新日時。**軽**。

**`CoreMem_delete`** — `name`（完全削除）/ `src`+`dst`（リネーム）。**軽**。

### LogStore（会話アーカイブ・5本）

**`conversation_index`** — `search`・`limit`(既定50,最大500)・`offset`。タイトル一覧（日付降順）。**軽**。

**`conversation_search`** — `q`・`date_from`・`date_to`・`limit`(既定5)。会話メタ（uuid/title/date/件数）。**軽**。

**`conversation_read`** — `uuid`(必須)・`include_thinking`・`thinking_limit`(既定1500)・`include_annotations`・`include_body`。`include_annotations=true` で注記インライン＋`[No.X]` 通番。**中**。

**`conversation_share`** — `uuid`(必須)。24h共有URL。**軽**。

**`log_annotate`** — `uuid`(必須)・`note`(必須)・`author`(必須)・`target`(任意=通番、省略で会話全体)。**生ログ不変・append-only**。**軽**。

### inbox（3本）

**`inbox_check`** — `to`('chat'/'code')・`include_read`。未読件数＋ID＋**常駐本文込み**（`persistent[]`）。**軽**。

**`inbox_read`** — `id`(必須)。1件取得して**既読化**。**軽**。

**`inbox_post`** — `to`(必須)・`title`(必須)・`body`(必須)・`from`・`from_model`・`to_model`・`reply_to_id`・`persistent`。**軽**。

### batch（1本）

**`batch_run_summary_layers`** — `backend`('lmstudio'/'anthropic')・`force`・`status_only`。2層要約・3層シンボリック・4層キーワードを生成。**重・非同期**。確認のみなら `status_only=true`（**軽**）。

---

## 3. 起動シーケンスとの関係

| モード | 使うツール |
|--------|-----------|
| 雑談・挨拶 | `CoreMem_read("core.md")` |
| お仕事 | `CoreMem_read("core.md")` ＋ `inbox_check`（未読あれば `inbox_read`） |

- **`CoreMem_read("core.md")` は必ず起動時**（MCP initialize が指示）
- `memory_search` は起動時に自動実行しない（遅延ロード）

---

## 4. ツール間の依存・推奨順

- **会話を読む**：`conversation_search`（or `conversation_index`）→ uuid → `conversation_read(uuid)`
- **inbox 処理**：`inbox_check` → 非常駐未読は `inbox_read(id)`（常駐は read 不要）
- **記憶を引く**：`memory_search(q)` → 要約で足りればそこまで／本文要れば `memory_read(id)`
- **記憶を書く**：`memory_write` → 返り値 `id` をチャットに記録
- **CoreMem 分割更新**：`CoreMem_read`（確認）→ 個別分割ファイルを `CoreMem_save`
- **注記**：`conversation_read(include_annotations=true)` で `[No.X]` 確認 → `log_annotate(uuid, target="No.X", ...)`
- **発注↔完了**：`inbox_post(...)` の返り値 `id` を、完了報告の `reply_to_id` に渡してスレッド化

---

## 5. ユースケース別パターン

**記憶を検索**
```
memory_search(q="キーワード")     # 1次で当たれば軽い
→ match_layer を確認 → 詳しく要れば memory_read(id) か full_body=true
```

**過去会話を読む**
```
conversation_search(q="...")      # UUID不明なとき（or conversation_index）
→ uuid → conversation_read(uuid, include_thinking=true)
```

**発注して完了報告を受ける**
```
[発注] inbox_post(to="code", from="chat", title="【発注】...", body="...") → 返り値 id
[実装] inbox_check(to="code") → inbox_read(id) → 実装 →
       inbox_post(to="chat", from="code", reply_to_id=<発注id>, title="【完了報告】...")
[発注] inbox_check(to="chat") → reply_to_id でスレッド確認
```

**CoreMem 読み書き**
```
読む: CoreMem_read("core.md")              # manifest あれば自動マージ
追記: CoreMem_save("todo.md", "...", mode="append")
書換: CoreMem_save("core_rules.md", "<全文>")
改名: CoreMem_delete(src="a.md", dst="b.md")
```

---

## 6. 落とし穴・注意

- **`memory_write` 後は index 全再構築**。大量連投を避けまとめ書き。
- **symbolic/keywords は要約バッチ後に有効**。書いた直後の raw は title/tags でしか1次ヒットしない。
- **CoreMem manifest マージ全文を保存しない**（区切りコメントごと保存すると壊れる）。個別分割ファイルへ。
- **inbox_read は既読化する**（未読に戻す機能は未実装）。
- **`log_annotate` は取り消せない**（誤りは新規注記で訂正）。
- **`batch_run_summary_layers` は重い**。状況確認だけなら必ず `status_only=true`。
