#!/bin/zsh
export EDITOR=vim
alias ll='ls -la'

# Create a directory and enter it
mkcd() {
  mkdir -p "$1" && cd "$1"
}

# Extract any archive
extract() {
  case "$1" in
    *.tar.gz|*.tgz) tar xzf "$1" ;;
    *.zip)          unzip "$1" ;;
    *.gz)           gunzip "$1" ;;
    *)              echo "unknown archive: $1" ;;
  esac
}

path_prepend() { [[ ":$PATH:" == *":$1:"* ]] || PATH="$1:$PATH"; }
