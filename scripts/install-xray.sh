#!/usr/bin/env bash
# Downloads Xray (the VLESS client halooglasi.com can be proxied through, see README)
# into ./bin for the current OS/CPU. Version and checksums are pinned.
# Usage: scripts/install-xray.sh
set -euo pipefail

VERSION="v26.3.27"
cd "$(dirname "$0")/.."

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  ASSET="linux-64";        SHA="23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae" ;;
  Linux-aarch64) ASSET="linux-arm64-v8a"; SHA="4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c" ;;
  Darwin-arm64)  ASSET="macos-arm64-v8a"; SHA="2e93a67e8aa1936ecefb307e120830fcbd4c643ab9b1c46a2d0838d5f8409eaf" ;;
  Darwin-x86_64) ASSET="macos-64";        SHA="f5b0471d3459eff1b82e48af0aeac186abcc3298210070afbbbd8437a4e8b203" ;;
  *) echo "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

FILE="Xray-${ASSET}.zip"
URL="https://github.com/XTLS/Xray-core/releases/download/${VERSION}/${FILE}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ${FILE} ${VERSION}"
curl -fsSL -o "$TMP/$FILE" "$URL"

if command -v sha256sum >/dev/null; then ACTUAL="$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)"; else ACTUAL="$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)"; fi
if [ "$ACTUAL" != "$SHA" ]; then
  echo "Checksum mismatch for ${FILE}: expected ${SHA}, got ${ACTUAL}" >&2
  exit 1
fi

# Ubuntu cloud images have python3 but not always unzip
if command -v unzip >/dev/null; then
  unzip -oq "$TMP/$FILE" xray LICENSE -d "$TMP"
else
  python3 -c 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); [z.extract(n, sys.argv[2]) for n in ("xray", "LICENSE")]' "$TMP/$FILE" "$TMP"
fi
mkdir -p bin/xray-licenses
install -m 755 "$TMP/xray" bin/xray
cp "$TMP/LICENSE" bin/xray-licenses/

bin/xray version | head -1
echo "Installed to bin/xray"
