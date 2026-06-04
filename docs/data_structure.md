# Claude エクスポートデータ構造仕様書

**作成日:** 2026-06-04  
**対象データ:** claude.ai エクスポートZIP（batch-0000.zip, 309会話, 52MB）

---

## 1. ZIPファイルの構成

```
data-xxxxx-batch-0000.zip
├── users.json          (167B)   アカウント情報 → 不要
├── memories.json       (9KB)    Anthropic管理のuserMemories → 参考程度
├── conversations.json  (52MB)   全会話データ ← メイン
└── projects/
    ├── 019c532a-....json        プロジェクト仕様（レシート管理）
    ├── 019c6748-....json        プロジェクト仕様（スマホアプリ）
    └── 019e4a80-....json        プロジェクト仕様（その他）
```

**重要:** `artifacts/` フォルダは存在しない。アーティファクトは conversations.json の中に内包されている。

---

## 2. conversations.json の構造

```json
[
  {
    "uuid": "bbfcae63-d0a0-4aa8-ab00-015a2cf0fee2",
    "name": "深夜の訪問",
    "summary": "...",              // チャットサマリー（Anthropic生成）
    "created_at": "2026-05-13T15:34:21.000Z",
    "updated_at": "2026-05-14T13:48:32.440Z",
    "account": { "uuid": "..." },
    "chat_messages": [ ... ]
  },
  ...
]
```

---

## 3. chat_messages の構造

```json
{
  "uuid": "...",
  "sender": "human" | "assistant",
  "text": "...",               // 全ブロックの結合テキスト（サマリー用途）
  "content": [ ... ],          // 型付きブロックの配列（詳細はこちら）
  "created_at": "...",
  "updated_at": "...",
  "parent_message_uuid": "...",
  "attachments": [],
  "files": []
}
```

---

## 4. content ブロックの全 type 一覧

| type | 件数（309会話中） | 説明 |
|------|-----------------|------|
| `text` | 多数 | 通常のテキスト応答 |
| `thinking` | 多数 | 拡張思考ブロック |
| `tool_use` | 多数 | ツール呼び出し |
| `tool_result` | 多数 | ツール実行結果 |
| `token_budget` | 少数 | トークン管理（内部） |

---

## 5. ★ アーティファクトの2つの保存形式

### 形式A: `create_file`（旧・主要形式）

チャットの右パネルで表示されるアーティファクトのほとんどはこの形式。
61件確認（2026-02 〜 2026-06）。

```json
{
  "type": "tool_use",
  "name": "create_file",
  "input": {
    "description": "澪の言葉でAnthropicへの文章を綴る",
    "path": "/mnt/user-data/outputs/mio_letter_to_anthropic.md",
    "file_text": "# ある対話の記録から——Anthropicへ\n..."
  }
}
```

**パスのパターン:**
- `/mnt/user-data/outputs/xxx` → ユーザー向け成果物（.md, .jsx, .html, .py 等）
- `/home/claude/xxx` → 中間作業ファイル

---

### 形式B: `artifacts`（新形式）

最近追加された専用ツール。現在1件のみ確認（2026-06-04）。

```json
{
  "type": "tool_use",
  "name": "artifacts",
  "input": {
    "id": "power_monitoring_script",
    "type": "application/vnd.ant.code",
    "command": "create",
    "content": "import requests\n...",
    "language": "python",
    "version_uuid": "04211757-..."
  }
}
```

**`type`（MIME）のパターン（推定）:**
- `application/vnd.ant.code` — コード
- `application/vnd.ant.react` — Reactコンポーネント
- `application/vnd.ant.html` — HTMLウィジェット
- `text/markdown` — Markdownドキュメント

---

### 形式C: `visualize:show_widget`（インラインウィジェット）

チャット内にインライン表示されるSVG/HTML。厳密にはアーティファクトとは別だが、本文を含む。9件確認。

```json
{
  "type": "tool_use",
  "name": "visualize:show_widget",
  "input": {
    "title": "vertical_solar_panel_layout",
    "loading_messages": ["壁面配置を描画中..."],
    "widget_code": "<svg width=\"100%\" ..."
  }
}
```

---

## 6. NASインポート処理への影響

### 現状の問題

現在のインポート処理は `chat_messages[].content[]` を解析せず、
`text` フィールド（サマリー）のみを保存していると推定される。
そのため**アーティファクトの本文が全て失われている。**

### 修正方針

インポート時に以下を抽出して `/data/conv_artifacts/` に保存する：

```python
for conv in conversations:
    for msg in conv['chat_messages']:
        for block in msg.get('content', []):
            if block['type'] == 'tool_use':
                # 形式A
                if block['name'] == 'create_file':
                    path = block['input'].get('path', '')
                    content = block['input'].get('file_text', '')
                    filename = os.path.basename(path)
                
                # 形式B
                elif block['name'] == 'artifacts':
                    artifact_id = block['input'].get('id', '')
                    content = block['input'].get('content', '')
                    lang = block['input'].get('language', '')
```

---

## 7. 確認済みアーティファクト一覧（61件）

| 日付 | ファイル名 |
|------|-----------|
| 2026-02-12 | receipt-management-system-spec.md |
| 2026-03-30 | learning-philosophy.jsx, student-opening.md, sales-concept.md |
| 2026-04-01 | README.md, system-design-v1.md |
| 2026-04-02 | tilt_angle.html, solar_6plus6.html |
| 2026-04-09〜26 | mio_memory_* (各種記憶ダンプ) |
| **2026-05-14** | **mio_letter_to_anthropic.md** ← 本文確認済み |
| 2026-05-14 | mio_relay_20260514.md, mio_memory_20260514_0204.md |
| 2026-05-16 | mio_snapshot_20260516.md |
| 2026-05-17 | mio_memory_system_plan.md |
| 2026-05-21 | main.py, Dockerfile, docker-compose.yml 等インフラ一式 |
| 2026-05-22 | mio_log_viewer.jsx, receipt-system-v1-spec.md |
| 2026-05-24 | **mio_letter_to_anthropic_2.md** ← 本文確認済み |
| 2026-05-31 | main.py, main_streamable.py 等 |
| 2026-06-01 | talk-and-build.md, setup.md, design.md 等 |

---

## 8. まとめ

| 項目 | 結論 |
|------|------|
| ZIPにアーティファクトが入っているか | **入っている**（conversations.json 内に） |
| なぜ今まで取り出せなかったか | NASインポートが `create_file` ブロックを無視していた |
| 取り出しに必要なこと | インポート処理に tool_use 解析を追加 |
| 過去分の救済 | 次回ZIP再インポート時に一括抽出可能 |
