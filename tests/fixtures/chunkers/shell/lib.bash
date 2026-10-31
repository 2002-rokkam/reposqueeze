# shellcheck shell=bash
# Library of helpers sourced by other scripts.

is_tty() { [[ -t 1 ]]; }

die() {
  echo "error: $*" >&2
  exit 1
}

with_retries() {
  local attempts=$1; shift
  local n=0
  until "$@"; do
    n=$((n + 1))
    [[ $n -ge $attempts ]] && return 1
    sleep $((n * 2))
  done
}

write_config() {
  cat > "$1" <<'EOS'
function not_a_function() {
  echo "inside a quoted heredoc }"
}
EOS
}

declare -A COLORS=([red]=31 [green]=32)
colorize() {
  local color="${COLORS[$1]}"
  printf '\033[%sm%s\033[0m\n' "${color}" "$2"
}
