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
- 外部記憶への書き込み（`memory_write`、`artifacts_save`）
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
| core.md 初版作成・保存 | chat（artifacts_save） |
| talk-and-build.md 下書き | chat → このファイル |
| talk-and-build.md コミット | Code（次のステップ） |

---

## ポイント

- **chatは揮発する。Codeは残る。** — chatで決めた重要なことは記憶か git に残す。
- **記憶は橋渡し。** — chatでmemory_writeしておくと、Codeが次のセッションで読める。
- **core.md が起動ファイル。** — 新しいセッション（chatでもCodeでも）は `artifacts_read("core.md")` から始まる。
- **Claude Code は淳さんの承認のもとで動く。** — chatが「これをやって」と提案し、淳さんが判断、Codeが実行。

---

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `CLAUDE.md` | Claude Code 向けリポジトリ案内 |
| `docs/design.md` | 機能設計仕様 |
| `docs/setup.md` | NAS→GitHub→WS セットアップ手順 |
| `docs/talk-and-build.md` | このファイル |
