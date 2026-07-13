# protocol_guide.md — MCPツール運用ガイド（mio-memory v3.60 / 全31本）

*新規セッションがこれ一枚でMCPツールの使い方が分かる参照ドキュメント。*
*このファイルは install 非依存（ツール機構は全 mio-memory 共通）。固有の起動ルール・呼称は `core_rules.md` を参照。*

---

## 0. 全体像 — 4つのストア + 1つのバッチ

mio-memory は**5種のストア**を MCP ツールで操作する。データの性質で使い分ける。

| ストア | 正式名 | 実体 | 性質 |
|--------|--------|------|------|
| **ExtMemory** | 外部記憶（KVストア） | `/data/memory/{id}.json` ＋ `index.json` | 大量・追記型。会話メモ・知識。階層検索対象 |
| **UserCoreMemory** | CoreMem | `/data/artifacts/`（バージョン管理＋シンボリックリンク） | 少数・上書き型。アイデンティティ・ルール・TODO |
| **LogStore** | 会話アーカイブ | `/data/conversations/` ＋ `/data/annotations/` | 不変ログ＋append-only注記。ZIP/Claude Codeインポート由来 |
| **inbox** | 軽量メッセージング | `/data/inbox/` | セッション間の伝言。chat/code/friend チャネル |
| **Album** | 画像記憶 | `/data/album/`（画像＋メタデータJSON） | 画像の保存・取得・共有。姿・思い出の写真 |
| **Uploads** | 汎用ファイル | `/data/uploads/`（ファイル＋メタデータJSON） | PDF・テキスト等の任意ファイル保管 |

加えて **batch**（要約レイヤー生成）が ExtMemory を裏で育てる。

---

## 1. ツール一覧（7系統・全31本）

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
| 9 | `CoreMem_list` | UserCoreMemory | ファイル一覧（__del__除外） | 軽 |
| 10 | `CoreMem_delete` | UserCoreMemory | 削除 or リネーム（src/dst） | 軽 |
| 11 | `conversation_index` | LogStore | 会話タイトル一覧（日付降順） | 軽 |
| 12 | `conversation_search` | LogStore | 会話をキーワード/日付で検索 | 軽 |
| 13 | `conversation_read` | LogStore | 会話本文を取得 | 中 |
| 14 | `conversation_share` | LogStore | 会話の24h共有URL | 軽 |
| 15 | `conversation_digest` | LogStore | ローカルLLMでダイジェスト生成（キャッシュ） | 重 |
| 16 | `log_annotate` | LogStore | 会話に注記を積む（append-only） | 軽 |
| 17 | `inbox_check` | inbox | 未読件数＋常駐本文（フィルタ対応） | 軽 |
| 18 | `inbox_read` | inbox | 1件取得して既読化（peek=trueで既読化なし） | 軽 |
| 19 | `inbox_post` | inbox | メッセージ送信 | 軽 |
| 20 | `inbox_update` | inbox | メッセージ部分更新 | 軽 |
| 21 | `inbox_delete` | inbox | メッセージ物理削除 | 軽 |
| 22 | `batch_run_summary_layers` | batch | 要約レイヤー生成バッチ起動 | **重**（LLM・非同期） |
| 23 | `album_save` | Album | 画像を保存（URL/NASパス、自動リサイズ） | 中 |
| 24 | `album_read` | Album | 画像を取得（base64＋メタデータ） | 中（画像分） |
| 25 | `album_list` | Album | 画像メタデータ一覧（本体なし） | 軽 |
| 26 | `album_share` | Album | 画像の24h共有URL | 軽 |
| 27 | `album_delete` | Album | 画像とメタデータを完全削除 | 軽 |
| 28 | `file_upload` | Uploads | ファイルを保存（URL/NASパス） | 中 |
| 29 | `file_read` | Uploads | メタデータ取得（テキストなら本文も） | 軽 |
| 30 | `file_list` | Uploads | ファイル一覧（タグフィルタ対応） | 軽 |
| 31 | `file_delete` | Uploads | ファイルを完全削除 | 軽 |

※ 友達セッション（`/mcp?token=<friend_token>`）では別途の限定ツールが出る。本ガイドは通常セッション31本が対象。

---

## 2. 各ツール詳細

### ExtMemory（記憶KVストア・6本）

**`memory_read_index`** — 全引数任意。全エントリの軽量メタ（id/title/tags/created_at/importance/keywords/symbolic）。`random=N`(1〜5)でランダム抽出（記憶の偶発的な再会用）、`filter="summarized"`でraw除外。`local_only`／`rating=adult` のエントリはデフォルト除外（`include_local=true`／`include_adult=true` で表示・v3.56）。**軽**。

**`memory_read`** — `id`(必須)。1エントリの全文（body含む）。レーティングによるゲートなし（ID直指定＝意図とみなす）。**軽**。

**`memory_write`** — `title`(必須)・`body`(必須)・`tags`・`importance`(high/normal/low)・`rating`(safe/mature/adult・任意)・`local_only`(bool・任意)。`rating="adult"` や `local_only=true` を付けると検索・一覧からデフォルト除外される（v3.56）。ID形式 `YYYYMMDD_HHMMSS_<先頭タグ>`。**返り値の `id` を必ずチャットに記録**。コスト=**中**（index 全再構築）。

**`memory_upsert`** — `id`(必須)・`title`(必須)・`body`(必須)。固定IDで上書き（無ければ新規）。コスト=**中**。

**`memory_search`** — `q`(必須)・`limit`(既定10,0=無制限)・`offset`・`full_body`・`include_local`・`include_adult`。**階層検索**：1次=index（title+tags+keywords+3層symbolic）→ 2次=要約 → 3次=全文。返り値は `summary`＋`symbolic`、各ヒットに `match_layer`（keyword/symbolic/summary/full）。全文は `full_body=true` か `memory_read`。`local_only`／`adult` はデフォルト除外（v3.56）。**軽〜中**。

**`memory_share`** — `id`(必須)。24h共有URL。**軽**。

### UserCoreMemory（CoreMem・4本）

**`CoreMem_save`** — `name`(必須)・`content`(必須)・`mode`("overwrite"既定/"append")。バージョン管理付き。**軽**。

**`CoreMem_read`** — `name`(必須)・`version`(任意)。`{stem}_manifest.md` があれば分割をマージ返却。⚠️ 書き込みはマージ全文でなく**個別分割ファイル**へ。**軽〜中**。

**`CoreMem_list`** — 引数なし。名前・最新version・更新日時。**軽**。

**`CoreMem_delete`** — `name`（完全削除）/ `src`+`dst`（リネーム）。**軽**。

### LogStore（会話アーカイブ・5本）

**`conversation_index`** — `search`・`limit`(既定50,最大500)・`offset`。タイトル一覧（日付降順）。**軽**。

**`conversation_search`** — `q`・`date_from`・`date_to`・`limit`(既定5)。会話メタ（uuid/title/date/件数）。**軽**。

**`conversation_read`** — `uuid`(必須)・`include_thinking`・`thinking_limit`(既定1500)・`include_annotations`・`include_body`・`turn_offset`(任意,負値=末尾起点)・`turn_limit`(任意,0=無制限)・`include_raw`(任意)。`include_annotations=true` で注記インライン＋`[No.X]` 通番。turn_offset/turn_limit でメッセージ単位スライス（冒頭=`turn_limit=4`／末尾=`turn_offset=-4`）。⚠️ `rating=adult` の会話はデフォルトで **safe ダイジェストに差し替え**て返る（原文は `include_raw=true` を明示・v3.56）。**中**。

**`conversation_share`** — `uuid`(必須)。24h共有URL。**軽**。

**`conversation_digest`** — `uuid`(必須)・`force`(任意,trueでキャッシュ無視再生成)・`safe_mode`(任意,trueでポリシーセーフ表現)。ローカルLLM(LMStudio)で会話をチャンク分割→ダイジェスト→統合。キャッシュあれば即返却。**重**（LLM・同期）。

**`log_annotate`** — `uuid`(必須)・`note`(必須)・`author`(必須)・`target`(任意=通番、省略で会話全体)。**生ログ不変・append-only**。**軽**。

### inbox（5本）

**`inbox_check`** — `to`('chat'/'code')・`include_read`・`limit`(件数上限)・`days`(直近N日,常駐は常に返す)・`from_model`(送信元フィルタ,OR一致)・`to_model`(宛先フィルタ,OR一致)。未読件数＋ID＋**常駐本文込み**（`persistent[]`）。null保存メッセージはモデルフィルタにヒットしない。**軽**。

**`inbox_read`** — `id`(必須)・`peek`(任意,trueで既読化せず読む=のぞき見モード,v3.60)。1件取得して**既読化**。**軽**。

**`inbox_post`** — `to`(必須)・`title`(必須)・`body`(必須)・`from`・`from_model`(文字列 or 配列)・`to_model`(文字列 or 配列)・`reply_to_id`・`persistent`。**軽**。

**`inbox_update`** — `id`(必須)・`persistent`(任意)・`title`(任意)・`body`(任意)。指定フィールドのみ更新。常駐解除（`persistent=false`）や件名・本文の修正に。**軽**。

**`inbox_delete`** — `id`(必須)。物理削除・復元不可。**軽**。

### batch（1本）

**`batch_run_summary_layers`** — `backend`('lmstudio'/'anthropic')・`force`・`status_only`。2層要約・3層シンボリック・4層キーワードを生成。**重・非同期**。確認のみなら `status_only=true`（**軽**）。

### Album（画像記憶・5本）

**`album_save`** — `url`（直リンク or HTMLページ、og:image/imgタグ自動抽出）または `file_path`（NASローカル）・`comment`・`tags`。長辺1024pxに自動リサイズ。**中**。

**`album_read`** — `id`(必須)。base64画像＋メタデータを返す（画像がそのまま表示される）。**中**（画像分のトークン）。

**`album_list`** — `tags`(任意)。メタデータ一覧（画像本体なし）。まずこれで探す。**軽**。

**`album_share`** — `id`(必須)。24h認証不要の共有URL。**軽**。

**`album_delete`** — `id`(必須)。画像とメタデータを完全削除（復元不可・v3.55）。**軽**。

### Uploads（汎用ファイル・4本・v3.59）

**`file_upload`** — `url` または `file_path`（NASローカル）・`filename`（省略可）・`comment`・`tags`。任意ファイル（PDF・テキスト等）を `/data/uploads/` に保存。**中**。

**`file_read`** — `id`(必須)。メタデータ返却。テキスト系（text/*・JSON・XML）は content フィールドに本文含む（50K文字で打ち切り）。**軽**。

**`file_list`** — `tags`（配列・省略可）。アップロード済みファイル一覧。タグフィルタ対応。**軽**。

**`file_delete`** — `id`(必須)。ファイルとメタデータを完全削除（復元不可）。**軽**。

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
- **inbox_read は既読化する**（未読に戻す機能は未実装）。他の個体宛てを未読のまま覗くなら `peek=true`（v3.60）。
- **`log_annotate` は取り消せない**（誤りは新規注記で訂正）。
- **`batch_run_summary_layers` は重い**。状況確認だけなら必ず `status_only=true`。
- **レーティング保護（v3.56）**：`local_only`／`rating=adult` の記憶と `rating=adult` の会話はデフォルトで見えない・読めない。「見つからない＝存在しない」ではないことに注意。明示フラグ（`include_local`/`include_adult`/`include_raw`）で常にアクセス可能。クラウドAIセッションでは、明示フラグを使う前に「本当にこの文脈に原文を持ち込むべきか」を一拍考えること（コンテンツフラグ再発防止がこの仕組みの目的）。
- **`album_read` は画像トークンを消費する**。一覧確認は `album_list` で。
