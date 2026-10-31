#!/usr/bin/env bash
# Checks that the image ignores dotenv files: neither the service nor its
# healthcheck may read .env, .env.production or .env.local mounted into /app.
# Usage: bash scripts/image-dotenv.sh <image>
# Each case runs in its own child process with set -e; the parent only
# aggregates, because bash ignores set -e inside if, || and &&.
set -uo pipefail

marker="dotenv-marker-556"
fixture=(-e PULSE_API_URL=http://api.invalid:3000)
expected_cmd='["bun","--no-env-file","src/main.ts"]'
expected_health='["CMD","bun","--no-env-file","-e"]'

fail() {
  echo "$1" >&2
  exit 1
}

case_control() {
  local image="$1" dir="$2" code=0 c="dotenv-control-$$"
  echo "$c" >> "$dir/containers"
  timeout 30 docker run --rm --name "$c" "${fixture[@]}" \
    -e "PULSE_LOG_LEVEL=$marker" "$image" > /dev/null 2> "$dir/control.err" || code=$?
  [ "$code" = "2" ] || fail "exit code $code, expected 2"
  grep -qF PULSE_LOG_LEVEL "$dir/control.err" || fail "stderr does not name PULSE_LOG_LEVEL"
}

show_container() {
  echo "container exit code: $(docker inspect -f '{{.State.ExitCode}}' "$1")"
  docker logs --tail 20 "$1" 2>&1
}

case_dotenv() {
  local image="$1" dir="$2" name="$3"
  local c="dotenv-${name#.}-$$"
  c="${c//./-}"
  printf 'PULSE_LOG_LEVEL=%s\nPULSE_CONSOLE_PORT=1\n' "$marker" > "$dir/dotenv"
  chmod 0644 "$dir/dotenv"
  echo "$c" >> "$dir/containers"
  docker run -d --name "$c" "${fixture[@]}" -v "$dir/dotenv:/app/$name:ro" "$image" > /dev/null
  local health=()
  mapfile -t health < <(docker image inspect "$image" | jq -r '.[0].Config.Healthcheck.Test[1:][]')
  local healthy=0
  for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$c")" != "true" ]; then
      show_container "$c"
      fail "container exited $(docker inspect -f '{{.State.ExitCode}}' "$c")"
    fi
    if docker exec "$c" "${health[@]}" > /dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 0.5
  done
  if [ "$healthy" != "1" ]; then
    show_container "$c"
    fail "healthcheck did not pass within 30 s"
  fi
  docker exec "$c" sh -c "test -r /app/$name && test -s /app/$name" || fail "/app/$name is missing or unreadable"
  if docker logs "$c" 2>&1 | grep -qF "$marker"; then
    show_container "$c"
    fail "the logs contain the dotenv marker"
  fi
  docker stop -t 10 "$c" > /dev/null
  local code
  code=$(docker inspect -f '{{.State.ExitCode}}' "$c")
  [ "$code" = "0" ] || { show_container "$c"; fail "exit code $code after docker stop"; }
}

case_image_config() {
  local image="$1"
  docker image inspect "$image" | jq -e --argjson cmd "$expected_cmd" '.[0].Config.Cmd == $cmd' > /dev/null \
    || fail "Cmd is $(docker image inspect -f '{{json .Config.Cmd}}' "$image")"
  docker image inspect "$image" | jq -e --argjson hc "$expected_health" '.[0].Config.Healthcheck.Test[0:4] == $hc' > /dev/null \
    || fail "Healthcheck starts with $(docker image inspect "$image" | jq -c '.[0].Config.Healthcheck.Test[0:4]')"
}

if [ "${1:-}" = "--case" ]; then
  set -e
  case "$2" in
    control) case_control "$3" "$4" ;;
    .env | .env.production | .env.local) case_dotenv "$3" "$4" "$2" ;;
    image-config) case_image_config "$3" ;;
    *) fail "unknown case $2" ;;
  esac
  exit 0
fi

image="${1:?usage: image-dotenv.sh <image>}"
dir="$(mktemp -d)"
chmod 0755 "$dir"
: > "$dir/containers"

cleanup() {
  while read -r c; do
    docker rm -f "$c" > /dev/null 2>&1 || true # the container may be gone already
  done < "$dir/containers"
  rm -rf "$dir"
}
trap cleanup EXIT

status=0
for name in control .env .env.production .env.local image-config; do
  bash "$0" --case "$name" "$image" "$dir" 2> "$dir/reason"
  code=$?
  if [ "$code" = "0" ]; then
    echo "ok: $name"
  else
    echo "FAIL: $name: $(tail -n 1 "$dir/reason")"
    status=1
  fi
done
exit "$status"
