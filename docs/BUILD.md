# Building

## OpenWrt SDK

Place this repository at `package/luci-app-sing-box` in a compatible OpenWrt 25.12 SDK. Update/install the SDK feeds, select the package and dependencies in menuconfig, then run:

```sh
make package/luci-app-sing-box/compile V=s
```

The UI/backend is interpreted (JavaScript/Python), with no application-specific native binary. The separate Sing-Box dependency must support the 1.14 configuration APIs used here. SDK metadata cannot guarantee that an older feed core implements those APIs.

## Standalone APK

On Linux, supply a trusted apk-tools 3 executable supporting `mkpkg` (the stripped OpenWrt runtime apk may not include that command). No build tool is downloaded by this command:

```sh
GUI_ONLY=1 APK_TOOL=/absolute/path/to/apk.static BUILD_DIR=/tmp/singbox-build sh tools/build-router.sh
```

Output: `/tmp/singbox-build/artifacts/luci-app-sing-box-0.1.0-r8.apk`. The script stages clean defaults, normalizes permissions and excludes Python bytecode. This APK is unsigned. Production release automation should sign artifacts using an independently managed package-signing key.

Omitting GUI_ONLY additionally repackages the pinned official x86_64 musl Sing-Box 1.14.4 binary after checking its hardcoded SHA-256. This optional path is architecture-specific and is not necessary to build the UI. No third-party core binary is included in this repository or the initial release assets.

## Tests and translations

From the repository parent (directory must be named `luci-app-sing-box`):

```sh
for f in luci-app-sing-box/tests/test_*.cjs; do node "$f" || exit; done
```

Backend suites require Linux, Python 3 and, for actual configuration checks, compatible Sing-Box in PATH. Router integration tests require OpenWrt tooling/root privileges and must be reviewed before running. The unit suites mock configuration mutations; real engine tests use temporary loopback listeners or a separate network namespace.

```sh
python3 tests/test_backend.py
python3 tests/test_core_manager.py
python3 tests/test_recovery.py
python3 tools/build-i18n.py
```

Source assets contain the pinned Twemoji SVG set and its license; rebuilding translations does not need a network connection. `tools/vendor-emoji.py` is the optional asset regeneration helper.
