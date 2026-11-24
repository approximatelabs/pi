#!/bin/sh
# Install pia: pi with an Affordance agent core.
#
#   curl -fsSL https://raw.githubusercontent.com/approximatelabs/pi/affordance/install-pia.sh | sh
#
# It installs, from npm, into ~/.local/share/pia (PIA_HOME to change it):
#   - pi 1.5.1 (@earendil-works/pi-coding-agent),
#   - this fork's agent core in place of pi's (packages/agent/earendil-works-pi-agent-core-1.5.1.tgz),
#   - Affordance (affordance-rs, the `affordance` command for macOS and Linux),
# and puts the `pia` command in ~/.local/bin (PIA_BIN to change it). Run it again to update.
# It needs Node.js 22.19 or newer. Nothing outside those two folders is changed.
set -eu

home=${PIA_HOME:-$HOME/.local/share/pia}
bindir=${PIA_BIN:-$HOME/.local/bin}
branch=${PIA_BRANCH:-affordance}
raw="https://raw.githubusercontent.com/approximatelabs/pi/$branch"

say() { printf '%s\n' "$*"; }
fail() { printf 'pia: %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 22.19 or newer is needed: https://nodejs.org"
command -v npm >/dev/null 2>&1 || fail "npm is needed (it comes with Node.js)"
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' \
  || fail "Node.js 22.19 or newer is needed; this is $(node --version)"
if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q "$1" -O "$2"; }
else fail "curl or wget is needed"; fi

say "Installing pia into $home"
mkdir -p "$home/bin" "$bindir"
fetch "$raw/packages/agent/earendil-works-pi-agent-core-1.5.1.tgz" "$home/pi-agent-core.tgz"
fetch "$raw/pia" "$home/pia"
chmod +x "$home/pia"

# pi, with every copy of its agent core replaced by this fork's, and Affordance.
cat > "$home/package.json" <<'JSON'
{
  "private": true,
  "dependencies": {
    "@earendil-works/pi-coding-agent": "1.5.1",
    "@earendil-works/pi-agent-core": "file:./pi-agent-core.tgz",
    "affordance-rs": "0.2.0"
  },
  "overrides": {
    "@earendil-works/pi-agent-core": "$@earendil-works/pi-agent-core"
  }
}
JSON
(cd "$home" && npm install --ignore-scripts --no-audit --no-fund --loglevel=error)

# The layout `pia` looks for: node_modules/ and bin/affordance beside it.
ln -sf "$home/node_modules/.bin/affordance" "$home/bin/affordance"
ln -sf "$home/pia" "$bindir/pia"

"$home/bin/affordance" --version >/dev/null 2>&1 || fail "the affordance command did not start on this machine"
test -d "$home/node_modules/@earendil-works/pi-agent-core/affordance" || fail "the agent core in place is not this fork's"

say "Installed: $bindir/pia"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) say "Add $bindir to your PATH to run it by name, for example:"
     say "  echo 'export PATH=\"$bindir:\$PATH\"' >> ~/.zshrc" ;;
esac
say "Then run: pia"
say "pia is pi with every option and setting it has (models, providers, keys); see https://github.com/approximatelabs/pi"
