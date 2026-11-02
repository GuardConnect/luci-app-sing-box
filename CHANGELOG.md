# Changelog

## v0.1.1 — 2026-11-02

- Fix native routing condition groups to match Throne and Sing-Box 1.14.4; preserve explicit OR and safe inversion scope.
- Merge geosite, GeoIP and custom rule-set references without overwriting.
- Reject boolean/float profile versions and IP versions.
- Add 100 real request comparisons against native rules and five JSON contract tests.
- Include earlier automatic TUN/DNS compatibility fixes; no live router installation is performed by the tests.
- Existing AND profiles with multiple fields in the same native group intentionally change to native semantics on re-apply; see docs/ROUTING-SEMANTICS.md.

## v0.1.0 вЂ” 2026-11-02

Initial public release; APK version 0.1.0-r8.

- Nine-tab Russian/English LuCI interface, independent language selection and bundled emoji.
- Named VLESS subscriptions, default source, scheduled refresh, import and per-source HWID registration.
- Ordered routing builder with RE2, geosite/GeoIP rule-sets, explicit per-rule nodes, PBR and optional automatic IPv4 capture.
- Primary dnsmasq/HTTPS DNS Proxy integration and separate internal DNS options.
- Bounded parallel ICMP, TCP Connect and real VLESS URL checks, explicit resolver and cancellation.
- Core version management, validated manual JSON editing and live logs.
- Apply/core switch recovery, isolated subscription downloads, robust RPC/probe errors and strict routing imports.

Known limits: automatic capture is IPv4-only; live platform coverage is x86/64 OpenWrt 25.12.6. TCP Connect does not authenticate VLESS; use URL mode for that. ECH may prevent domain detection. No XHTTP/VLESS Encryption/Clash import. Provider-side HWID reset is not supported. The app uses modern Sing-Box 1.14 APIs and is not compatible with older cores. The standalone APK is unsigned.
