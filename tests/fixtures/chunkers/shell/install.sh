#!/bin/sh
# Installer with awkward quoting.

fetch() {
  url="$1"
  INFO="$(curl -fsSL "${url}" | sed -E 's/\(|\)//g' | awk '{ print $1 }')"
  echo "${INFO}" "it's fine" 'single "quotes" {' "$(echo "nested { brace")"
}

install_all() {
  for pkg in a b c; do
    fetch "https://example.com/${pkg}.tar.gz" || {
      echo "failed: ${pkg}" >&2
      return 1
    }
  done
}

cleanup() { rm -rf "${TMPDIR:-/tmp}/installer"; }

install_all
