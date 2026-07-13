# TS-1: TypeScript 移行計画（ストラングラー方式）

*作成: 2026-07-13 / リング0・リング1・トランスポート前倒し（リング4/5の一部）実装済み*

## 方針

main.py（Flask・単一ファイル）を一括書き換えせず、**TypeScript のリバースプロキシを
前段に置き、エンドポイントを1つずつ TS 側へ移す**（ストラングラーパターン）。

- **合格判定は常に TS-0 特性テストスイート**（`tests/`・53件）。
  `MIO_TS1=1 pytest tests/` が全パスする限り「同一サーバー」とみなす
- 移行の各段階で本番投入可能（プロキシは透過なので、移行済みエンドポイントが
  0本でも53本でも外部挙動は同じ）
- 途中で中止しても損失なし（プロキシを外せば Python 単体運用に即戻る）

## 現状（リング0＋リング1＋トランスポート前倒し・2026-07-14 時点）

```
クライアント → [ts/ TypeScript サーバー] → [memory/app/main.py (Flask)]
                 ├ /health                          … TS ネイティブ
                 ├ GET /api/memory/index            … TS ネイティブ
                 ├ GET /api/memory/tags             … TS ネイティブ
                 ├ GET /api/memory/hsearch          … TS ネイティブ（統合検索含む）
                 ├ GET /api/memory/<id>             … TS ネイティブ
                 ├ /.well-known/oauth-*             … TS ネイティブ
                 ├ /oauth/{register,authorize,token} … TS ネイティブ（PKCE・DCR）
                 ├ /mcp トランスポート層             … TS ネイティブ（initialize/ping/
                 │    notifications/SSE/セッション/Origin検証。tools/* は JSON-RPC の
                 │    まま Python へ転送。友達セッションは丸ごと透過）
                 └ その他すべて                      … Python へ透過転送
                       ※ TS 検証済みトークンは API_TOKEN に書き換えて転送
                         （TS 発行 OAuth トークンが未移行エンドポイントでも通る）
```

- `ts/src/` — index.ts（ルーター＋プロキシ）/ auth.ts（Bearer・?token=・oauth_store.json）/
  data.ts（/data/ JSON 読み取り層）/ search.ts（階層検索・_hierarchical_search 互換）/
  oauth.ts（OAuth 2.1+DCR・oauth_store.json 互換永続化）/ mcp.ts（MCPトランスポート層）
- 依存ゼロ（node:http のみ）。SSE・チャンク対応
- `MIO_TS1=1 pytest tests/` で二段構成起動 → **65件全パス確認済み**（直接モードも全パス）
- ビルド: `cd ts && npm install && npx tsc` → `node dist/index.js`
- 環境変数: `MIO_PORT` / `MIO_UPSTREAM_HOST` / `MIO_UPSTREAM_PORT` / `MIO_DATA_ROOT` /
  `MIO_API_TOKEN` / `MIO_BASE_URL` / `MIO_ALLOWED_ORIGINS`

**リング1で得た知見**: main.py は `encoding` 指定なしの `open()` が多く、Linux（本番）では
utf-8、Windows ローカルでは cp932 になる。テストは `PYTHONUTF8=1` で本番と同条件に固定した。
TS 実装は utf-8 固定（本番互換）。

## リング計画（各リング＝1コミット・テスト全パスが完了条件）

| リング | 対象 | 判断ポイント |
|---|---|---|
| 0 | プロキシ骨格＋/health | ✅ 完了（2026-07-13） |
| 1 | 認証ミドルウェア＋読み取り系REST（index/read/tags/hsearch） | ✅ 完了（2026-07-13）— auth.ts / data.ts / search.ts。統合検索含む。Werkzeugヘッダ有無でネイティブ/プロキシ振り分けを実機検証済み |
| 4/5前倒し | **MCPトランスポート層＋OAuth/DCR**（mcp.ts / oauth.ts） | ✅ 完了（2026-07-14）— MCP 2026-07-28 破壊的仕様（initialize廃止・ステートレス化・OAuth強化）の7/28公開確定を受け前倒し。tools/* ディスパッチは Python 転送のまま（リング4本体で移行）。新仕様対応時は ts/ のみ改修 |
| 2 | 書き込み系REST（write/upsert/patch/delete/reindex） | oplog・index再構築の互換。**Python と同時書き込みしない**排他方針（oauth_store.json は TS 側書き込み＋プロキシ時トークン書き換えで解決済み — 同パターンが使えるか要検討） |
| 3 | inbox / coremem / conversations REST | symlink 版管理の互換 |
| 4 | MCP tools/list・tools/call の TS ネイティブ化 | ツール実装は内部で REST 相当関数を呼ぶ構造に（トランスポート層は前倒し済み） |
| 5 | インポート・バッチ・友達システム | バッチは要 LLM クライアント（Anthropic SDK / fetch）。友達セッションの /mcp 透過も此処で解消 |
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
