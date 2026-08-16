#!/usr/bin/env bash
# TS前段・本番スイッチ化: 新構成への切り替え
# Python を :5003 に退避、TS前段を :5002（外向き）で起動する。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.yml"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${COMPOSE_FILE}.bak.${TIMESTAMP}"

echo "=== MCP_NEW: TS前段への切り替え ==="
echo ""

# --- バックアップ ---
echo "[1/5] バックアップ作成..."
cp "$COMPOSE_FILE" "$BACKUP_FILE"
echo "  docker-compose.yml → $(basename "$BACKUP_FILE")"

if [ -f "${ROOT_DIR}/.env" ]; then
  cp "${ROOT_DIR}/.env" "${ROOT_DIR}/.env.bak.${TIMESTAMP}"
  echo "  .env → .env.bak.${TIMESTAMP}"
fi

if [ -f "${ROOT_DIR}/memory/data/oauth_store.json" ]; then
  cp "${ROOT_DIR}/memory/data/oauth_store.json" "${ROOT_DIR}/memory/data/oauth_store.json.bak.${TIMESTAMP}"
  echo "  oauth_store.json → oauth_store.json.bak.${TIMESTAMP}"
fi

# --- docker-compose.yml 差し替え ---
echo ""
echo "[2/5] docker-compose.yml を新構成に差し替え..."
cat > "$COMPOSE_FILE" << 'YAML'
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
YAML
echo "  完了（Python :5003 / TS :5002）"

# --- コンテナ起動 ---
echo ""
echo "[3/5] コンテナ起動..."
cd "$ROOT_DIR"
docker-compose up -d --build
echo ""

# --- ヘルスチェック ---
echo "[4/5] ヘルスチェック..."
sleep 3

TS_HEALTH=$(curl -s --max-time 10 http://127.0.0.1:5002/health 2>/dev/null || echo '{"error":"unreachable"}')
echo "  TS前段 (:5002): $TS_HEALTH"

if echo "$TS_HEALTH" | grep -q '"served_by":"ts"'; then
  echo "  → TS前段が外向きポートで稼働中"
else
  echo "  → WARNING: served_by:ts が見つかりません。ロールバックを検討してください"
  echo "    ロールバック: bash scripts/MCP_OLD.sh $BACKUP_FILE"
fi

PY_HEALTH=$(curl -s --max-time 10 http://127.0.0.1:5003/health 2>/dev/null || echo '{"error":"unreachable"}')
echo "  Python  (:5003): $PY_HEALTH"

# --- MCP疎通確認 ---
echo ""
echo "[5/5] MCP疎通確認..."

# .env から MIO_API_TOKEN を読む
if [ -f "${ROOT_DIR}/.env" ]; then
  TOKEN=$(grep -E '^MIO_API_TOKEN=' "${ROOT_DIR}/.env" | head -1 | cut -d= -f2-)
fi
TOKEN="${TOKEN:-changeme}"

MCP_RESP=$(curl -s --max-time 10 -X POST http://127.0.0.1:5002/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"switchover-test","version":"1.0"}}}' 2>/dev/null || echo '{"error":"unreachable"}')

if echo "$MCP_RESP" | grep -q '"mio-memory"'; then
  echo "  MCP initialize: OK"
else
  echo "  MCP initialize: 応答異常"
  echo "  $MCP_RESP"
fi

echo ""
echo "=== 切り替え完了 ==="
echo "バックアップ: $BACKUP_FILE"
echo "ロールバック: bash scripts/MCP_OLD.sh $BACKUP_FILE"
echo ""
echo "次のステップ:"
echo "  1. Claude.ai からコネクタ再接続（OAuth再認証）を確認"
echo "  2. チャット側でMCPツール疎通を確認"
echo "  3. 3〜7日間の観察期間後、*.bak.* を整理"
