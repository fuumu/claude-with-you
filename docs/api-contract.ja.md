# API 契約ドキュメント（TS-0）

*対象: mio-memory v4.0 / 作成: 2026-07-13 / 最終更新: 2026-10-30*

このドキュメントは、mio-memory が外部に約束している挙動（契約）を固定化するためのもの。
もとは Python 版 `memory/app/main.py` の挙動から作り、v4.0 で TypeScript 単体（`ts/`）になってからも同じ契約を守っている
（本書で「main.py」と書いているのは v3.x の Python 版のこと。Python 版は `legacy-python` ブランチにある）。
**実行可能な契約は `tests/` の特性テストスイート**であり、本書はその地図にあたる。
TypeScript への移行（TS-1 / TS-FULL）では、tests/ が全件グリーンであることを「同じサーバーである」ことの判定基準にした。

## テストスイートの実行方法

```powershell
# 初回のみ: venv 作成と依存導入
python -m venv .venv
.venv/Scripts/python -m pip install pytest requests pillow

# 実行（サーバーは一時データディレクトリで自動起動される。既存環境には触れない）
.venv/Scripts/python -m pytest tests/ -q
```

テストは HTTP 越しの**ブラックボックス**で、サーバーの内部を import しない。
`tests/conftest.py` は `ts/` をビルドして（src が dist より新しいときだけ `npx tsc`）`node ts/dist/index.js` を起動する（Node.js 22 が必要）。
移行中は同じスイートを Python 版・TS 前段・TS 単体の3通りで流していた。

**テスト用フック（運用では未指定＝従来どおり）:**

| 環境変数 | 用途 |
|---|---|
| `MIO_DATA_ROOT` | データルートの差し替え（デフォルト `/data`） |
| `MIO_PORT` | リッスンポート（デフォルト `5002`） |
| `MIO_BIND` | バインド先（デフォルト `0.0.0.0`。テストは `127.0.0.1`） |

---

## 1. 共通契約

### 認証

- REST / MCP とも Bearer トークン認証: `Authorization: Bearer <token>`
- 有効なトークンは ① `MIO_API_TOKEN` ② OAuth アクセストークン（30日・`oauth_store.json` 永続化）
- **フォールバック**: `?token=<token>` クエリパラメータでも認証可（`<img>`/`<a>` タグ用）
- 認証失敗は **401**
- 認証不要: `/health`、OAuth ディスカバリ・フロー、`/api/share/<token>`、`/api/album/shared/<token>`、`/register`、`/activate`

### レスポンス共通形

- MCP ツール返却が dict の場合: `server_time`（JST ISO 8601）と `server_version` が必ず付与される
- MCP ツール返却が list の場合: `{"data": [...], "server_time": ..., "server_version": ...}` にラップされる
- ツールレベルのエラーは HTTP 200 のまま `{"error": "..."}` を返す（JSON-RPC エラーではない）

### ID 形式

| 種別 | 形式 | 例 |
|---|---|---|
| ExtMemory エントリ | `YYYYMMDD_HHMMSS_<先頭タグ>` | `20260713_194909_ts0` |
| 会話（LogStore） | claude.ai の UUID / Code セッション ID | `0050e3a7-...` |
| inbox | `inbox_YYYYMMDD_HHMMSS_<hex8>` | `inbox_20260713_150648_5c786bed` |
| Uploads | `YYYYMMDD_HHMMSS_<filename先頭30字>` | `20260713_160000_report` |
| ZIP由来エントリ | `YYYYMMDD_HHMMSS_<連番4>_<uuid先頭8>` | `20260713_152622_0487_0050e3a7` |

---

## 2. ヘルスチェック・OAuth

| メソッド | パス | 契約 |
|---|---|---|
| GET | `/health` | 200 `{status:"ok", time, version, mcp_tool_count, mcp_tools, served_by:"ts"}` 認証不要 |
| GET | `/.well-known/oauth-authorization-server` | issuer / authorization_endpoint / token_endpoint / registration_endpoint、`code_challenge_methods_supported` に S256 |
| POST | `/oauth/register` | Dynamic Client Registration |
| GET/POST | `/oauth/authorize` `/oauth/token` | PKCE(S256/plain) 必須。認可コード10分、アクセストークン30日 |

## 3. ExtMemory REST（`/api/memory`）

| メソッド | パス | 契約 |
|---|---|---|
| GET | `/api/memory/index` | index配列（deleted除外・local_only/adult除外。`?include_local` `?include_adult` `?random=N` `?filter=summarized`） |
| GET | `/api/memory/<id>` | エントリ全文。**論理削除後も deleted:true で読める**（レーティングゲートなし） |
| POST | `/api/memory` | 201。ID はサーバー採番。`source_thread` を受け付ける |
| PATCH | `/api/memory/<id>` | title / body / tags / source_thread / importance / keywords のみ更新可 |
| DELETE | `/api/memory/<id>` | 論理削除（deleted=true。indexから消える） |
| GET | `/api/memory/search?q=` | 全文検索（body込みエントリ配列） |
| GET | `/api/memory/hsearch?q=` | 階層検索。`results[]{id,title,tags,keywords,match_layer,summary,symbolic,source_thread,...}` + `total` + `has_more`。`?include_conversations=true` で `conversations[]` + `conversations_total` 追加（v3.61） |
| GET | `/api/memory/tags` | タグ→件数マップ |
| POST | `/api/memory/reindex` | index.json 再構築 |
| POST | `/api/memory/share/<id>` | 共有トークン発行 |
| GET | `/api/share/<token>` | 認証不要でエントリ返却（24h期限） |
| ~~GET~~ | ~~`/api/memories/symbolic`~~ | TS-FULL ステップ4 で廃止（404。旧パス埋め込みトークン API `/api/<token>/memory/...` も同時に廃止。`test_removed_legacy_routes_are_404`） |
| POST | `/api/memory/cleanup-empty` | 空エントリの一括論理削除（`dry_run` 対応, v3.79） |
| GET | `/api/export` | CoreMem+ExtMemory の ZIP |
| POST | `/api/import/backup` | export ZIP から復元（multipart `file`・`mode=skip/overwrite`・`dry_run=true`）。応答 `{mode, dry_run, memory{restored,skipped,overwritten}, coremem{...}, conflicts[], errors[]}`。ZIP不正・構造不一致・不正modeは400（v3.63・契約は tests/test_backup_restore.py） |
| POST | `/api/import/compare` | ZIP 比較（データ変更なし） |

## 4. MCP トランスポート（`/mcp`）

- `POST /mcp` — JSON-RPC 2.0。単発・バッチ（配列）対応
- id なし（notification）→ **202 Accepted**（本文なし）
- `Accept: text/event-stream` を含むと SSE 形式（`event: message` + `data: <json>`）で返る。含まなければ `application/json`
- `initialize` → `result.serverInfo` / `result.instructions`（CoreMem_read("core.md") の案内を含む）/ `Mcp-Session-Id` ヘッダ発行
- `tools/list` → 通常セッションは **37本**（v3.90）
- `tools/call` → `result.content[0] = {type:"text", text:"<JSON文字列>"}`。画像系は `_mcp_content`（type:"image", base64）
- `ping` → `{}`
- 未知メソッド → JSON-RPC error `-32601`
- 友達トークン（`/mcp?token=<friend_token>`）では別ツールセット（6本: friend_memory_read/write/delete, mio_self_note, friend_inbox_check/read）

### 4b. MCP 2026-07-28 ステートレスコア（v3.62 から TS 層で先行実装）

新仕様の契約は `tests/test_mcp_2026.py` に固定（旧 Python 版 main.py は 2025-11-25 のままだった）。デュアル時代サーバーとして、レガシー（initialize + `Mcp-Session-Id`）と同一エンドポイントで共存する。

- モダン判定: `params._meta["io.modelcontextprotocol/protocolVersion"]` または `MCP-Protocol-Version` ヘッダが 2026-07-28（または未知の版）を宣言したリクエスト。セッションIDは発行も参照もしない
- `server/discover`（MUST）→ `result.{resultType, supportedVersions, capabilities, instructions, ttlMs, cacheScope, _meta["io.modelcontextprotocol/serverInfo"]}`。`serverInfo` はトップレベルではなく `result._meta` に配置。版宣言なしのプローブにも応答
- `clientCapabilities` 必須: モダンリクエストは `params._meta["io.modelcontextprotocol/clientCapabilities"]` が必須。欠落 → **400** + error `-32602`（Invalid params）。`server/discover` のヘッダなしプローブ（版宣言なし）は免除
- 必須ヘッダ検証（2026-07-28 宣言時）: `MCP-Protocol-Version` / `Mcp-Method` /（tools/call は）`Mcp-Name` がボディと不一致・欠落 → **400** + error `-32020`（HeaderMismatch）。`Mcp-Name` は `=?base64?...?=` センチネルをデコードして比較
- 未対応の版 → **400** + error `-32022`（`data.supported` / `data.requested` 付き）
- 廃止メソッド（`ping`・`initialize` をモダン宣言で呼ぶ等）→ **404** + `-32601`
- 全結果に `resultType: "complete"`、`tools/list` に `ttlMs` / `cacheScope`、全モダンレスポンスの `result._meta` に `io.modelcontextprotocol/serverInfo` を注入（tools/* の中身は 2025-11-25 と同じ）
- `subscriptions/listen` → SSE（`notifications/subscriptions/acknowledged` + keep-alive コメント）
- OAuth 強化: 認可応答リダイレクトに `iss`（RFC 9207）／DCR で `application_type` 受理（既定 `web`）／`grant_type=refresh_token`（発行・使用ごとローテーション・再利用は `invalid_grant`・`scope` 縮小可）／`/.well-known/oauth-authorization-server/<suffix>` にも応答・`grant_types_supported` に `refresh_token`

## 5. MCP ツール（38本）の返却形状（要点）

引数の詳細は README.ja.md / CoreMem `protocol_guide_detail.md` を参照。ここではテストで固定化した返却形状のみ列挙する。

| ツール | 返却の契約 |
|---|---|
| `memory_read_index` | list → `{data:[{id,title,tags,created_at,importance,keywords?,symbolic?,rating?,local_only?}]}`。`random=N`（1〜5クランプ） |
| `memory_read` | エントリ dict 全文。存在しない id は `{error}` |
| `memory_write` | 作成エントリ dict（`id` 必須確認）。`rating`/`local_only` 受付 |
| `memory_upsert` | 固定 id で上書き/新規。作成 dict。`rating`/`local_only` 受付（省略時は既存値温存, v3.73） |
| `memory_search` | `{results[], total, has_more}`。デフォルト body なし（`summary`+`symbolic`+`match_layer`）。`full_body=true` で body。`author` で著者フィルタ（部分一致・v3.81）。`search_layer` で検索対象レイヤー限定（`index`/`summary`/`full`・v3.81）。`include_conversations=true` で `conversations[]`+`conversations_total`（v3.61） |
| `CoreMem_save` | `{name, version, version_str}`。`mode="append"` は `<!-- APPEND datetime -->` 区切りで追記。`mode="str_replace"` は `old_str`→`new_str` 部分置換（v3.80）。`target` でプロジェクトスコープ（v3.90） |
| `CoreMem_read` | `{name, version, content}`。manifest があれば `merged:true` + `<!-- BEGIN/END: file -->` 区切り + `manifest` マップ。`current_model`（出席簿本登録）/ `refer_only`（登録スキップ）対応（v3.85）。`target` でプロジェクトスコープ（v3.90） |
| `CoreMem_list` | list → `{data:[{name,version,updated_at,size}]}`。`__del__` プレフィックス除外。`size`（bytes）追加（v3.90）。`target` でプロジェクトスコープ（v3.90） |
| `CoreMem_delete` | `{deleted}` / リネーム時 `{renamed,src,dst}`。`target` でプロジェクトスコープ（v3.90） |
| `project_create` | `{name, path, files[]}`。`/data/projects/{name}/` にテンプレート群を配置（v3.90） |
| `project_list` | `{projects:[{name,summary,file_count}]}`。全プロジェクト列挙（v3.90） |
| `conversation_index` | `{total, offset, limit, items[]}` |
| `conversation_search` | list → `{data:[{uuid,title,created_at,updated_at,message_count}]}`。複数キーワードAND一致（v3.81）・日付範囲可。`body_search=true` で本文も検索（v3.76） |
| `conversation_read` | 本文 dict。`turn_offset`（負値=末尾起点）/`turn_limit`。`include_annotations=true` で注記+`[No.X]`。**adult はデフォルトで原文非返却**（`include_raw=true` で原文）。`redact=true` で承認済み伏せ字版（v3.69）。`[assistant]` ラベルは個体名に置換（v3.80） |
| `conversation_share` | `{token, url, expires_at}`。24h 共有 URL 発行（v3.23） |
| `conversation_digest` | `{digest, uuid, cached, chunks, model}`。ローカル LLM でダイジェスト生成。`force=true` でキャッシュ無視再生成。`safe_mode=true` で昇華スタイル変換（v3.71〜）。チャンク結合生成（v3.53） |
| `log_annotate` | 追記した注記（seq は 1 始まり連番）。編集・削除 API なし |
| `inbox_check` | `{count, ids, non_persistent_unread_count, non_persistent_unread_ids, persistent[]（本文込み）}`。`limit/days/from_model/to_model` フィルタ |
| `inbox_read` | メッセージ dict（既読化）。`peek=true` は既読化しない（v3.60）。persistent は常に既読化されない |
| `inbox_post` | 作成メッセージ dict。`from_model`/`to_model` は文字列→配列正規化 |
| `inbox_update` | 部分更新後の dict（未指定フィールド維持） |
| `inbox_delete` | 物理削除 |
| `batch_run_summary_layers` | `status_only=true` → `{running,total,processed,errors,skipped,raw_pending,keywords_pending}` |
| `batch_run_rating` | `status_only=true` → `{running,total,processed,errors,skipped,pending,index_counts,skip_reasons,error_uuids}`。`force=true` で auto 再判定（manual は不変）。判定不能ログは `rating_skip_reason` 付きで恒久スキップ（v3.68/v3.70） |
| `album_*` / `file_*` | REST と同じメタデータ形状。`album_read` は MCP image content。`album_save` は `rating`/`guard_message` 受付（v3.77）。`album_read`/`album_list` は adult デフォルト除外（`include_adult` で表示・v3.77） |
| `attendance_view` | `individual` 指定時 `{individual,last_seen,days_since,count,others_in_period,period,total,rows[]}` / 省略時 `{individual:"all",individuals{},period,total,rows[]}`。rows は日付降順・`kind`（conversation/inbox/memory/checkin）＋実ログ参照（uuid/inbox_id/memory_id）付き（v3.71） |
| `sublimate` | `{sublimated,rating,rating_reason,chunks,attempts,needs_human,model,uuid?}`。`text`/`uuid` どちらか必須（両方は `{error}`・exclusive）。LLM 到達不能時は `{error:"sublimation failed: ..."}`（v3.71） |
| `oplog_list` | `{total, rows:[{timestamp, operation, target_id}]}`。降順（新しい順）。`operation`/`date_from`/`date_to`/`limit`（既定50・最大500）でフィルタ（v3.88） |

## 6. インポート（v3.60 の契約を含む）

| メソッド | パス | 契約 |
|---|---|---|
| POST | `/import` | claude.ai エクスポート ZIP。`{imported, skipped, conversations_saved, artifacts_extracted, source_threads_linked}` |
| POST | `/api/import/claude-code` | `.jsonl` 単体 / `.zip`。`{imported, skipped, errors, conversations_saved, source_threads_linked}` |
| POST | `/api/import/openwebui` | OpenWebUI チャットエクスポート `.json`。`{imported, skipped, errors, conversations_saved, source_threads_linked}`（v3.66） |

**重複チェック（v3.60 根本修正）:**
- 同一会話の再インポートは skip（ExtMemory エントリを増殖させない）
- 判定は `imported_uuids.json` **と** 既存エントリの `source_thread` 集合の OR。
  **imported_uuids.json が消えていても重複しない**（テスト `test_zip_reimport_dedup_survives_missing_import_log` で固定）
- `overwrite=true` は重複チェックをスキップして再作成する（通常運用では使わない）

**source_thread 自動紐づけ（v3.60）:**
- インポート会話の本文から `memory_id: <ID>` を走査 → 該当エントリの空 `source_thread` に会話UUIDを設定
- 補助: エントリ created_at が**ちょうど1つ**の会話の時間範囲に収まる場合のみ紐づけ
- 既存の source_thread は**上書きしない**
- 会話保存（`_save_conversations`）はメッセージ数を比較し多い方を残す（v3.77）。rating 系メタは既存ファイルから引き継ぐ

**TS 実装（TS-FULL ステップ3・`ts/src/rest-import.ts`）での main.py との差（意図的）:**
- `/api/import/compare`・`/api/import/unsloth`・`/api/import-status`・`/api/conversations/index/rebuild`・`/cleanup-empty`・`PATCH /<uuid>/title`・`/api/conv-artifacts*` も TS が応答する
- 壊れた ZIP・JSON は 500 ではなく 400
- `conversations.json` は1件ずつ流して処理する（数百 MB でも1本の文字列にしない）。先に全体を検証し、壊れていれば何も書かない
- uuid にパス区切り・`..`・NUL を含む会話と、パスとして不正なアーティファクト名は保存しない（main.py はそのままパスに使っていた）
- インポートで作るエントリの ID（時刻_番号_uuid 先頭8文字）が既存ファイルとぶつかったら `_2` `_3` … を付ける（main.py は同じ秒の別インポートで上書きしていた。`test_import_entry_ids_do_not_overwrite`）
- source_thread を紐づけたときも `index.json` を作り直す（main.py は imported > 0 のときだけ）
- `index/rebuild` は `{uuid}_digest*.json`・`{uuid}_redacted.json` のキャッシュを会話として数えない

**TS 実装（TS-FULL ステップ4・`ts/src/rest-admin.ts`）での main.py との差（意図的）:**
- 会話・アルバムの共有トークンを `GET /api/share/<token>` に渡すと 404（main.py は 500）
- REST の CoreMem 保存・削除（`POST/DELETE /api/coremem/<name>`）も oplog に `coremem_save` / `coremem_delete` を残す（main.py は MCP 経由のときだけ）
- `limit` などの整数パラメータが数字でなければ 400（main.py は 500）
- ステップ4で直した TS 側の遅れ: REST `hsearch` の `author` / `search_layer`（v3.81）、`index.json` の `body_length` をコードポイント数に（絵文字を 2 と数えていた）、REST の CoreMem 保存の manifest ガード（409・v3.96）

**TS 実装（TS-FULL ステップ5・`ts/src/rest-media.ts`）での main.py との差（意図的）:**
- `POST /api/album/upload` で上げた画像の `original_filename` は実際のファイル名（main.py は一時ファイル名 `_upload_tmp_…` になっていた）
- `POST /api/uploads` は同じ秒に同じ名前のファイルを上げても上書きしない（ID に `_2` `_3` … を付ける）
- 画像として読めないファイルのエラー文言は画像ライブラリ（Pillow / sharp）ごとに違う（どちらも 400）
- `/api/album`（末尾スラッシュなし）も一覧として応答する（main.py は `/api/album/` へリダイレクト）

**TS 単体化（v4.0・TS-FULL ステップ8）での main.py との差（意図的）:**
- どのルートにも当たらないパスは JSON の 404 `{"error": "not found"}`（Flask は HTML の 404 ページ）
- 起動時処理（基本ディレクトリの作成・旧形式アップロードメタの退避・新規環境の CoreMem シードと welcome inbox）は同じ契約（`tests/test_startup.py`）。スケルトンの置き場所は `ts/skeleton/coremem/<lang>/`（`MIO_SKELETON_DIR` で差し替え可）

## 7. その他 REST

| グループ | パス | 契約の要点 |
|---|---|---|
| conversations | `/api/conversations/*` | 検索（`q`/`from`/`to`/`limit`/`body_search`・updated_at 降順）/ index（`search`/`limit`≤500/`offset`・`{total,offset,limit,items}`）/ rebuild（`{rebuilt, model_backfilled, titles_improved, titles_default, titles_no_auto, participants_filled}`＋該当時 `debug_no_auto`。改善タイトル・participants は会話JSONへ書き戻す。v3.97〜v3.99）/ `<uuid>` 取得（404）/ annotations（空なら `[]`）/ share POST（`{token,url,expires_at}`・`expires_in` 指定可）/ view GET（認証不要・不正 404・期限切れ 410）/ rating PATCH（safe/mature/adult 以外は 400・`rating_skip_reason` クリア）/ rebuild は rating 系メタ（reason/source/skip_reason）を保全（v3.70） |
| coremem | `/api/coremem*` | 一覧 `[{name,version,updated_at}]` / POST `{content}`→201 `{name,version,version_str}`（版番号は連番）/ `?version=N` で旧版 / DELETE は全版削除 `{deleted}`（対象なし 404）/ manifest マージ返却。`?raw=true` で素通し |
| inbox | `/api/inbox*` | GET一覧 / POST（`expires_at`/`ttl_days` 期間常駐・persistent と排他 400・期限切れはチェック時既読降格, v3.70）/ PATCH read・unread / PATCH 部分更新（`expires_at`/`ttl_days`/`read` 受付, v3.70）/ DELETE |
| album | `/api/album/*` | 一覧（`include_adult` 対応）/ 画像 / upload / PATCH メタ（rating・guard_message 含む）/ DELETE / share（共有画像は認証不要）（v3.77） |
| memory dedup | `POST /api/memory/dedup-scan` | source_thread 重複スキャン＋soft-delete。`dry_run=true` でプレビュー（v3.77） |
| uploads | `/api/uploads/*` | 一覧 / ダウンロード / POST（201・タグはカンマ・読点・空白区切り）/ DELETE（404 if missing） |
| batch | `/api/batch/status` `/api/batch/start` | 要約バッチ: 状態 dict / バックグラウンド起動 |
| rating-batch | `/api/rating-batch/status` `/api/rating-batch/start` | レーティング判定バッチ: 状態 dict（`pending`=次回対象件数・`index_counts` 分布・`skip_reasons`・`error_uuids`, v3.70）/ バックグラウンド起動（v3.68） |
| redact | `/api/conversations/<uuid>/redact` `redacted` `redact/approve` `redact/reject` `redact-status` | 伏せ字ログ: 生成・取得・承認・差し戻し・ステータス一覧（v3.69） |
| attendance | `GET /api/attendance` | 出席簿: `?individual=&date_from=&date_to=&limit=`（MCP attendance_view と同一ロジック, v3.74） |
| oplog | `GET /api/oplog` | 操作ログ全件。`DELETE /api/oplog/<index>` で個別削除（v3.82） |
| conv-artifacts | `GET /api/conv-artifacts` | 会話から抽出したファイル一覧。`GET /api/conv-artifacts/<uuid>/<filename>` でダウンロード |
| projects | `GET /api/projects` | プロジェクト一覧（v3.90） |
| oauth-resource | `GET /.well-known/oauth-protected-resource` | OAuth 保護リソースメタデータ |
| conversations-cleanup | `POST /api/conversations/cleanup-empty` | 空会話ログの一括非表示（`dry_run` 対応, v3.79） |
| import-status | `/api/import-status` | 最終ZIPインポート記録 |
| friends | `/api/friends*` `/register` `/activate` | 友達システム（登録・承認・取り消し・削除・直接登録・招待文・公開ページ。`tests/test_friends_rest.py`。メール送信は SendGrid 未設定の経路のみ） |

## 8. 既知の未カバー領域（v3.62 時点。その後の追補を併記）

- ~~友達システム（登録→承認→アクティベーション→friend MCP セッション）~~ → REST と公開ページは `tests/test_friends_rest.py`（TS-FULL ステップ6）、friend MCP セッションは `tests/test_llm_native.py`（リング5）。SendGrid の実送信は未カバー
- ~~`conversation_digest` / 要約バッチの実生成（ローカルLLM 依存のため status 系のみ固定）~~ → テスト内のモック LLM（`MockLLM`）で生成まで固定（リング5・伏せ字は TS-FULL ステップ7）
- ~~`album_save(url=...)` の外部ダウンロード・HTML画像抽出~~ → モック LLM の静的配信で固定（リング5）
- ~~レガシー `/mcp/sse` / `/mcp/messages`~~ → TS-FULL ステップ1 で廃止（404。`test_legacy_sse_endpoints_removed`）

**v3.62 で追補済み**（tests/test_oauth_mcp_transport.py・12件）: OAuth フルフロー
（register→authorize→token→発行トークンで REST/MCP。PKCE S256 検証・不正 verifier/
password/grant の拒否）、MCP トランスポート（initialize の Mcp-Session-Id ヘッダ発行・
Accept: text/event-stream の SSE 応答・DELETE・GET 405・parse error・バッチ・認証 401）。
※ v3.62 で main.py の initialize が `Mcp-Session-Id` ヘッダ未発行＋`_session_id`
内部キー漏れだったバグを修正（§3 の記載どおりの挙動になった）。

**リング3で追補済み**（tests/test_coremem_rest.py・7件 / tests/test_conversations_rest.py・8件）:
coremem REST（保存 201・版番号連番・版指定読み・一覧形状・content なし 400・404・全版削除・認証）、
conversations REST（検索フィルタ・body_search・index ページング・rebuild・取得・注記一覧・
share/view（期限切れ 410 含む）・認証）。
