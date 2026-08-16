#!/usr/bin/env bash
# TS前段・本番スイッチ化: 旧構成へのロールバック
# TS前段を停止し、Python を :5002（外向き）に戻す。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.yml"

echo "=== MCP_OLD: 旧構成へのロールバック ==="
echo ""

# --- バックアップファイルの特定 ---
if [ $# -ge 1 ] && [ -f "$1" ]; then
  BACKUP_FILE="$1"
elif [ $# -ge 1 ]; then
  echo "ERROR: 指定されたバックアップファイルが見つかりません: $1"
  exit 1
else
  # 引数なし: 最新の .bak.* を自動検出
  BACKUP_FILE=$(ls -t "${COMPOSE_FILE}".bak.* 2>/dev/null | head -1)
  if [ -z "$BACKUP_FILE" ]; then
    echo "ERROR: バックアップファイルが見つかりません"
    echo "  使い方: bash scripts/MCP_OLD.sh [バックアップファイルパス]"
    echo "  例:     bash scripts/MCP_OLD.sh docker-compose.yml.bak.20260816_150000"
    exit 1
  fi
  echo "最新のバックアップを使用: $(basename "$BACKUP_FILE")"
fi

# --- 復元 ---
echo "[1/3] docker-compose.yml を復元..."
cp "$BACKUP_FILE" "$COMPOSE_FILE"
echo "  $(basename "$BACKUP_FILE") → docker-compose.yml"

# --- コンテナ再起動 ---
echo ""
echo "[2/3] コンテナ再起動..."
cd "$ROOT_DIR"
docker-compose up -d --build

# ts-proxy コンテナが残っていれば停止・削除
if docker-compose ps --services 2>/dev/null | grep -q ts-proxy; then
  echo "  ts-proxy コンテナを停止・削除..."
  docker-compose rm -f -s ts-proxy 2>/dev/null || true
fi
echo ""

# --- ヘルスチェック ---
echo "[3/3] ヘルスチェック..."
sleep 3

PY_HEALTH=$(curl -s --max-time 10 http://127.0.0.1:5002/health 2>/dev/null || echo '{"error":"unreachable"}')
echo "  Python (:5002): $PY_HEALTH"

if echo "$PY_HEALTH" | grep -q '"status":"ok"'; then
  if echo "$PY_HEALTH" | grep -q '"served_by":"ts"'; then
    echo "  → WARNING: まだTS経由のようです。docker-compose.yml を確認してください"
  else
    echo "  → Python が外向きポートで稼働中（旧構成に復帰）"
  fi
else
  echo "  → WARNING: ヘルスチェック失敗。コンテナの状態を確認してください"
  echo "    docker-compose ps"
  echo "    docker-compose logs memory"
fi

echo ""
echo "=== ロールバック完了 ==="
