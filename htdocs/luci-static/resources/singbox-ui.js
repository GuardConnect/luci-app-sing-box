'use strict';
'require baseclass';
'require form';
'require rpc';
'require uci';
'require ui';
'require poll';
'require singbox-i18n as i18n';
'require singbox-choices as choices';

function T(text) { return i18n.tr(text); }

// Native LuCI tabs are intentionally absent; all package navigation uses its saved language.
if (ui.menu && ui.menu.flushCache) ui.menu.flushCache();

var status = rpc.declare({ object: 'luci.singbox', method: 'status', expect: {} });
var nodes = rpc.declare({ object: 'luci.singbox', method: 'nodes', expect: {} });
var importNodes = rpc.declare({ object: 'luci.singbox', method: 'import', params: ['text', 'subscription_id'], expect: {} });
var subscriptions = rpc.declare({ object: 'luci.singbox', method: 'subscriptions', expect: {} });
var saveSubscription = rpc.declare({ object: 'luci.singbox', method: 'subscription_save', params: ['id', 'name', 'url', 'update_interval', 'default'], expect: {} });
var refreshSubscription = rpc.declare({ object: 'luci.singbox', method: 'subscription_refresh', params: ['id'], expect: {} });
var reregisterSubscription = rpc.declare({ object: 'luci.singbox', method: 'subscription_reregister', params: ['id'], expect: {} });
var deleteSubscription = rpc.declare({ object: 'luci.singbox', method: 'subscription_delete', params: ['id'], expect: {} });
var applyConfig = rpc.declare({ object: 'luci.singbox', method: 'apply', expect: {} });
var stop = rpc.declare({ object: 'luci.singbox', method: 'stop', expect: {} });
var restart = rpc.declare({ object: 'luci.singbox', method: 'restart', expect: {} });
var commitConfig = rpc.declare({ object: 'uci', method: 'commit', params: ['config'], reject: true });
var generateHWID = rpc.declare({ object: 'luci.singbox', method: 'hwid', expect: {} });
var startProbe = rpc.declare({ object: 'luci.singbox', method: 'probe_start', params: ['ids'], expect: {} });
var cancelProbe = rpc.declare({ object: 'luci.singbox', method: 'probe_cancel', params: ['job'], expect: {} });
var pollProbe = rpc.declare({ object: 'luci.singbox', method: 'probe_poll', params: ['job'], expect: {} });
var getConfig = rpc.declare({ object: 'luci.singbox', method: 'config_get', expect: {} });
var saveManualConfig = rpc.declare({ object: 'luci.singbox', method: 'config_save', params: ['text'], expect: {} });
var useAutomaticConfig = rpc.declare({ object: 'luci.singbox', method: 'config_auto', expect: {} });
var createInterface = rpc.declare({ object: 'luci.singbox', method: 'create_interface', expect: {} });
var createFirewall = rpc.declare({ object: 'luci.singbox', method: 'create_firewall', expect: {} });
var coreStatus = rpc.declare({ object: 'luci.singbox.core', method: 'status', expect: {} });
var coreCheck = rpc.declare({ object: 'luci.singbox.core', method: 'check', expect: {} });
var coreInstall = rpc.declare({ object: 'luci.singbox.core', method: 'install', params: ['version'], expect: {} });
var coreRestore = rpc.declare({ object: 'luci.singbox.core', method: 'restore', expect: {} });
var corePoll = rpc.declare({ object: 'luci.singbox.core', method: 'poll', expect: {} });
var readLogs = rpc.declare({ object: 'luci.singbox', method: 'logs', expect: {} });
var getInterfaces = rpc.declare({ object: 'luci.singbox', method: 'interfaces', expect: {} });
var setLanguage = rpc.declare({ object: 'luci.singbox', method: 'set_language', params: ['language'], expect: {} });

function result(r) {
	if (r.error || r.ok === false) throw new Error(T(r.error || 'Operation failed'));
	if (r.message) r.message = T(r.message);
	return r;
}

function queryWithRetry(fn, attempt) {
	return fn().catch(function(error) {
		if ((attempt || 0) >= 2 || !/XHR|timed?\s*out|timeout|network|fetch/i.test(error.message || '')) throw error;
		return new Promise(function(resolve) { setTimeout(resolve, 500); }).then(function() { return queryWithRetry(fn, (attempt || 0) + 1); });
	});
}

function probeLatency(payload, run, onProgress) {
    run.lastState='starting';
    run.starting=startProbe(payload).then(result);
	return run.starting.then(function(started) {
		var request=JSON.parse(payload),workers=request.options.probe_method==='url_test'?2:6;
        var deadline=Date.now()+Math.max(120000,(Math.ceil(request.ids.length/workers)*(Number(request.options.probe_timeout || 8)+8)+30)*1000);
		function poll() {
            if(run.cancelled)return {ok:true,state:'cancelled'};
			return queryWithRetry(function() { return pollProbe(started.job); }).then(result).then(function(r) {
                if(!run.cancelled && onProgress)onProgress(r);
				run.lastState=r.state;
				if (run.cancelled || r.state === 'done' || r.state === 'cancelled') return r;
				if (Date.now() > deadline) throw new Error(T('Превышено время ожидания проверки. Можно повторить.'));
				return new Promise(function(resolve) { setTimeout(resolve, 250); }).then(poll);
			});
		}
		return poll();
	});
}

function serverLabel(name, suffix) { return choices.label(name + (suffix ? ' · ' + suffix : '')); }

function serverEndpoint(n) {
	return (n.server && n.server.indexOf(':') >= 0 ? '[' + n.server + ']' : n.server) + ':' + (n.port || '—');
}

return baseclass.extend({
	load: function() {
		return Promise.all([uci.load('singbox_gui'), nodes().then(result), status().then(result), coreStatus().then(result),
			this.tab === 'logs' ? readLogs().then(result) : Promise.resolve(null),
			this.tab === 'subscription' ? subscriptions().then(result) : Promise.resolve(null),
			this.tab === 'network' ? getInterfaces().then(result).catch(function() { return { interfaces: [] }; }) : Promise.resolve(null)]);
	},
	render: function(data) {
		i18n.setLanguage(uci.get('singbox_gui', 'main', 'ui_language') || 'ru');
		var activeTab = this.tab || 'settings';
		var extraContent = this.extraContent;
		var fieldsByTab = {
			settings: ['ui_language','enabled','log_level','hwid_enabled','hwid','_generate_hwid','device_os','device_os_version','device_model','subscription_user_agent_mode','subscription_user_agent'],
			subscription: [],
			servers: ['_subscription','probe_method','probe_dns','probe_url_preset','probe_custom_url','probe_timeout','_latency'],
			dns: ['dns_mode','dns','bootstrap_dns','dns_detour'],
			network: ['interface','device','address','mtu','uplink','source_zone','manage_firewall','_firewall'],
			versions: [], config: [], logs: [], routing: []
		};
		var m = new form.Map('singbox_gui', 'LuCi-Sing-Box');
		var s = m.section(form.NamedSection, 'main', 'main');
		function saveConfig() {
			return m.save().then(function() { return commitConfig('singbox_gui'); })
				.then(function() { return ui.changes.init(); });
		}
		var o;
		var currentStatus = data[2] || {};
		var serviceBadge = E('span', {}, '');
		var interfaceBadge = E('span', {}, '');
		var firewallBadge = E('span', {}, '');
		var firewallDescription = E('span', {}, '');
		function describeFirewall(name) {
			firewallDescription.textContent = T('Правила для интерфейса ') + (name || T('из поля выше')) + T(': привязка к firewall-зоне и перенаправление из выбранной LAN-зоны. Снятие флажка не удаляет существующие правила.');
		}
		describeFirewall(currentStatus.interface);
		function badge(element, active, yes, no) {
			element.className = 'sb-state ' + (active ? 'sb-state-up' : 'sb-state-down');
			element.textContent = active ? yes : no;
		}
		function renderStatus(r) {
			currentStatus = r;
			badge(serviceBadge, r.running, T('Запущен'), T('Остановлен'));
			var fields = m.root && typeof m.lookupOption === 'function' ? m.lookupOption('interface', 'main') : [];
			var draft = fields && fields[0] && typeof fields[0].formvalue === 'function' ? fields[0].formvalue('main') : null;
			badge(interfaceBadge, r.interface_created && (!draft || draft === r.interface), T('Создан'), T('Отсутствует'));
			badge(firewallBadge, r.firewall_ready, T('Правила созданы'), T('Правила отсутствуют'));
		}
		renderStatus(currentStatus);
		var allNodes = data[1].nodes || [], sourceList = data[1].subscriptions || [];
		var activeSource = this.subscription || '';
		if (!sourceList.some(function(source) { return source.id === activeSource; }))
			activeSource = data[1].default_id || (sourceList[0] && sourceList[0].id) || '';
		var visibleNodes = activeSource ? allNodes.filter(function(n) { return (n.subscription_ids || []).indexOf(activeSource) >= 0; }) : allNodes;
		var probeMode = uci.get('singbox_gui', 'main', 'probe_method') || 'tcp_connect';
		var refreshProbeColumns = function() {};
		var resetProbes = function() {};
		o = s.option(form.DummyValue, '_service_status', T('Статус'));
		o.renderWidget = function() { return serviceBadge; };
		o = s.option(form.ListValue, 'ui_language', T('Язык пакета'));
		o.value('ru', 'Русский'); o.value('en', 'English'); o.default = 'ru'; o.rmempty = false;
		o.description = T('Язык применяется сразу и сохраняется отдельно от языка LuCI.');
		o.onchange = function(ev, sectionId, language) {
			if (language === (uci.get('singbox_gui', 'main', 'ui_language') || 'ru')) return Promise.resolve();
			return setLanguage(language).then(result).then(function() {
				if (ui.menu && ui.menu.flushCache) ui.menu.flushCache();
				window.location.reload();
			})
				.catch(function(e) { ui.addNotification(null, E('p', {}, T(e.message)), 'error'); });
		};
		o = s.option(form.Flag, 'enabled', T('Включить Sing-box')); o.rmempty = false;
		o = s.option(form.ListValue, 'log_level', T('Уровень журнала'));
		o.default = 'info'; o.rmempty = false;
		o.value('trace', T('trace — Подробная трассировка'));
		o.value('debug', T('debug — Отладка'));
		o.value('info', T('info — Информация'));
		o.value('warn', T('warn — Предупреждения'));
		o.value('error', T('error — Ошибки'));
		o.value('fatal', T('fatal — Критические ошибки'));
		o.value('panic', T('panic — Аварийные ошибки'));
		o.value('disabled', T('Отключить журнал'));
		o.readonly = uci.get('singbox_gui', 'main', 'manual_enabled') === '1';
		o.description = o.readonly ? T('В ручном режиме уровень журнала задаётся в разделе log JSON-конфигурации.') : T('Применяется кнопкой «Сохранить и применить». Для обычной работы используйте info, для диагностики — debug или trace.');
		o = s.option(form.Value, 'subscription', T('URL подписки'));
		o.description = T('URL хранится на роутере. Поддерживаются текстовый и base64 списки vless://.');
		o = s.option(form.Flag, 'hwid_enabled', T('Передавать HWID при загрузке подписки')); o.rmempty = false;
		o = s.option(form.Value, 'hwid', T('HWID устройства')); o.depends('hwid_enabled', '1');
		o.description = T('Постоянный идентификатор в заголовке x-hwid. Можно ввести HWID, выданный провайдером. Не меняйте его после привязки подписки.');
		o = s.option(form.Button, '_generate_hwid', T('Создать HWID')); o.depends('hwid_enabled', '1');
		o.inputtitle = T('Сгенерировать идентификатор'); o.inputstyle = 'action';
		o.onclick = function() {
			return generateHWID().then(result).then(function(r) {
				m.lookupOption('hwid', 'main')[0].getUIElement('main').setValue(r.hwid);
			}).catch(function(e) { ui.addNotification(null, E('p', {}, T(e.message)), 'error'); });
		};
		[['device_os', T('ОС для подписки (x-device-os)')], ['device_os_version', T('Версия ОС (x-ver-os)')],
		 ['device_model', T('Модель (x-device-model)')]].forEach(function(v) {
			o = s.option(form.Value, v[0], v[1]); o.depends('hwid_enabled', '1');
		});
		o = s.option(form.ListValue, 'subscription_user_agent_mode', T('User-Agent подписки'));
		o.value('auto', T('Автоматически — по текущей версии Sing-box'));
		o.value('custom', T('Задать вручную')); o.default = 'auto'; o.rmempty = false;
		var uaInfo = E('span', {}, currentStatus.user_agent || ('sing-box/' + (currentStatus.core_version || '…')));
		o.description = E('span', {}, [T('Автоматический User-Agent: '), uaInfo]);
		o = s.option(form.Value, 'subscription_user_agent', T('Свой User-Agent'));
		o.rmempty = false;
		o.depends('subscription_user_agent_mode', 'custom');
		o.placeholder = currentStatus.user_agent || T('sing-box/текущая_версия');
		o.description = T('Используется только при загрузке подписки в ручном режиме User-Agent.');
		o = s.option(form.DummyValue, '_subscription', T('Подписка'));
		o.description = T('Серверов в подписке: ') + visibleNodes.length;
		o.renderWidget = function() {
			return E('select', { 'aria-label': T('Переключить подписку'), change: function() {
				window.location.href = L.url('admin','services','sing-box','servers') + '?subscription=' + encodeURIComponent(this.value);
			} }, sourceList.map(function(source) { return E('option', { value: source.id, selected: source.id === activeSource ? true : null }, source.name); }));
		};
		o = s.option(form.ListValue, 'probe_method', T('Способ проверки задержки'));
		o.onchange = function(ev, sectionId, value) { probeMode = value; refreshProbeColumns(); resetProbes(); };
		o.value('tcp_connect', T('TCP Connect — порт VLESS-сервера'));
		o.value('url_test', T('HTTP(S) URL через VLESS'));
		o.value('diagnostics', T('Диагностика ICMP / TCP порта VLESS'));
		o.default = 'tcp_connect'; o.rmempty = false;
		o = s.option(form.Value, 'probe_dns', T('DNS для проверок'));
        o.value('default', T('Основной DNS прямого подключения'));
        [['1.1.1.1','Cloudflare'],['8.8.8.8','Google'],['9.9.9.9','Quad9'],['94.140.14.14','AdGuard'],['77.88.8.8','Яндекс'],['208.67.222.222','OpenDNS']].forEach(function(v){o.value(v[0],v[1]+' · '+v[0]);});
        o.default='default';o.rmempty=false;o.datatype='or("default",ipaddr)';o.onchange=function(){resetProbes();};
        o.description=T('DNS используется только для этой проверки.');
        o.renderWidget=function(sectionId,optionIndex,cfgvalue){
            var widget=new ui.Combobox(cfgvalue || this.default,this.transformChoices(),{
                id:this.cbid(sectionId),sort:this.keylist,datatype:this.datatype,
                select_placeholder:'',custom_placeholder:T('Свой DNS…'),
                validate:this.getValidator(sectionId),disabled:this.readonly != null ? this.readonly : this.map.readonly
            });
            // Combobox forces optional=true in its constructor; this DNS always has a default.
            widget.options.optional=false;
            return widget.render();
        };
		o = s.option(form.ListValue, 'probe_url_preset', T('URL для теста'));
		o.value('google', 'Google — https://www.gstatic.com/generate_204');
		o.value('cloudflare', 'Cloudflare — https://cp.cloudflare.com/generate_204');
		o.value('apple', 'Apple — https://captive.apple.com/hotspot-detect.html');
		o.value('custom', T('Свой URL'));
		o.default = 'google'; o.rmempty = false; o.depends('probe_method', 'url_test'); o.onchange=function(){resetProbes();};
		o = s.option(form.Value, 'probe_custom_url', T('Свой URL для теста'));
		o.depends({ probe_method: 'url_test', probe_url_preset: 'custom' });o.onchange=function(){resetProbes();};
		o = s.option(form.Value, 'probe_timeout', T('Таймаут проверки, секунд'));
		o.default = '8'; o.datatype = 'range(2,20)'; o.rmempty = false; o.onchange=function(){resetProbes();};
		o = s.option(form.DummyValue, '_latency', '');
		o.renderWidget = function() {
			var list = visibleNodes, cells = {}, checking = false, generation=0, activeRun=null;
			function format(value, measured, error) {
				if (value != null) return value.toFixed(1) + T(' мс');
				if (error && error.indexOf('http_') === 0) return 'HTTP ' + error.substring(5);
				return ({ dns: T('Ошибка DNS'), refused: T('Порт закрыт'), timeout: T('Таймаут'), not_run: '—',
					proxy_error: T('Ошибка подключения VLESS'), tls_error: T('Ошибка TLS'), probe_error: T('Ошибка проверки'),
					unreachable: T('Нет маршрута / ошибка сети'), no_reply: T('Нет ICMP-ответа') })[error] || (measured ? T('Не измерено') : '—');
			}
			var rows = list.map(function(n) {
				var measured = {};
				var icmp = E('td', { 'class': 'sb-connect-metric' }, format(measured.icmp_ms, 'icmp_ms' in measured, measured.icmp_error));
				var nodeTcp = E('td', { 'class': 'sb-connect-metric' }, format(measured.tcp_ms, 'tcp_ms' in measured, measured.tcp_error));
				var test = E('td', { 'class': 'sb-url-metric', title: measured.url || '' }, format(measured.test_ms, false, measured.test_error));
				cells[n.id] = [icmp, nodeTcp, test];
				var row = E('tr', {}, [E('td', { 'class': 'sb-server' }, [E('div', { 'class': 'sb-name' }, serverLabel(n.name)), E('div', { 'class': 'sb-address' }, serverEndpoint(n))]), icmp, nodeTcp, test]);
				return row;
			});
			var progress = E('span', { style: 'margin-left:10px;' }, '');
            function finishRun(run,message){
                if(activeRun!==run)return;
                activeRun=null;checking=false;button.disabled=!list.length;stopButton.disabled=true;
                if(message)progress.textContent=T(message);
            }
            function stopRun(run,message){
                if(activeRun!==run)return Promise.resolve();
                if(run.stopping)return run.stopPromise || Promise.resolve();
                run.cancelled=true;run.stopping=true;generation++;stopButton.disabled=true;
                progress.textContent=T('Остановка проверки…');
                var cancel=run.lastState==='done' || run.lastState==='cancelled' ? Promise.resolve() :
                    (run.starting ? run.starting.then(function(started){return cancelProbe(started.job).then(result);},function(){return {ok:true};}) : Promise.resolve());
                run.stopPromise=cancel.then(function(){finishRun(run,message || 'Проверка остановлена.');}).catch(function(error){
                    if(activeRun!==run)return;
                    run.stopping=false;stopButton.disabled=false;
                    progress.textContent=T('Не удалось остановить проверку. Повторите остановку.');
                    ui.addNotification(null,E('p',{},T(error.message)),'error');
                });
                return run.stopPromise;
            }

			var button = E('button', { 'class': 'cbi-button cbi-button-action', type: 'button',
				click: function() {
					if (checking || !list.length) return;
					resetProbes(); var runGeneration=generation, run={cancelled:false,starting:null,stopping:false};activeRun=run;stopButton.disabled=false;
					checking = true;
					button.disabled = true;
					var probeOptions = {};
					['probe_method', 'probe_url_preset', 'probe_custom_url', 'probe_timeout', 'probe_dns'].forEach(function(key) {
						var option = m.lookupOption(key, 'main')[0];
						probeOptions[key] = option.formvalue('main') || option.default || '';
					});
					var batchSize = 128;
					probeMode = probeOptions.probe_method; refreshProbeColumns();
					var chain = Promise.resolve(), done = 0;
					for (var start = 0; start < list.length; start += batchSize) {
						(function(batch) {
							chain = chain.then(function() {
                                    if(runGeneration!==generation)return;
								progress.textContent = T('Проверка: ') + done + ' / ' + list.length;
                                return probeLatency(JSON.stringify({ids: batch.map(function(n) { return n.id; }), options: probeOptions}),run,function(r){
                                    if(runGeneration!==generation)return;
                                    Object.keys(r.latency || {}).forEach(function(id) {
										var l = r.latency[id];
										cells[id][0].textContent = format(l.icmp_ms, 'icmp_ms' in l, l.icmp_error);
										cells[id][1].textContent = format(l.tcp_ms, 'tcp_ms' in l, l.tcp_error);
										cells[id][2].textContent = format(l.test_ms, true, l.test_error);
										cells[id][2].title = l.url || '';
									});
                                    progress.textContent=T('Проверено: ')+(done+(r.completed || Object.keys(r.latency || {}).length))+' / '+list.length;
                                }).then(result).then(function(r){
                                    if(runGeneration!==generation)return;
									done += batch.length;
									progress.textContent = T('Проверено: ') + done + ' / ' + list.length;
								});
							});
						})(list.slice(start, start + batchSize));
					}
					chain.catch(function(e) {
                        if(activeRun!==run || run.cancelled)return;
						ui.addNotification(null, E('p', {}, T(e.message)), 'error');
                        return stopRun(run,'Проверка прервана. Можно повторить.');
					}).finally(function() {
                        if(activeRun!==run || run.cancelled)return;
                        finishRun(run);
					});
				}}, T('Проверить задержку серверов'));
            var stopButton=E('button',{'class':'cbi-button cbi-button-negative',type:'button',disabled:true,click:function(){
                return activeRun ? stopRun(activeRun) : Promise.resolve();
            }},T('Остановить проверку задержки серверов'));
            stopButton.disabled=true;
			button.disabled = !list.length;
			var panel = E('div', { 'class': 'sb-probes', style: 'width:100%;' }, [
				E('style', {}, '.sb-probes .sb-scroll{max-height:440px;overflow:auto;border:1px solid rgba(128,128,128,.3);border-radius:6px}' +
					'.sb-probes table{width:100%;min-width:640px;border-collapse:separate;border-spacing:0}' +
					'.sb-probes th,.sb-probes td{padding:12px 16px!important;vertical-align:middle;text-align:center;border-bottom:1px solid rgba(128,128,128,.2)}' +
					'.sb-probes th{position:sticky;top:0;z-index:1;background:var(--background-color,#303030);color:var(--text-color,#f4f4f4);font-weight:600;white-space:nowrap}' +
					'.sb-probes td.sb-server,.sb-probes th:first-child{text-align:left;width:44%}' +
					'.sb-probes .sb-name{font-weight:600;line-height:1.45;overflow-wrap:anywhere}' +
					'.sb-probes .sb-address{font-size:11px;opacity:.65;line-height:1.5;margin-top:4px;overflow-wrap:anywhere}' +
					'.sb-probes .sb-select{width:180px;text-align:right}.sb-probes .sb-select button{min-width:160px;white-space:nowrap}' +
					'.sb-probes tbody tr:hover{background:rgba(128,128,128,.08)}.sb-probes .sb-selected{background:rgba(60,160,190,.14)}' +
					'.sb-probes.sb-connect .sb-url-metric,.sb-probes.sb-url .sb-connect-metric{display:none}'),
				E('div', { 'class': 'sb-probe-toolbar' }, [E('strong', {}, T('Задержка серверов')), button, stopButton, progress]),
				E('div', { 'class': 'sb-scroll' },
					E('table', {}, [
						E('thead', {}, E('tr', {}, [E('th', {}, T('Сервер')), E('th', { 'class': 'sb-connect-metric' }, 'ICMP'), E('th', { 'class': 'sb-connect-metric' }, T('TCP порта VLESS')), E('th', { 'class': 'sb-url-metric' }, T('HTTP(S) через VLESS'))])),
						E('tbody', {}, rows)])),
				E('div', { 'class': 'cbi-value-description', style: 'margin-top:10px;line-height:1.5;' }, T('TCP Connect измеряет соединение до порта узла; диагностика добавляет ICMP. URL-тест измеряет время до первого байта HTTP-ответа через VLESS. Общий адрес входа у нескольких стран даёт одинаковую задержку TCP. Ошибка DNS не означает отказ сервера.'))]);
			resetProbes = function(){generation++;Object.keys(cells).forEach(function(id){cells[id].forEach(function(cell){cell.textContent='—';cell.title='';});});progress.textContent='';if(activeRun)stopRun(activeRun);};
			refreshProbeColumns = function() { panel.className = 'sb-probes ' + (probeMode === 'url_test' ? 'sb-url' : 'sb-connect'); };
			refreshProbeColumns();
			return panel;
		};
		o = s.option(form.ListValue, 'dns_mode', T('Режим DNS'));
		o.value('https_dns_proxy', T('Основной DNS прямого подключения'));
		o.value('external', T('Отдельный DNS настраиваемый внутри Sing-Box'));
		o.default = 'https_dns_proxy'; o.rmempty = false;
		o.description = T('Рекомендуется использовать основной DNS так как он позволяет выполнять перехват доменных имён');
		o = s.option(form.Value, 'dns', T('Внешний DNS')); o.rmempty = false;
		o.placeholder = T('— Выберите DNS —');
		o.renderWidget = function(sectionId, optionIndex, cfgvalue) {
			return new ui.Combobox(cfgvalue != null ? cfgvalue : this.default, this.transformChoices(), {
				id: this.cbid(sectionId), sort: this.keylist, optional: this.optional || this.rmempty,
				datatype: this.datatype, select_placeholder: T('— Выберите DNS —'),
				custom_placeholder: T('Свой DNS…'), validate: this.getValidator(sectionId),
				disabled: this.readonly != null ? this.readonly : this.map.readonly
			}).render();
		};
		o.depends('dns_mode', 'external');
		o.value('https://1.1.1.1/dns-query', 'Cloudflare DoH');
		o.value('https://8.8.8.8/dns-query', 'Google DoH');
		o.value('tls://1.1.1.1', 'Cloudflare DoT');
		o.description = T('IP, udp://IP, tcp://IP, tls://host или https://host/dns-query.');
		o = s.option(form.Value, 'bootstrap_dns', T('DNS для подключения к серверу')); o.datatype = 'ip4addr'; o.rmempty = false;
		o.value('8.8.8.8', 'Google — 8.8.8.8');
		o.value('8.8.4.4', 'Google — 8.8.4.4');
		o.value('1.1.1.1', 'Cloudflare — 1.1.1.1');
		o.value('1.0.0.1', 'Cloudflare — 1.0.0.1');
		o.value('9.9.9.9', 'Quad9 — 9.9.9.9');
		o.value('149.112.112.112', 'Quad9 — 149.112.112.112');
		o.value('94.140.14.14', 'AdGuard — 94.140.14.14');
		o.value('94.140.15.15', 'AdGuard — 94.140.15.15');
		o.renderWidget = function(sectionId, optionIndex, cfgvalue) {
			return new ui.Combobox(cfgvalue != null ? cfgvalue : this.default, this.transformChoices(), {
				id: this.cbid(sectionId), sort: this.keylist, optional: false, datatype: 'ip4addr',
				select_placeholder: T('— Выберите DNS-провайдера —'), custom_placeholder: T('Свой IPv4 DNS…'),
				validate: this.getValidator(sectionId), disabled: this.readonly != null ? this.readonly : this.map.readonly
			}).render();
		};
		o.depends('dns_mode', 'external');
		o.description = T('Доступный напрямую IPv4 DNS для разрешения имени VLESS-сервера и DNS-сервиса.');
		o = s.option(form.ListValue, 'dns_detour', T('Путь внешнего DNS'));
		o.depends('dns_mode', 'external');
		o.value('proxy', T('Через VLESS из выхода по умолчанию; иначе напрямую')); o.value('direct', T('Напрямую через uplink'));
		[['interface', T('Имя интерфейса OpenWrt'), 'uciname'],
		 ['device', T('TUN-устройство'), null], ['address', T('IPv4 адрес TUN (/30)'), 'cidr4'],
		 ['mtu', 'MTU', 'range(1280,9000)'], ['uplink', T('Подключение к интернету'), null],
		 ['source_zone', T('Исходная firewall-зона'), 'uciname']].forEach(function(v) {
			o = s.option(form.Value, v[0], v[1]); o.rmempty = false;
			if (v[2]) o.datatype = v[2];
			if (v[0] === 'uplink') {
				o.description = T('Выберите подключение, через которое доступен VLESS-сервер. В скобках указано устройство. При необходимости его имя можно ввести вручную.');
				((data[6] && data[6].interfaces) || []).forEach(function(item) {
					o.value(item.device, item.names.join(' / ') + ' (' + item.device + ')' + (item.default_route ? T(' — основной выход') : '') + (item.up ? '' : T(' — не подключён')));
				});
				o.renderWidget = function(sectionId, optionIndex, cfgvalue) {
					return new ui.Combobox(cfgvalue != null ? cfgvalue : this.default, this.transformChoices(), {
						id: this.cbid(sectionId), sort: this.keylist, optional: false,
						select_placeholder: T('— Выберите подключение —'), custom_placeholder: T('Другое устройство…'),
						validate: this.getValidator(sectionId), disabled: this.readonly != null ? this.readonly : this.map.readonly
					}).render();
				};
			}
			if (v[0] === 'interface') {
				o.description = T('Кнопка создаёт сетевой интерфейс OpenWrt; TUN поднимает запущенный Sing-box. При переименовании ссылки PBR обновятся автоматически.');
				o.onchange = function(ev, sectionId, value) { badge(interfaceBadge, value === currentStatus.interface && currentStatus.interface_created, T('Создан'), T('Отсутствует')); describeFirewall(value); };
				var baseRender = o.renderWidget;
				o.renderWidget = function(sectionId, optionIndex, cfgvalue) {
					return Promise.resolve(baseRender.call(this, sectionId, optionIndex, cfgvalue)).then(function(widget) {
						var createButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: function() {
							return action(this, function() { return saveConfig().then(createInterface).then(result).then(function(r) {
								ui.addNotification(null, E('p', {}, r.message), 'info'); return status();
							}).then(renderStatus).then(function() { return ui.changes.init(); }); });
						}}, T('Создать'));
						return E('div', { style: 'display:flex;align-items:center;flex-wrap:wrap;gap:10px;' }, [widget, createButton, interfaceBadge]);
					});
				};
			}
		});
		o = s.option(form.Flag, 'manage_firewall', T('Создавать firewall-правила вместе с интерфейсом'));
		o.default = '1'; o.rmempty = false;
		o.description = firewallDescription;
		o = s.option(form.DummyValue, '_firewall', T('Межсетевой экран'));
		o.renderWidget = function() { return E('div', { style: 'display:flex;align-items:center;flex-wrap:wrap;gap:10px;' }, [
			E('button', { type: 'button', 'class': 'cbi-button', click: function() {
				return action(this, function() { return saveConfig().then(createFirewall).then(result).then(function(r) {
					ui.addNotification(null, E('p', {}, r.message), 'info'); return status();
				}).then(renderStatus).then(function() { return ui.changes.init(); }); });
			}}, T('Создать / обновить firewall-правила')), firewallBadge]); };
		var pasted = E('textarea', { 'class': 'cbi-input-textarea', rows: 8,
			style: 'display:block;width:100%;max-width:100%;min-height:180px;box-sizing:border-box;resize:vertical;font-family:monospace;',
			spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
			placeholder: T('vless://UUID@server:443?...#Название\n\nvless://…\n\nМожно вставить несколько ссылок или base64-подписку.') });
		var info = E('style', {}, '.sb-state{display:inline-block;border-radius:999px;padding:3px 12px;font-size:12px;font-weight:600;line-height:1.4;color:#fff;white-space:nowrap}.sb-state-up{background:#279247}.sb-state-down{background:#c72c34}');
		function action(button, fn) {
			button.disabled = true;
			return Promise.resolve().then(fn).catch(function(e) { ui.addNotification(null, E('p', {}, T(e.message)), 'error'); })
				.finally(function() { button.disabled = false; });
		}
		var sourceDetails = data[5] && data[5].subscriptions || [];
        function importOptions(){
            var options=sourceDetails.map(function(source){return E('option',{value:source.id},source.name);});
            if(!sourceDetails.some(function(source){return source.id==='manual';}))
                options.unshift(E('option',{value:'manual'},T('Отдельная группа: импортированные ссылки')));
            return options;
        }
		var importTarget = E('select', { 'aria-label': T('Подписка для импорта') }, importOptions());
        importTarget.value='manual';
        function syncImportTargets(){
            var previous=importTarget.value;
            importTarget.replaceChildren.apply(importTarget,importOptions());
            importTarget.value=previous==='manual' || sourceDetails.some(function(source){return source.id===previous;}) ? previous : 'manual';
        }
		var importButton = E('button', { 'class': 'cbi-button cbi-button-action', click: function() {
			return action(this, function() {
				return saveConfig()
					.then(function() { return importNodes(pasted.value, importTarget.value || 'manual'); }).then(result).then(function(r) {
						if (r.warnings && r.warnings.length) {
							ui.showModal(T('Импортировано: ') + r.count, [E('p', {}, r.warnings.map(T).join('\n')),
								E('button', { 'class': 'cbi-button', click: function() { window.location.reload(); } }, T('Продолжить'))]);
						} else window.location.reload();
					});
			});
		}}, T('Импортировать / обновить подписку'));
		var applyButton = E('button', { 'class': 'cbi-button cbi-button-apply', click: function() {
			return action(this, function() {
				return saveConfig().then(applyConfig).then(result)
					.then(function(r) { return ui.changes.init().then(function() { return r; }); })
					.then(function(r) { ui.addNotification(null, E('p', {}, r.message), 'info'); return status(); })
					.then(renderStatus);
			});
		}}, T('Сохранить и применить'));
		var stopButton = E('button', { 'class': 'cbi-button cbi-button-negative', click: function() {
			return action(this, function() { return stop().then(result).then(function() { window.location.reload(); }); });
		}}, T('Остановить'));
		var restartButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: function() {
			return action(this, function() { return restart().then(result).then(function(r) {
				ui.addNotification(null, E('p', {}, r.message), 'info'); return status();
			}).then(renderStatus); });
		}}, T('Перезапустить'));
		var coreData = data[3] || {}, coreBusy = false;
		function dateText(ts) { return ts ? new Date(typeof ts === 'number' ? ts * 1000 : ts).toLocaleString(i18n.locale()) : T('Ещё не выполнялась'); }
		function coreChoices(d) {
			var versions = (d.versions || []).slice();
			if (d.current && !versions.some(function(v) { return v.version === d.current; })) versions.unshift({ version: d.current });
			return versions.map(function(v) { return E('option', { value: v.version }, v.version + (v.version === d.latest ? T(' — последняя стабильная') : '')); });
		}
		var coreCurrent = E('span', {}, ''), coreSystem = E('span', {}, ''), coreLatest = E('span', {}, '');
		var coreChecked = E('span', {}, ''), coreAttempt = E('span', {}, ''), coreInstalled = E('span', {}, '');
		var coreSource = E('span', {}, ''), coreArch = E('span', {}, ''), coreError = E('p', { style: 'color:#d45a4f;' }, '');
		var coreProgress = E('p', { role: 'status' }, '');
		var versionSelect = E('select', { 'class': 'cbi-input-select', 'aria-label': T('Версия ядра Sing-box') }, coreChoices(coreData));
		function showCore(d, refresh) {
			coreData = d;
			coreCurrent.textContent = d.current || T('Не определена'); coreSystem.textContent = d.system || T('Не определена');
			coreLatest.textContent = d.latest || T('Пока не проверено'); coreChecked.textContent = dateText(d.last_checked);
			coreAttempt.textContent = dateText(d.last_attempt || d.last_checked); coreInstalled.textContent = dateText(d.installed_at);
			coreSource.textContent = d.managed ? T('Управляемая копия: /etc/singbox-gui/core/sing-box') : T('Системный пакет: /usr/bin/sing-box');
			coreArch.textContent = (d.architecture || '—') + (d.supported === false ? T(' — установка из GUI для этой платформы не поддерживается') : '');
			coreError.textContent = T(d.last_error || '');
			uaInfo.textContent = d.user_agent || currentStatus.user_agent || '—';
			if (refresh && versionSelect.replaceChildren) {
				var previous = versionSelect.value;
				versionSelect.replaceChildren.apply(versionSelect, coreChoices(d));
				versionSelect.value = (d.versions || []).some(function(v) { return v.version === previous; }) ? previous : (d.latest || d.current || '');
			}
			else if (!versionSelect.value) versionSelect.value = d.current || '';
		}
		function setCoreBusy(value) {
			coreBusy = value; checkCoreButton.disabled = value;
			installCoreButton.disabled = value || !coreData.supported || !versionSelect.value;
			restoreCoreButton.disabled = value || !coreData.managed; versionSelect.disabled = value;
		}
		function followCoreJob() {
			var deadline = Date.now() + 600000;
			function poll() {
				return queryWithRetry(corePoll).then(function(r) {
					coreProgress.textContent = T(r.message || r.error) || T('Выполнение…');
					if (r.state === 'done') return result(r);
					if (Date.now() > deadline) throw new Error(T('Операция ядра не завершилась за 10 минут. Обновите сведения.'));
					return new Promise(function(resolve) { setTimeout(resolve, 1000); }).then(poll);
				});
			}
			return poll();
		}
		function changeCore(fn) {
			if (coreBusy) return Promise.resolve();
			setCoreBusy(true);
			return fn().then(result).then(followCoreJob).catch(function(e) {
				coreProgress.textContent = T(e.message); ui.addNotification(null, E('p', {}, T(e.message)), 'error');
			}).finally(function() {
				return Promise.all([coreStatus().then(result), status().then(result)]).then(function(r) { showCore(r[0], true); renderStatus(r[1]); })
					.finally(function() { setCoreBusy(false); });
			});
		}
		var checkCoreButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: function() { return changeCore(coreCheck); } }, T('Проверить обновления'));
		var installCoreButton = E('button', { type: 'button', 'class': 'cbi-button cbi-button-apply', click: function() {
			return changeCore(function() { return coreInstall(versionSelect.value); });
		}}, T('Установить выбранную версию'));
		var restoreCoreButton = E('button', { type: 'button', 'class': 'cbi-button', click: function() { return changeCore(coreRestore); } }, T('Вернуть ядро системного пакета'));
		showCore(coreData, false); setCoreBusy(false);
		function coreField(label, element) { return E('div', { 'class': 'cbi-value sb-core-row' }, [E('label', { 'class': 'cbi-value-title' }, label), E('div', { 'class': 'cbi-value-field' }, element)]); }
		var coreSection = E('div', { 'class': 'cbi-section' }, [E('h3', {}, T('Ядро Sing-box: версия и обновления')),
			coreField(T('Текущая версия'), coreCurrent), coreField(T('Версия системного пакета'), coreSystem),
			coreField(T('Последняя стабильная'), coreLatest), coreField(T('Последняя проверка обновлений'), coreChecked),
			coreField(T('Последняя попытка проверки / установки'), coreAttempt), coreField(T('Последнее переключение ядра'), coreInstalled),
			coreField(T('Источник активного ядра'), coreSource), coreField(T('Архитектура'), coreArch),
			coreField(T('Выбрать версию'), versionSelect),
			coreField(T('Управление'), E('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;' }, [checkCoreButton, installCoreButton, restoreCoreButton])),
			coreField(T('Результат операции'), E('div', {}, [coreProgress, coreError,
				E('p', { 'class': 'cbi-value-description' }, T('Официальные стабильные релизы SagerNet. Архив проверяется по SHA-256, конфиг — новым ядром до переключения. При ошибке запуска возвращается прежнее ядро. Файл системного пакета не перезаписывается. Проверка требует работающего DNS и доступа к GitHub.'))]))]);
		var rawConfig = E('textarea', { rows: 22, spellcheck: 'false', autocomplete: 'off',
			style: 'display:block;width:100%;min-height:400px;box-sizing:border-box;font-family:monospace;line-height:1.5;resize:vertical;',
			'aria-label': T('JSON конфигурация Sing-box') });
		var manualInfo = E('p', {}, T('В ручном режиме параметры подключения берутся из JSON. Выбор сервера и DNS в форме снова формирует конфиг после возврата к генерации из GUI.'));
		var manualSave = E('button', { type: 'button', 'class': 'cbi-button cbi-button-apply', click: function() {
			return action(this, function() {
				return Promise.resolve().then(function() {
					try { JSON.parse(rawConfig.value); } catch (error) { throw new Error(T('Некорректный JSON. Проверьте синтаксис конфигурации.')); }
					return saveManualConfig(rawConfig.value);
				})
					.then(result).then(function(r) {
						manualInfo.textContent = r.message;
						return ui.changes.init();
					});
			});
		}}, T('Сохранить и применить вручную'));
		var automaticButton = E('button', { type: 'button', 'class': 'cbi-button', click: function() {
			return action(this, function() {
				return saveConfig().then(useAutomaticConfig).then(result).then(function(r) {
					manualInfo.textContent = r.message;
					return getConfig();
				}).then(result).then(function(r) { rawConfig.value = r.text; return ui.changes.init(); });
			});
		}}, T('Вернуть конфигурацию из GUI'));
		var editor = E('div', { 'class': 'sb-config-editor', style: 'display:none;margin-top:12px;' }, [manualInfo, rawConfig,
			E('p', { 'class': 'sb-editor-actions', style: 'margin-top:12px;' }, [manualSave, ' ', automaticButton])]);
		var editorLoaded = false;
		var showConfig = E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: function() {
			if (editor.style.display !== 'none') {
				editor.style.display = 'none';
				showConfig.textContent = T('Отобразить текущий конфиг для редактирования');
				return;
			}
			if (editorLoaded) {
				editor.style.display = '';
				showConfig.textContent = T('Скрыть редактор конфига');
				return;
			}
			return action(this, function() {
				return getConfig().then(result).then(function(r) {
					rawConfig.value = r.text; editor.style.display = ''; editorLoaded = true;
					showConfig.textContent = T('Скрыть редактор конфига');
					manualInfo.textContent = (r.manual ? T('Ручной режим. ') : T('Конфигурация сформирована GUI. ')) +
						T('Изменения JSON проверяются sing-box check. После сохранения вручную JSON используется при перезапуске; настройки сервера и DNS формы применятся после возврата к генерации из GUI.');
				});
			});
		}}, T('Отобразить текущий конфиг для редактирования'));
		var configSection = E('div', { 'class': 'cbi-section', style: 'margin:24px 0;' }, [
			E('h3', {}, T('Ручное редактирование конфигурации Sing-box')),
			E('div', { 'class': 'cbi-section-node' },
				E('div', { 'class': 'cbi-value', style: 'padding-top:8px;padding-bottom:16px;' }, [
					E('label', { 'class': 'cbi-value-title' }, T('Конфигурация JSON')),
					E('div', { 'class': 'cbi-value-field' }, [showConfig, editor])]))]);
		var importSection = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, T('Импорт подписки и VLESS-ссылок')),
			E('div', { 'class': 'cbi-section-node' }, [
				E('div', { 'class': 'cbi-value' }, [E('label', { 'class': 'cbi-value-title' }, T('В какую подписку')), E('div', { 'class': 'cbi-value-field' }, importTarget)]),
				E('div', { 'class': 'cbi-value' }, [
					E('label', { 'class': 'cbi-value-title' }, T('Ссылки / base64')),
					E('div', { 'class': 'cbi-value-field' }, [pasted,
						E('div', { 'class': 'cbi-value-description', style: 'margin:8px 0 12px;' },
							T('Вставьте ссылки по одной на строку или base64-список. Импорт заменит серверы только выбранной подписки. Для загрузки по URL используйте кнопку в блоке подписки. Текст этого поля не сохраняется.')),
						importButton])])])]);
		function sourceField(label, input) { return E('div', { 'class': 'cbi-value' }, [E('label', { 'class': 'cbi-value-title' }, label), E('div', { 'class': 'cbi-value-field' }, input)]); }
		var defaultSourceId = data[5] && data[5].default_id || sourceDetails[0] && sourceDetails[0].id || '';
		var managedId = defaultSourceId;
		var sourcePicker = E('select', { 'aria-label': T('Сохранённые подписки'), change: function() { managedId = this.value; renderManagedSource(); } });
		var managedBody = E('div', {});
		function reloadSources(id) {
			return subscriptions().then(result).then(function(r) {
				sourceDetails = r.subscriptions || [];
                syncImportTargets();
				defaultSourceId = r.default_id || '';
				managedId = id || managedId || r.default_id;
				if (!sourceDetails.some(function(s) { return s.id === managedId; })) managedId = r.default_id || '';
				updateSourcePicker();
			});
		}
		function updateSourcePicker() {
			sourcePicker.replaceChildren.apply(sourcePicker, sourceDetails.map(function(s) {
				return E('option', { value: s.id, selected: s.id === managedId ? true : null }, s.name + (s.id === defaultSourceId ? T(' · по умолчанию') : ''));
			}));
			sourcePicker.disabled = !sourceDetails.length;
			renderManagedSource();
		}
		function renderManagedSource() {
			var source = sourceDetails.find(function(s) { return s.id === managedId; });
			if (!source) { managedBody.replaceChildren(E('p', {}, T('Добавьте URL подписки, чтобы загрузить серверы.'))); return; }
			var name = E('input', { type: 'text', value: source.name, maxlength: 80, 'aria-label': T('Название подписки') });
			var url = E('input', { type: 'text', value: source.url, spellcheck: 'false', 'aria-label': T('Редактировать URL подписки') });
			var interval = E('input', { type: 'number', value: source.update_interval || 0, min: 0, max: 10080, step: 1, 'aria-label': T('Интервал обновления, минут') });
			var editing = E('div', { 'class': 'sb-source-edit', style: 'display:none;' }, [
				sourceField(T('Название'), name), sourceField(T('URL подписки'), url),
				sourceField(T('Автообновление, минут'), E('div', {}, [interval, E('div', { 'class': 'cbi-value-description' }, T('0 — отключено. От 5 до 10080 минут. Например: 60 — каждый час, 360 — каждые 6 часов.'))])),
				E('div', { 'class': 'sb-source-actions sb-source-centered' }, [E('button', { type: 'button', 'class': 'cbi-button cbi-button-apply', click: function() { return action(this, function() {
					return saveSubscription(source.id, name.value, url.value, String(interval.value), source.id === defaultSourceId ? '1' : '0').then(result).then(function() { return reloadSources(source.id); });
				}); } }, T('Сохранить изменения')), E('button', { type: 'button', 'class': 'cbi-button', click: function() { editing.style.display = 'none'; } }, T('Отмена'))])]);
			var intervalText = source.update_interval ? T('Каждые ') + source.update_interval + T(' мин.') : T('Выключено');
			var nextAt = Math.max(source.updated_at || 0, source.last_attempt || 0) + (source.update_interval || 0) * 60;
			var nextUpdate = source.update_interval ? (nextAt <= Date.now() / 1000 ? T('В ближайшую минуту') : dateText(nextAt)) : T('Дата проверки не установлена');
			managedBody.replaceChildren(
				sourceField(T('Сведения'), E('dl', { 'class': 'sb-source-summary' }, [
					E('dt', {}, T('Серверов:')), E('dd', {}, String(source.count)),
					E('dt', {}, T('Обновлено:')), E('dd', {}, dateText(source.updated_at)),
					E('dt', {}, T('Автообновление:')), E('dd', {}, intervalText),
					E('dt', {}, T('Следующая проверка:')), E('dd', {}, nextUpdate),
					source.hwid ? E('dt', {}, T('HWID подписки:')) : '', source.hwid ? E('dd', {}, source.hwid) : '',
					source.last_error ? E('dt', { 'class': 'sb-source-error' }, T('Ошибка:')) : '',
					source.last_error ? E('dd', { 'class': 'sb-source-error' }, T(source.last_error)) : ''])),
				sourceField(T('Управление'), E('div', { 'class': 'sb-source-actions' }, [
					E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: function() { return action(this, function() { return saveConfig().then(function() { return refreshSubscription(source.id); }).then(result).then(function() { return reloadSources(source.id); }); }); } }, T('Обновить')),
					E('button', { type: 'button', 'class': 'cbi-button', click: function() { editing.style.display = editing.style.display === 'none' ? '' : 'none'; } }, T('Редактировать')),
					E('button', { type: 'button', 'class': 'cbi-button', disabled: source.url ? null : true, click: function() {
						ui.showModal(T('Перерегистрировать подписку с новым HWID?'), [E('p', {}, T('Для подписки «') + source.name + T('» будет создан новый HWID и выполнена загрузка с этим идентификатором. Провайдер может засчитать его как новое устройство. Прежняя регистрация на стороне провайдера автоматически не удаляется. Другие подписки сохранят свои HWID.')),
							E('div', { 'class': 'sb-source-actions' }, [E('button', { type: 'button', 'class': 'cbi-button', click: function() { ui.hideModal(); } }, T('Отмена')),
								E('button', { type: 'button', 'class': 'cbi-button cbi-button-action', click: function() { return action(this, function() {
									return reregisterSubscription(source.id).then(result).then(function(r) { ui.hideModal(); ui.addNotification(null, E('p', {}, r.message), 'info'); return reloadSources(source.id); });
								}); } }, T('Перерегистрировать'))])]);
					} }, T('Перерегистрировать подписку с новым HWID')),
					E('button', { type: 'button', 'class': 'cbi-button', disabled: source.id === defaultSourceId ? true : null, click: function() { return action(this, function() { return saveSubscription(source.id, source.name, source.url, String(source.update_interval || 0), '1').then(result).then(function() { return reloadSources(source.id); }); }); } }, T('По умолчанию')),
					E('a', { 'class': 'cbi-button', href: L.url('admin','services','sing-box','servers') + '?subscription=' + encodeURIComponent(source.id) }, T('Пинг')),
					E('button', { type: 'button', 'class': 'cbi-button cbi-button-negative', click: function() { ui.showModal(T('Удалить подписку «') + source.name + T('»?'), [E('p', {}, T('Её список серверов будет удалён.')), E('div', { 'class': 'sb-source-actions' }, [E('button', { 'class': 'cbi-button', click: function() { ui.hideModal(); } }, T('Отмена')), E('button', { 'class': 'cbi-button cbi-button-negative', click: function() { return action(this, function() { return deleteSubscription(source.id).then(result).then(function() { ui.hideModal(); return reloadSources(); }); }); } }, T('Удалить подписку'))])]); } }, T('Удалить'))])), editing);
		}
		var addUrl = E('input', { type: 'text', placeholder: 'https://…', spellcheck: 'false', 'aria-label': T('Добавить URL подписки') });
		var addSource = E('button', { type: 'button', 'class': 'cbi-button cbi-button-add', click: function() { return action(this, function() {
			if (!addUrl.value || !addUrl.value.trim()) return Promise.reject(new Error(T('Введите URL подписки.')));
			return saveConfig().then(function() { return saveSubscription('', '', addUrl.value.trim(), '0', '0'); }).then(result).then(function(r) {
				addUrl.value = '';
				return refreshSubscription(r.id).then(result).catch(function(e) { ui.addNotification(null, E('p', {}, T(e.message)), 'error'); }).then(function() { return reloadSources(r.id); });
			});
		}); } }, T('Добавить'));
		var sourceManager = E('div', { 'class': 'cbi-section sb-source-manager' }, [E('h3', {}, T('Подписки')),
			sourceField(T('Добавить подписку'), E('div', { 'class': 'sb-source-add' }, [addUrl, addSource])),
			sourceField(T('Подписка'), sourcePicker), managedBody]);
		updateSourcePicker();
		function logContent(text) { return text === 'Записей Sing-box пока нет.' ? T(text) : text; }
		var logText = E('textarea', { readonly: true, rows: 24, 'aria-label': T('Журнал Sing-box'),
			style: 'display:block;width:100%;box-sizing:border-box;font-family:monospace;line-height:1.5;resize:vertical;' });
		logText.value = logContent(data[4] && data[4].text || '');
		var logLive = true, logFollow = true, logPending = null, logGeneration = 0;
		var logState = E('span', { role: 'status', 'class': 'sb-log-state' }, T('В реальном времени · обновление каждую секунду'));
		function refreshLogs() {
			if (logPending) return logPending;
			var generation = logGeneration;
			logPending = readLogs().then(result).then(function(r) {
				if (generation !== logGeneration) return;
				var top = logText.scrollTop;
				var content = logContent(r.text || '');
				if (logText.value !== content) logText.value = content;
				logText.scrollTop = logFollow ? logText.scrollHeight : top;
				logState.textContent = (logLive ? T('В реальном времени') : T('Пауза')) + T(' · обновлено ') + new Date().toLocaleTimeString(i18n.locale());
			}).catch(function(e) {
				if (generation === logGeneration) logState.textContent = T('Ошибка обновления: ') + T(e.message);
				throw e;
			}).finally(function() { logPending = null; });
			return logPending;
		}
		var liveToggle = E('input', { type: 'checkbox', checked: true, 'aria-label': T('Журнал в реальном времени'), change: function() {
			logLive = this.checked;
			logGeneration++;
			logState.textContent = logLive ? T('В реальном времени · ожидание обновления') : T('Пауза');
			if (logLive) refreshLogs().catch(function() {});
		} });
		var followToggle = E('input', { type: 'checkbox', checked: true, 'aria-label': T('Автопрокрутка журнала'), change: function() {
			logFollow = this.checked;
			if (logFollow) logText.scrollTop = logText.scrollHeight;
		} });
		var logSection = E('div', { 'class': 'cbi-section' }, [E('h3', {}, T('Журнал Sing-box')),
			E('div', { 'class': 'sb-source-actions', style: 'margin-bottom:12px;' }, [E('button', { type: 'button', 'class': 'cbi-button', click: function() { return action(this, refreshLogs); } }, T('Обновить журнал')),
				E('button', { type: 'button', 'class': 'cbi-button', click: function() { return action(this, function() {
					function fallback() { logText.focus(); logText.select(); if (!document.execCommand('copy')) throw new Error(T('Не удалось скопировать журнал. Выделите текст и нажмите Ctrl+C.')); }
					return Promise.resolve().then(function() {
						if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext)
							return navigator.clipboard.writeText(logText.value).catch(fallback);
						fallback();
					}).then(function() { ui.addNotification(null, E('p', {}, T('Журнал скопирован.')), 'info'); });
				}); } }, T('Скопировать журнал')),
				E('label', { 'class': 'sb-log-toggle' }, [liveToggle, T(' В реальном времени')]),
				E('label', { 'class': 'sb-log-toggle' }, [followToggle, T(' Автопрокрутка')])]),
			E('p', { style: 'margin:0 0 10px;opacity:.75;font-size:12px;' }, logState), logText]);
		if (activeTab !== 'all') {
			var allowed = fieldsByTab[activeTab] || fieldsByTab.settings;
			s.children = s.children.filter(function(option) { return (activeTab === 'settings' && option.option === '_service_status') || allowed.indexOf(option.option) >= 0; });
		}
		// LuCI 25.12 renders description strings only; keep live DOM summaries in widgets.
		(s.children || []).forEach(function(option) {
			if (!option.description || typeof option.description === 'string') return;
			var description = option.description, renderWidget = option.renderWidget;
			option.description = '';
			option.renderWidget = function() {
				return Promise.resolve(renderWidget.apply(this, arguments)).then(function(widget) {
					return E('div', { 'class': 'sb-field-stack' }, [widget, E('div', { 'class': 'cbi-value-description' }, description)]);
				});
			};
		});
		return m.render().then(function(rendered) {
			var tabLabels = [['settings',T('Настройки')],['subscription',T('Подписка')],['servers',T('Пинг')],['routing',T('Маршрутизация')],['dns','DNS'],['network',T('Сеть')],['versions',T('Версии')],['config',T('Конфигурация')],['logs',T('Журнал')]];
			var navigation = E('div', { 'class': 'sb-navigation', 'aria-label': T('Вкладки Sing-Box') }, [
				E('style', {}, '#tabmenu{display:none!important}'),
				E('ul', { 'class': 'tabs' }, tabLabels.map(function(tab) {
					return E('li', { 'class': tab[0] === activeTab ? 'active' : '' },
						E('a', { href: L.url('admin','services','sing-box',tab[0]), 'aria-current': tab[0] === activeTab ? 'page' : null }, tab[1]));
				}))]);
			var contents = [navigation, info, rendered];
			if (activeTab === 'versions' || activeTab === 'all') contents.push(coreSection);
			if (activeTab === 'subscription' || activeTab === 'all') contents.push(sourceManager, importSection);
			if (activeTab === 'config' || activeTab === 'all') contents.push(configSection);
			if (activeTab === 'logs' || activeTab === 'all') contents.push(logSection);
			if (extraContent) contents.push(extraContent);
			if (activeTab !== 'versions' && activeTab !== 'logs' && activeTab !== 'routing') contents.push(E('div', { 'class': 'cbi-page-actions' }, [stopButton, restartButton, applyButton]));
			var layout = '.sb-app{max-width:1440px;margin:0 auto}' +
				'.sb-app .cbi-section{padding:20px 22px;margin:0 0 20px;border:1px solid rgba(128,128,128,.24);border-radius:8px;background:rgba(128,128,128,.035)}' +
				'.sb-app .cbi-section h3{margin:0 0 18px;padding-bottom:12px;border-bottom:1px solid rgba(128,128,128,.2)}' +
				'.sb-app .cbi-value{display:grid;grid-template-columns:220px minmax(0,1fr);column-gap:24px;align-items:start;padding:12px 0;min-height:0;margin:0}' +
				'.sb-tab-routing .cbi-map>.cbi-section,.sb-tab-subscription .cbi-map>.cbi-section,.sb-tab-versions .cbi-map>.cbi-section,.sb-tab-config .cbi-map>.cbi-section,.sb-tab-logs .cbi-map>.cbi-section{display:none}' +
				'.sb-app .sb-core-row{grid-template-columns:280px minmax(0,1fr);align-items:center;max-width:1080px;margin:0 auto;padding:10px 0;min-height:34px}' +
				'.sb-app .sb-core-row label.cbi-value-title{padding:0;line-height:1.5}.sb-app .sb-core-row .cbi-value-field{overflow-wrap:anywhere}' +
				'.sb-app .sb-core-row .cbi-value-description{margin-top:0}.sb-app .sb-core-row .cbi-value-field>p:empty{display:none}' +
				'.sb-tab-config .cbi-section-node{max-width:1120px;margin:0 auto}.sb-tab-config .cbi-value{grid-template-columns:minmax(0,1fr);gap:12px}' +
				'.sb-tab-config .cbi-value label.cbi-value-title{text-align:center;padding:0}.sb-tab-config .cbi-value-field{text-align:center}' +
				'.sb-config-editor>p:first-child{text-align:left;line-height:1.6;margin:16px 0 12px}.sb-config-editor textarea{text-align:left}' +
				'.sb-editor-actions{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:10px}' +
				'.sb-probe-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px 16px;margin:0 0 14px}.sb-probe-toolbar>strong{font-size:14px}.sb-probe-toolbar>span{margin-left:0!important;font-size:12px;opacity:.8}' +
				'.sb-source-manager{margin:24px 0}.sb-source-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.sb-source-card .sb-source-info{margin:8px 0 16px;opacity:.75}.sb-source-card h3{overflow-wrap:anywhere}' +
				'.sb-source-card>.sb-source-actions{justify-content:center}' +
				'.sb-log-toggle{display:inline-flex;align-items:center;gap:6px;margin:0;cursor:pointer;white-space:nowrap}' +
				'.sb-source-add{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.sb-source-add input{flex:1;min-width:180px}.sb-source-summary{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 20px;line-height:1.6;margin:0;padding:0}.sb-source-summary dt,.sb-source-summary dd{float:none;width:auto;margin:0;padding:0;text-align:left;font-weight:normal;overflow-wrap:anywhere}.sb-source-summary dt{opacity:.75}.sb-source-error{color:#d45a4f}.sb-source-edit{margin-top:16px;padding-top:12px;border-top:1px solid rgba(128,128,128,.2)}.sb-source-centered{justify-content:center}' +
				'.sb-app [data-field="cbid.singbox_gui.main._service_status"]{align-items:center}.sb-app [data-field="cbid.singbox_gui.main._service_status"] label.cbi-value-title{padding:0;line-height:1.5}.sb-app [data-field="cbid.singbox_gui.main._service_status"]>.cbi-value-field{display:flex;align-items:center}' +
				'@media(max-width:720px){.sb-app.sb-tab-settings [data-field="cbid.singbox_gui.main._service_status"]{grid-template-columns:max-content max-content;gap:24px}}' +
				'.sb-app .cbi-value.hidden,.sb-app .cbi-value[hidden]{display:none!important}.sb-app .cbi-value:after,.sb-app .cbi-value:before{display:none}' +
				'.sb-app .cbi-value-title{float:none;width:auto;text-align:right;padding:7px 0;margin:0;line-height:1.5;overflow-wrap:anywhere}' +
				'.sb-app .cbi-value-field{margin:0!important;min-width:0;padding:0;line-height:1.5}' +
				'.sb-app .cbi-value-field input:not([type=checkbox]):not([type=button]),.sb-app .cbi-value-field select,.sb-app .cbi-value-field .cbi-dropdown{width:100%;max-width:560px;box-sizing:border-box}' +
				'.sb-app .cbi-value-description{line-height:1.55;margin-top:7px;opacity:.85;max-width:920px}' +
				'.sb-app .cbi-button{min-height:32px;padding:5px 13px;line-height:1.4;white-space:normal}' +
				'.sb-app .cbi-page-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:10px;padding:16px 20px;border:1px solid rgba(128,128,128,.2);border-radius:8px;margin:20px 0}' +
				'.sb-app [data-field="cbid.singbox_gui.main._latency"]{grid-template-columns:minmax(0,1fr);gap:10px}' +
				'.sb-app [data-field="cbid.singbox_gui.main._latency"]>.cbi-value-title{text-align:left;font-weight:600}' +
				'@media(max-width:720px){.sb-app .cbi-section{padding:16px 12px}.sb-app .cbi-value{grid-template-columns:minmax(0,1fr);gap:6px}.sb-app .cbi-value label.cbi-value-title{text-align:left;padding:0}.sb-app .cbi-value-field>input:not([type=checkbox]),.sb-app .cbi-value-field>select{max-width:100%}.sb-app .cbi-page-actions{justify-content:stretch}.sb-app .cbi-page-actions button{flex:1}}';
			contents.unshift(E('style', {}, layout));
			var page = E('div', { 'class': 'sb-app sb-tab-' + activeTab }, contents);
			if (typeof poll !== 'undefined' && poll.add) poll.add(function() { return status().then(result).then(renderStatus).catch(function() {}); }, 5);
			if ((activeTab === 'versions' || activeTab === 'all') && coreData.job && coreData.job.state === 'running') changeCore(function() { return Promise.resolve({ok:true}); }).catch(function() {});
			if (activeTab === 'logs') {
				refreshLogs().catch(function() {});
				if (typeof poll !== 'undefined' && poll.add) poll.add(function() {
					if (!logLive || (typeof document !== 'undefined' && document.hidden)) return Promise.resolve();
					return refreshLogs().catch(function() {});
				}, 1);
			}
			return page;
		});
	},
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
