# TS-1: TypeScript 移行計画（ストラングラー方式）

*作成: 2026-07-13 / リング0〜3・トランスポート前倒し（リング4/5の一部）・MCP 2026-07-28 RC先行実装済み*

## 方針

main.py（Flask・単一ファイル）を一括書き換えせず、**TypeScript のリバースプロキシを
前段に置き、エンドポイントを1つずつ TS 側へ移す**（ストラングラーパターン）。

- **合格判定は常に TS-0 特性テストスイート**（`tests/`・53件）。
  `MIO_TS1=1 pytest tests/` が全パスする限り「同一サーバー」とみなす
- 移行の各段階で本番投入可能（プロキシは透過なので、移行済みエンドポイントが
  0本でも53本でも外部挙動は同じ）
- 途中で中止しても損失なし（プロキシを外せば Python 単体運用に即戻る）

## 現状（リング0〜3＋トランスポート前倒し・2026-07-14 時点）

```
クライアント → [ts/ TypeScript サーバー] → [memory/app/main.py (Flask)]
                 ├ /health                          … TS ネイティブ
                 ├ GET /api/memory/{index,tags,hsearch,<id>} … TS ネイティブ
                 ├ POST /api/memory                 … TS ネイティブ（作成・ID採番）
                 ├ PATCH/DELETE /api/memory/<id>    … TS ネイティブ（部分更新・論理削除）
                 ├ POST /api/memory/reindex         … TS ネイティブ（index.json 再構築）
                 ├ /api/inbox*（一覧/投稿/既読/更新/削除） … TS ネイティブ
                 ├ /api/coremem*（一覧/保存/版指定読み/マージ/削除） … TS ネイティブ
                 ├ /api/conversations*（検索/index/rebuild/取得/注記/
                 │    share/view/rating）           … TS ネイティブ（digest のみ転送）
                 ├ /.well-known/oauth-*             … TS ネイティブ
                 ├ /oauth/{register,authorize,token} … TS ネイティブ（PKCE・DCR）
                 ├ /mcp トランスポート層             … TS ネイティブ（デュアル時代:
                 │    レガシー = initialize/ping/notifications/SSE/セッション、
                 │    モダン = MCP 2026-07-28 ステートレスコア（server/discover・
                 │    subscriptions/listen・必須ヘッダ検証・resultType/ttlMs注入）。
                 │    tools/* は JSON-RPC のまま Python へ転送。友達セッションは丸ごと透過）
                 └ その他すべて                      … Python へ透過転送
                       ※ TS 検証済みトークンは API_TOKEN に書き換えて転送
                         （TS 発行 OAuth トークンが未移行エンドポイントでも通る）
```

- `ts/src/` — index.ts（ルーター＋プロキシ）/ auth.ts（Bearer・?token=・oauth_store.json）/
  data.ts（/data/ JSON 読み取り層）/ write.ts（作成・更新・削除・oplog・index再構築）/
  search.ts（階層検索・_hierarchical_search 互換）/
  oauth.ts（OAuth 2.1+DCR・oauth_store.json 互換永続化）/ mcp.ts（MCPトランスポート層）/
  inbox.ts / coremem.ts（symlink 版管理・コピーフォールバック互換）/
  conversations.ts（会話 REST・share_tokens.json 互換）
- 依存ゼロ（node:http のみ）。SSE・チャンク対応
- `MIO_TS1=1 pytest tests/` で二段構成起動 → **100件全パス確認済み**（直接モードは85件パス＋
  15件skip — MCP 2026-07-28 特性テストは TS 層のみの実装のため Python 単体では skip）
- ビルド: `cd ts && npm install && npx tsc` → `node dist/index.js`
- 環境変数: `MIO_PORT` / `MIO_UPSTREAM_HOST` / `MIO_UPSTREAM_PORT` / `MIO_DATA_ROOT` /
  `MIO_API_TOKEN` / `MIO_BASE_URL` / `MIO_ALLOWED_ORIGINS`

**リング2で得た知見**: Windows ローカルでは Python のテキストモード書き込みが
`\n` → `\r\n` 変換するため、index.json 等が CRLF になる（本番 Linux は LF）。
TS は常に LF（本番互換）。実機検証で「TS 再構築と Python 再構築の index.json は
改行正規化後にバイト一致」を確認済み — 本番では正規化不要で完全一致する。
oplog（create/update/delete・diff.before/after・author）も形式互換を確認済み。

**リング1で得た知見**: main.py は `encoding` 指定なしの `open()` が多く、Linux（本番）では
utf-8、Windows ローカルでは cp932 になる。テストは `PYTHONUTF8=1` で本番と同条件に固定した。
TS 実装は utf-8 固定（本番互換）。

## リング計画（各リング＝1コミット・テスト全パスが完了条件）

| リング | 対象 | 判断ポイント |
|---|---|---|
| 0 | プロキシ骨格＋/health | ✅ 完了（2026-07-13） |
| 1 | 認証ミドルウェア＋読み取り系REST（index/read/tags/hsearch） | ✅ 完了（2026-07-13）— auth.ts / data.ts / search.ts。統合検索含む。Werkzeugヘッダ有無でネイティブ/プロキシ振り分けを実機検証済み |
| 4/5前倒し | **MCPトランスポート層＋OAuth/DCR**（mcp.ts / oauth.ts） | ✅ 完了（2026-07-14）— MCP 2026-07-28 破壊的仕様（initialize廃止・ステートレス化・OAuth強化）の7/28公開確定を受け前倒し。tools/* ディスパッチは Python 転送のまま（リング4本体で移行）。新仕様対応時は ts/ のみ改修 |
| 新仕様RC | **MCP 2026-07-28 RC先行実装**（mcp.ts / oauth.ts 改修） | ✅ 完了（2026-07-14）— デュアル時代サーバー（レガシー initialize と モダン ステートレスコアの同一エンドポイント共存・仕様の era 判別ルールどおり）。server/discover・subscriptions/listen・必須ヘッダ検証（-32020/-32022/-32601）・resultType/ttlMs/cacheScope 注入・OAuth強化（iss/application_type/refresh_token/RFC 8414 suffix）。特性テスト15件追補（TS1モードのみ実行）→ TS1 100件全パス。7/28正式版とのRC差分確認が残タスク |
| 2 | 書き込み系REST（create/patch/delete/reindex） | ✅ 完了（2026-07-14）— write.ts。ID採番（JST・タグslug）・oplog・index再構築とも Python 互換を実機検証（改行正規化後バイト一致）。テスト構成では REST 書き込み=TS・MCP 経由の書き込み=Python（転送先）が共存するが、両者同一アルゴリズムのため index/oplog は収束する |
| 3 | inbox / coremem / conversations REST | ✅ 完了（2026-07-14）— inbox.ts / coremem.ts / conversations.ts。REST特性テスト20件追補（inbox 5・coremem 7・conversations 8）。symlink 版管理は TS も symlink→コピーのフォールバックで互換、版番号は実装間で連番継続を実機確認。会話 _index.json は TS 再構築と Python 再構築がバイト完全一致。share トークン・rating ゲートも相互運用検証済み。digest（要ローカルLLM）のみリング5まで Python 転送 |
| 4 | MCP tools/list・tools/call の TS ネイティブ化 | ツール実装は内部で REST 相当関数を呼ぶ構造に（トランスポート層は前倒し済み） |
| 5 | インポート・バッチ・友達システム・conversation digest | バッチ・digest は要 LLM クライアント（Anthropic SDK / fetch）。友達セッションの /mcp 透過も此処で解消 |
| 6 | Python 撤去・Dockerfile を Node ベースへ | 特性テスト＋本番並行稼働期間を経て判断 |

## 設計上の約束

- **データ形式は変えない** — `/data/` 配下の JSON ファイル・ディレクトリ構造は
  Python 版と完全互換を保つ（どちらの実装でも読み書きできる状態を維持）
- リングをまたぐ間、移行済みエンドポイントは TS が応答し、未移行は Python へ転送
- 各エンドポイント移行時、必要ならまず特性テストを追補してから移す
  （テストが薄い箇所は docs/api-contract.ja.md §8 参照）
- 依存は最小主義（リング4まで外部依存なしを目標。以降も要吟味）

## 未決事項（淳さんと相談）

- リング1着手のタイミング（TS-0/リング0 は判断材料の提供まで）
- 本番での前段プロキシ投入時期（リング2〜3 あたりが目安か）
- Node ランタイムの NAS Docker イメージ選定
