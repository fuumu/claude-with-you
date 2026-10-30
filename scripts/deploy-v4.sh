#!/usr/bin/env bash
# v3.x（Python 版・TS 前段構成）→ v4.0（TypeScript 単体）への切り替えデプロイ。NAS で一回だけ使う。
# docs/setup.ja.md「v3.x（Python 版・TS 前段構成）から v4.0 への切り替え」の手順を順に実行する:
#   0. 事前チェック（場所・git・origin/main の取得・早送りできるか）  ← ここまではサービスに触れない
#   1. バックアップ（docker-compose.yml・.env・memory/data → ../mio-backups/<日時>-deploy-v4/）
#   2. 旧構成の停止（ローカルの docker-compose.yml のまま down。ts-proxy も止めるため）
#   3. ローカル変更を git stash に退避して origin/main へ早送り
#   4. TS 単体でビルド・起動
#   5. ヘルスチェック（/health が v4.0・served_by "ts" を返すこと）
# 失敗したらその時点で止まり、そのときの状態と戻し方を表示する。戻すときは scripts/rollback-v4.sh。
#
# 使い方（v3.x の NAS にはまだこのファイルが無いので、取り出してから実行する。sudo は付けない）:
#   cd /volume1/docker/mio
#   git fetch origin main
#   git show origin/main:scripts/deploy-v4.sh > ../deploy-v4.sh
#   bash ../deploy-v4.sh        # ステップごとに確認する
#   bash ../deploy-v4.sh -y     # 確認を省く
#
# 環境変数（ふだんは不要）:
#   MIO_REPO_DIR        実行してよいディレクトリ（既定 /volume1/docker/mio）
#   MIO_BACKUP_ROOT     バックアップの置き場（既定 リポジトリの一つ上の mio-backups/）
#   MIO_HEALTH_URL      ヘルスチェック先（既定 http://127.0.0.1:5002/health）
#   MIO_HEALTH_TIMEOUT  起動を待つ秒数（既定 120）
if [ -z "${BASH_VERSION:-}" ]; then
    echo "bash で実行してください: bash $0" >&2
    exit 1
fi
set -Eeuo pipefail
# 失敗した行を表示するため、実行前に自分の中身を覚えておく（実行中にファイルが消えても表示できる）
mapfile -t SELF_LINES < "${BASH_SOURCE[0]}" || SELF_LINES=()

EXPECTED_DIR="${MIO_REPO_DIR:-/volume1/docker/mio}"
HEALTH_URL="${MIO_HEALTH_URL:-http://127.0.0.1:5002/health}"
HEALTH_TIMEOUT="${MIO_HEALTH_TIMEOUT:-120}"
TOTAL=5

YES=false
STAGE="0. 事前チェック"
BRANCH=""
KIND=""
PROJECT=""
BACKUP_ROOT=""
BACKUP_DIR=""
TARGET_VERSION=""
DOCKER_BIN=""
COMPOSE_CMD=()
HEALTH_BODY=""
SUDO_KEEPALIVE_PID=""
# どこまで進んだか（失敗・中止のときの案内に使う）
STOPPED=false
STASHED=false
UPDATED=false
STARTED=false

# ── 表示 ─────────────────────────────────────────────────────────────
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; CYAN=$'\033[36m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; RESET=''
fi

step() { STAGE="$1. $2"; printf '\n%s%s[%s/%s] %s%s\n' "$BOLD" "$CYAN" "$1" "$TOTAL" "$2" "$RESET"; }
info() { printf '%s==>%s %s\n' "$CYAN" "$RESET" "$*"; }
ok()   { printf '%s✔%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
err()  { printf '%s✘ %s%s\n' "$RED" "$*" "$RESET" >&2; }

usage() {
    cat <<'EOF'
使い方: bash deploy-v4.sh [-y]
  v3.x（Python 版・TS 前段構成）から v4.0（TypeScript 単体）へ切り替える。
  リポジトリのルート（/volume1/docker/mio）で、sudo を付けずに実行する。
  -y, --yes   ステップごとの確認を省く
  -h, --help  この説明
EOF
}

# 失敗・中止したときに、いまの状態とここからの戻し方を表示する
show_state() {
    {
        printf '\n%s── いまの状態（「%s」で止まりました）──%s\n' "$BOLD" "$STAGE" "$RESET"
        if [[ -n "$BACKUP_DIR" ]]; then
            printf '  バックアップ: %s\n' "$BACKUP_DIR"
        fi
        if [[ "$STOPPED" != true ]]; then
            printf '  旧構成は動いたままです（サービスには触れていません）。\n'
        elif [[ "$STARTED" == true ]]; then
            printf '  v4.0 のコンテナは起動しましたが、応答を確認できていません。\n'
            printf '  ログを見る:   sudo docker-compose logs --tail 100 memory\n'
            printf '  旧構成に戻す: bash scripts/rollback-v4.sh -b %s\n' "$BACKUP_DIR"
        elif [[ "$UPDATED" == true ]]; then
            printf '  旧構成は止まっていて、リポジトリは v4.0 に更新済みです（まだ起動していません）。\n'
            printf '  v4.0 の起動をやり直す: sudo docker-compose up -d --build\n'
            printf '  旧構成に戻す:          bash scripts/rollback-v4.sh -b %s\n' "$BACKUP_DIR"
        else
            printf '  旧構成は止まっています（リポジトリは更新前のまま）。旧構成をそのまま起動し直すには:\n'
            if [[ "$STASHED" == true ]]; then
                printf '    git stash pop\n'
            fi
            printf '    cp %s/docker-compose.yml docker-compose.yml\n' "$BACKUP_DIR"
            printf '    sudo docker-compose up -d\n'
        fi
    } >&2
}

die() {
    err "$*"
    show_state
    exit 1
}

on_error() {
    local code="$1" line="$2" src
    trap - ERR
    src="${SELF_LINES[$(( line - 1 ))]:-$BASH_COMMAND}"
    src="${src#"${src%%[![:space:]]*}"}"
    err "失敗しました（${line} 行目・終了コード ${code}）: ${src}"
    show_state
    exit "$code"
}

confirm() {
    local ans=""
    if [[ "$YES" == true ]]; then
        return 0
    fi
    printf '%s?%s %s [y/N] ' "$YELLOW" "$RESET" "$1"
    if ! read -r ans; then
        ans=""
        echo
    fi
    case "$ans" in
        y|Y|yes|Yes|YES) return 0 ;;
    esac
    warn "中止しました。"
    show_state
    exit 1
}

# ── コマンド ─────────────────────────────────────────────────────────
# 失敗したときに呼び出し元の行（compose build など）がエラー表示に出るよう、終了コードだけ返す
as_root() {
    if [[ "$(id -u)" -eq 0 ]]; then
        "$@" || return $?
    else
        sudo "$@" || return $?
    fi
}

compose() { as_root "${COMPOSE_CMD[@]}" "$@" || return $?; }

# 長い処理の途中で sudo のパスワードを聞き直されないよう、資格を更新し続ける
keep_sudo_alive() {
    if [[ "$(id -u)" -eq 0 ]]; then
        return 0
    fi
    (
        trap - ERR
        trap 'kill "${nap:-}" 2>/dev/null || true; exit 0' TERM
        while kill -0 "$$" 2>/dev/null; do
            sudo -n true 2>/dev/null || true
            sleep 30 &
            nap=$!
            wait "$nap" || true
        done
    ) </dev/null >/dev/null 2>&1 &
    SUDO_KEEPALIVE_PID=$!
}

# docker-compose.yml の種類: ts-front（TS 前段＋Python）/ python（Python 単体）/ v4（TS 単体）/ unknown
compose_kind() {
    local text
    text="$(cat)"
    if grep -q '^[[:space:]]*ts-proxy:' <<<"$text"; then
        echo ts-front
    elif grep -q 'context:[[:space:]]*\./memory' <<<"$text"; then
        echo python
    elif grep -q 'context:[[:space:]]*\./ts' <<<"$text"; then
        echo v4
    else
        echo unknown
    fi
}

kind_label() {
    case "$1" in
        ts-front) echo "TS 前段＋Python（v3.x）" ;;
        python)   echo "Python 単体（v3.x）" ;;
        v4)       echo "TS 単体（v4.0〜）" ;;
        *)        echo "不明な形" ;;
    esac
}

health_body() { curl -fsS --max-time 5 "$1" 2>/dev/null; }

# JSON から "key":"値" か "key":数値 を素朴に取り出す（jq が無い NAS 向け）
json_field() {
    local v
    v="$({ printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -n 1 | sed 's/^[^:]*:"\(.*\)"$/\1/'; } || true)"
    if [[ -z "$v" ]]; then
        v="$({ printf '%s' "$1" | grep -o "\"$2\":[0-9.]*" | head -n 1 | sed 's/^[^:]*://'; } || true)"
    fi
    printf '%s' "$v"
}

# wait_health URL 期待する版 期待する served_by（空なら問わない）。HEALTH_BODY に最後の応答が残る
wait_health() {
    local url="$1" want_ver="$2" want_by="$3" deadline body
    deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
    while :; do
        body="$(health_body "$url" || true)"
        HEALTH_BODY="$body"
        if [[ -n "$body" && "$(json_field "$body" status)" == ok ]] &&
            [[ -z "$want_ver" || "$(json_field "$body" version)" == "$want_ver" ]] &&
            [[ -z "$want_by" || "$(json_field "$body" served_by)" == "$want_by" ]]; then
            echo
            return 0
        fi
        if (( $(date +%s) >= deadline )); then
            echo
            return 1
        fi
        printf '.'
        sleep 3
    done
}

git_stash() {
    local name email
    name="$(git config user.name || true)"
    email="$(git config user.email || true)"
    git -c "user.name=${name:-mio-deploy}" -c "user.email=${email:-mio-deploy@localhost}" stash push -m "$1"
}

# ── 各ステップ ───────────────────────────────────────────────────────
preflight() {
    step 0 "事前チェック（ここまではサービスに触れません）"
    local here expected top url changes body remote_kind data_kb avail_kb f
    here="$(pwd -P)"
    expected="$(cd "$EXPECTED_DIR" 2>/dev/null && pwd -P || true)"
    if [[ -z "$expected" || "$here" != "$expected" ]]; then
        die "リポジトリのルート（$EXPECTED_DIR）で実行してください。いまいる場所: $here"
    fi
    command -v git >/dev/null || die "git が見つかりません"
    top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [[ -z "$top" ]] || [[ "$(cd "$top" 2>/dev/null && pwd -P || true)" != "$here" ]]; then
        die "$here は git リポジトリのルートではありません"
    fi
    url="$(git remote get-url origin 2>/dev/null || true)"
    case "$url" in
        *claude-with-you*) ;;
        *) die "origin が claude-with-you ではありません（${url:-未設定}）" ;;
    esac
    [[ -f docker-compose.yml ]] || die "docker-compose.yml がありません"
    [[ -f .env ]] || die ".env がありません"
    [[ -d memory/data ]] || die "memory/data がありません（データの置き場所が違う？）"
    for f in curl tar gzip awk comm; do
        command -v "$f" >/dev/null || die "$f が見つかりません"
    done
    if [[ "$(id -u)" -eq 0 && "$(stat -c %u .git 2>/dev/null || echo '?')" != 0 ]]; then
        die "sudo を付けずに実行してください（git は普段のユーザーで動かし、docker と tar だけ中で sudo します）"
    fi
    ok "場所: $here（origin: $url）"

    DOCKER_BIN="$(command -v docker || true)"
    [[ -n "$DOCKER_BIN" ]] || die "docker が見つかりません"
    if command -v docker-compose >/dev/null; then
        COMPOSE_CMD=("$(command -v docker-compose)")
    else
        COMPOSE_CMD=("$DOCKER_BIN" compose)
    fi
    if [[ "$(id -u)" -ne 0 ]]; then
        info "docker と tar の操作に sudo を使います（パスワードを聞かれたら入力してください）"
        sudo -v || die "sudo が使えません"
        keep_sudo_alive
    fi
    compose version >/dev/null 2>&1 || die "docker-compose が動きません（${COMPOSE_CMD[*]}）"
    PROJECT="$(printf '%s' "${COMPOSE_PROJECT_NAME:-$(basename "$here")}" | tr '[:upper:]' '[:lower:]')"

    BRANCH="$(git symbolic-ref --short -q HEAD || echo '(detached)')"
    KIND="$(compose_kind < docker-compose.yml)"
    info "ブランチ: $BRANCH / HEAD: $(git log -1 --format='%h %s')"
    info "docker-compose.yml: $(kind_label "$KIND")"
    changes="$(git status --short --untracked-files=no)"
    if [[ -n "$changes" ]]; then
        info "ローカル変更（手順3で git stash に退避します）:"
        printf '%s\n' "$changes" | sed 's/^/      /'
    fi
    body="$(health_body "$HEALTH_URL" || true)"
    if [[ -n "$body" ]]; then
        info "いまの /health: version $(json_field "$body" version)・served_by $(json_field "$body" served_by)"
    else
        warn "いまの /health に応答がありません（$HEALTH_URL）"
    fi
    case "$KIND" in
        v4) warn "すでに TS 単体の構成です。続けると更新・再ビルド・再起動だけを行います" ;;
        unknown) warn "docker-compose.yml が想定と違う形です。バックアップはそのまま取ります" ;;
    esac

    info "origin/main を取得しています"
    git fetch origin main
    remote_kind="$(git show origin/main:docker-compose.yml 2>/dev/null | compose_kind || true)"
    [[ "$remote_kind" == v4 ]] || die "origin/main の docker-compose.yml が TS 単体の形になっていません（${remote_kind:-読めない}）"
    TARGET_VERSION="$({ git show origin/main:ts/src/version.ts 2>/dev/null |
        sed -n "s/^export const VERSION = '\([^']*\)'.*/\1/p"; } || true)"
    [[ -n "$TARGET_VERSION" ]] || die "origin/main の ts/src/version.ts から版を読めません"
    if [[ "$BRANCH" == main ]]; then
        git merge-base --is-ancestor HEAD origin/main ||
            die "この main には origin/main に無いコミットがあります（早送りできません）。git log origin/main..HEAD で確認してください"
    elif git show-ref --verify --quiet refs/heads/main; then
        git merge-base --is-ancestor main origin/main ||
            die "ローカルの main に origin/main に無いコミットがあります（早送りできません）"
    fi
    # 更新で入ってくるファイルと同じ名前の未追跡ファイルがあると、止めたあとで git が失敗する
    local collisions=()
    while IFS= read -r f; do
        if [[ -e "$f" || -L "$f" ]]; then
            collisions+=("$f")
        fi
    done < <(LC_ALL=C comm -13 \
        <(git -c core.quotePath=false ls-tree -r --name-only HEAD | LC_ALL=C sort) \
        <(git -c core.quotePath=false ls-tree -r --name-only origin/main | LC_ALL=C sort))
    if (( ${#collisions[@]} > 0 )); then
        die "更新で入ってくるファイルと同じ名前の未追跡ファイルがあります。退避してからやり直してください: ${collisions[*]}"
    fi
    ok "origin/main（v$TARGET_VERSION）へ早送りで更新できます"

    BACKUP_ROOT="${MIO_BACKUP_ROOT:-$(dirname "$here")/mio-backups}"
    (umask 077; mkdir -p "$BACKUP_ROOT")
    data_kb="$({ as_root du -sk memory/data | cut -f1; } 2>/dev/null || true)"
    avail_kb="$({ df -Pk "$BACKUP_ROOT" | awk 'NR == 2 {print $4}'; } 2>/dev/null || true)"
    [[ "$data_kb" =~ ^[0-9]+$ ]] || data_kb=0
    [[ "$avail_kb" =~ ^[0-9]+$ ]] || avail_kb=""
    info "memory/data: 約 $(( data_kb / 1024 )) MB / バックアップ先の空き: 約 $(( ${avail_kb:-0} / 1024 )) MB（$BACKUP_ROOT）"
    if [[ -n "$avail_kb" ]] && (( avail_kb < data_kb )); then
        warn "バックアップ先の空きがデータの大きさより少ないです（圧縮すれば収まることもあります）"
        if [[ "$YES" == true ]]; then
            die "空きが足りないかもしれないので -y では進めません。確認しながら実行してください"
        fi
        confirm "このまま進めますか？"
    fi

    printf '\n%sこれから行うこと%s\n' "$BOLD" "$RESET"
    printf '  1. バックアップ（docker-compose.yml・.env・memory/data）→ %s/<日時>-deploy-v4/\n' "$BACKUP_ROOT"
    printf '  2. 旧構成の停止（いまの docker-compose.yml のまま down）\n'
    printf '  3. ローカル変更を git stash に退避し、origin/main（v%s）へ早送り\n' "$TARGET_VERSION"
    printf '  4. TS 単体のイメージをビルドして起動\n'
    printf '  5. %s が version %s・served_by ts を返すか確認\n' "$HEALTH_URL" "$TARGET_VERSION"
}

backup() {
    step 1 "バックアップ"
    confirm "docker-compose.yml・.env・memory/data をバックアップします。よいですか？"
    BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-deploy-v4"
    (umask 077; mkdir -p "$BACKUP_DIR")
    cp -p docker-compose.yml "$BACKUP_DIR/docker-compose.yml"
    cp -p .env "$BACKUP_DIR/.env"
    git status --short > "$BACKUP_DIR/git-status.txt"
    git diff > "$BACKUP_DIR/local-changes.patch"
    {
        echo "created_at=$(date '+%Y-%m-%dT%H:%M:%S%z')"
        echo "script=deploy-v4"
        echo "repo=$PWD"
        echo "branch=$BRANCH"
        echo "head=$(git rev-parse HEAD)"
        echo "compose_kind=$KIND"
    } > "$BACKUP_DIR/backup.info"
    ok "設定: $BACKUP_DIR/docker-compose.yml・.env（いまの HEAD とローカル変更の差分も保存）"
    info "memory/data を固めています（大きいと数分かかります）"
    as_root tar czf "$BACKUP_DIR/mio-data.tgz" memory/data
    as_root gzip -t "$BACKUP_DIR/mio-data.tgz"
    ok "データ: $BACKUP_DIR/mio-data.tgz（$({ du -h "$BACKUP_DIR/mio-data.tgz" | cut -f1; } 2>/dev/null || true)）"
}

stop_old() {
    step 2 "旧構成の停止"
    info "いまの docker-compose.yml（$(kind_label "$KIND")）のまま止めます"
    confirm "止めている間は mio-memory に接続できなくなります。止めますか？"
    compose down --remove-orphans
    STOPPED=true
    local left
    left="$(as_root "$DOCKER_BIN" ps --format '{{.Names}}' | grep -E "^${PROJECT}[-_]" || true)"
    if [[ -n "$left" ]]; then
        die "止まっていないコンテナがあります: $(printf '%s' "$left" | tr '\n' ' ')"
    fi
    if health_body "$HEALTH_URL" >/dev/null; then
        die "止めたのに $HEALTH_URL が応答しています（ほかのプロセスがポートを使っている？）"
    fi
    ok "旧構成を止めました"
}

update_repo() {
    step 3 "ローカル変更の退避と更新"
    confirm "ローカル変更を git stash に退避し、origin/main（v$TARGET_VERSION）へ更新します。よいですか？"
    if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
        git_stash "deploy-v4 $(date '+%Y-%m-%d %H:%M') より前のローカル変更"
        STASHED=true
        ok "退避しました: $(git stash list -n 1)"
    else
        info "ローカル変更はありません"
    fi
    if [[ "$BRANCH" != main ]]; then
        if git show-ref --verify --quiet refs/heads/main; then
            git checkout main
        else
            git checkout -b main origin/main
        fi
    fi
    git merge --ff-only -q origin/main
    UPDATED=true
    ok "更新しました: $(git log -1 --format='%h %s')"
}

start_new() {
    step 4 "TS 単体でビルド・起動"
    confirm "TS 単体（v$TARGET_VERSION）のイメージをビルドして起動します。よいですか？"
    info "ビルドしています（npm install があるので数分かかることがあります）"
    compose build
    compose up -d --remove-orphans
    STARTED=true
    ok "起動しました"
}

check_health() {
    step 5 "ヘルスチェック"
    info "$HEALTH_URL の応答を待っています（最大 ${HEALTH_TIMEOUT} 秒）"
    if ! wait_health "$HEALTH_URL" "$TARGET_VERSION" ts; then
        compose ps || true
        compose logs --tail 50 memory || true
        die "$HEALTH_URL が version $TARGET_VERSION・served_by ts を返しません（最後の応答: ${HEALTH_BODY:-なし}）"
    fi
    ok "/health: version $(json_field "$HEALTH_BODY" version)・served_by $(json_field "$HEALTH_BODY" served_by)・MCP ツール $(json_field "$HEALTH_BODY" mcp_tool_count) 本"
    compose ps
    printf '%s\n' "── 起動ログ（末尾）──"
    compose logs --tail 15 memory || true
}

summary() {
    printf '\n%s%sv%s への切り替えが終わりました。%s\n' "$BOLD" "$GREEN" "$TARGET_VERSION" "$RESET"
    printf '  バックアップ: %s\n' "$BACKUP_DIR"
    if [[ "$STASHED" == true ]]; then
        printf '  退避したローカル変更: git stash list の一番上（中身は git stash show -p）\n'
    fi
    printf '  このあと確かめること:\n'
    printf '    - 管理画面（https://<公開URL>/admin.html）が開く\n'
    printf '    - claude.ai / Claude Code から MCP ツール（例: CoreMem_read）が動く。MCP の URL は /mcp\n'
    printf '  戻すとき: bash scripts/rollback-v4.sh\n'
}

parse_args() {
    while (( $# > 0 )); do
        case "$1" in
            -y|--yes) YES=true ;;
            -h|--help) usage; exit 0 ;;
            *) err "知らないオプションです: $1"; usage >&2; exit 2 ;;
        esac
        shift
    done
}

# 更新中にこのファイル自体が書き換わっても動き続けるよう、全体を関数にしてから実行する
main() {
    parse_args "$@"
    trap 'on_error $? $LINENO' ERR
    trap 'if [[ -n "$SUDO_KEEPALIVE_PID" ]]; then kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true; fi' EXIT
    preflight
    backup
    stop_old
    update_repo
    start_new
    check_health
    summary
}

main "$@"; exit $?
