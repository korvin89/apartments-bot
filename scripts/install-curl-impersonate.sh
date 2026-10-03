#!/usr/bin/env bash
# Downloads curl-impersonate (needed for halooglasi.com, which sits behind Cloudflare)
# into ./bin for the current OS/CPU. Version and checksums are pinned.
# Usage: scripts/install-curl-impersonate.sh
set -euo pipefail

VERSION="v2.2.3"
cd "$(dirname "$0")/.."

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  ASSET="x86_64-linux-gnu";  SHA="ca7c8aae49e33260d3a2400db16c7737aaf04692d606a843502056b42990f989" ;;
  Linux-aarch64) ASSET="aarch64-linux-gnu"; SHA="5e71795b971f32be8f3d7785895f4dceb232f04414f5a067db266432a5b08657" ;;
  Darwin-arm64)  ASSET="arm64-macos";       SHA="2569f4139460fcb301484d37938de91b1c220efd15487ee22a9db554262062fe" ;;
  Darwin-x86_64) ASSET="x86_64-macos";      SHA="4686806d59abea93866a917c3025a049ef3d7a3240de742ad66bd1a4d9890dc7" ;;
  *) echo "Unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

FILE="curl-impersonate-${VERSION}.${ASSET}.tar.gz"
URL="https://github.com/lexiforest/curl-impersonate/releases/download/${VERSION}/${FILE}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading ${FILE}"
curl -fsSL -o "$TMP/$FILE" "$URL"

if command -v sha256sum >/dev/null; then ACTUAL="$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)"; else ACTUAL="$(shasum -a 256 "$TMP/$FILE" | cut -d' ' -f1)"; fi
if [ "$ACTUAL" != "$SHA" ]; then
  echo "Checksum mismatch for ${FILE}: expected ${SHA}, got ${ACTUAL}" >&2
  exit 1
fi

mkdir -p bin/curl-impersonate-licenses
tar -xzf "$TMP/$FILE" -C "$TMP"
install -m 755 "$TMP/curl-impersonate" bin/curl-impersonate
cp "$TMP"/LICENSE* bin/curl-impersonate-licenses/ 2>/dev/null || true

bin/curl-impersonate --version | head -1
echo "Installed to bin/curl-impersonate"
