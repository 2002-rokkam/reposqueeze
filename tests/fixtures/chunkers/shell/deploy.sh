#!/usr/bin/env bash
# Deploy helper: builds, tags and ships an image.
set -euo pipefail

REGISTRY="${REGISTRY:-registry.example.com}"

usage() {
  cat <<EOF
Usage: $0 <build|push|release> [options]
  build    build the image
  push     push the image
EOF
}

log() { printf '[%s] %s\n' "$(date +%T)" "$*" >&2; }

build_image() {
  local tag="$1"
  log "building ${tag}"
  docker build --pull -t "${REGISTRY}/app:${tag}" .
}

function push_image {
  local tag="$1"
  if [ -z "${tag}" ]; then
    log "missing tag"
    return 1
  fi
  docker push "${REGISTRY}/app:${tag}"
}

main() {
  local cmd="${1:-}"
  case "${cmd}" in
    build)
      build_image "${2:-latest}"
      ;;
    push)
      push_image "${2:-latest}"
      ;;
    release)
      build_image "$2" && push_image "$2"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
