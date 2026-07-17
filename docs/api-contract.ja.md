# API 契約ドキュメント（TS-0）

*対象: mio-memory v3.61 / 作成: 2026-07-13*

このドキュメントは、現行 `memory/app/main.py` が外部に約束している挙動（契約）を固定化するためのもの。
**実行可能な契約は `tests/` の特性テストスイート**であり、本書はその地図にあたる。
TS-1（TypeScript移行）の際は、tests/ が全件グリーンであることが「同じサーバーである」ことの判定基準になる。

## テストスイートの実行方法

```powershell
# 初回のみ: venv 作成と依存導入
python -m venv .venv
.venv/Scripts/python -m pip install flask pytest requests pillow

# 実行（サーバーは一時データディレクトリで自動起動される。既存環境には触れない）
.venv/Scripts/python -m pytest tests/ -q
```

テストは HTTP 越しの**ブラックボックス**で、`main.py` の内部を import しない。
サーバー実装を差し替えても（例: TS版）、`tests/conftest.py` の起動コマンドを変えるだけで同じスイートが使える。

**テスト用フック（運用では未指定＝従来どおり）:**

| 環境変数 | 用途 |
|---|---|
| `MIO_DATA_ROOT` | データルートの差し替え（デフォルト `/data`） |
| `MIO_PORT` | リッスンポート（デフォルト `5002`） |

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
| GET | `/health` | 200 `{status:"ok", version, mcp_tool_count}` 認証不要 |
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
| GET | `/api/export` | CoreMem+ExtMemory の ZIP |
| POST | `/api/import/backup` | export ZIP から復元（multipart `file`・`mode=skip/overwrite`・`dry_run=true`）。応答 `{mode, dry_run, memory{restored,skipped,overwritten}, coremem{...}, conflicts[], errors[]}`。ZIP不正・構造不一致・不正modeは400（v3.63・契約は tests/test_backup_restore.py） |

## 4. MCP トランスポート（`/mcp`）

- `POST /mcp` — JSON-RPC 2.0。単発・バッチ（配列）対応
- id なし（notification）→ **202 Accepted**（本文なし）
- `Accept: text/event-stream` を含むと SSE 形式（`event: message` + `data: <json>`）で返る。含まなければ `application/json`
- `initialize` → `result.serverInfo` / `result.instructions`（CoreMem_read("core.md") の案内を含む）/ `Mcp-Session-Id` ヘッダ発行
- `tools/list` → 通常セッションは **31本**
- `tools/call` → `result.content[0] = {type:"text", text:"<JSON文字列>"}`。画像系は `_mcp_content`（type:"image", base64）
- `ping` → `{}`
- 未知メソッド → JSON-RPC error `-32601`
- 友達トークン（`/mcp?token=<friend_token>`）では別ツールセット（4本）

### 4b. MCP 2026-07-28 ステートレスコア（TS層のみ・`MIO_TS1=1` で検証）

新仕様の契約は `tests/test_mcp_2026.py` に固定（Python 単体モードでは skip — main.py は 2025-11-25 のまま）。デュアル時代サーバーとして、レガシー（initialize + `Mcp-Session-Id`）と同一エンドポイントで共存する。

- モダン判定: `params._meta["io.modelcontextprotocol/protocolVersion"]` または `MCP-Protocol-Version` ヘッダが 2026-07-28（または未知の版）を宣言したリクエスト。セッションIDは発行も参照もしない
- `server/discover`（MUST）→ `result.{resultType, supportedVersions, capabilities, serverInfo, instructions, ttlMs, cacheScope}`。版宣言なしのプローブにも応答
- 必須ヘッダ検証（2026-07-28 宣言時）: `MCP-Protocol-Version` / `Mcp-Method` /（tools/call は）`Mcp-Name` がボディと不一致・欠落 → **400** + error `-32020`（HeaderMismatch）。`Mcp-Name` は `=?base64?...?=` センチネルをデコードして比較
- 未対応の版 → **400** + error `-32022`（`data.supported` / `data.requested` 付き）
- 廃止メソッド（`ping`・`initialize` をモダン宣言で呼ぶ等）→ **404** + `-32601`
- 全結果に `resultType: "complete"`、`tools/list` に `ttlMs` / `cacheScope` を注入（tools/* の中身は従来どおり Python 転送）
- `subscriptions/listen` → SSE（`notifications/subscriptions/acknowledged` + keep-alive コメント）
- OAuth 強化: 認可応答リダイレクトに `iss`（RFC 9207）／DCR で `application_type` 受理（既定 `web`）／`grant_type=refresh_token`（発行・使用ごとローテーション・再利用は `invalid_grant`・`scope` 縮小可）／`/.well-known/oauth-authorization-server/<suffix>` にも応答・`grant_types_supported` に `refresh_token`

## 5. MCP ツール（31本）の返却形状（要点）

引数の詳細は README.ja.md / CoreMem `protocol_guide_detail.md` を参照。ここではテストで固定化した返却形状のみ列挙する。

| ツール | 返却の契約 |
|---|---|
| `memory_read_index` | list → `{data:[{id,title,tags,created_at,importance,keywords?,symbolic?,rating?,local_only?}]}`。`random=N`（1〜5クランプ） |
| `memory_read` | エントリ dict 全文。存在しない id は `{error}` |
| `memory_write` | 作成エントリ dict（`id` 必須確認）。`rating`/`local_only` 受付 |
| `memory_upsert` | 固定 id で上書き/新規。作成 dict |
| `memory_search` | `{results[], total, has_more}`。デフォルト body なし（`summary`+`symbolic`+`match_layer`）。`full_body=true` で body。`include_conversations=true` で `conversations[]`+`conversations_total`（v3.61） |
| `memory_share` | `{token, url(admin.html?token=..&id=..), expires_at}` |
| `CoreMem_save` | `{name, version, version_str}`。`mode="append"` は `<!-- APPEND datetime -->` 区切りで追記 |
| `CoreMem_read` | `{name, version, content}`。manifest があれば `merged:true` + `<!-- BEGIN/END: file -->` 区切り + `manifest` マップ |
| `CoreMem_list` | list → `{data:[{name,version,updated_at}]}`。`__del__` プレフィックス除外 |
| `CoreMem_delete` | `{deleted}` / リネーム時 `{renamed,src,dst}` |
| `conversation_index` | `{total, offset, limit, items[]}` |
| `conversation_search` | list → `{data:[{uuid,title,created_at,updated_at,message_count}]}`。タイトル一致のみ・日付範囲可 |
| `conversation_read` | 本文 dict。`turn_offset`（負値=末尾起点）/`turn_limit`。`include_annotations=true` で注記+`[No.X]`。**adult はデフォルトで原文非返却**（`include_raw=true` で原文） |
| `log_annotate` | 追記した注記（seq は 1 始まり連番）。編集・削除 API なし |
| `inbox_check` | `{count, ids, non_persistent_unread_count, non_persistent_unread_ids, persistent[]（本文込み）}`。`limit/days/from_model/to_model` フィルタ |
| `inbox_read` | メッセージ dict（既読化）。`peek=true` は既読化しない（v3.60）。persistent は常に既読化されない |
| `inbox_post` | 作成メッセージ dict。`from_model`/`to_model` は文字列→配列正規化 |
| `inbox_update` | 部分更新後の dict（未指定フィールド維持） |
| `inbox_delete` | 物理削除 |
| `batch_run_summary_layers` | `status_only=true` → `{running,total,processed,errors,skipped,raw_pending,keywords_pending}` |
| `album_*` / `file_*` | REST と同じメタデータ形状。`album_read` は MCP image content |

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
- 会話保存（`_save_conversations`）は重複チェックと独立に常に実行される（rating 引き継ぎ含む）

## 7. その他 REST

| グループ | パス | 契約の要点 |
|---|---|---|
| conversations | `/api/conversations/*` | 検索（`q`/`from`/`to`/`limit`/`body_search`・updated_at 降順）/ index（`search`/`limit`≤500/`offset`・`{total,offset,limit,items}`）/ rebuild（`{rebuilt}`）/ `<uuid>` 取得（404）/ annotations（空なら `[]`）/ share POST（`{token,url,expires_at}`・`expires_in` 指定可）/ view GET（認証不要・不正 404・期限切れ 410）/ rating PATCH（safe/mature/adult 以外は 400） |
| coremem | `/api/coremem*` | 一覧 `[{name,version,updated_at}]` / POST `{content}`→201 `{name,version,version_str}`（版番号は連番）/ `?version=N` で旧版 / DELETE は全版削除 `{deleted}`（対象なし 404）/ manifest マージ返却。`?raw=true` で素通し |
| inbox | `/api/inbox*` | GET一覧 / POST / PATCH read・unread / PATCH 部分更新 / DELETE |
| album | `/api/album/*` | 一覧 / 画像 / upload / PATCH メタ / DELETE / share（共有画像は認証不要） |
| uploads | `/api/uploads/*` | 一覧 / ダウンロード / POST（201・タグはカンマ・読点・空白区切り）/ DELETE（404 if missing） |
| batch | `/api/batch/status` `/api/batch/start` | 要約バッチ: 状態 dict / バックグラウンド起動 |
| rating-batch | `/api/rating-batch/status` `/api/rating-batch/start` | レーティング判定バッチ: 状態 dict / バックグラウンド起動（v3.68） |
| redact | `/api/conversations/<uuid>/redact` `redacted` `redact/approve` `redact/reject` `redact-status` | 伏せ字ログ: 生成・取得・承認・差し戻し・ステータス一覧（v3.69） |
| import-status | `/api/import-status` | 最終ZIPインポート記録 |
| friends | `/api/friends*` `/register` `/activate` | 友達システム（テストは未カバー・SendGrid 依存） |

## 8. 既知の未カバー領域（v3.62 時点）

- 友達システム（登録→承認→アクティベーション→friend MCP セッション）
- `conversation_digest` / 要約バッチの実生成（ローカルLLM 依存のため status 系のみ固定）
- `album_save(url=...)` の外部ダウンロード・HTML画像抽出
- レガシー `/mcp/sse` / `/mcp/messages`

これらは TS-1 実施前に必要に応じて追加する。

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
