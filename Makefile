include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-sing-box
PKG_VERSION:=0.1.1
PKG_RELEASE:=3
PKG_LICENSE:=MIT CC-BY-4.0

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-sing-box
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=LuCI VLESS subscription manager for sing-box and PBR
  DEPENDS:=+luci-base +rpcd +sing-box +python3 +curl +ca-bundle +kmod-tun +resolveip
  PKGARCH:=all
endef

define Build/Compile
endef

define Package/luci-app-sing-box/install
	$(INSTALL_DIR) $(1)
	$(CP) ./root/* $(1)/
	find $(1) -type d -name __pycache__ -prune -exec rm -rf {} +
	find $(1) -type f -name '*.pyc' -exec rm -f {} +
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/sing-box
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/sing-box/*.js $(1)/www/luci-static/resources/view/sing-box/
	$(INSTALL_DATA) ./htdocs/luci-static/resources/singbox-ui.js $(1)/www/luci-static/resources/
	$(INSTALL_DATA) ./htdocs/luci-static/resources/singbox-i18n.js $(1)/www/luci-static/resources/
	$(INSTALL_DATA) ./htdocs/luci-static/resources/singbox-routing.js $(1)/www/luci-static/resources/
	$(INSTALL_DATA) ./htdocs/luci-static/resources/singbox-choices.js $(1)/www/luci-static/resources/
	$(CP) ./htdocs/luci-static/resources/singbox-emoji $(1)/www/luci-static/resources/
	find $(1) -type d -exec chmod 755 {} +
	find $(1) -type f -exec chmod 644 {} +
	chmod 755 $(1)/etc/init.d/singbox-gui $(1)/etc/hotplug.d/iface/95-singbox-gui $(1)/usr/libexec/singbox-gui $(1)/usr/libexec/rpcd/luci.singbox
	chmod 755 $(1)/usr/libexec/singbox-gui-core $(1)/usr/libexec/singbox-core-manager $(1)/usr/libexec/rpcd/luci.singbox.core
	chmod 600 $(1)/etc/config/singbox_gui
endef

define Package/luci-app-sing-box/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
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
exit 0
endef

define Package/luci-app-sing-box/conffiles
/etc/config/singbox_gui
/etc/singbox-gui/
endef

define Package/luci-app-sing-box/prerm
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
/etc/init.d/singbox-gui stop
/etc/init.d/singbox-gui disable
[ ! -f /etc/crontabs/root ] || sed -i '/# luci-singbox-subscriptions$$/d' /etc/crontabs/root
/etc/init.d/cron reload
exit 0
endef

$(eval $(call BuildPackage,luci-app-sing-box))
