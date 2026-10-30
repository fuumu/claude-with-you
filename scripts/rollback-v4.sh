#!/usr/bin/env bash
# v4.0（TypeScript 単体）→ v3.x（legacy-python ブランチ・TS 前段構成）へのロールバック。deploy-v4.sh と対で使う。
#   0. 事前チェック（場所・git・使うバックアップ・legacy-python の取得）  ← ここまではサービスに触れない
#   1. v4.0 の停止
#   2. legacy-python ブランチへ切り替え（ローカル変更があれば git stash に退避）
#   3. deploy-v4.sh がバックアップした docker-compose.yml（TS 前段構成）を戻す
#   4. 旧構成でビルド・起動
#   5. ヘルスチェック
# 失敗したらその時点で止まり、そのときの状態と続け方を表示する。
#
# 使い方（リポジトリのルートで。sudo は付けない）:
#   cd /volume1/docker/mio
#   bash scripts/rollback-v4.sh                # いちばん新しい v3.x 構成のバックアップを使う。ステップごとに確認する
#   bash scripts/rollback-v4.sh -y             # 確認を省く
#   bash scripts/rollback-v4.sh -b <ディレクトリ>  # 使うバックアップを指定（../mio-backups/<日時>-deploy-v4）
#   bash scripts/rollback-v4.sh --pre-deploy   # legacy-python ではなく、デプロイ直前に動いていたコミットへ戻す
#
# 環境変数（ふだんは不要）:
#   MIO_REPO_DIR         実行してよいディレクトリ（既定 /volume1/docker/mio）
#   MIO_BACKUP_ROOT      バックアップの置き場（既定 リポジトリの一つ上の mio-backups/）
#   MIO_HEALTH_URL       ヘルスチェック先（既定 http://127.0.0.1:5002/health）
#   MIO_UPSTREAM_HEALTH  TS 前段構成のときの Python 側（既定 http://127.0.0.1:5003/health）
#   MIO_HEALTH_TIMEOUT   起動を待つ秒数（既定 180。Python のビルドがあるので長め）
if [ -z "${BASH_VERSION:-}" ]; then
    echo "bash で実行してください: bash $0" >&2
    exit 1
fi
set -Eeuo pipefail
# 失敗した行を表示するため、実行前に自分の中身を覚えておく（実行中にファイルが消えても表示できる）
mapfile -t SELF_LINES < "${BASH_SOURCE[0]}" || SELF_LINES=()

EXPECTED_DIR="${MIO_REPO_DIR:-/volume1/docker/mio}"
HEALTH_URL="${MIO_HEALTH_URL:-http://127.0.0.1:5002/health}"
UPSTREAM_HEALTH_URL="${MIO_UPSTREAM_HEALTH:-http://127.0.0.1:5003/health}"
HEALTH_TIMEOUT="${MIO_HEALTH_TIMEOUT:-180}"
TOTAL=5

YES=false
PRE_DEPLOY=false
BACKUP_ARG=""
STAGE="0. 事前チェック"
BRANCH=""
KIND=""
PROJECT=""
BACKUP_ROOT=""
BACKUP_DIR=""
BACKUP_KIND=""
TARGET=""        # 切り替え先（legacy-python か、デプロイ直前のコミット）
TARGET_LABEL=""
DOCKER_BIN=""
COMPOSE_CMD=()
HEALTH_BODY=""
SUDO_KEEPALIVE_PID=""
# どこまで進んだか（失敗・中止のときの案内に使う）
STOPPED=false
STASHED=false
SWITCHED=false
RESTORED=false
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
使い方: bash scripts/rollback-v4.sh [-y] [-b <バックアップのディレクトリ>] [--pre-deploy]
  v4.0（TypeScript 単体）から v3.x（legacy-python・TS 前段構成）へ戻す。
  リポジトリのルート（/volume1/docker/mio）で、sudo を付けずに実行する。
  -y, --yes         ステップごとの確認を省く
  -b, --backup DIR  使うバックアップ（省略時は ../mio-backups/ のいちばん新しい v3.x 構成のもの）
  --pre-deploy      legacy-python ではなく、バックアップを取ったとき（デプロイ直前）のコミットへ戻す
  -h, --help        この説明
EOF
}

# 失敗・中止したときに、いまの状態とここからの続け方を表示する
show_state() {
    {
        printf '\n%s── いまの状態（「%s」で止まりました）──%s\n' "$BOLD" "$STAGE" "$RESET"
        if [[ -n "$BACKUP_DIR" ]]; then
            printf '  使うバックアップ: %s\n' "$BACKUP_DIR"
        fi
        if [[ "$STOPPED" != true ]]; then
            printf '  v4.0 は動いたままです（サービスには触れていません）。\n'
            return
        fi
        if [[ "$STARTED" == true ]]; then
            printf '  旧構成のコンテナは起動しましたが、応答を確認できていません。\n'
            printf '  ログを見る: sudo docker-compose logs --tail 100\n'
        elif [[ "$RESTORED" == true ]]; then
            printf '  %s に切り替えて docker-compose.yml も戻しました（まだ起動していません）。\n' "$TARGET_LABEL"
            printf '  旧構成の起動をやり直す: sudo docker-compose up -d --build\n'
        elif [[ "$SWITCHED" == true ]]; then
            printf '  %s に切り替えました。docker-compose.yml はまだ戻していません。続きを手で行うなら:\n' "$TARGET_LABEL"
            printf '    cp %s/docker-compose.yml docker-compose.yml\n' "$BACKUP_DIR"
            printf '    sudo docker-compose up -d --build\n'
        else
            printf '  v4.0 は止まっています（リポジトリはそのまま）。\n'
            printf '  v4.0 を起動し直す: sudo docker-compose up -d\n'
        fi
        if [[ "$SWITCHED" == true ]]; then
            printf '  v4.0 に戻すなら: sudo docker-compose down; git checkout -- docker-compose.yml; git checkout main; sudo docker-compose up -d --build\n'
        fi
        if [[ "$STASHED" == true ]]; then
            printf '  退避したローカル変更: git stash list の一番上\n'
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

# wait_health URL 期待する served_by（空なら問わない）。HEALTH_BODY に最後の応答が残る
wait_health() {
    local url="$1" want_by="$2" deadline body
    deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
    while :; do
        body="$(health_body "$url" || true)"
        HEALTH_BODY="$body"
        if [[ -n "$body" && "$(json_field "$body" status)" == ok ]] &&
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

info_value() { sed -n "s/^$2=//p" "$1/backup.info" 2>/dev/null | head -n 1 || true; }

# いちばん新しい v3.x 構成（TS 前段か Python 単体）のバックアップを探す
find_backup() {
    local d kind
    [[ -d "$BACKUP_ROOT" ]] || return 0
    while IFS= read -r d; do
        d="${d%/}"
        [[ -f "$d/docker-compose.yml" ]] || continue
        kind="$(compose_kind < "$d/docker-compose.yml")"
        if [[ "$kind" == ts-front || "$kind" == python ]]; then
            printf '%s' "$d"
            return 0
        fi
    done < <(ls -1d "$BACKUP_ROOT"/*/ 2>/dev/null | LC_ALL=C sort -r || true)
}

# ── 各ステップ ───────────────────────────────────────────────────────
preflight() {
    step 0 "事前チェック（ここまではサービスに触れません）"
    local here expected top url changes body head f
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
    for f in curl awk comm; do
        command -v "$f" >/dev/null || die "$f が見つかりません"
    done
    if [[ "$(id -u)" -eq 0 && "$(stat -c %u .git 2>/dev/null || echo '?')" != 0 ]]; then
        die "sudo を付けずに実行してください（git は普段のユーザーで動かし、docker だけ中で sudo します）"
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
        info "docker の操作に sudo を使います（パスワードを聞かれたら入力してください）"
        sudo -v || die "sudo が使えません"
        keep_sudo_alive
    fi
    compose version >/dev/null 2>&1 || die "docker-compose が動きません（${COMPOSE_CMD[*]}）"
    PROJECT="$(printf '%s' "${COMPOSE_PROJECT_NAME:-$(basename "$here")}" | tr '[:upper:]' '[:lower:]')"

    BRANCH="$(git symbolic-ref --short -q HEAD || echo '(detached)')"
    KIND="$(compose_kind < docker-compose.yml)"
    info "ブランチ: $BRANCH / HEAD: $(git log -1 --format='%h %s')"
    info "docker-compose.yml: $(kind_label "$KIND")"
    if [[ "$KIND" != v4 ]]; then
        warn "いまの docker-compose.yml は TS 単体（v4）の形ではありません。すでに戻っているかもしれません"
    fi
    changes="$(git status --short --untracked-files=no)"
    if [[ -n "$changes" ]]; then
        info "ローカル変更（手順2で git stash に退避します）:"
        printf '%s\n' "$changes" | sed 's/^/      /'
    fi
    body="$(health_body "$HEALTH_URL" || true)"
    if [[ -n "$body" ]]; then
        info "いまの /health: version $(json_field "$body" version)・served_by $(json_field "$body" served_by)"
    else
        warn "いまの /health に応答がありません（$HEALTH_URL）"
    fi

    # 使うバックアップ
    BACKUP_ROOT="${MIO_BACKUP_ROOT:-$(dirname "$here")/mio-backups}"
    if [[ -n "$BACKUP_ARG" ]]; then
        BACKUP_DIR="$(cd "$BACKUP_ARG" 2>/dev/null && pwd -P || true)"
        [[ -n "$BACKUP_DIR" ]] || die "バックアップのディレクトリがありません: $BACKUP_ARG"
    else
        BACKUP_DIR="$(find_backup)"
        [[ -n "$BACKUP_DIR" ]] || die "$BACKUP_ROOT に v3.x 構成（TS 前段か Python 単体）の docker-compose.yml を含むバックアップがありません。-b で指定してください"
    fi
    [[ -f "$BACKUP_DIR/docker-compose.yml" ]] || die "$BACKUP_DIR に docker-compose.yml がありません"
    BACKUP_KIND="$(compose_kind < "$BACKUP_DIR/docker-compose.yml")"
    if [[ "$BACKUP_KIND" != ts-front && "$BACKUP_KIND" != python ]]; then
        die "$BACKUP_DIR/docker-compose.yml は v3.x の構成ではありません（$(kind_label "$BACKUP_KIND")）"
    fi
    ok "バックアップ: $BACKUP_DIR（$(kind_label "$BACKUP_KIND")・作成 $(info_value "$BACKUP_DIR" created_at)）"

    # 切り替え先
    if [[ "$PRE_DEPLOY" == true ]]; then
        head="$(info_value "$BACKUP_DIR" head)"
        [[ -n "$head" ]] || die "$BACKUP_DIR/backup.info にデプロイ直前のコミット（head=）がありません"
        git cat-file -e "${head}^{commit}" 2>/dev/null || die "デプロイ直前のコミット $head がこのリポジトリにありません"
        TARGET="$head"
        TARGET_LABEL="デプロイ直前のコミット ${head:0:7}"
    else
        info "origin/legacy-python を取得しています"
        git fetch origin legacy-python
        git rev-parse --verify -q origin/legacy-python >/dev/null || die "origin/legacy-python が見つかりません"
        if git show-ref --verify --quiet refs/heads/legacy-python; then
            git merge-base --is-ancestor legacy-python origin/legacy-python ||
                die "ローカルの legacy-python に origin に無いコミットがあります（早送りできません）"
        fi
        TARGET="origin/legacy-python"
        TARGET_LABEL="legacy-python（$(git log -1 --format='%h' origin/legacy-python)）"
    fi
    # 切り替えで入ってくるファイルと同じ名前の未追跡ファイルがあると、止めたあとで git が失敗する
    local collisions=()
    while IFS= read -r f; do
        if [[ -e "$f" || -L "$f" ]]; then
            collisions+=("$f")
        fi
    done < <(LC_ALL=C comm -13 \
        <(git -c core.quotePath=false ls-tree -r --name-only HEAD | LC_ALL=C sort) \
        <(git -c core.quotePath=false ls-tree -r --name-only "$TARGET" | LC_ALL=C sort))
    if (( ${#collisions[@]} > 0 )); then
        die "切り替えで入ってくるファイルと同じ名前の未追跡ファイルがあります。退避してからやり直してください: ${collisions[*]}"
    fi
    ok "切り替え先: $TARGET_LABEL"

    printf '\n%sこれから行うこと%s\n' "$BOLD" "$RESET"
    printf '  1. v4.0 の停止（いまの docker-compose.yml のまま down）\n'
    printf '  2. %s へ切り替え（ローカル変更があれば git stash に退避）\n' "$TARGET_LABEL"
    printf '  3. %s/docker-compose.yml を戻す\n' "$BACKUP_DIR"
    printf '  4. 旧構成（%s）でビルド・起動\n' "$(kind_label "$BACKUP_KIND")"
    printf '  5. %s の応答を確認\n' "$HEALTH_URL"
}

stop_v4() {
    step 1 "v4.0 の停止"
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
    ok "v4.0 を止めました"
}

switch_branch() {
    step 2 "${TARGET_LABEL} へ切り替え"
    confirm "${TARGET_LABEL} に切り替えます。よいですか？"
    if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
        git_stash "rollback-v4 $(date '+%Y-%m-%d %H:%M') より前のローカル変更"
        STASHED=true
        ok "退避しました: $(git stash list -n 1)"
    fi
    if [[ "$PRE_DEPLOY" == true ]]; then
        git checkout --detach "$TARGET"
    elif git show-ref --verify --quiet refs/heads/legacy-python; then
        git checkout legacy-python
        git merge --ff-only -q origin/legacy-python
    else
        git checkout -b legacy-python origin/legacy-python
    fi
    SWITCHED=true
    ok "切り替えました: $(git log -1 --format='%h %s')"
}

restore_compose() {
    step 3 "docker-compose.yml を戻す"
    confirm "$BACKUP_DIR/docker-compose.yml（$(kind_label "$BACKUP_KIND")）を戻します。よいですか？"
    cp -p "$BACKUP_DIR/docker-compose.yml" docker-compose.yml
    RESTORED=true
    ok "戻しました（$(kind_label "$(compose_kind < docker-compose.yml)")）"
}

start_old() {
    step 4 "旧構成でビルド・起動"
    confirm "旧構成をビルドして起動します。よいですか？"
    info "ビルドしています（数分かかることがあります）"
    compose build
    compose up -d --remove-orphans
    STARTED=true
    ok "起動しました"
}

check_health() {
    step 5 "ヘルスチェック"
    local want_by=""
    if [[ "$BACKUP_KIND" == ts-front ]]; then
        want_by=ts
    fi
    info "$HEALTH_URL の応答を待っています（最大 ${HEALTH_TIMEOUT} 秒）"
    if ! wait_health "$HEALTH_URL" "$want_by"; then
        compose ps || true
        compose logs --tail 50 || true
        die "$HEALTH_URL が応答しません（最後の応答: ${HEALTH_BODY:-なし}）"
    fi
    ok "/health: version $(json_field "$HEALTH_BODY" version)・served_by $(json_field "$HEALTH_BODY" served_by)"
    if [[ "$BACKUP_KIND" == ts-front ]]; then
        info "Python 側 $UPSTREAM_HEALTH_URL も確認しています"
        if ! wait_health "$UPSTREAM_HEALTH_URL" ""; then
            compose logs --tail 50 memory || true
            die "Python 側（$UPSTREAM_HEALTH_URL）が応答しません"
        fi
        ok "Python 側: version $(json_field "$HEALTH_BODY" version)"
    fi
    compose ps
}

summary() {
    printf '\n%s%sロールバックが終わりました。%s\n' "$BOLD" "$GREEN" "$RESET"
    printf '  いま: %s ＋ %s\n' "$TARGET_LABEL" "$(kind_label "$BACKUP_KIND")"
    if [[ "$STASHED" == true ]]; then
        printf '  退避したローカル変更: git stash list の一番上\n'
    fi
    printf '  もう一度 v4.0 に切り替えるとき:\n'
    printf '    git fetch origin main\n'
    printf '    git show origin/main:scripts/deploy-v4.sh > ../deploy-v4.sh\n'
    printf '    bash ../deploy-v4.sh\n'
}

parse_args() {
    while (( $# > 0 )); do
        case "$1" in
            -y|--yes) YES=true ;;
            -b|--backup)
                if (( $# < 2 )); then
                    err "-b にはバックアップのディレクトリを指定してください"
                    exit 2
                fi
                BACKUP_ARG="$2"
                shift
                ;;
            --pre-deploy) PRE_DEPLOY=true ;;
            -h|--help) usage; exit 0 ;;
            *) err "知らないオプションです: $1"; usage >&2; exit 2 ;;
        esac
        shift
    done
}

# legacy-python にはこのファイルが無い。切り替えでファイルが消えても動き続けるよう、全体を関数にしてから実行する
main() {
    parse_args "$@"
    trap 'on_error $? $LINENO' ERR
    trap 'if [[ -n "$SUDO_KEEPALIVE_PID" ]]; then kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true; fi' EXIT
    preflight
    stop_v4
    switch_branch
    restore_compose
    start_old
    check_health
    summary
}

main "$@"; exit $?
