#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ;;
  *) echo 'This setup command expects an Apple Silicon Mac.' >&2; exit 1 ;;
esac
python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else "Python 3.12 is required.")'

node_version=v22.23.5
browser_version=158.0.8127.36
runtime="$repo/../runtime"
mkdir -p "$runtime/downloads" "$runtime/cache" "$runtime/tmp"
runtime=$(CDPATH= cd -- "$runtime" && pwd)
downloads="$runtime/downloads"
export TMPDIR="$runtime/tmp" PIP_CACHE_DIR="$runtime/cache/pip" PIP_DISABLE_PIP_VERSION_CHECK=1
export npm_config_cache="$runtime/cache/npm" PYTHONPYCACHEPREFIX="$runtime/pycache"
export SUPPORT_RUNTIME="$runtime"
export LC_ALL=C

download() {
  url=$1
  name=$2
  digest=$3
  if [ ! -f "$downloads/$name" ]; then
    curl -fLsS --retry 2 --max-time 180 "$url" -o "$downloads/$name.part"
    mv "$downloads/$name.part" "$downloads/$name"
  fi
  if ! (cd "$downloads" && printf '%s  %s\n' "$digest" "$name" | shasum -a 256 -c -); then
    rm -f "$downloads/$name"
    return 1
  fi
}

node_archive="node-$node_version-darwin-arm64.tar.gz"
download "https://nodejs.org/dist/$node_version/$node_archive" "$node_archive" \
  e7131995759b61a0170b646010d2ad35a5d37b4cb0d471f3e8317eac6f742f3d
tar -xzf "$downloads/$node_archive" -C "$runtime"
PATH="$runtime/node-$node_version-darwin-arm64/bin:$PATH"
export PATH
npm ci --no-fund --no-audit

base="https://storage.googleapis.com/chrome-for-testing-public/$browser_version/mac-arm64"
download "$base/chrome-headless-shell-mac-arm64.zip" chrome-headless-shell-mac-arm64.zip \
  c24d40a3786322ff3a5e3ac6eed162226cbaf07ebe468715407827226b0f8897
download "$base/chromedriver-mac-arm64.zip" chromedriver-mac-arm64.zip \
  e44347354ea6a7b666e4ef03803974e1344f78ce9c4466acd896ea6af53136e8
unzip -qo "$downloads/chrome-headless-shell-mac-arm64.zip" -d "$runtime"
unzip -qo "$downloads/chromedriver-mac-arm64.zip" -d "$runtime"

python3 -m venv "$runtime/venv"
python="$runtime/venv/bin/python"
"$python" -m pip install -r ml/requirements.txt
"$python" -m ml.dataset
"$python" -m ml.train
