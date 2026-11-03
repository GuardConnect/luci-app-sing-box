#!/bin/sh
# Run this script from the extracted source tree. Only staging files are temporary.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SOURCE_DIR=${SOURCE_DIR:-$(dirname "$SCRIPT_DIR")}
[ -f "$SOURCE_DIR/Makefile" ] && [ -d "$SOURCE_DIR/root" ] && [ -d "$SOURCE_DIR/htdocs" ] || {
    echo "Invalid source directory: $SOURCE_DIR" >&2
    exit 1
}
SOURCE_DIR=$(CDPATH= cd -- "$SOURCE_DIR" && pwd -P)
BUILD_DIR=${BUILD_DIR:-/tmp/singbox-build}
mkdir -p "$BUILD_DIR"
BUILD_DIR=$(CDPATH= cd -- "$BUILD_DIR" && pwd -P)
APK=${APK_TOOL:-$BUILD_DIR/apk-static/sbin/apk.static}
[ -x "$APK" ] || { echo "Prepare a trusted apk.static and set APK_TOOL to its path." >&2; exit 1; }
APK=$(CDPATH= cd -- "$(dirname -- "$APK")" && pwd -P)/$(basename -- "$APK")
STAGE=$(mktemp -d "$BUILD_DIR/stage.XXXXXX")
cleanup() {
    case "$STAGE" in "$BUILD_DIR"/stage.*) rm -rf -- "$STAGE" ;; esac
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
GUI=$STAGE/gui
CORE=$STAGE/core
mkdir -p "$GUI" "$CORE" "$BUILD_DIR/artifacts"
cd "$BUILD_DIR"
VERSION=1.14.4
if [ "${GUI_ONLY:-0}" != 1 ]; then
ARCHIVE=sing-box-$VERSION-linux-amd64-musl.tar.gz
if [ ! -f "$ARCHIVE" ]; then
    curl -fsSL --retry 2 --max-time 150 "https://github.com/SagerNet/sing-box/releases/download/v$VERSION/$ARCHIVE" -o "$ARCHIVE"
fi
echo "8f7c5f0651238850d96a0e488e5473cd77ec1a0098f63942e943f475a12057ca  $ARCHIVE" | sha256sum -c -
tar -xzf "$ARCHIVE"
mkdir -p "$CORE/usr/bin" "$CORE/usr/share/licenses/sing-box"
cp "sing-box-$VERSION-linux-amd64-musl/sing-box" "$CORE/usr/bin/"
cp "sing-box-$VERSION-linux-amd64-musl/LICENSE" "$CORE/usr/share/licenses/sing-box/"
chmod 755 "$CORE/usr/bin/sing-box"
"$CORE/usr/bin/sing-box" version
"$APK" mkpkg --compat 3.0.0 --files "$CORE" --info name:sing-box \
    --info version:$VERSION-r1 --info arch:x86_64 --info license:GPL-3.0-or-later \
    --info 'description:Official SagerNet sing-box binary, repackaged for OpenWrt 25.12 x86/64' \
    --info url:https://sing-box.sagernet.org/ \
    --info 'depends:ca-bundle kmod-tun' --output artifacts/sing-box-$VERSION-r1.apk
fi
cp -a "$SOURCE_DIR/root/." "$GUI/"
mkdir -p "$GUI/www"
cp -a "$SOURCE_DIR/htdocs/." "$GUI/www/"
find "$GUI" -type d -name __pycache__ -prune -exec rm -rf -- {} +
find "$GUI" -type f -name '*.pyc' -exec rm -f -- {} +
find "$GUI" "$CORE" -type d -exec chmod 755 {} +
find "$GUI" -type f -exec chmod 644 {} +
chmod 755 "$GUI/etc/init.d/singbox-gui" "$GUI/etc/hotplug.d/iface/95-singbox-gui" \
    "$GUI/usr/libexec/singbox-gui" "$GUI/usr/libexec/rpcd/luci.singbox" \
    "$GUI/usr/libexec/singbox-gui-core" "$GUI/usr/libexec/singbox-core-manager" "$GUI/usr/libexec/rpcd/luci.singbox.core"
chmod 600 "$GUI/etc/config/singbox_gui"
"$APK" mkpkg --compat 3.0.0 --files "$GUI" --info name:luci-app-sing-box \
    --info version:0.1.1-r2 --info arch:noarch --info 'license:MIT AND CC-BY-4.0' \
    --info 'description:LuCI VLESS subscriptions, routing, DNS and latency tests' \
    --info 'depends:luci-base rpcd sing-box>=1.14.4 python3 curl ca-bundle kmod-tun resolveip' \
    --script post-install:"$SOURCE_DIR/tools/post-install.sh" \
    --script post-upgrade:"$SOURCE_DIR/tools/post-install.sh" \
    --script pre-deinstall:"$SOURCE_DIR/tools/pre-deinstall.sh" \
    --output artifacts/luci-app-sing-box-0.1.1-r2.apk
sha256sum artifacts/*.apk
