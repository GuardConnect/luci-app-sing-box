#!/bin/sh
if [ -z "$IPKG_INSTROOT" ]; then
    /etc/init.d/singbox-gui stop
    /etc/init.d/singbox-gui disable
    [ ! -f /etc/crontabs/root ] || sed -i '/# luci-singbox-subscriptions$/d' /etc/crontabs/root
    /etc/init.d/cron reload
fi
exit 0
