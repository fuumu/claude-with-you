# セットアップ手順

**[English version](setup.md)** ← 日本語版（このファイル）が正。英語版はここから同期。

## 現状

| 場所 | 状態 |
|------|------|
| GitHub `<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>` | リポジトリあり（空または初期状態） |
| NAS `<YOUR_NAS_PATH>` | 実ファイルあり |
| WS | 何もない |

---

## Phase 1：NAS → GitHub

WSからNASにSSH（`<YOUR_NAS_USER>` ユーザー）して以下を実行。

### 1-0. GitHub認証（SSH鍵）

```bash
# SSH鍵生成（NASユーザーのホームディレクトリに作成される）
ssh-keygen -t ed25519 -C "mio-nas"
# → <YOUR_NAS_HOME>/.ssh/id_ed25519(.pub) が作成される
# プロンプトは3回Enterのみ（保存先・パスフレーズ・確認）

# Synologyはパーミッションが広すぎるので修正（必須）
chmod 600 ~/.ssh/id_ed25519
chmod 700 ~/.ssh

# 公開鍵を表示
cat ~/.ssh/id_ed25519.pub
```

↑ターミナルに表示された文字列をコピーして、**同じWSのブラウザ**でGitHubに登録。  
Settings → SSH and GPG keys → New SSH key → 貼り付けて保存。  
（ファイル転送不要——ターミナルとブラウザが同じ画面にある）

```bash
# 接続確認
ssh -T git@github.com
# "Hi <YOUR_GITHUB_USERNAME>! You've successfully authenticated..." が出ればOK
```

### 1-1. リポジトリ設定

```bash
cd <YOUR_NAS_PATH>

# git初期化
git init

# リモート登録（SSH形式）
git remote add origin git@github.com:<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git

# .gitignore作成
cat > .gitignore << 'EOF'
.env
memory/data/
__pycache__/
*.pyc
EOF

# ステージング・コミット
git add .
git commit -m "initial commit: mio-memory MCP server"

# プッシュ
# GitHubに初期コミットがある場合
git pull origin main --allow-unrelated-histories
git push origin main

# GitHubが空の場合
# git push -u origin main
```

---

## Phase 2：WS準備

PowerShellで実行。

### 2-0. GitHub認証（GitHub CLI）

```powershell
# GitHub CLIインストール
winget install GitHub.cli
# wingetがない場合は https://cli.github.com からインストーラーをDL

# 認証（ブラウザが開くのでGitHubアカウントでログイン）
gh auth login
```

### 2-1. 開発環境セットアップ

```powershell
# 作業フォルダ作成
New-Item -ItemType Directory -Path <YOUR_LOCAL_PATH>
Set-Location <YOUR_LOCAL_PATH>

# Claude Codeインストール（Node.js 18以上が前提）
npm install -g @anthropic-ai/claude-code

# リポジトリ取得
git clone https://github.com/<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git
Set-Location <YOUR_REPO_NAME>

# Claude Code起動確認
claude
```

---

## Phase 3：作業開始

WSのリポジトリディレクトリでClaude Codeセッションを起動すれば、Claude Codeがファイルの読み書き・コミット・プッシュを担当する。

あなたの役割：方針・確認・承認。

---

## Phase 4：NASへのデプロイ（コード更新時）

WSからNASにSSHして以下を実行。

```bash
cd <YOUR_NAS_PATH>

git pull origin main

sudo docker-compose up -d --build memory
```

ヘルスチェック：

```bash
curl <YOUR_SERVER_URL>/health
# {"status": "ok", "version": "3.x", ...} が返ればOK
```

> **注意：** NASでは `docker-compose` に `sudo` が必要。`git pull` は `origin main` を明示する（upstream未設定のため）。

---

## 新規インストール時の初期化（CoreMem スケルトン）

`memory/data/` は `.gitignore` 対象のため、まっさらな環境には記憶もルールも付いてこない。
mio-memory は**空でも起動するが**、アシスタントの「自分は誰か」を定義する CoreMem `core.md` だけは
中身が無いと意味をなさない（MCP initialize が起動時に `CoreMem_read("core.md")` を指示するため）。

これを埋めるのが **`memory/skeleton/`**（リポジトリに同梱・v3.43〜）。

### 自動シードの挙動（冪等・既存環境は不変）

初回起動時、`_seed_coremem_if_empty()` が次の契約で動く：

1. CoreMem に `core_stable.md` が**無い新規環境のときだけ** `skeleton/coremem/*.md` を投入する
2. 同名ファイルが既にあればスキップ（**冪等**。再起動で二重投入しない）
3. `core_stable.md` がある既存環境では**一切何もしない**（運用中のデータを保護）

投入されるファイル：`core_manifest.md` / `core_stable.md` / `core_rules.md` / `core_infra.md` /
`core_history.md` / `todo.md` / `protocol_guide.md` / `welcome.md`

### ヘルプ導線（`MIO_SEED_WELCOME`、デフォルト on）

新規ユーザーが迷わないよう、初回シード時に「困ったら接続中の Claude に使い方を聞けばよい」導線を入れる：

- `welcome.md`（ユーザー向け案内）をシード
- 常駐 inbox メッセージを1本投入（AI が起動時に気づき、ユーザーに案内できる）
- 案内が不要なら `.env` で `MIO_SEED_WELCOME=off`

### シード言語（`MIO_SEED_LANG`）

スケルトンは日英2言語（`skeleton/coremem/ja/`・`en/`）。投入する言語は環境変数で選ぶ：

- 未指定 → **`ja`**（デフォルト）
- `MIO_SEED_LANG=en` → 英語スケルトン
- 指定言語が無ければ `ja` にフォールバック

英語話者の新規環境では `.env` に `MIO_SEED_LANG=en` を設定してから初回起動する。

### セットアップ後の記入

1. `core_stable.md`（アイデンティティ）・`core_infra.md`（host/URL/version）の `<...>` を自分の環境に書き換える
   - admin.html の CoreMem タブ、または MCP `CoreMem_save` で編集
2. `core_rules.md` の運用ルールを必要に応じて調整
3. `protocol_guide.md`（MCPツール全31本ガイド）はそのまま使える（install 非依存）

> スケルトンの中身・方針の詳細は `memory/skeleton/README.md` を参照。

---

## お友達システム セットアップ

### SendGrid 設定

お友達システムの承認メール送信に SendGrid を使用する。

**1. SendGrid アカウント設定**

1. [sendgrid.com](https://sendgrid.com) でアカウントを作成（無料プランで十分）
2. Settings → API Keys → Create API Key
3. Permissions: **Mail Send** のみで OK
4. 生成されたキーをコピー（一度しか表示されない）

**2. 送信元メールアドレスの認証**

1. Settings → Sender Authentication → Single Sender Verification
2. 送信元として使うメールアドレスを登録・確認

**3. .env に設定**

```env
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxx
SENDGRID_FROM_EMAIL=mio@your-domain.com
MIO_REGISTER_URL=https://your-domain.com
```

`MIO_REGISTER_URL` は承認メール内アクティベーションリンクのベース URL（末尾にパスを付けない——`/activate` が自動付与される）。省略可（省略時は `MIO_BASE_URL` を使用）。

**注意:** `SENDGRID_API_KEY` が未設定の場合、承認メールは送信されない。アクティベーションコードは admin.html の Friends タブで手動確認できる。

---

## LMStudio セットアップ（WSで実行）

`generate_summary_layers.py` を `--backend lmstudio` で使う場合の準備。

### 1. Anthropic互換エンドポイントを有効化

1. LMStudio を起動
2. 左サイドバーの **Developer** タブ（`</>`アイコン）を開く
3. **Server** を `Running` にする
4. **Anthropic-compatible** が有効になっていることを確認（チェックボックスまたはトグル）
5. ポート番号が `1234` になっていることを確認

### 2. Windowsファイアウォールでポート1234を開放

管理者権限のPowerShellで実行：

```powershell
netsh advfirewall firewall add rule name="LMStudio" dir=in action=allow protocol=TCP localport=1234
```

### 3. NASから接続確認

NASにSSHして疎通テスト：

```bash
curl http://<YOUR_WS_IP>:1234/v1/models
# LMStudioが応答すればOK
```

---

## Dockerビルド時のDNS問題（Synology NAS固有）

### 症状

`python:3.11-slim` イメージのビルド中に `pip install` がDNS解決失敗で止まる：

```
pip install anthropic
...
socket.gaierror: [Errno -3] Temporary failure in name resolution
```

### 原因

Synology NASのDockerビルド環境はデフォルトのDNSが機能しない場合がある。

### 解決策

`docker-compose.yml` の `build:` セクションに `network: host` を追加すると、ビルド時にホストのDNS（インターネット疎通あり）を使うようになる：

```yaml
services:
  memory:
    build:
      context: ./memory
      network: host    ← これを追加
```

---

## network_mode: host 使用時の注意点

コンテナからWSのLMStudio（`<YOUR_WS_IP>:1234`）に接続するため、`network_mode: host` を設定している。

### 注意：`ports:` と `dns:` は不要

`network_mode: host` 使用時は `ports:` と `dns:` の設定が無視される（警告が出る場合もある）ため、**削除すること**：

```yaml
services:
  memory:
    network_mode: host
    # ports: は削除（network_mode: host では無効）
    # dns: は削除（ホストのDNSを使うため不要）
    volumes:
      - ./memory/data:/data
      - ./scripts:/app/scripts:ro
```
