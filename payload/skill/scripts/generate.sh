#!/bin/sh
# commit-intent bootstrap — locates a modern node and runs generate.mjs.
# Managed by the commit-intent installer — edit in the commit-intent repo.
# Fail-open by design: this script must never block a commit, so every exit
# path (including a crashed generate.mjs) returns 0.

[ "$INTENT_SKIP" = "1" ] && exit 0
[ -n "$CI" ] && exit 0

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0

# Hooks spawned by GUI clients get a minimal PATH, and version managers often
# default to an old node — probe candidates and take the first node >= 20.
node_ok() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(parseInt(process.versions.node, 10) >= 20 ? 0 : 1)' >/dev/null 2>&1
}

NODE_BIN=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
else
  for cand in "$HOME/.nvm/versions/node/"v24*/bin/node "$HOME/.nvm/versions/node/"v22*/bin/node "$HOME/.nvm/versions/node/"v20*/bin/node "$HOME/.volta/bin/node" "$HOME/.asdf/shims/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if node_ok "$cand"; then
      NODE_BIN="$cand"
      break
    fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "commit-intent: no node >= 20 found; skipping intent doc" >&2
  exit 0
fi

"$NODE_BIN" "$DIR/generate.mjs" "$@"
exit 0
