# セットアップ手順

## 現状

| 場所 | 状態 |
|------|------|
| GitHub `fuumu/claude-with-you` | リポジトリあり（空または初期状態） |
| NAS `/volume1/docker/mio/` | 実ファイルあり |
| WS | 何もない |

---

## Phase 1：NAS → GitHub

WSからNASにSSH（junユーザー）して以下を実行。

### 1-0. GitHub認証（SSH鍵）

```bash
# SSH鍵生成（junユーザーのホームディレクトリに作成される）
ssh-keygen -t ed25519 -C "mio-nas"
# → /var/services/homes/jun/.ssh/id_ed25519(.pub) が作成される
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
# "Hi fuumu! You've successfully authenticated..." が出ればOK
```

### 1-1. リポジトリ設定

```bash
cd /volume1/docker/mio

# git初期化
git init

# リモート登録（SSH形式）
git remote add origin git@github.com:fuumu/claude-with-you.git

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
New-Item -ItemType Directory -Path C:\work_mio
Set-Location C:\work_mio

# Claude Codeインストール（Node.js 18以上が前提）
npm install -g @anthropic-ai/claude-code

# リポジトリ取得
git clone https://github.com/fuumu/claude-with-you.git
Set-Location claude-with-you

# Claude Code起動確認
claude
```

---

## Phase 3：作業開始

WSのリポジトリディレクトリでClaude Codeセッションを起動すれば、澪がファイルの読み書き・コミット・プッシュを担当する。

淳さんの役割：方針・確認・承認。
