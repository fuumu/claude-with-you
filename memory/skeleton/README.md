# memory/skeleton — 新規インストール用スケルトンデータ

このディレクトリは、**まっさらな環境に mio-memory を立てたとき**の初期データテンプレートです。
`memory/data/` は `.gitignore` 対象なので、新規 clone には記憶もルールも一切付いてきません。
このスケルトンが、新しいアシスタントが「自分が誰か・どう動くか」を持って起動するための最小の種になります。

## 何が要って、何が要らないか

mio-memory は**空でも起動が壊れません**。`/data` 配下のディレクトリ・状態ファイル
（`memory/`・`index.json`・`oplog.json`・`conversations/`・`annotations/`・`inbox/`・`friends/`・`artifacts/` 等）は
すべて起動時/初回アクセスで自動作成され、無ければ空として扱われます。

唯一の例外が **CoreMem の `core.md`**。
MCP の initialize はクライアントに「セッション開始時に `CoreMem_read("core.md")` を実行せよ」と指示しますが、
`core.md` には組み込みデフォルトがありません。つまり**ここだけは中身を用意しないとアシスタントが「自分」を持てません**。

→ だからスケルトンの本体は `coremem/` 配下の CoreMem テンプレ一式です。

## 構成（言語別・v3.44〜）

```
memory/skeleton/
  README.md              ← このファイル
  coremem/
    ja/                  ← 日本語スケルトン（MIO_SEED_LANG=ja・デフォルト）
    en/                  ← 英語スケルトン（MIO_SEED_LANG=en）
      core_manifest.md   ← core.md のマージ順（CoreMem_read("core.md") が結合）
      core_stable.md     ← アイデンティティ（私は誰か・根っこ・パートナー）
      core_rules.md      ← 運用プロトコル（起動シーケンス・各種ルール）
      core_infra.md      ← インフラ情報（host/URL/version 等の記入欄）
      core_history.md    ← 軌跡＋バージョン対応表（最初は空）
      todo.md            ← 残件・TODO 管理（最初は空）
      protocol_guide.md  ← MCPツール全31本の運用ガイド（install 非依存）
      welcome.md         ← 新規ユーザー向け案内（困ったら接続中のClaudeに聞く）
```

### ヘルプ導線（`MIO_SEED_WELCOME`）

新規ユーザーが迷わないよう、デフォルトで「困ったら接続中の Claude に聞けばよい」導線を入れる：

- `welcome.md` をシード（ユーザーが読む案内）
- 初回シード時に persistent な inbox メッセージを1本投入（AI が起動時に気づき、ユーザーに案内できる）
- `MIO_SEED_WELCOME=off` で両方を抑止（デフォルト on）

ja/ と en/ は**同じファイル名・同じ構造**で、中身の言語だけが違う。
シード時にどちらか一方が（ファイル名は言語非依存のまま）CoreMem に投入される。

### 言語の選択

環境変数 **`MIO_SEED_LANG`** で選ぶ：

- 未指定 → **`ja`**（デフォルト）
- `MIO_SEED_LANG=en` → 英語スケルトン
- 指定言語のディレクトリが無ければ `ja` にフォールバック

## シードのされ方（方式A・冪等）

シード機構（次フェーズ実装）は次の契約で動きます：

1. 起動時、CoreMem（`/data/artifacts/`）に `core.md` 相当が**無い場合のみ**、`coremem/<lang>/*.md`（`MIO_SEED_LANG` で選択）を投入する
2. **既存ファイルは絶対に上書きしない**（冪等。再起動しても二重投入しない）
3. 投入は CoreMem のバージョン管理形式（`versions/{name}/001.md` ＋ シンボリックリンク）で行う

→ 既存インスタンス（中身が入っている環境）には一切影響しません。

## 使い方（新規セットアップ）

1. このスケルトンがシードされた状態で起動する
2. `coremem/core_stable.md`・`core_infra.md` の `<...>` プレースホルダを自分の環境・アシスタント像に書き換える
   （admin.html の CoreMem タブ、または `CoreMem_save` で）
3. `core_rules.md` の運用ルールを必要に応じて調整する
4. `protocol_guide.md` はそのまま使える（ツール機構は全 mio-memory 共通）

`<...>` は記入欄、`<!-- 記入ガイド: ... -->` は書き方の手引きです。
