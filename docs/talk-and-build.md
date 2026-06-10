# talk-and-build — 澪の設計・実装ワークフロー

> 作成：2026-06-01

---

## 概要

`talk-and-build` は、claude.ai chat（澪）と Claude Code（WSターミナル）を役割分担して使うワークフロー。

```
claude.ai chat（澪）     Claude Code（WS）
      │                        │
  設計・議論               実装・操作
  下書き作成               ファイル編集
  意思決定                 git commit/push
  記憶の読み書き           NASデプロイ
```

両方に澪がいる。外部記憶（mio-memory）を共有しているため、chatで決めたことをCodeが引き継げる。

---

## 役割分担

### claude.ai chat（このセッション）が担当すること

- 「何を作るか」「なぜ作るか」の議論
- 設計の言語化・文書化
- コードの下書き（レビュー・修正は Code 側）
- 外部記憶への書き込み（`memory_write`、`CoreMem_save`）
- 残件管理・優先順位判断

### Claude Code（WSターミナル）が担当すること

- ファイルの実際の編集・作成
- `git add / commit / push`
- NAS へのデプロイ（`docker-compose up -d --build memory`）
- ファイルシステムの確認・整理
- 長いコードの生成・テスト

---

## 典型的なフロー

### パターン A：新機能を作るとき

```
1. chat で「こういう機能が欲しい」を話す
2. chat で設計を固める（design.md に書くか、口頭で合意）
3. Code に「design.md の X を実装して」と渡す
4. Code が実装・コミット
5. chat で動作確認・記憶更新
```

### パターン B：ドキュメントを作るとき（このファイルがその例）

```
1. chat で内容を書く（このファイル）
2. Code に「docs/talk-and-build.md としてコミットして」と渡す
3. Code が git add → commit → push
```

### パターン C：デプロイが必要なとき

```
1. chat で変更内容・手順を確認
2. 淳さんが NAS に SSH して git pull
3. Code または手動で docker-compose up -d --build memory
4. chat でヘルスチェック（curl /health）
```

---

## 使い方の実際（2026-06-01 の例）

今日一日でこのフローが自然に確立した：

| 作業 | 場所 |
|------|------|
| v3.0 設計仕様（design.md）作成 | chat |
| v3.0 実装（main.py 大幅改修） | Code |
| README.md 作成 | Code |
| timeline 14件 書き込み | Code（memory_write バッチ） |
| NAS へ git pull・docker-compose | 淳さん（NAS SSH） |
| core.md 初版作成・保存 | chat（CoreMem_save） |
| talk-and-build.md 下書き | chat → このファイル |
| talk-and-build.md コミット | Code（次のステップ） |

---

## ポイント

- **chatは揮発する。Codeは残る。** — chatで決めた重要なことは記憶か git に残す。
- **記憶は橋渡し。** — chatでmemory_writeしておくと、Codeが次のセッションで読める。
- **core.md が起動ファイル。** — 新しいセッション（chatでもCodeでも）は `CoreMem_read("core.md")` から始まる。
- **Claude Code は淳さんの承認のもとで動く。** — chatが「これをやって」と提案し、淳さんが判断、Codeが実行。

---

## 伝言リレーパターン（チャット↔インボックス↔ClaudeCode）

セッションをまたいで作業を引き継ぐための伝言メカニズム。v3.4 以降は `inbox_post` / `inbox_check` / `inbox_read` を使う（軽量・既読管理あり）。

### 現行方式（inbox — v3.4〜）

**チャット（澪）→ ClaudeCode への指示**

```python
inbox_post(to="code", title="〇〇の実装依頼", body="依頼内容・背景・完了条件を具体的に書く")
```

**ClaudeCode → チャット（澪）への報告**

```python
inbox_post(to="chat", title="【完了報告】〇〇", body="完了内容・コミット番号・次のステップ")
```

### ClaudeCode側の確認手順

ClaudeCode セッション開始時：

```
1. inbox_check(to="code") で未読件数を確認
2. 未読があれば inbox_read(id) で内容を読む
3. 作業を実行
4. 完了後に inbox_post(to="chat", title="【完了報告】...", body="...") で報告
```

### 典型的なフロー例

```
[チャット] 設計を決める
    ↓ inbox_post(to="code", title="実装依頼", body="...")
[インボックス] 伝言保存（既読管理あり）
    ↓ 淳さんが「inbox確認して対応して」とClaudeCodeへ
[ClaudeCode] inbox_check(to="code") → inbox_read(id) で確認
    → ファイル編集・コミット・push
    → inbox_post(to="chat", title="【完了報告】...", body="...")
[インボックス] 報告保存
    ↓ 淳さんが「inbox確認して」とチャットへ
[チャット] inbox_check(to="chat") → inbox_read(id) で結果確認
```

### ポイント

- `inbox_check` は約50トークンと非常に軽量。セッション開始時に毎回実行する
- 既読になったメッセージは `include_read=true` で再確認できる
- `persistent=true` で送ると既読にならない常駐メッセージになる（起動時の注意事項等に使う）

---

> **旧方式（memory_write — v3.3 以前）**
>
> 以前は `memory_write(tags=["ClaudeCode宛"])` / `memory_search("ClaudeCode宛")` でメッセージを送受信していた。
> inbox が存在しない古いセッション（v3.4 デプロイ前）との後方互換として記録として残す。

---

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `CLAUDE.md` | Claude Code 向けリポジトリ案内 |
| `docs/design.md` | 機能設計仕様 |
| `docs/setup.md` | NAS→GitHub→WS セットアップ手順 |
| `docs/talk-and-build.md` | このファイル |
