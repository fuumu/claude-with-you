#!/usr/bin/env bash
# .env_sample の新規項目を既存 .env にマージする。
# 既存の値は上書きしない。.env_sample から消えた項目は警告のみ。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${ROOT_DIR}/.env"
SAMPLE_FILE="${ROOT_DIR}/.env_sample"

YES=false
if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
    YES=true
fi

if [[ ! -f "$SAMPLE_FILE" ]]; then
    echo "ERROR: .env_sample not found" >&2
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    echo ".env not found — copying .env_sample as .env"
    cp "$SAMPLE_FILE" "$ENV_FILE"
    echo "Done. Edit .env to set your values."
    exit 0
fi

# KEY=VALUE または # KEY=VALUE から KEY を抽出する関数
extract_key() {
    local line="$1"
    if [[ "$line" =~ ^[[:space:]]*([A-Z][A-Z0-9_]*)= ]]; then
        echo "${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^[[:space:]]*#[[:space:]]*([A-Z][A-Z0-9_]*)= ]]; then
        echo "${BASH_REMATCH[1]}"
    fi
}

# .env を解析して KEY → 行内容 のマップを作る
declare -A env_map
declare -a env_keys=()
while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    key="$(extract_key "$line")"
    if [[ -n "$key" ]]; then
        env_map["$key"]="$line"
        env_keys+=("$key")
    fi
done < "$ENV_FILE"

# .env_sample のキー一覧を収集
declare -A sample_keys_set
while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    key="$(extract_key "$line")"
    if [[ -n "$key" ]]; then
        sample_keys_set["$key"]=1
    fi
done < "$SAMPLE_FILE"

# .env_sample の構造に沿ってマージ出力を生成
tmpfile="$(mktemp)"
added=()
while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    key="$(extract_key "$line")"

    if [[ -n "$key" && -n "${env_map[$key]+x}" ]]; then
        echo "${env_map[$key]}" >> "$tmpfile"
    elif [[ -n "$key" ]]; then
        echo "$line" >> "$tmpfile"
        added+=("$key")
    else
        echo "$line" >> "$tmpfile"
    fi
done < "$SAMPLE_FILE"

# .env_sample から消えたキーを末尾に保持（勝手に消さない）
deprecated=()
for key in "${env_keys[@]}"; do
    if [[ -z "${sample_keys_set[$key]+x}" ]]; then
        deprecated+=("$key")
    fi
done

if [[ ${#deprecated[@]} -gt 0 ]]; then
    echo "" >> "$tmpfile"
    echo "# ── .env_sample から削除済み（手動確認推奨） ──" >> "$tmpfile"
    for key in "${deprecated[@]}"; do
        echo "${env_map[$key]}" >> "$tmpfile"
    done
fi

# 差分なしなら終了
if [[ ${#added[@]} -eq 0 && ${#deprecated[@]} -eq 0 ]]; then
    echo ".env is up to date — no changes needed."
    rm -f "$tmpfile"
    exit 0
fi

# プレビュー表示
echo "=== .env update preview ==="
echo ""

if [[ ${#added[@]} -gt 0 ]]; then
    echo "[ADD] New variables from .env_sample:"
    for key in "${added[@]}"; do
        echo "  + $key"
    done
    echo ""
fi

if [[ ${#deprecated[@]} -gt 0 ]]; then
    echo "[WARN] Variables in .env not in .env_sample (kept, not removed):"
    for key in "${deprecated[@]}"; do
        echo "  ? $key"
    done
    echo ""
fi

echo "--- diff ---"
diff -u "$ENV_FILE" "$tmpfile" || true
echo "--- end diff ---"
echo ""

if [[ "$YES" != true ]]; then
    read -r -p "Apply changes? [y/N] " reply
    if [[ ! "$reply" =~ ^[Yy]$ ]]; then
        echo "Aborted."
        rm -f "$tmpfile"
        exit 0
    fi
fi

# バックアップ作成
backup="${ENV_FILE}.bak.$(date +%Y%m%d_%H%M)"
cp "$ENV_FILE" "$backup"
echo "Backup: $backup"

# 適用
mv "$tmpfile" "$ENV_FILE"
echo "Done. .env updated."
