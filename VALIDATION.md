# Validation — v0.1.0

Platform: OpenWrt 25.12.6 x86/64; Sing-Box 1.14.4. Date: 2026-11-02.

- 45 backend unit/regression tests, 7 core manager tests and 3 recovery tests passed on Linux/OpenWrt.
- All 8 frontend/translation suites passed; 509 translation entries.
- All 9 installed tabs rendered in isolated Chrome with no detected JavaScript errors.
- Real isolated VLESS succeeds with correct UUID and fails with invalid UUID without direct fallback.
- Parallel ICMP/TCP results, DNS sharing within a job, individual node errors and progress verified.
- Authenticated cancellation stops workers/temporary cores, cleans files and permits immediate restart.
- Actual RE2 and official geosite rule-set checks passed in isolated loopback core.
- Automatic TUN/policy routes/nftables started in a separate network namespace; host routes were unchanged.
- Deployment/smoke checks preserved production configuration and service state.

Recovery failures are tested with isolated mocks; no deliberate live production outage or real core upgrade was performed in this audit. Other architectures and other LuCI themes are not certified by these checks. Tests do not prove the absence of every possible defect. Screenshots use anonymized display data, not claimed benchmark results.

Release APK: standalone noarch 0.1.0-r8 built with apk-tools 3.0.8 in compatibility mode 3.0.0. OpenWrt apk 3.0.5 accepts the upgrade simulation with installed dependencies. Package payload was extracted for comparison against build inputs; no live installation or service restart is needed for this packaging verification.
