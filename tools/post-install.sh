#!/bin/sh
if [ -z "$IPKG_INSTROOT" ]; then
    mkdir -p /etc/singbox-gui
    chmod 700 /etc/singbox-gui
    chmod 600 /etc/config/singbox_gui
    if ! uci -q get singbox_gui.main.dns_mode >/dev/null; then
        uci set singbox_gui.main.dns_mode=https_dns_proxy
        uci commit singbox_gui
    fi
    rm -f /tmp/luci-indexcache /tmp/luci-indexcache.*
    rm -f /tmp/luci-modulecache/*
    /etc/init.d/rpcd reload
    /usr/libexec/singbox-gui install-schedule
fi
exit 0
