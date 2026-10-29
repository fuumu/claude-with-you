# TS-FULL 準備：Python 側担当機能の棚卸し

*2026-10-29 / v3.99 時点（commit 34e84d1）。調査のみ・コード変更なし。*

> **進捗（2026-10-29）**: 下の「まとめ」の 1（Python 非依存化）と 2（テストハーネス）は `ts-full-step1` で完了。廃止決定: レガシー SSE（削除済み）・旧パス埋め込みトークン API・`/api/memories/symbolic`。移植決定: dedup-scan・cleanup-empty ×2（4 の管理 REST で扱う）。
> **進捗（2026-10-30）**: 3（インポート一式）は `ts-full-step3` で完了 — インポート 6 ルート・`index/rebuild`・`cleanup-empty`（会話）・タイトル変更・`conv-artifacts`。会話 REST の TS 側の遅れ（AND 検索・individual・hidden・oplog）も解消。
> **進捗（2026-10-30）**: 4（管理 REST）は `ts-full-step4` で完了 — 旧検索・dedup-scan・cleanup-empty・oplog・共有トークン・projects・attendance・export/backup。旧パス埋め込みトークン API と symbolic は両サーバーから削除。Python と TS の REST 差分テストで、既に移植済みだったルートの遅れ（hsearch・body_length・manifest ガード）も解消。
> **進捗（2026-10-30）**: 5（album / uploads REST）は `ts-full-step5` で完了。

前提：TS-1 で MCP ツール 38/38 は TS ネイティブ（`tools.ts` に `FORWARD` を返すハンドラーは残っていない）。
ただし TS 前段（`ts/src/index.ts`）は「担当外のリクエストは全部 Python へ透過転送」する作りなので、
**MCP ツール以外の REST・HTML・常駐処理の多くはまだ Python が応答している**。

凡例：✅ TS ネイティブ ／ ⚠️ 一部 or Python に依存 ／ ❌ Python のみ

---

## 1. main.py のエンドポイント

### 1-1. TS 前段そのものが Python に依存している箇所（TS-only 化で最初に壊れる）

| 機能 | Python 側の現状 | TS 側の対応状況 | TS-only に必要な作業 |
|------|----------------|----------------|---------------------|
| `GET /health` | VERSION・tool数などを返す | ⚠️ `index.ts` が **Python の /health を取得してキャッシュ**し `served_by: ts` を足して返す。Python が落ちていると 503 | VERSION 定数を TS に持たせ、/health を自前で組み立てる |
| `server_version`（全ツール応答） | `VERSION` 定数 | ⚠️ `mcp.ts upstreamVersion()` が Python /health から取得 | 同上（TS 側に VERSION を置く） |
| ツール定義（tools/list） | `_MCP_TOOLS`（正本） | ⚠️ `tool-defs.ts` / `friend-defs.ts` は `scripts/gen_ts_tool_defs.py` が **main.py を ast で読んで生成** | 正本を TS 側に移す（生成スクリプト廃止 or TS→TS） |
| MCP の未知メソッド | `_process_mcp_message` | ⚠️ `initialize`/`ping`/notifications/`tools/*` 以外（resources/list 等）は Python へ転送 | TS で -32601 等を返す |
| `/mcp/sse`・`/mcp/messages`（レガシー SSE） | 実装あり | ❌ 透過転送 | 廃止 or 移植（現 Claude.ai は `/mcp` のみ使用） |
| 友達セッション以外の `/mcp` | — | ✅ | — |
| `/mcp` 友達セッション | `_handle_friend_tool_call` | ✅ `friend.ts`（initialize 注入・6 ツール） | — |

### 1-2. REST（移植済み）

| ルート | TS |
|--------|----|
| `GET /api/memory/index` `/tags` `/hsearch` `/<id>` | ✅ |
| `POST /api/memory` ・ `POST /api/memory/reindex` ・ `PATCH/DELETE /api/memory/<id>` | ✅ |
| `/api/inbox` 全部（GET/POST、`<id>` の GET/PATCH/DELETE、`/read` `/unread` `/persistent`） | ✅（【生】昇華パイプライン含む） |
| `/api/coremem` 全部（list / GET / POST / DELETE、`target`） | ✅ |
| `GET /api/conversations/`（検索）・`/index`・`/<uuid>`・`/<uuid>/annotations`・`GET /api/conversations/view`（共有・認証不要）・`POST /share/<uuid>`・`PATCH /<uuid>/rating` | ✅ |
| `POST /api/conversations/<uuid>/digest` ・ `/api/batch/status|start` ・ `/api/rating-batch/status|start` ・ `/api/llm-status` | ✅（`rest-llm.ts`） |
| OAuth：`/.well-known/oauth-authorization-server`・`/oauth-protected-resource`・`/oauth/register`・`/oauth/authorize`（GET/POST）・`/oauth/token` | ✅ |

### 1-3. REST（未移植＝Python のみ）

| 機能 | ルート | 利用元 | TS-only に必要な作業 |
|------|--------|--------|---------------------|
| **会話インポート** | `POST /import`（ZIP）・`/api/import/claude-code`・`/api/import/openwebui`・`/api/import/unsloth`・`/api/import/compare`・`GET /api/import-status` | admin.html Import タブ、**テストの fixture 多数** | 4 形式のコンバーター＋取り込み処理（`_save_conversations`・`_link_source_threads`・タイトル自動改善・`extract_artifacts`・完了時バッチ自動起動）。**最大の塊**（main.py 3427〜4660 行付近 約1200行） |
| 会話インデックス再構築 | `POST /api/conversations/index/rebuild` | admin.html | model/participants バックフィル・タイトル改善・JSON 書き戻し |
| 会話タイトル変更 | `PATCH /api/conversations/<uuid>/title` | admin.html | 会話 JSON・_index・ExtMemory の 3 か所更新 |
| 空ログ掃除 | `POST /api/conversations/cleanup-empty`・`POST /api/memory/cleanup-empty` | admin.html（手動運用） | 移植 or 廃止判断 |
| 伏せ字（redact） | `POST /<uuid>/redact`・`GET /<uuid>/redacted`・`/redact/approve`・`/redact/reject`・`GET /api/conversations/redact-status` | admin.html Redact タブ | LLM 生成（`_generate_redacted`）＋承認フロー。※`conversation_read` の「承認済み伏せ字を返す」側は TS 済み |
| 会話抽出ファイル | `GET /api/conv-artifacts`・`/api/conv-artifacts/<uuid>/<file>` | admin.html・logs.html | 一覧・配信（抽出自体はインポート時） |
| バックアップ | `GET /api/export`（ZIP）・`POST /api/import/backup`（dry_run/mode） | admin.html | ZIP 生成・展開（Node に zip ライブラリが要る） |
| 旧キーワード検索 | `GET /api/memory/search` | **admin.html・logs.html が使用中** | 移植 or 画面側を `hsearch` に寄せる |
| symbolic 一覧 | `GET /api/memories/symbolic` | 不明（外部スクリプト？） | 利用確認の上で移植 or 廃止 |
| 重複スキャン | `POST /api/memory/dedup-scan` | 手動運用 | 同上 |
| パス埋め込みトークン（旧） | `/api/<token>/memory/index` `/search` `/<id>` `POST /api/<token>/memory` | 旧クライアント | 廃止判断（要淳さん確認） |
| oplog | `GET /api/oplog`・`DELETE /api/oplog/<i>` | admin.html | 単純。※MCP `oplog_list` は TS 済み |
| 共有トークン | `POST /api/share-token`・`POST /api/memory/share/<id>`・`GET /api/share/<token>`（認証不要） | admin.html | 単純。※MCP `memory_share` は TS 済み（同じ share_tokens.json） |
| プロジェクト一覧 | `GET /api/projects` | admin.html | 単純。※MCP `project_list` は TS 済み |
| 出席簿 | `GET /api/attendance` | admin.html | 薄いラッパー。※`attendance-view.ts` 済み |
| アルバム REST | `GET /api/album/`・`GET /<id>`・`POST /upload`・`PATCH /<id>`・`DELETE /<id>`・`POST /<id>/share`・`GET /shared/<token>`（認証不要） | admin.html Album タブ | upload のリサイズは `album-save.ts`（sharp）を流用可。multipart 受信が要る |
| アップロード REST | `GET/POST /api/uploads`・`GET/DELETE /api/uploads/<id>` | admin.html Uploads タブ | multipart 受信・ダウンロード配信 |
| 友達 REST | `POST /api/friends/register`・`GET /api/friends`・`/approve`・`/send_email`（SendGrid）・`/direct_register`・`/revoke`・`DELETE /<seq>`・`GET /invitation`・`POST /activate` | admin.html・register.html・activate.html | 登録〜承認〜メール送信（SENDGRID_*）。※友達 MCP セッションは TS 済み |

## 2. Admin 画面（HTML）のサーブと API 依存

| ページ | サーブ | 叩いている API（未移植のもの） |
|--------|--------|-------------------------------|
| `admin.html` | ❌ Python（`/admin.html`） | import 系全部・export/backup・redact-status・index/rebuild・album/uploads/friends・oplog・share-token・`/api/share/`・projects・attendance・conv-artifacts・**`/api/memory/search`** |
| `logs.html` | ❌ Python | **`/api/memory/search`**・conv-artifacts（他は TS 済み） |
| `share.html` | ❌ Python | なし（`/api/conversations/view` は TS 済み） |
| `register.html`・`activate.html` | ❌ Python | `/api/friends/register`・`/invitation`・`/activate` |

→ TS-only 化には **静的ファイル配信**（5 ページ。`memory/app/*.html` を TS イメージに同梱）＋上表の API が必要。

## 3. バッチ処理の Python 依存度

| 処理 | Python 側 | TS 側 | TS-only に必要な作業 |
|------|----------|-------|---------------------|
| 要約レイヤー（2/3/4層） | `_run_summary_batch` | ✅ `llm-tasks.ts`（MCP・REST とも） | — |
| レーティング | `_run_rating_batch` | ✅ | — |
| conversation_digest 生成 | ✅ | ✅ | — |
| sublimate／inbox【生】自動昇華 | ✅ | ✅ | — |
| **夜間バッチスケジューラ** | `_nightly_batch_loop`（起動時スレッド、`MIO_NIGHTLY_BATCH_HOUR`/`_BACKEND`） | ❌ なし | TS に毎日 N 時起動のタイマーを実装 |
| **インポート完了時のバッチ自動起動** | ✅（`MIO_IMPORT_AUTO_BATCH`） | ❌（インポート自体が未移植） | インポート移植と一緒に |
| 伏せ字生成 | `_generate_redacted` | ❌ | 1-3 の redact と同じ |
| 外部スクリプト | `scripts/generate_summary_layers.py`（REST 経由・サーバー外で実行） | — | REST 経由なので TS-only でも動く見込み。Python 残置で可 |

⚠️ **現状の注意（並走期間の既知リスク）**：バッチ状態は各プロセスのメモリにある。TS 前段運用中は MCP/REST からの起動は TS、夜間とインポート完了時の自動起動は Python で走るので、**同じバッチが二重に動きうる**（ts1-migration.ja.md Ring 5 の注記どおり）。

## 4. LLM 関連の分担

| 機能 | Python | TS |
|------|--------|----|
| LLM クライアント（`LLM_ENDPOINTS` 探索・OK モデル選択・LM Studio ロード/アンロード・anthropic バックエンド） | `_lm_client` 他 | ✅ `llm.ts`（同一ロジック、Anthropic Messages 互換） |
| `llm_status`（MCP・REST） | ✅ | ✅（ただし LLM ログバッファは**プロセスごと**。夜間バッチを Python が回している間、その記録は TS の llm_status に出ない） |
| REST-LLM（`rest-llm.ts`） | — | ✅ digest / batch / rating-batch / llm-status |
| 伏せ字生成 | ✅ | ❌ |

→ LLM 系で残るのは **伏せ字生成と夜間スケジューラだけ**。

## 5. テストスイート

全テストが **ブラックボックス HTTP**（main.py を import しない）。`conftest.py` は常に `main.py` を起動し、`MIO_TS1=1` のときだけ TS 前段を前に置く。

| 区分 | 該当 | TS-only での扱い |
|------|------|-----------------|
| ハーネス | `conftest.py`（Python 起動が必須） | **TS 単体起動モードを追加**（upstream なし）。MockLLM はそのまま使える |
| Python 前提の照合 | `test_mcp_core.py::test_ts_tool_defs_snapshot_matches_python`（main.py の `_MCP_TOOLS` と照合） | 正本を TS に移したら削除 or 書き換え |
| TS 専用 | `test_mcp_2026.py`（17）・`test_ts_native_complete.py`（2）— `MIO_TS1=1` 時のみ | そのまま |
| **未移植 API を fixture／検証に使う** | `POST /import`：test_attendance_sublimate / test_conversation_tools / test_conversations_rest / test_import_conversations / test_llm_native / test_mcp_core / test_rating_visibility。`/api/import/*`・`/api/export`：test_backup_restore / test_import_conversations / test_uploads_album_misc。`index/rebuild`：test_conversations_rest / test_rating_visibility。redact：test_conversation_tools / test_conversations_rest。`/api/album`・`/api/uploads`：test_ring4_misc_tools / test_uploads_album_misc。`/api/oplog`：test_attendance_sublimate / test_llm_native。`/api/attendance`：test_attendance_sublimate。`/api/share/`・`admin.html`：test_mcp_core / test_inbox_rest。`dedup`：test_import_conversations | インポートを先に移植するか、fixture をデータ直書きに変える。**インポートが会話系テストの土台になっているので、ここが最優先** |
| 上記以外 | test_coremem / test_coremem_rest / test_inbox / test_inbox_rest（admin.html 以外）/ test_inbox_ttl / test_health_auth / test_oauth_mcp_transport / test_path_traversal 等 | TS 単体でも通る見込み（ハーネス対応のみ） |

テスト件数（参考）：計 約 236 件（`def test_` の数）。

## 6. その他 Python にしかないもの

| 機能 | Python 側 | TS-only に必要な作業 |
|------|----------|---------------------|
| 起動時シード | `_seed_coremem_if_empty`（`memory/skeleton/coremem`、`MIO_SEED_LANG`）・`_seed_welcome_inbox`（`MIO_SEED_WELCOME`） | 新規インストール時のみ効く。TS に移植（skeleton を TS イメージへ同梱） |
| uploads 旧メタ移行 | 起動時 `_uploads_migrate_all` | TS は `file_list` 等の前に `migrateAllMeta()` 済み。起動時版は不要の見込み |
| アクセスログ | `_log_mcp_access`（クライアント分類・`MIO_LOG_LEVEL`） | TS 側は LLM ログのみ。必要なら移植 |
| 友達承認メール | SendGrid（`SENDGRID_API_KEY`/`_FROM_EMAIL`）、`MIO_REGISTER_URL` | 友達 REST と一緒に |
| Docker | `docker-compose.yml` は **Python（memory）のみ**。TS は `docker-compose.parallel.yml` / 手順書（ts-switchover）で前段化 | TS-only 用 compose を作り、`memory` サービスを Node イメージに差し替え。`./scripts` マウントの要否確認 |
| Python 依存パッケージ | flask / anthropic / Pillow（`memory/wheels` 同梱） | 退避ブランチ側へ |

---

## まとめ：TS-only 化の作業の塊（発注の切り方の提案）

1. **Python 非依存化（小）**：/health と server_version を TS 自前に・ツール定義の正本を TS へ・未知 MCP メソッドの応答・レガシー SSE の扱い決め。**これだけで「Python が落ちても MCP は完全に動く」状態になる**
2. **テストハーネス**：conftest に TS 単体モード
3. **インポート一式（大）**：ZIP / Claude Code / OpenWebUI / Unsloth / compare / import-status ＋ index/rebuild・title・conv-artifacts・完了時バッチ起動
4. **管理 REST（中・単純が多い）**：oplog・share-token・`/api/share/`・projects・attendance・`/api/memory/search`・symbolic・dedup・cleanup-empty×2・export/backup
5. **バイナリ系 REST（中）**：album REST・uploads REST（multipart）
6. **友達 REST＋メール（中）**、HTML 5 ページの静的配信
7. **夜間スケジューラ・伏せ字生成（中・LLM）**
8. **起動時シード**、compose 差し替え、Python を退避ブランチへ

要確認（淳さん）：旧パス埋め込みトークン API・レガシー SSE・`/api/memories/symbolic`・dedup-scan・cleanup-empty を「移植」か「廃止」か。
