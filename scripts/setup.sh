#!/usr/bin/env sh
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

major="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "$major" != "20" ]; then
  echo "Node.js 20 is required; found $(node --version)." >&2
  exit 1
fi

npm ci
printf '%s\n' "FixLab dependencies are installed. Run 'npm run validate'."
