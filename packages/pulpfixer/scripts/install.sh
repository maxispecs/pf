#!/usr/bin/env bash
# Install pf (the pulpfixer CLI) on this machine.
#
#   scripts/install.sh                  install the latest published version from the cellars registry
#   scripts/install.sh --from-source    build this monorepo checkout, pack its packages and install them globally
#   scripts/install.sh --host           set up an EC2 instance (as root; `pf host install` sends this via SSM)
#
# Options:
#   --yes          do not ask before removing the legacy pulpfixer 1.x global
#   --dry-run      print what would happen, change nothing
#   --registry U   registry URL (default: the cellars staging registry)
#   --no-setup     skip `pf setup` at the end
#   --plugin N     also install the registry plugin N (@pf-plugins/N) with `pf plugin install` (repeatable)
#
# Host options (with --host; the rest are passed to `pf host init`):
#   --secrets S    ssm (default) or secretsmanager: where NPM_TOKEN and the agent key live
#   --prefix P     secret name prefix (default /pulpfixer: /pulpfixer/npm-token, /pulpfixer/anthropic-api-key)
#   --region R     AWS region (default: the instance's)
#   --service U    systemd unit the agent may restart (repeatable)
#   --budget USD   spending cap per agent run
#   --timer        daily `pf host update` systemd timer
#   --no-agent     do not install Claude Code
#
# pf is a monorepo: the `pulpfixer` package pulls in @pulpfixer/kit and the built-in plugins as
# dependencies, so one `npm install -g` is enough. Plugins from the registry live in ~/.pf/plugins
# (managed with `pf plugin`); `pf update` updates pf, those plugins and registry skills together.
#
# If npm's global directory is not writable by you (Homebrew Node owned by root: EACCES), the script
# switches npm to a user prefix (~/.npm-global, or PF_NPM_PREFIX) and adds its bin to your shell rc.
#
# Needs Node >= 18 and npm (--host installs Node with dnf/yum/apt when it is missing).
# pf and its packages are public on cellars, so installing needs no token. An auth line in
# ~/.npmrc (NPM_TOKEN, token from #frontend) is only for publishing and private registry plugins;
# --host reads the token from SSM or Secrets Manager with the instance role.
# A token is never written or printed.
set -euo pipefail

PACKAGE="pulpfixer"
REGISTRY="https://cellars.staging.pangenea.com/"
FROM_SOURCE=0
YES=0
DRY=0
SETUP=1
HOST=0
AGENT=1
SECRETS="ssm"
PREFIX="/pulpfixer"
AWS_REGION_ARG=""
INIT_ARGS=()
PLUGINS=()

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
    --plugin) shift; PLUGINS+=("${1:?--plugin needs a name}") ;;
    --registry) shift; REGISTRY="${1:?--registry needs a URL}" ;;
    --host) HOST=1; YES=1; SETUP=0 ;;
    --no-agent) AGENT=0 ;;
    --secrets) shift; SECRETS="${1:?--secrets needs ssm or secretsmanager}"; INIT_ARGS+=(--secrets "$SECRETS") ;;
    --prefix) shift; PREFIX="${1:?--prefix needs a value}"; INIT_ARGS+=(--prefix "$PREFIX") ;;
    --region) shift; AWS_REGION_ARG="${1:?--region needs a value}"; INIT_ARGS+=(--region "$AWS_REGION_ARG") ;;
    --service) shift; INIT_ARGS+=(--service "${1:?--service needs a unit}") ;;
    --budget) shift; INIT_ARGS+=(--budget "${1:?--budget needs a number}") ;;
    --timer) INIT_ARGS+=(--timer) ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

say "${O}${B}pf${Z} ${B}install${Z}"
[ "$DRY" = 1 ] && say "${D}(dry run: nothing is changed)${Z}"

# 0. Host mode: root, Node from the OS, the registry token read with the instance role
if [ "$HOST" = 1 ]; then
  [ "$FROM_SOURCE" = 0 ] || die "--host installs from the registry; drop --from-source"
  [ "$(id -u)" = 0 ] || [ "$DRY" = 1 ] || die "--host needs root (SSM Run Command runs as root; locally use sudo)"
  export HOME="${HOME:-/root}"
  if ! command -v node >/dev/null 2>&1; then
    if command -v dnf >/dev/null 2>&1; then run dnf install -y nodejs npm
    elif command -v yum >/dev/null 2>&1; then run yum install -y nodejs npm
    elif command -v apt-get >/dev/null 2>&1; then run apt-get update -q; DEBIAN_FRONTEND=noninteractive run apt-get install -y -q nodejs npm
    else die "Node is missing and no dnf, yum or apt-get to install it"; fi
  fi
  command -v aws >/dev/null 2>&1 || die "the aws CLI is missing: install awscli, it reads secrets with the instance role"
  REGION_FLAG=()
  [ -n "$AWS_REGION_ARG" ] && REGION_FLAG=(--region "$AWS_REGION_ARG")
  if [ "$SECRETS" = ssm ]; then
    TOKEN_CMD=(aws ssm get-parameter --name "${PREFIX%/}/npm-token" --with-decryption --query Parameter.Value --output text "${REGION_FLAG[@]+"${REGION_FLAG[@]}"}")
  elif [ "$SECRETS" = secretsmanager ]; then
    TOKEN_CMD=(aws secretsmanager get-secret-value --secret-id "${PREFIX#/}/npm-token" --query SecretString --output text "${REGION_FLAG[@]+"${REGION_FLAG[@]}"}")
  else die "--secrets must be ssm or secretsmanager"; fi
  if [ "$DRY" = 1 ]; then
    printf '  %swould read NPM_TOKEN with:%s %s\n' "$D" "$Z" "${TOKEN_CMD[*]}"
  else
    # Only this process and npm see the token. It is never written or printed.
    NPM_TOKEN="$("${TOKEN_CMD[@]}")" || die "cannot read the registry token with ${TOKEN_CMD[*]} (check the instance role)"
    export NPM_TOKEN
  fi
  run mkdir -p /etc/pulpfixer
  if [ "$DRY" = 0 ]; then
    HOST_NAME="${REGISTRY#*://}"; HOST_NAME="${HOST_NAME%%/*}"
    ( umask 077; printf '//%s/:_authToken=${NPM_TOKEN}\n' "$HOST_NAME" > /etc/pulpfixer/npmrc )
  fi
  export NPM_CONFIG_USERCONFIG=/etc/pulpfixer/npmrc
fi

# 1. Node and npm
command -v node >/dev/null 2>&1 || die "Node is not installed. Install Node >= 18 first (https://nodejs.org)."
command -v npm  >/dev/null 2>&1 || die "npm is not installed."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $(node -v) is too old: pf needs Node >= 18."
ok "Node $(node -v), npm $(npm -v)"

# 1b. A global prefix this user cannot write to (Homebrew's /opt/homebrew/lib/node_modules owned by
#     root, a system Node in /usr/local) makes `npm install -g` fail with EACCES. Switch to a
#     user-owned prefix instead of sudo: it never touches the system directories. (--host runs as
#     root and keeps the system prefix.)
if [ "$HOST" = 0 ]; then
  GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
  GLOBAL_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  # The directory npm writes into: the global node_modules, or the prefix while it does not exist yet.
  WRITE_DIR="$GLOBAL_ROOT"; [ -d "$WRITE_DIR" ] || WRITE_DIR="$GLOBAL_PREFIX"
  if [ -n "$WRITE_DIR" ] && [ ! -w "$WRITE_DIR" ]; then
    USER_PREFIX="${PF_NPM_PREFIX:-$HOME/.npm-global}"
    warn "npm's global directory $WRITE_DIR is not writable by you: using the user prefix $USER_PREFIX (no sudo)"
    run mkdir -p "$USER_PREFIX"
    run npm config set prefix "$USER_PREFIX"
    export PATH="$USER_PREFIX/bin:$PATH"
    RC="$HOME/.$(basename "${SHELL:-/bin/zsh}")rc"
    PATH_LINE="export PATH=\"$USER_PREFIX/bin:\$PATH\""
    if [ -f "$RC" ] && grep -qF "$USER_PREFIX/bin" "$RC"; then
      ok "$USER_PREFIX/bin is already on PATH in $RC"
    elif [ "$DRY" = 1 ]; then
      printf '  %swould append to %s:%s %s\n' "$D" "$RC" "$Z" "$PATH_LINE"
    else
      printf '%s\n' "$PATH_LINE" >> "$RC"
      ok "added $USER_PREFIX/bin to PATH in $RC (open a new terminal, or: source $RC)"
    fi
  fi
fi

# 2. Registry auth (optional; presence only, never the token)
REG_HOST="${REGISTRY#*://}"; REG_HOST="${REG_HOST%%/*}"
NPMRC="${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}"
if [ "$FROM_SOURCE" = 0 ] && [ "$HOST" = 0 ]; then
  if [ -f "$NPMRC" ] && grep -q "^//${REG_HOST}/:_authToken=" "$NPMRC"; then
    ok "registry auth line for $REG_HOST found in $NPMRC"
  elif [ -n "${NPM_TOKEN:-}" ]; then
    ok "no auth line for $REG_HOST in $NPMRC (not needed: pf is public); pf setup can add one that reads \$NPM_TOKEN"
  else
    ok "no registry auth needed: pf is public on $REG_HOST"
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
  ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
  [ -f "$ROOT/pnpm-workspace.yaml" ] || die "cannot find the monorepo root from $0"
  command -v pnpm >/dev/null 2>&1 || die "building from source needs pnpm."
  say "Building from source in $ROOT"
  [ -d "$ROOT/node_modules" ] || run pnpm --dir "$ROOT" install
  run pnpm --dir "$ROOT" build
  # pnpm pack turns the workspace:* dependencies into real versions; npm installs the tarballs together.
  PACKS="$(mktemp -d)"
  for pkg in kit plugin-aws plugin-yubikey core; do run pnpm --dir "$ROOT/packages/$pkg" pack --pack-destination "$PACKS"; done
  run npm install -g "$PACKS"/*.tgz
  rm -rf "$PACKS"
else
  say "Installing $PACKAGE from $REGISTRY"
  run npm install -g "$PACKAGE@latest" --registry "$REGISTRY"
fi

# 5. Verify and set up
if [ "$DRY" = 1 ]; then
  say ""; say "${D}dry run finished${Z}"; exit 0
fi
export PATH="$PATH:$(npm prefix -g)/bin"
command -v pf >/dev/null 2>&1 || die "installed, but \`pf\` is not on PATH. Add \"$(npm prefix -g)/bin\" to PATH."
ok "pf is on PATH: $(command -v pf)"
if [ "${#PLUGINS[@]}" -gt 0 ]; then
  say "Installing plugins"
  for plugin in "${PLUGINS[@]}"; do
    pf plugin install "$plugin" || warn "could not install plugin $plugin: retry with pf plugin install $plugin"
  done
fi
if [ "$HOST" = 1 ]; then
  if [ "$AGENT" = 1 ] && ! command -v claude >/dev/null 2>&1; then
    npm install -g @anthropic-ai/claude-code || die "could not install Claude Code"
  fi
  unset NPM_TOKEN
  pf host init "${INIT_ARGS[@]+"${INIT_ARGS[@]}"}"
  pf host login || warn "pf host login reported problems (see above): fix the IAM role or secrets, then rerun pf host login"
  say ""
  say "${G}Done.${Z} Try ${B}pf host fix \"check for pending security patches\"${Z}"
  exit 0
fi
if [ "$SETUP" = 1 ]; then
  pf setup --yes || warn "pf setup reported items needing attention: run pf doctor"
fi
say ""
say "${G}Done.${Z} Run ${B}pf${Z} inside a repo for its menu, or anywhere for the fallback menu."
