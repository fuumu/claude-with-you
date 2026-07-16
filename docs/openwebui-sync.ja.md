# OpenWebUI 会話ログ同期 設計書

ステータス: **Phase 1 部分実装**（v3.66 でエクスポートファイルからの手動インポートを実装。API ポーリングによる自動同期は未実装）

## 1. 概要

OpenWebUI のチャット履歴を mio-memory の会話ログストア（`/data/conversations/`）に取り込み、
既存の Claude.ai エクスポートログと統合して `conversation_search` / `conversation_read` / `conversation_digest` で横断検索・閲覧できるようにする。

## 2. 背景

- Claude.ai の会話ログは ZIP エクスポート → `POST /import` でインポートしている
- LMStudio + OpenWebUI でローカル LLM チャット環境を構築予定
- ローカル LLM の会話も同じ外部記憶に蓄積して検索・ダイジェスト化したい
- Claude.ai ログと OpenWebUI ログは同じ `/data/conversations/` に混在させ、source で識別する

## 3. アーキテクチャ

```
[OpenWebUI]
    │
    │ GET /api/v1/chats  (Bearer token)
    │
    ▼
[mio-memory: _openwebui_sync()]
    │
    │ 1. チャット一覧取得
    │ 2. UUID 重複チェック（imported_uuids + conversations/）
    │ 3. フォーマット変換（OpenWebUI → mio-memory conversations 形式）
    │ 4. /data/conversations/{id}.json に保存
    │ 5. _index.json 更新
    │ 6. ExtMemory エントリ作成（tags: ["会話ログ", "openwebui", "raw"]）
    │
    ▼
[/data/conversations/]  ← Claude.ai ログと混在
```

## 4. OpenWebUI チャットデータ構造

### API エンドポイント

```
GET /api/v1/chats
Authorization: Bearer <OPENWEBUI_API_KEY>

レスポンス: [
  {
    "id": "uuid-string",
    "title": "会話タイトル",
    "chat": {
      "messages": [...],           // フラット配列
      "history": {
        "messages": { ... },       // ID→メッセージのマップ（ツリー構造）
        "currentId": "..."
      }
    },
    "models": ["model-name"],
    "tags": [...],
    "created_at": 1234567890,      // Unix timestamp
    "updated_at": 1234567890
  },
  ...
]
```

### メッセージ構造

```json
{
  "id": "msg-uuid",
  "role": "user" | "assistant",
  "content": "テキスト内容",
  "parentId": "parent-msg-uuid" | null,
  "childrenIds": ["child-msg-uuid", ...],
  "model": "model-name",
  "modelName": "表示名",
  "timestamp": 1234567890,
  "done": true
}
```

## 5. フォーマット変換

### OpenWebUI → mio-memory conversations 変換

OpenWebUI のメッセージはツリー構造（parentId / childrenIds）で管理されている。
mio-memory の `conversation_read` は `chat_messages` 配列を期待する。

変換処理:
1. `chat.history.messages` からルートメッセージ（parentId == null）を探す
2. childrenIds を辿ってフラット配列に展開（深さ優先）
3. 各メッセージを `chat_messages` 形式に変換:

```python
{
    "uuid": owui_chat["id"],
    "name": owui_chat["title"],
    "source": "openwebui",           # ← 識別用フィールド（新規追加）
    "model": owui_chat.get("models", [None])[0],
    "created_at": iso_from_unix(owui_chat["created_at"]),
    "updated_at": iso_from_unix(owui_chat["updated_at"]),
    "chat_messages": [
        {
            "sender": msg["role"],     # "user" | "assistant"
            "content": msg["content"], # テキスト or リスト
            "model": msg.get("model"),
            "timestamp": msg.get("timestamp"),
        }
        for msg in flattened_messages
    ]
}
```

### ExtMemory エントリ

ZIP インポートと同様に、各会話に対応する ExtMemory エントリも作成:

```python
{
    "id": f"{ts}_{i:04d}_{uid[:8]}",
    "title": f"[会話/OWUI] {title}",
    "body": "",
    "tags": ["会話ログ", "openwebui", "raw"],
    "source_thread": uid,
    "importance": "low",
    "author": "openwebui",
}
```

タグに `openwebui` を付与することで、Claude.ai 由来のログ（`会話ログ` タグのみ）と区別可能。

## 6. 同期方式

### 定期ポーリング（夜間バッチ方式）

既存の `_nightly_batch_loop` と同じパターンで、デーモンスレッドが毎日指定時刻に同期を実行。

```python
def _openwebui_sync_loop():
    while True:
        hour_s = os.environ.get('MIO_OPENWEBUI_SYNC_HOUR', 'off')
        if hour_s in ('', 'off', 'none'):
            time.sleep(3600)
            continue
        # 指定時刻まで sleep → _run_openwebui_sync() 実行
```

### 手動実行

REST エンドポイントと MCP ツールで手動同期も可能:

- `POST /api/openwebui/sync` — 即時同期（管理者のみ）
- MCP ツール追加は見送り（頻度が低いため REST で十分）

### 重複チェック

- OpenWebUI のチャット ID をキーに、`/data/conversations/` に既存ファイルがあればスキップ
- `imported_uuids.json` にも追加（ZIP インポートとの一貫性）
- `updated_at` が変わっている場合は上書き更新（会話の追記に対応）

## 7. 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `MIO_OPENWEBUI_URL` | *(空)* | OpenWebUI の URL（例: `http://openwebui:8080`）。空なら同期無効 |
| `MIO_OPENWEBUI_API_KEY` | *(空)* | OpenWebUI の Admin API キー |
| `MIO_OPENWEBUI_SYNC_HOUR` | `off` | 同期実行時刻（JST, 0-23）。`off` で無効 |

`MIO_OPENWEBUI_URL` が空なら同期関連の処理は一切動かない（既存環境に非接触）。

## 8. 実装計画

### Phase 1: 基盤（最小構成）
- [ ] OpenWebUI API クライアント（チャット一覧取得 + 個別取得）— 未実装（API ポーリング方式）
- [x] フォーマット変換（OpenWebUI → mio-memory conversations 形式）— v3.66 `_convert_openwebui_chat()` で実装。messages 配列 / history.messages ツリー両対応
- [x] `_save_conversations()` への統合（既存関数を再利用）— v3.66 で実装
- [x] `POST /api/import/openwebui` REST エンドポイント — v3.66 で実装（設計書の `POST /api/openwebui/sync` とはパスが異なる。エクスポートファイルのアップロード方式）
- [x] 重複チェック（UUID + imported_uuids）— v3.66 で実装（_existing_source_threads との OR チェック）

### Phase 2: 自動化
- [ ] `_openwebui_sync_loop()` デーモンスレッド — 未実装
- [ ] 環境変数による設定 — 未実装
- [x] admin.html Import タブにインポートUI追加 — v3.66 でドロップゾーン追加（同期ボタンではなくファイルアップロード方式）

### Phase 3: 拡張（必要に応じて）
- [ ] conversation_index の source フィルタ（openwebui / claude 等で絞り込み）
- [ ] logs.html での OpenWebUI ログ表示対応
- [ ] tool_use ブロックの変換（OpenWebUI の tool calling 結果の保持）

## 9. 考慮事項

### OpenWebUI 側の準備
- Admin Settings → API Keys で API キーを発行
- または環境変数 `WEBUI_SECRET_KEY` でシークレットキー設定

### ネットワーク
- 同一 NAS 上の Docker コンテナ間通信なら `http://openwebui:8080`（Docker ネットワーク経由）
- 外部ネットワーク経由なら HTTPS 推奨

### パフォーマンス
- 初回同期は全会話を取得するため時間がかかる可能性
- 2回目以降は `updated_at` 比較でスキップが効く
- OpenWebUI API のページネーション対応が必要な場合あり

### 既存機能への影響
- `/data/conversations/` に保存するため、既存の `conversation_search` / `conversation_read` / `conversation_digest` がそのまま使える
- `source` フィールドを追加するが、既存の読み取りロジックは影響を受けない（未知フィールドは無視される）
- ZIP インポートの重複チェック（`imported_uuids.json`）と共存

## 10. 前提条件

- OpenWebUI がインストール済みで API アクセス可能
- LMStudio が稼働中で OpenWebUI から接続済み
- mio-memory と OpenWebUI が同一 Docker ネットワークにいる（推奨）
