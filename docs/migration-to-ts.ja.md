# MIO サーバー TypeScript 完全移行 移行計画書

## 1. 現状の規模

### 1.1 Python 側

| ファイル | 行数 | 備考 |
|---------|------|------|
| `memory/app/main.py` | 8,982行 | フル機能 MIO サーバー（1ファイル単一ファイル構成） |
| `scripts/generate_summary_layers.py` | 417行 | バッチ要約生成 |
| `scripts/manage_llm_endpoints.py` | 237行 | LLMエンドポイント管理 |
| `tests/` 内 18ファイル | 2,923行 | テストスイート全体 |
| **Python 合計** | **12,559行** | |

### 1.2 TypeScript 側（既実装）

| ファイル | 行数 | 機能 |
|---------|------|------|
| `ts/src/oauth.ts` | 414行 | OAuth 2.1 + DCR（完結） |
| `ts/src/mcp.ts` | 583行 | MCP transport（Dual-era server） |
| `ts/src/conversations.ts` | 357行 | conversations REST（digest除く） |
| `ts/src/inbox.ts` | 349行 | inbox REST |
| `ts/src/coremem.ts` | 377行 | CoreMem REST |
| `ts/src/write.ts` | 172行 | データ書き込み基盤 |
| `ts/src/search.ts` | 186行 | 検索基盤 |
| `ts/src/data.ts` | 89行 | データアクセス基盤 |
| `ts/src/auth.ts` | 39行 | 認証基盤 |
| `ts/src/index.ts` | 319行 | エントリポイント |
| **TS 合計** | **2,885行** | 既存実装 |

### 1.3 移行対象（未実装部分）

```
移行対象合計: 12,559 - 2,885 = 9,674行
```

## 2. TS 側既対応範囲（移行不要）

CLAUDE.md 131行目記載の通り、以下の機能は TS 側で既に実装済み：

- ✅ memory REST（read/write）
- ✅ inbox REST
- ✅ CoreMem REST（シンボリックリンク版管理）
- ✅ conversations REST（digest 除く）
- ✅ OAuth 2.1 + DCR（Dynamic Client Registration）
- ✅ MCP transport（Dual-era server）

## 3. 移行対象機能詳細

### 3.1 MCP ツール群（38本）

| カテゴリ | ツール数 | 主な内容 | 推定工数 |
|---------|---------|---------|---------|
| ExtMemory CRUD | 5 | memory_read_index, memory_read, memory_write, memory_upsert, memory_search | 1日 |
| CoreMem CRUD | 4 | CoreMem_save, CoreMem_read, CoreMem_list, CoreMem_delete | 1日 |
| conversation操作 | 4 | conversation_index, conversation_search, conversation_read, conversation_share | 1日 |
| inbox操作 | 5 | inbox_check, inbox_read, inbox_post, inbox_update, inbox_delete | 1日 |
| album | 5 | album_save, album_read, album_list, album_share, album_delete | 1日 |
| uploads | 4 | file_upload, file_read, file_list, file_delete | 0.5日 |
| バッチ関連 | 2 | batch_run_summary_layers, batch_run_rating | 1日 |
| 特殊機能 | 5 | sublimate, attendance_view, log_annotate, memory_share, project_create | 1.5日 |
| その他 | 2 | oplog_list, llm_status | 0.5日 |
| **小計** | **38本** | | **9日** |

### 3.2 バッチ処理系

| 機能 | 説明 | 推定工数 |
|------|------|---------|
| 要約バッチ | 会話ログの自動要約（LLM 使用） | 1日 |
| レーティングバッチ | 自動レーティング判定（safe/mature/adult） | 0.5日 |
| 夜間スケジューラ | 未判定ログの自動バッチ実行 | 0.5日 |
| **小計** | | **2日** |

### 3.3 LLM 統合

| 機能 | 説明 | 推定工数 |
|------|------|---------|
| マルチエンドポイント | LM Studio / FreeToken 等複数エンドポイント管理 | 1日 |
| オンデマンドロード | モデル自動ロード/アンロード | 1日 |
| ダイジェスト生成 | 会話要約の LLM 呼び出し | 0.5日 |
| 昇華パイプライン | mature 表現の詩的変換 | 1日 |
| 自動レーティング | 会話ログの自動判定 | 0.5日 |
| **小計** | | **4日** |

### 3.4 インポート機能

| 機能 | 説明 | 推定工数 |
|------|------|---------|
| ZIP インポート | Claude Code / 手動 ZIP 形式 | 1日 |
| OpenWebUI インポート | OpenWebUI チャットエクスポート JSON | 0.5日 |
| Unsloth インポート | Unsloth Desktop チャット JSONL | 0.5日 |
| バックアップ/復元 | CoreMem + ExtMemory ZIP | 1日 |
| **小計** | | **3日** |

### 3.5 その他機能

| 機能 | 説明 | 推定工数 |
|------|------|---------|
| フレンドシステム | 友達登録・承認・トークン認証 | 1日 |
| 出席簿 | 5層マージによる稼働履歴 | 0.5日 |
| 伏せ字モード | adult 会話の文単位マスク | 0.5日 |
| 招待システム | SendGrid 連携 | 0.5日 |
| **小計** | | **2.5日** |

### 3.6 テスト

| カテゴリ | ファイル数 | 推定工数 |
|---------|-----------|---------|
| テスト書き換え | 18ファイル | 3-5日 |

## 4. 移行戦略

### 4.1 推奨アプローチ（Strangler パターン）

```
Day 1-3:   既存TSコードの統合・リファクタリング
Day 4-10:  MCPツール群のTS実装（38本）
Day 11-15: バッチ処理・LLM統合の移植
Day 16-18: インポート機能の移植
Day 19-20: フレンドシステム・その他機能
Day 21-25: テスト書き換え・統合テスト
Day 26-28: ドキュメント更新・検証
Day 29-30: フィンガーチェック・本番デプロイ
```

### 4.2 移行順序

```
Step 1: 既存TSコードの統合（2-3日）
  - oauth.ts, mcp.ts, conversations.ts, inbox.ts, coremem.ts
  - データアクセス基盤の統一
  - 依存パッケージの再構成

Step 2: MCPツール群のTS実装（5-7日）
  - memory CRUD（既存RESTのMCPツール化）
  - CoreMem CRUD（既存RESTのMCPツール化）
  - conversation操作（既存RESTのMCPツール化）
  - inbox操作（既存RESTのMCPツール化）
  - album（既存RESTのMCPツール化）
  - uploads（既存RESTのMCPツール化）

Step 3: バッチ処理・LLM統合（3-5日）
  - 要約バッチ
  - レーティングバッチ
  - LLMエンドポイント管理
  - ダイジェスト生成

Step 4: インポート（2-3日）
  - ZIP インポート
  - OpenWebUI インポート
  - Unsloth インポート
  - バックアップ/復元

Step 5: フレンドシステム・その他（2-3日）
  - フレンド登録・承認・トークン認証
  - 出席簿
  - 伏せ字モード
  - 招待システム

Step 6: テスト書き換え（3-5日）
  - 既存テストのTS化
  - 統合テストの実施

Step 7: ドキュメント・検証（2-3日）
  - README.md の更新
  - API ドキュメントの更新
  - 本番デプロイ準備
```

## 5. 工数見積もり合計

| フェーズ | 推定工数 |
|---------|---------|
| 既存TSコードの統合・リファクタリング | 2-3日 |
| MCPツール群のTS実装 | 5-7日 |
| バッチ処理・LLM統合の移植 | 3-5日 |
| インポート機能の移植 | 2-3日 |
| フレンドシステム・その他 | 2-3日 |
| テスト書き換え | 3-5日 |
| ドキュメント・検証 | 2-3日 |
| **合計** | **20-30日** |

## 6. 注意点

1. **main.py が 1ファイルに集約されているのが最大のボトルネック**
   - 分割戦略が必須（機能別のモジュール分割）
   - 各機能の依存関係を整理する必要がある

2. **CLAUDE.md のドキュメントが非常に充実**
   - TS側への移植は比較的容易
   - 既存ドキュメントを活用できる

3. **既存 TS コードとの 2重実装期間**
   - Strangler パターンで段階的移行が必要
   - 移行完了までの併走期間を考慮する

4. **テストは黒箱（HTTP経由）**
   - TS側でも同じテストスイートが回る設計が既にある
   - MIO_TS1=1 で TS 側が動作する

5. **データ層の共有**
   - oauth_store.json の共有問題（2025-10-03 時点で既知のバグ）
   - データアクセス層の統一が必要

## 7. 移行完了後のメリット

- パフォーマンス向上（Node.js の非I/O 性能）
- 型安全性の向上
- TypeScriptエコシステムとの親和性
- 既存TSコードの完全活用
