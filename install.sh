#!/usr/bin/env bash
# Installs Remote Codex Control on a Mac and starts the guided setup.
#
# One-line form, which keeps the terminal attached for the setup questions:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/PATELOM925/Remote-Codex-Control-Public/main/install.sh)"
#
# Safe to run twice. An existing clone is updated with git pull --ff-only.
set -euo pipefail

REPO_URL="https://github.com/PATELOM925/Remote-Codex-Control-Public.git"
REPO_SLUG="PATELOM925/Remote-Codex-Control-Public"
INSTALL_DIR="${RCC_DIR:-$HOME/Remote-Codex-Control}"
START_DIR="$(pwd)"

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed. Install the Command Line Tools with: xcode-select --install"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Install Node 22.5 or newer from https://nodejs.org, or run: brew install node"
fi

if ! node -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 22 || (a === 22 && b >= 5) ? 0 : 1)"; then
  fail "Node $(node -p 'process.versions.node') is too old. Install Node 22.5 or newer, then run this again."
fi

# True when the folder is a git clone of this public repo.
is_rcc_clone() {
  local origin
  origin="$(git -C "$1" config --get remote.origin.url 2>/dev/null || true)"
  case "$origin" in
    "https://github.com/$REPO_SLUG" | "https://github.com/$REPO_SLUG.git" | "git@github.com:$REPO_SLUG.git")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

if [ -e "$INSTALL_DIR" ]; then
  if [ -d "$INSTALL_DIR/.git" ] && is_rcc_clone "$INSTALL_DIR"; then
    echo "Updating the existing install in $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    fail "$INSTALL_DIR exists and is not a Remote Codex Control clone. Set RCC_DIR to an empty folder and run this again."
  fi
else
  echo "Cloning into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

(cd "$INSTALL_DIR" && npm ci)

# Run the wizard from the folder the user started in, so its default project folder is that folder.
# --prefix points npm at the install. The wizard stays attached to the terminal.
echo "Starting the guided setup"
cd "$START_DIR"
if [ -t 0 ]; then
  npm --prefix "$INSTALL_DIR" run setup
elif (: </dev/tty) 2>/dev/null; then
  npm --prefix "$INSTALL_DIR" run setup </dev/tty
else
  fail "No terminal is attached. Run this in Terminal, or run: cd \"$INSTALL_DIR\" && npm run setup"
fi
