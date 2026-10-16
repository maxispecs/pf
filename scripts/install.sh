#!/usr/bin/env bash
# Install pf (the pulpfixer CLI) on this machine.
#
#   scripts/install.sh                  install the latest published version from the cellars registry
#   scripts/install.sh --from-source    build this checkout and link it globally (for development)
#
# Options:
#   --yes          do not ask before removing the legacy pulpfixer 1.x global
#   --dry-run      print what would happen, change nothing
#   --registry U   registry URL (default: the cellars staging registry)
#   --no-setup     skip `pf setup` at the end
#
# Needs Node >= 18 and npm. Installing from the registry needs NPM_TOKEN (token from #frontend)
# or an existing auth line for the registry in ~/.npmrc. A token is never written or printed.
set -euo pipefail

PACKAGE="pulpfixer"
REGISTRY="https://cellars.staging.pangenea.com/"
FROM_SOURCE=0
YES=0
DRY=0
SETUP=1

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; D=$'\033[2m'; R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; O=$'\033[38;5;208m'; Z=$'\033[0m'
else
  B=""; D=""; R=""; G=""; Y=""; O=""; Z=""
fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$Z" "$*"; }
die()  { printf '  %s✘%s %s\n' "$R" "$Z" "$*" >&2; exit 1; }
run()  {
  if [ "$DRY" = 1 ]; then printf '  %swould run:%s %s\n' "$D" "$Z" "$*"; else "$@"; fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from-source) FROM_SOURCE=1 ;;
    --yes|-y) YES=1 ;;
    --dry-run|-n) DRY=1 ;;
    --no-setup) SETUP=0 ;;
    --registry) shift; REGISTRY="${1:?--registry needs a URL}" ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

say "${O}${B}pf${Z} ${B}install${Z}"
[ "$DRY" = 1 ] && say "${D}(dry run: nothing is changed)${Z}"

# 1. Node and npm
command -v node >/dev/null 2>&1 || die "Node is not installed. Install Node >= 18 first (https://nodejs.org)."
command -v npm  >/dev/null 2>&1 || die "npm is not installed."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $(node -v) is too old: pf needs Node >= 18."
ok "Node $(node -v), npm $(npm -v)"

# 2. Registry auth (presence only, never the token)
HOST="${REGISTRY#*://}"; HOST="${HOST%%/*}"
NPMRC="${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
if [ "$FROM_SOURCE" = 0 ]; then
  if [ -f "$NPMRC" ] && grep -q "^//${HOST}/:_authToken=" "$NPMRC"; then
    ok "registry auth line for $HOST found in $NPMRC"
  elif [ -n "${NPM_TOKEN:-}" ]; then
    warn "no auth line for $HOST in $NPMRC: pf setup will add one that reads \$NPM_TOKEN"
  else
    die "no registry auth. Export NPM_TOKEN (token from #frontend) and rerun, or add '//${HOST}/:_authToken=\${NPM_TOKEN}' to $NPMRC."
  fi
fi

# 3. Legacy pulpfixer 1.x owns the `pf` command: remove it first
LEGACY_VERSION="$(node -e '
  const { execFileSync } = require("child_process"); const fs = require("fs"); const path = require("path");
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop();
    const v = JSON.parse(fs.readFileSync(path.join(root, "'"$PACKAGE"'", "package.json"), "utf8")).version;
    if (parseInt(v, 10) < 2) process.stdout.write(v);
  } catch {}
')"
if [ -n "$LEGACY_VERSION" ]; then
  warn "legacy pulpfixer $LEGACY_VERSION is installed globally and owns the \`pf\` command"
  REMOVE=0
  if [ "$YES" = 1 ]; then REMOVE=1
  elif [ "$DRY" = 1 ]; then REMOVE=1
  elif [ -t 0 ]; then
    printf '  %s?%s Remove it so pf v2 takes over? (y/N) ' "$O" "$Z"; read -r ANSWER || ANSWER=""
    case "$ANSWER" in y|Y|yes|YES) REMOVE=1 ;; esac
  fi
  [ "$REMOVE" = 1 ] || die "legacy pulpfixer left in place. Rerun with --yes to replace it."
  run npm rm -g "$PACKAGE"
  say "  ${D}its data in ~/.pulpfixer is not touched${Z}"
else
  ok "no legacy pulpfixer 1.x found"
fi

# 4. Install
if [ "$FROM_SOURCE" = 1 ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  [ -f "$ROOT/package.json" ] || die "cannot find the repo root from $0"
  say "Building from source in $ROOT"
  if [ ! -d "$ROOT/node_modules" ]; then
    if command -v pnpm >/dev/null 2>&1; then run pnpm --dir "$ROOT" install; else run npm --prefix "$ROOT" install; fi
  fi
  if command -v pnpm >/dev/null 2>&1; then run pnpm --dir "$ROOT" build; else run npm --prefix "$ROOT" run build; fi
  # Installing a directory links it, so rebuilding updates the global pf.
  run npm install -g "$ROOT"
else
  say "Installing $PACKAGE from $REGISTRY"
  run npm install -g "$PACKAGE@latest" --registry "$REGISTRY"
fi

# 5. Verify and set up
if [ "$DRY" = 1 ]; then
  say ""; say "${D}dry run finished${Z}"; exit 0
fi
command -v pf >/dev/null 2>&1 || die "installed, but \`pf\` is not on PATH. Add \"$(npm prefix -g)/bin\" to PATH."
ok "pf is on PATH: $(command -v pf)"
if [ "$SETUP" = 1 ]; then
  pf setup --yes || warn "pf setup reported items needing attention: run pf doctor"
fi
say ""
say "${G}Done.${Z} Run ${B}pf${Z} inside a repo for its menu, or anywhere for the fallback menu."
