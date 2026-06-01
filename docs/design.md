# 設計仕様書：mio-memory MCPサーバー拡張

> 作成：2026-06-01  
> 対象：`/volume1/docker/mio/memory/app/main.py`

---

## 概要

今回のバッチで追加・変更する機能は4つ。  
すべてファイルI/Oに関係するため、1回のデプロイにまとめる。

1. `memory_upsert` ツール（core.md用）
2. アーティファクト管理（`artifacts_save` / `artifacts_read` / `artifacts_list`）
3. 会話ログZIPインポート
4. core.md 運用フロー

---

## 1. memory_upsert

### 目的
固定IDで記憶エントリを上書きする。core.mdの更新に使う。

### ツール定義
```
memory_upsert(id, title, body, tags, importance)
```

### 動作
- 指定IDのエントリが存在する → 削除して新規作成
- 存在しない → 新規作成
- IDは呼び出し側が指定（例：`core_md_current`）

### 実装メモ
既存の `memory_delete(id)` + `memory_write(...)` の組み合わせでも代替可能。  
upsertとして1ツールにまとめると呼び出しが1回で済む。

---

## 2. アーティファクト管理

### 目的
スクリプト・設計メモ・core.mdなどをNASに永続保存し、バージョン管理する。

### ディレクトリ構造
```
data/artifacts/
├── core.md          → versions/core_md/003.md   （シンボリックリンク）
├── script_01.sh     → versions/script_01/002.sh
└── versions/
    ├── core_md/
    │   ├── 001.md
    │   ├── 002.md
    │   └── 003.md
    └── script_01/
        ├── 001.sh
        └── 002.sh
```

- トップレベルにシンボリックリンク → 常に最新が見える
- `versions/{name_slug}/` にシーケンス番号で過去バージョンを保持
- name_slug：ファイル名の `.` を `_` に変換（例：`core.md` → `core_md`）

### ツール定義

#### artifacts_save
```
artifacts_save(name, content)
```
1. `versions/{name_slug}/` に次のシーケンス番号でファイル保存
2. トップレベルのシンボリックリンクを新バージョンに張り替え
3. 保存したバージョン番号を返す

#### artifacts_read
```
artifacts_read(name, version=None)
```
- `version` 省略時：シンボリックリンク経由で最新を読む
- `version` 指定時：その番号のファイルを読む

#### artifacts_list
```
artifacts_list()
```
- トップレベルのシンボリックリンク一覧を返す（名前・最新バージョン番号・更新日時）

---

## 3. 会話ログZIPインポート

### 目的
ClaudeのエクスポートZIPをドロップするだけで、会話ログを外部記憶に取り込む。  
プロジェクト外・プロジェクト内どちらのエクスポートにも対応する。

### エンドポイント
```
POST /import
Content-Type: multipart/form-data
```

### 動作
1. ZIPを受け取り、一時ディレクトリに展開
2. `conversations.json`（またはそれ相当のファイル）を検出
3. 各会話をパースし、会話IDで重複チェック
4. 未インポート分のみバッチ書き込み
5. インポート件数・スキップ件数を返す

### 重複チェックキー
会話ID（`conversations.json` の各エントリの `uuid` フィールド）

### admin.html連携
ドラッグ&ドロップUIをadmin.htmlに追加する（別タスク）。

---

## 4. core.md 運用フロー

### 役割
「このファイル1つを読めば、その日の澪になれる」セッション起動用の圧縮記憶。  
userMemoriesの骨格 + 直近の重要な外部記憶を2〜5KBに凝縮したもの。

### 保存場所
`data/artifacts/core.md`（上記アーティファクト管理で保存）  
→ 固定パス、常に最新バージョンが参照される

### 更新タイミング
- `解除` または `/記憶抽出` コマンド時に澪が自動更新

### 起動プロトコル（現行 → 変更後）
| | 現行 | 変更後 |
|---|---|---|
| ツール呼び出し数 | 約8回 | 約3回 |
| 手順 | tool_search → memory_search×N → read_index → memory_read | tool_search → artifacts_read("core.md") |

---

## 実装優先順位

| 優先度 | 機能 | 理由 |
|--------|------|------|
| 高 | memory_upsert | core.md更新に必要 |
| 高 | artifacts_save / artifacts_read | core.md保存に必要 |
| 中 | artifacts_list | あると便利、なくても動く |
| 中 | ZIPインポートバックエンド | admin.html UIと組み合わせて |
| 低 | admin.html ドロップUI | バックエンド後 |
