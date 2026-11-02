# LuCi-Sing-Box

[Русский](README.md) · English

**Manage Sing-Box on your OpenWrt router through a web interface.** Add VLESS subscriptions, choose servers, check latency and decide which websites should use your VPN.

[Download](https://github.com/GuardConnect/luci-app-sing-box/releases/latest) · [Report an issue](https://github.com/GuardConnect/luci-app-sing-box/issues)

## Features

- Multiple subscriptions with automatic updates.
- Different servers for individual websites or all traffic sent to Sing-Box.
- Routing through PBR or built-in automatic capture.
- Rules for domains, IP addresses and website categories (geosite).
- Server latency and connectivity checks.
- HTTPS DNS Proxy integration, DNS settings and subscription HWID.
- Core updates, live logs and a configuration editor.
- Russian and English interface.

## Installation

Tested on **OpenWrt 25.12.6 x86/64** with **Sing-Box 1.14.4**. Install the **Sing-Box core 1.14.4 or newer** separately. Other architectures have not been tested on real devices yet.

1. Back up your router settings.
2. Download `luci-app-sing-box-0.1.0-r8.apk` from [Releases](https://github.com/GuardConnect/luci-app-sing-box/releases/latest) and copy it to `/tmp` on the router.
3. Connect to the router over SSH and run:

```sh
apk update
apk add --allow-untrusted /tmp/luci-app-sing-box-0.1.0-r8.apk
```

`--allow-untrusted` is required because the package is currently unsigned. If installation reports a missing compatible Sing-Box dependency, install the core first.

Open **Services → Sing-Box** in OpenWrt.

## First setup

1. **Subscription:** paste your provider's subscription URL and load the servers.
2. **Network:** select your internet uplink, such as `wan (eth0)`, then create the Sing-Box interface and firewall rules.
3. **Routing:** choose how traffic reaches Sing-Box:
   - **With PBR:** select the new interface in the relevant PBR policies.
   - **Without PBR:** disable PBR and other conflicting routing tools, then select automatic capture. It supports IPv4.
4. On the same tab, choose a server as the **default outbound** or assign servers to individual rules. The initial default is **Direct connection**, which does not use the VPN.
5. Enable Sing-Box in **Settings**, then click **Save and apply**.

Use **Ping** to check your servers. If the connection fails, open **Log**.

## Screenshots

Private values are replaced with examples. Screenshots show the Russian interface; English is also available.

![Subscriptions](docs/screenshots/singbox-subscription.png)

<details>
<summary>Routing, settings, DNS and updates</summary>

![Routing](docs/screenshots/singbox-routing.png)
![Settings](docs/screenshots/singbox-settings.png)
![DNS](docs/screenshots/singbox-dns.png)
![Versions](docs/screenshots/singbox-versions.png)

</details>

## Learn more

- [Detailed guide and limitations](docs/GUIDE.en.md)
- [Build from source](docs/BUILD.md)
- [Validation](VALIDATION.md)
- [Changelog](CHANGELOG.md)

An independent project, not an official OpenWrt or SagerNet product. Code: MIT. Emoji artwork: CC BY 4.0.
