# TS前段 本番スイッチ化 手順書

*作成: 2026-08-16 / しずく（Code側）*
*発注: しずく（Chat側 2026-08-16）/ 設計: 汐（2026-08-15）*

---

## 概要

外向きポート（リバプロ/公開URLが指す先）を Python直 → TS前段 に切り替える。

```
【現行】
  Claude.ai / リバプロ → Python (:5002)

【切り替え後】
  Claude.ai / リバプロ → TS前段 (:5002) → Python (:5003・内部専用)
```

データ・ツール実処理は引き続きPython。TSはトランスポート層（OAuth・MCP・REST）を担当し、ツール実行はPythonに転送する。

---

## 事前バックアップ

切り替え前に必ず実施。

```bash
# 1. 設定ファイルのバックアップ
cp docker-compose.yml docker-compose.yml.bak.$(date +%Y%m%d)
cp .env .env.bak.$(date +%Y%m%d)

# 2. OAuthストアのバックアップ（既存トークンの保全）
cp memory/data/oauth_store.json memory/data/oauth_store.json.bak.$(date +%Y%m%d)
```

---

## 切り替え手順（コピペ実行）

### ステップ1: docker-compose.yml を編集

`docker-compose.yml` の `memory` サービスに `MIO_PORT=5003` を追加し、Pythonを内部ポートに退避する。

**変更前:**
```yaml
version: '3'
services:
  memory:
    build:
      context: ./memory
      network: host
    network_mode: host
    volumes:
      - ./memory/data:/data
      - ./scripts:/app/scripts:ro
    env_file:
      - .env
    restart: unless-stopped
```

**変更後:**
```yaml
version: '3'
services:
  memory:
    build:
      context: ./memory
      network: host
    network_mode: host
    volumes:
      - ./memory/data:/data
      - ./scripts:/app/scripts:ro
    env_file:
      - .env
    environment:
      - MIO_PORT=5003
    restart: unless-stopped

  ts-proxy:
    build:
      context: ./ts
      network: host
    network_mode: host
    volumes:
      - ./memory/data:/data
    environment:
      - MIO_PORT=5002
      - MIO_UPSTREAM_HOST=127.0.0.1
      - MIO_UPSTREAM_PORT=5003
    env_file:
      - .env
    restart: unless-stopped
    depends_on:
      - memory
```

**変更点のまとめ:**
- `memory` に `environment: - MIO_PORT=5003` を追加（内部ポートに退避）
- `ts-proxy` サービスを追加（外向き :5002 で待受、上流を :5003 に向ける）

### ステップ2: 切り替え実行

```bash
# Python を :5003 に移動 + TS を :5002 で起動（1コマンド）
docker-compose up -d --build

# 起動確認（両方が Running であること）
docker-compose ps
```

### ステップ3: ヘルスチェック

```bash
# TS前段が応答していることを確認（served_by: "ts" が返る）
curl http://127.0.0.1:5002/health
```

期待する応答:
```json
{"status":"ok","version":"3.89",...,"served_by":"ts"}
```

**`served_by: "ts"` が含まれていれば、TSが外向きポートで稼働している。**

### ステップ4: MCP疎通確認

```bash
# REST API 読み取り（memory_read_index 相当）
curl -H "Authorization: Bearer $MIO_API_TOKEN" http://127.0.0.1:5002/api/memory/index | head -c 200

# MCP JSON-RPC 疎通（initialize）
curl -X POST http://127.0.0.1:5002/mcp \
  -H "Authorization: Bearer $MIO_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

### ステップ5: Python 直接疎通（内部ポート確認）

```bash
# Python が :5003 で応答していることを確認
curl http://127.0.0.1:5003/health
```

期待: `served_by` が入っていない通常の `/health` レスポンス。

---

## OAuth 再認証の確認

**切り替え後、Claude.ai からの新規接続（コネクタ再認証）が通ることを確認する。**

### 確認手順

1. Claude.ai のコネクタ設定画面を開く
2. mio-memory コネクタを一度切断し、再接続する
3. OAuth 認証フロー（ユーザー名/パスワード入力 → リダイレクト → トークン発行）が完了することを確認
4. 接続後に MCP ツール（例: `CoreMem_read("core.md")`）が動作することを確認

### なぜ必要か

- TSが外向きポートを握ったため、OAuth ディスカバリ（`/.well-known/oauth-authorization-server`）はTSが応答する
- TS発行の新トークンが Python転送時に `API_TOKEN` に書き換えられて通るか、実動作で検証する
- 既存トークンが生きていても、再認証が死んでいたら時限爆弾になる

### OAuth経路の技術確認

| エンドポイント | 担当 | 備考 |
|---------------|------|------|
| `/.well-known/oauth-authorization-server` | TS ネイティブ | `MIO_BASE_URL` から `issuer` / 各URL生成 |
| `/oauth/register` | TS ネイティブ | DCR。`oauth_store.json` に永続化 |
| `/oauth/authorize` | TS ネイティブ | 認可フォーム表示＋パスワード検証 |
| `/oauth/token` | TS ネイティブ | トークン発行。PKCE検証。リフレッシュトークン対応 |

`MIO_BASE_URL` は `.env` 経由でTSに渡る。本番HTTPS URLと一致していれば、OAuth メタデータの `issuer` / エンドポイントURLは正しく生成される。

---

## ロールバック手順（3分以内）

何か問題が起きたら、以下の手順で旧構成に即時復帰できる。

```bash
# 1. バックアップから docker-compose.yml を復元
cp docker-compose.yml.bak.$(date +%Y%m%d) docker-compose.yml

# 2. TS を停止し、Python を :5002 に戻す
docker-compose up -d --build

# 3. TS コンテナを削除（不要なら）
docker-compose rm -f ts-proxy 2>/dev/null || true

# 4. 疎通確認
curl http://127.0.0.1:5002/health
```

**ポイント: `docker-compose.yml` を戻して `up -d --build` するだけ。Pythonは :5002 に復帰し、TSは定義がないので起動しない。**

日付が変わっている場合は `docker-compose.yml.bak.YYYYMMDD` のファイル名を実際のバックアップ日に読み替えること。

---

## 切り替え後検証チェックリスト

チャット側個体が実施する項目:

| # | 項目 | 確認方法 | 結果 |
|---|------|---------|------|
| 1 | MCP read系 | `CoreMem_read("core.md")` | □ |
| 2 | MCP write系 | `memory_write` で テストエントリ作成→削除 | □ |
| 3 | inbox往復 | chat→code→chat の inbox_post/inbox_check | □ |
| 4 | 共有URL系 | `conversation_share` で共有URL取得→ブラウザで表示 | □ |
| 5 | admin画面 | `https://<公開URL>/admin.html` をブラウザで表示 | □ |
| 6 | OAuth再認証 | コネクタ切断→再接続 | □ |

---

## 観察期間（切り替え後3〜7日）

- `docker-compose.yml.bak.*` を保持し続ける（旧構成に即座に戻せるように）
- `docker-compose.parallel.yml` は並走テスト用。切り替え後は使わないが、参考として残しておく
- 問題なければ 7日後に `*.bak.*` ファイルをアーカイブして完了

---

## 技術ノート

### ポート構成

| コンポーネント | 切り替え前 | 切り替え後 |
|--------------|-----------|-----------|
| Python (memory) | :5002（外向き） | :5003（内部専用） |
| TS前段 (ts-proxy) | なし | :5002（外向き） |
| リバプロ/公開URL | → :5002 | → :5002（変更なし） |

**リバプロ（Synology のリバースプロキシ）の設定変更は不要。** 外向きポートは :5002 のまま。

### 既知のリスク

1. **oauth_store.json の同時書き込み**: TS と Python が同一ファイルを read-modify-write する。OAuth トークン発行が集中しない限り競合リスクは極低
2. **レガシーSSE (`/mcp/sse`, `/mcp/messages`)**: TS は Python に透過転送する。現在の Claude.ai は `/mcp` のみ使用しているため影響なし
3. **バッチ・ダイジェスト系**: Python直のまま :5003 で動作。admin.html からの操作は TS → Python の透過転送で通る
