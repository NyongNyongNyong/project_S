#!/usr/bin/env bash
# 업데이트 반영 후 빌드하고 API 서버를 백그라운드로 띄웁니다. SSH 세션이 끊겨도 nohup으로 프로세스는 유지됩니다.
#
# 사용:
#   bash scripts/redeploy-server.sh
#   bash scripts/redeploy-server.sh --no-pull   # git pull 생략(이미 코드만 갱신한 경우)
#
# 환경변수:
#   SKIP_GIT_PULL=1  --no-pull 과 동일
#
# 종료(수동):
#   kill "$(cat .server.pid)"   또는   fuser -k "${PORT}/tcp"

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PID_FILE="${ROOT}/.server.pid"
LOG_FILE="${ROOT}/server.log"
GIT_PULL=1

for arg in "$@"; do
  case "$arg" in
    --no-pull) GIT_PULL=0 ;;
    -h|--help)
      grep '^#' "$0" | grep -v '^#!/' | sed 's/^# //' | sed 's/^#//'
      exit 0
      ;;
  esac
done

if [[ "${SKIP_GIT_PULL:-}" == "1" ]]; then
  GIT_PULL=0
fi

PORT="$(
  node -e "require('dotenv').config(); process.stdout.write(String(process.env.PORT || '4000'));" \
    2>/dev/null || echo "4000"
)"

echo "[redeploy] ROOT=$ROOT PORT=$PORT"

if [[ "$GIT_PULL" == "1" ]] && [[ -d .git ]]; then
  echo "[redeploy] git pull --ff-only"
  git pull --ff-only
elif [[ "$GIT_PULL" == "1" ]]; then
  echo "[redeploy] .git 없음, git pull 생략"
fi

echo "[redeploy] npm install"
npm install

echo "[redeploy] npm run build"
npm run build

stop_previous() {
  if [[ -f "$PID_FILE" ]]; then
    local oldpid
    oldpid="$(tr -d '[:space:]' <"$PID_FILE" || true)"
    if [[ -n "$oldpid" ]] && kill -0 "$oldpid" 2>/dev/null; then
      echo "[redeploy] 이전 PID 종료: $oldpid"
      kill "$oldpid" 2>/dev/null || true
      sleep 1
      if kill -0 "$oldpid" 2>/dev/null; then
        kill -9 "$oldpid" 2>/dev/null || true
      fi
    fi
    rm -f "$PID_FILE"
  fi
  if command -v fuser >/dev/null 2>&1; then
    echo "[redeploy] 포트 ${PORT}/tcp 사용 프로세스 정리(있다면)"
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
    sleep 0.5
  else
    echo "[redeploy] 경고: fuser 없음. 포트가 점유돼 있으면 수동으로 종료하세요."
  fi
}

stop_previous

if [[ ! -f dist/server.js ]]; then
  echo "[redeploy] 오류: dist/server.js 없음. 빌드 실패 여부를 확인하세요." >&2
  exit 1
fi

echo "[redeploy] 서버 기동 (nohup, 로그: $LOG_FILE)"
nohup node dist/server.js >>"$LOG_FILE" 2>&1 &
NEWPID=$!
echo "$NEWPID" >"$PID_FILE"
echo "[redeploy] PID=$NEWPID (기록: $PID_FILE)"

sleep 0.4
if kill -0 "$NEWPID" 2>/dev/null; then
  echo "[redeploy] 완료. http://0.0.0.0:${PORT} (로컬: http://127.0.0.1:${PORT})"
  echo "[redeploy] 로그: tail -f ${LOG_FILE}"
else
  echo "[redeploy] 오류: 프로세스가 바로 죽었을 수 있습니다. tail -50 ${LOG_FILE}" >&2
  exit 1
fi
