'use strict';
'require baseclass';
'require rpc';
'require ui';
'require uci';
'require singbox-i18n as i18n';
'require singbox-choices as choices';

var getProfile = rpc.declare({ object:'luci.singbox', method:'routing_get', expect:{} });
var start = rpc.declare({ object:'luci.singbox', method:'routing_start', params:['text','mode'], expect:{} });
var pollJob = rpc.declare({ object:'luci.singbox', method:'routing_poll', params:['job'], expect:{} });
function T(s) { return i18n.tr(s); }
function success(r) { if (r.ok === false || r.error) throw new Error(T(r.error || 'Operation failed')); return r; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

return baseclass.extend({
    load:function() { return getProfile().then(success); },
    render:function(data) {
        i18n.setLanguage(uci.get('singbox_gui','main','ui_language') || 'ru');
        var draft=clone(data.job ? data.job.profile : data.profile), dirty=!!(data.job && data.job.mode==='check'), busy=false;
        var root=E('div',{'class':'sb-routing','aria-label':T('Routing builder')});
        var settings=E('div',{'class':'sb-routing-settings'}), table=E('div',{}), sets=E('div',{});
        var status=E('span',{role:'status'},T('No unsaved routing changes'));
        var preview=E('textarea',{readonly:true,rows:18,'aria-label':T('Generated routing JSON'),style:'display:none;width:100%;box-sizing:border-box;font-family:monospace;resize:vertical;'});
        var nodes=data.nodes || [];
        if(typeof window!=='undefined' && window.addEventListener)window.addEventListener('beforeunload',function(event){if(dirty){event.preventDefault();event.returnValue='';}});
        function notify(error) { ui.addNotification(null,E('p',{},T(error.message || error)),'error'); }
        function changed() { dirty=true;status.textContent=T('Unsaved routing changes');preview.style.display='none'; }
        function textInput(value, label) { return E('input',{type:'text',value:value || '', 'aria-label':T(label)}); }
        function area(value,label,placeholder) { var input=E('textarea',{rows:3,'aria-label':T(label),placeholder:placeholder || '',spellcheck:'false'});input.value=(value || []).join('\n');return input; }
        function lines(input) { return input.value.split(/\r?\n/).map(function(v){return v.trim();}).filter(Boolean); }
        function field(label,widget,description) { return E('div',{'class':'cbi-value'},[E('label',{'class':'cbi-value-title'},T(label)),E('div',{'class':'cbi-value-field'},[widget,description ? E('div',{'class':'cbi-value-description'},T(description)) : ''])]); }
        function checkbox(value,label,onchange) { return E('label',{'class':'sb-routing-check'},[E('input',{type:'checkbox',checked:value ? true : null,change:function(){onchange(this.checked);}}),' '+T(label)]); }
        function toggleCard(value,label,help,onchange){return E('div',{'class':'sb-routing-toggle-card'},[checkbox(value,label,onchange),E('p',{'class':'sb-routing-field-help'},T(help))]);}
        function button(label,callback,style,disabled) { return E('button',{type:'button','class':'cbi-button '+(style || ''),disabled:disabled ? true : null,click:callback},T(label)); }
        function select(value,choices,label,onchange) { return E('select',{'aria-label':T(label),change:function(){if(onchange)onchange.call(this,this.value);}},choices.map(function(item){return E('option',{value:item[0],selected:String(item[0])===String(value)?true:null},T(item[1]));})); }
        function outboundChoices() {
            return [['direct',T('Direct connection')],['block',T('Block')]].concat(nodes.map(function(n){
                var host=String(n.server || '');
                return ['node:'+n.id,n.name+' · '+(host.indexOf(':')>=0?'['+host+']':host)+':'+n.port];
            }));
        }
        function outboundSelect(value,label,onchange){
            var items=outboundChoices();
            if(!items.some(function(item){return item[0]===value;}))items.push([value,T('Unavailable server')+' · '+String(value).replace(/^node:/,'')]);
            return choices.dropdown(value,items,onchange,T(label));
        }
        function targetName(value) { var entry=outboundChoices().find(function(item){return item[0]===value;});return entry?entry[1]:T('Unavailable server')+' · '+String(value).replace(/^node:/,''); }
        function editRule(index) {
            var rule=index == null ? {name:T('New rule'),enabled:true,mode:'and',invert:false,match_all:false,outbound:'direct',conditions:{}} : clone(draft.rules[index]);
            var name=textInput(rule.name,'Rule name'), mode=select(rule.mode,[['and','All conditions (AND)'],['or','Any condition (OR)']],'Condition logic');
            var target=outboundSelect(rule.outbound,'Rule outbound',function(value){rule.outbound=value;});
            var enabled=rule.enabled, invert=rule.invert, matchAll=rule.match_all;
            var inputs={},conditions=rule.conditions || {};
            var specifications=[
                ['domain','Exact domains','example.com'],['domain_suffix','Domain suffixes','.example.com'],
                ['domain_keyword','Domain keywords','video'],['domain_regex','Domain regular expressions','^([a-z0-9-]+\\.)?example\\.com$'],
                ['geosite','Geosite categories','google\nyoutube\ntelegram'],['geoip','GeoIP categories','ru\nus'],
                ['ip_cidr','Destination IP / CIDR','203.0.113.0/24'],['source_ip_cidr','Source IP / CIDR','192.168.1.100/32'],
                ['port','Destination ports','443\n8000:9000'],['source_port','Source ports','1024:65535'],
                ['network','Networks','tcp\nudp'],['protocol','Sniffed protocols','tls\nhttp\nquic'],
                ['rule_set','Custom rule-set tags','my-domains']
            ];
            var grid=E('div',{'class':'sb-routing-grid'});
            specifications.forEach(function(spec){
                var input=area(conditions[spec[0]],spec[1],spec[2]);inputs[spec[0]]=input;
                input.id='sb-rule-'+spec[0];
                var children=[E('label',{'for':input.id},T(spec[1])),input];
                if(spec[0]==='geosite') {
                    var preset=select('',[['','Add a popular category'],['google','Google'],['youtube','YouTube'],['telegram','Telegram'],['discord','Discord'],['category-ads-all','Advertising']],'Geosite preset',function(value){if(value){var values=lines(input);if(values.indexOf(value)<0)values.push(value);input.value=values.join('\n');this.value='';}});
                    children.push(E('div',{'class':'sb-routing-category-actions'},[preset,E('a',{'class':'cbi-button sb-routing-catalog',href:'https://github.com/SagerNet/sing-geosite/tree/rule-set',target:'_blank',rel:'noopener noreferrer',title:T('Open the SagerNet category catalog in a new tab')},T('View category catalog'))]));
                    children.push(E('p',{'class':'sb-routing-field-help'},T('Choose a preset or enter one category per line. The catalog opens in a new tab; use names such as google, without geosite- or .srs.')));
                }
                grid.appendChild(E('div',{'class':'sb-routing-condition'},children));
            });
            var ipVersion=select(conditions.ip_version || 0,[['0','Any IP version'],['4','IPv4'],['6','IPv6']],'IP version');
            var privateIP=!!conditions.ip_is_private,privateSource=!!conditions.source_ip_is_private;
            ipVersion.id='sb-rule-ip-version';
            var ipOptions=E('div',{'class':'sb-routing-ip-options'},[
                E('div',{'class':'sb-routing-toggle-card sb-routing-ip-version'},[
                    E('label',{'for':ipVersion.id},T('IP version')),ipVersion,
                    E('p',{'class':'sb-routing-field-help'},T('Choose IPv4, IPv6, or both IP versions for this rule.'))]),
                toggleCard(privateIP,'Private destination IP','Matches traffic to private destination addresses, such as 10.0.0.1 or 192.168.1.1. Useful for local services. Combined with other conditions using the selected AND/OR logic.',function(v){privateIP=v;}),
                toggleCard(privateSource,'Private source IP','Matches traffic from a private source address, such as a LAN device at 192.168.1.100. Use Source IP / CIDR to specify a particular client or subnet. Combined using the selected AND/OR logic.',function(v){privateSource=v;})
            ]);
            var conditionPanel=E('div',{'class':'sb-routing-condition-panel'},[
                ipOptions,
                E('div',{'class':'sb-routing-editor-note'},[
                    E('p',{},T('Enter one value per line. Regular expressions use the Sing-box RE2 syntax. Geosite categories are converted to current rule-sets.')),
                    E('p',{},T('Values within one field use OR; fields use the selected AND/OR logic.'))]),grid]);
            var matchBox=checkbox(matchAll,'Match all traffic',function(value){matchAll=value;conditionPanel.style.display=value?'none':'';mode.disabled=value;});
            conditionPanel.style.display=matchAll?'none':'';mode.disabled=matchAll;
            var content=[
                E('div',{'class':'sb-routing-editor-header'},[field('Rule name',name),field('Rule outbound',target),field('Condition logic',mode)]),
                E('div',{'class':'sb-routing-editor-flags'},[toggleCard(enabled,'Enabled','The rule participates in routing. Disable it to keep it in the list without applying it.',function(v){enabled=v;}),toggleCard(invert,'Invert match','Applies the rule when its combined conditions do not match. The final AND/OR result is inverted, rather than each individual field.',function(v){invert=v;})]),
                E('div',{'class':'sb-routing-match-all'},[matchBox,E('p',{'class':'sb-routing-field-help'},T('Matches all remaining TUN traffic after earlier rules and managed DNS handling, without extra filters. The selected outbound is applied and later rules are skipped. Place this rule last. With inversion enabled, it matches no traffic.'))]),
                conditionPanel,
                E('div',{'class':'sb-routing-toolbar sb-routing-end'},[
                    button('Cancel',function(){ui.hideModal();}),
                    button('Save rule',function(){
                        var values={};Object.keys(inputs).forEach(function(key){var list=lines(inputs[key]);if(list.length)values[key]=list;});
                        if(Number(ipVersion.value))values.ip_version=Number(ipVersion.value);
                        if(privateIP)values.ip_is_private=true;if(privateSource)values.source_ip_is_private=true;
                        if(!matchAll && !Object.keys(values).length){notify(new Error(T('Add a condition or explicitly match all traffic')));return;}
                        rule={name:name.value.trim() || T('New rule'),enabled:enabled,mode:mode.value,invert:invert,match_all:matchAll,outbound:rule.outbound,conditions:matchAll?{}:values};
                        if(index==null)draft.rules.push(rule);else draft.rules[index]=rule;
                        changed();renderRules();ui.hideModal();
                    },'cbi-button-apply')])];
            ui.showModal(T(index==null?'Add routing rule':'Edit routing rule'),content,'sb-routing-modal');
        }
        function summary(rule) {
            if(rule.match_all)return T('All traffic');
            var labels={domain:'Exact domains',domain_suffix:'Domain suffixes',domain_keyword:'Domain keywords',domain_regex:'Domain regular expressions',geosite:'Geosite categories',geoip:'GeoIP categories',ip_cidr:'Destination IP / CIDR',source_ip_cidr:'Source IP / CIDR',port:'Destination ports',source_port:'Source ports',network:'Networks',protocol:'Sniffed protocols',rule_set:'Custom rule-set tags',ip_version:'IP version',ip_is_private:'Private destination IP',source_ip_is_private:'Private source IP'};
            return Object.keys(rule.conditions || {}).map(function(key){var value=rule.conditions[key];return T(labels[key] || key)+': '+(Array.isArray(value)?value.join(', '):value===true?T('Yes'):value);}).join(' · ');
        }
        function renderRules() {
            var rows=draft.rules.map(function(rule,index){
                return E('tr',{'class':rule.enabled?'':'sb-routing-disabled'},[
                    E('td',{},String(index+1)),E('td',{},checkbox(rule.enabled,'Enabled',function(value){rule.enabled=value;changed();renderRules();})),
                    E('td',{},[E('strong',{},rule.name),E('div',{'class':'sb-routing-rule-summary',title:summary(rule)},summary(rule)),E('small',{},rule.mode.toUpperCase()+(rule.invert?' · '+T('Inverted'):''))]),
                    E('td',{},choices.label(targetName(rule.outbound))),E('td',{},E('div',{'class':'sb-routing-row-actions'},[
                        button('↑',function(){var previous=draft.rules[index-1];draft.rules[index-1]=rule;draft.rules[index]=previous;changed();renderRules();},'',index===0),
                        button('↓',function(){var next=draft.rules[index+1];draft.rules[index+1]=rule;draft.rules[index]=next;changed();renderRules();},'',index===draft.rules.length-1),
                        button('Edit',function(){editRule(index);}),button('Duplicate',function(){var copy=clone(rule);copy.name+=' · '+T('copy');draft.rules.splice(index+1,0,copy);changed();renderRules();}),
                        button('Delete',function(){draft.rules.splice(index,1);changed();renderRules();},'cbi-button-negative')]))]);
            });
            table.replaceChildren(E('div',{'class':'sb-routing-scroll'},E('table',{'class':'sb-routing-table'},[
                E('thead',{},E('tr',{},['#','Enabled','Rule and conditions','Outbound','Actions'].map(function(label){return E('th',{},T(label));}))),
                E('tbody',{},rows.length?rows:E('tr',{},E('td',{colspan:5},T('No routing rules. Unmatched traffic uses the default outbound.'))))])));
        }
        function editSet(index) {
            var entry=index==null?{tag:'',url:'',format:'binary'}:clone(draft.rule_sets[index]);
            var tag=textInput(entry.tag,'Rule-set tag'),url=textInput(entry.url,'Rule-set URL');
            var format=select(entry.format,[['binary','Binary (.srs)'],['source','Source (.json)']],'Rule-set format');
            ui.showModal(T('Custom rule-set'),[field('Rule-set tag',tag),field('Rule-set URL',url,'Use an HTTPS URL. Reference this tag in a rule.'),field('Rule-set format',format),
                E('div',{'class':'sb-routing-toolbar sb-routing-end'},[button('Cancel',function(){ui.hideModal();}),button('Save rule-set',function(){
                    if(!tag.value.trim()||!url.value.trim()){notify(new Error(T('Enter a rule-set tag and URL')));return;}
                    entry={tag:tag.value.trim(),url:url.value.trim(),format:format.value};
                    if(index==null)draft.rule_sets.push(entry);else draft.rule_sets[index]=entry;
                    changed();renderSets();ui.hideModal();
                },'cbi-button-apply')])]);
        }
        function renderSets() {
            sets.replaceChildren.apply(sets,draft.rule_sets.length?draft.rule_sets.map(function(entry,index){
                return E('div',{'class':'sb-routing-set'},[E('div',{},[E('strong',{},entry.tag),E('div',{'class':'sb-routing-rule-summary'},entry.url)]),E('span',{},entry.format),button('Edit',function(){editSet(index);}),button('Delete',function(){draft.rule_sets.splice(index,1);changed();renderSets();},'cbi-button-negative')]);
            }):[E('p',{},T('Geosite and GeoIP categories are added automatically. Custom URLs are optional.'))]);
        }
        function renderSettings() {
            var interval=E('input',{type:'number',value:draft.rule_set_interval,min:1,max:168,change:function(){draft.rule_set_interval=Number(this.value);changed();}});
            settings.replaceChildren(
                field('Routing',checkbox(draft.enabled,'Enable internal routing',function(v){draft.enabled=v;changed();})),
                field('Traffic capture',select(draft.capture_mode || 'pbr',[['pbr','PBR — existing policies'],['automatic','Automatic routes — without PBR']],'Traffic capture',function(v){draft.capture_mode=v;changed();}),'Automatic mode captures traffic through TUN and nftables on its own. Disable conflicting packages and add-ons before applying it.'),
                field('Default outbound',outboundSelect(draft.final,'Default outbound',function(v){draft.final=v;changed();})),
                field('Domain and protocol detection',checkbox(draft.sniff,'Enable domain and protocol detection',function(v){draft.sniff=v;changed();}),'Domain rules need a visible domain name. TLS ECH or encrypted traffic may prevent detection.'),
                field('Rule-set source',select(draft.mirror || 'github',[['github','SagerNet / GitHub'],['jsdelivr','SagerNet / jsDelivr mirror']],'Rule-set source',function(v){draft.mirror=v;changed();})),
                field('Rule-set updates, hours',interval,'Sing-box updates remote rule-sets automatically. Initial downloads are validated before saving.'));
        }
        function setBusy(value) {
            busy=value;settings.inert=value;table.inert=value;sets.inert=value;
            root.querySelectorAll('input,select,textarea,button').forEach(function(element){
                if(value){element._routingDisabled=element.disabled;element.disabled=true;}
                else element.disabled=!!element._routingDisabled;
            });
        }
        function execute(mode,existingJob) {
            if(busy)return Promise.resolve();
            setBusy(true);status.textContent=T('Validating routing profile');
            var deadline=Date.now()+600000;
            function wait(ident){return pollJob(ident).then(success).then(function(r){
                if(r.state==='done')return success(r);
                status.textContent=T(r.message || 'Working…');
                if(Date.now()>deadline)throw new Error(T('Routing operation timed out. Reload the status before retrying.'));
                return new Promise(function(resolve){setTimeout(resolve,1000);}).then(function(){return wait(ident);});
            });}
            return (existingJob?Promise.resolve({ok:true,job:existingJob}):start(JSON.stringify(draft),mode)).then(success).then(function(r){return wait(r.job);}).then(function(r){
                if(mode!=='check')dirty=false;
                status.textContent=T(r.message)+(dirty?' · '+T('Unsaved routing changes'):'');
                preview.value=JSON.stringify(r.preview,null,2);preview.style.display='';
            }).catch(function(error){status.textContent=T(error.message);notify(error);}).finally(function(){setBusy(false);});
        }
        function exportProfile() {
            var text=E('textarea',{readonly:true,rows:20,style:'width:100%;font-family:monospace;'});text.value=JSON.stringify(draft,null,2);
            ui.showModal(T('Export routing profile'),[text,E('p',{},T('This JSON contains the builder profile and can be imported back.')),
                E('div',{'class':'sb-routing-toolbar sb-routing-end'},[button('Close',function(){ui.hideModal();}),button('Download JSON',function(){var blob=new Blob([text.value],{type:'application/json'}),url=URL.createObjectURL(blob),link=E('a',{href:url,download:'singbox-routing.json'});link.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);})])]);
        }
        function normalizeImport(value){
            function invalid(message){throw new Error(T(message || 'Invalid routing profile'));}
            function object(item){return item && typeof item==='object' && !Array.isArray(item);}
            function keys(item,allowed,message){if(!object(item) || Object.keys(item).some(function(key){return allowed.indexOf(key)<0;}))invalid(message);}
            function text(item,limit){if(typeof item!=='string' || item.length>limit || /[\u0000-\u001f]/.test(item))invalid();return item.trim();}
            function flag(item,fallback){if(item===undefined)return fallback;if(typeof item!=='boolean')invalid();return item;}
            function target(item){if(item==='proxy')return 'direct';if(typeof item!=='string' || (['direct','block'].indexOf(item)<0 && !/^node:[a-f0-9]{24}$/.test(item)))invalid('Invalid routing outbound');return item;}
            function list(item){
                if(typeof item==='string')item=item.split(/\r?\n/);
                if(!Array.isArray(item) || item.length>256)invalid();
                return Array.from(new Set(item.map(function(entry){return text(entry,2048);}).filter(Boolean)));
            }
            keys(value,['version','name','enabled','sniff','final','capture_mode','rule_set_interval','mirror','rules','rule_sets']);
            if(value.version!==1 || !Array.isArray(value.rules) || !Array.isArray(value.rule_sets) || value.rules.length>200 || value.rule_sets.length>64)invalid();
            var result={version:1,enabled:flag(value.enabled,true),sniff:flag(value.sniff,true),final:target(value.final===undefined?'direct':value.final),capture_mode:value.capture_mode===undefined?'pbr':value.capture_mode,rule_set_interval:value.rule_set_interval===undefined?24:value.rule_set_interval,mirror:value.mirror===undefined?'github':value.mirror,rules:[],rule_sets:[]};
            if(['pbr','automatic'].indexOf(result.capture_mode)<0 || ['github','jsdelivr'].indexOf(result.mirror)<0 || !Number.isInteger(result.rule_set_interval) || result.rule_set_interval<1 || result.rule_set_interval>168)invalid();
            if(result.capture_mode==='automatic' && !result.enabled)invalid('Automatic routes require internal routing to be enabled');
            var tags=new Set();
            result.rule_sets=value.rule_sets.map(function(entry){
                keys(entry,['tag','url','format'],'Invalid rule-set definition');
                var tag=text(entry.tag,80),url=text(entry.url,4096),format=entry.format===undefined?'binary':entry.format;
                if(!/^[a-zA-Z0-9][a-zA-Z0-9_.@!-]{0,79}$/.test(tag) || tags.has(tag) || !/^https:\/\//i.test(url) || /\s/.test(url) || ['binary','source'].indexOf(format)<0)invalid('Invalid rule-set definition');
                tags.add(tag);return {tag:tag,url:url,format:format};
            });
            var lists=['domain','domain_suffix','domain_keyword','domain_regex','geosite','geoip','ip_cidr','source_ip_cidr','port','source_port','network','protocol','rule_set'];
            result.rules=value.rules.map(function(entry,index){
                keys(entry,['name','enabled','mode','invert','match_all','outbound','conditions'],'Invalid routing rule');
                var conditions=entry.conditions===undefined?{}:entry.conditions;
                keys(conditions,lists.concat(['ip_is_private','source_ip_is_private','ip_version']),'Invalid routing rule');
                var rule={name:entry.name===undefined?T('New rule'):text(entry.name,80) || T('New rule'),enabled:flag(entry.enabled,true),mode:entry.mode===undefined?'and':entry.mode,invert:flag(entry.invert,false),match_all:flag(entry.match_all,false),outbound:target(entry.outbound===undefined?'direct':entry.outbound),conditions:{}};
                if(['and','or'].indexOf(rule.mode)<0)invalid('Invalid routing rule');
                lists.forEach(function(key){if(conditions[key]!==undefined){var entries=list(conditions[key]);if(entries.length)rule.conditions[key]=entries;}});
                ['ip_is_private','source_ip_is_private'].forEach(function(key){if(flag(conditions[key],false))rule.conditions[key]=true;});
                if(conditions.ip_version!==undefined && conditions.ip_version!==null && conditions.ip_version!=='' && [0,4,6].indexOf(conditions.ip_version)<0)invalid('Invalid routing rule');
                if(conditions.ip_version)rule.conditions.ip_version=conditions.ip_version;
                if(!rule.match_all && !Object.keys(rule.conditions).length)invalid('Add a condition or explicitly match all traffic');
                if((rule.conditions.rule_set || []).some(function(tag){return !tags.has(tag);}))invalid('A referenced custom rule-set is not defined');
                return rule;
            });
            return result;
        }
        function importProfile() {
            var text=E('textarea',{rows:20,style:'width:100%;font-family:monospace;','aria-label':T('Routing profile JSON')});
            ui.showModal(T('Import routing profile'),[text,E('p',{},T('Import an exported builder profile. The current draft is replaced; nothing is applied until you save.')),
                E('div',{'class':'sb-routing-toolbar sb-routing-end'},[button('Cancel',function(){ui.hideModal();}),button('Import',function(){try{
                    if(text.value.length>1048576)throw new Error(T('Routing profile is too large'));
                    var value=normalizeImport(JSON.parse(text.value));
                    var previous=draft;
                    try{draft=value;renderSettings();renderRules();renderSets();}
                    catch(error){draft=previous;renderSettings();renderRules();renderSets();throw error;}
                    changed();ui.hideModal();
                }catch(error){notify(error);}},'cbi-button-apply')])]);
        }
        var preset=select('',[['','Choose a preset'],['private','Private IPs → direct'],['ads','Advertising geosite → block'],['quic','UDP 443 → block']],'Routing preset');
        var addPreset=button('Add preset',function(){
            var value=preset.value;if(!value)return;
            draft.rules.push({name:T(value==='private'?'Private IPs → direct':value==='ads'?'Advertising geosite → block':'UDP 443 → block'),enabled:true,mode:'and',invert:false,match_all:false,outbound:value==='private'?'direct':'block',conditions:value==='private'?{ip_is_private:true}:value==='ads'?{geosite:['category-ads-all']}:{network:['udp'],port:['443']}});
            changed();renderRules();preset.value='';
        });
        root.appendChild(E('style',{},'.sb-app .sb-routing-settings{width:100%;max-width:1060px;margin:20px auto 4px}.sb-app .sb-routing-settings .cbi-value{grid-template-columns:220px minmax(0,1fr);gap:0 24px;padding:12px 0}.sb-app .sb-routing-settings .cbi-value-title{padding:6px 0;line-height:1.5}.sb-app .sb-routing-settings .cbi-value-field{min-width:0}.sb-app .sb-routing-settings .cbi-value-field>select,.sb-app .sb-routing-settings .cbi-value-field>.cbi-dropdown{max-width:none;width:100%;min-height:32px}.sb-app .sb-routing-settings .sb-routing-check{min-height:32px;margin:0;gap:9px}.sb-app .sb-routing-settings .sb-routing-check input{margin:0;flex-shrink:0}.sb-app .sb-routing .sb-routing-settings .cbi-value-field>input[type=number]{max-width:none;width:100%;min-height:32px;box-sizing:border-box}.sb-app .sb-routing-settings .cbi-value-description{max-width:none;margin-top:6px}.sb-app .sb-routing-settings .cbi-value+.cbi-value{border-top:1px solid rgba(128,128,128,.12)}@media(max-width:720px){.sb-app .sb-routing-settings{margin-top:12px}.sb-app .sb-routing-settings .cbi-value{grid-template-columns:minmax(0,1fr);gap:6px;padding:14px 0}.sb-app .sb-routing-settings label.cbi-value-title{text-align:left;padding:0}.sb-app .sb-routing-settings input[type=number]{max-width:100%}}.sb-routing-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:12px 0}.sb-routing-end{justify-content:flex-end}.sb-routing-footer>.sb-routing-toolbar{justify-content:flex-end;margin:0 0 10px}.sb-routing-footer-status{text-align:right;margin:0;line-height:1.5}.sb-routing-footer>textarea{margin-top:16px}.sb-routing-check{display:inline-flex;align-items:center;gap:7px;margin:0;line-height:1.6}.sb-routing-scroll{overflow:auto;border:1px solid rgba(128,128,128,.25);border-radius:6px}.sb-routing-table{width:100%;min-width:850px;border-collapse:collapse}.sb-routing-table th,.sb-routing-table td{padding:12px!important;vertical-align:middle;border-bottom:1px solid rgba(128,128,128,.2);text-align:left}.sb-routing-table th{white-space:nowrap}.sb-routing-rule-summary{max-width:600px;overflow-wrap:anywhere;font-size:12px;opacity:.75;line-height:1.5;margin:4px 0}.sb-routing-row-actions{display:flex;flex-wrap:wrap;gap:5px}.sb-routing-row-actions button{padding:4px 8px!important;min-height:28px!important}.sb-routing-disabled{opacity:.55}.sb-routing-set{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:12px 0;border-bottom:1px solid rgba(128,128,128,.2)}.sb-routing-set>div{flex:1;min-width:200px}.sb-routing-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 20px}.sb-routing-condition{min-width:0}.sb-routing-condition>label{display:block;font-weight:600;margin:6px 0}.sb-routing-condition textarea{width:100%;box-sizing:border-box;font-family:monospace;resize:vertical}.sb-routing-condition select{width:100%;margin-top:6px}.sb-routing-modal{max-width:1100px!important}.sb-routing-modal .cbi-value{display:grid;grid-template-columns:180px minmax(0,1fr);gap:15px;margin-bottom:12px}.sb-routing-modal .cbi-value-title{width:auto;float:none}.sb-routing-modal .cbi-value-field{margin:0;min-width:0}.sb-routing-modal input[type=text],.sb-routing-modal select{width:100%}@media(max-width:720px){.sb-routing-grid{grid-template-columns:minmax(0,1fr)}.sb-routing-modal .cbi-value{grid-template-columns:minmax(0,1fr)}.sb-routing-modal .cbi-value label.cbi-value-title{text-align:left}}.sb-routing-modal .sb-routing-editor-header{display:grid;gap:12px;margin:4px 0 16px}.sb-routing-modal .cbi-value{grid-template-columns:180px minmax(0,1fr);align-items:start;margin:0;padding:0;gap:16px}.sb-routing-modal .cbi-value-title{float:none;width:auto;text-align:left;padding:6px 0;line-height:1.5}.sb-routing-modal .cbi-value-field{margin:0!important;padding:0;min-width:0}.sb-routing-modal .cbi-value-field>input[type=text],.sb-routing-modal .cbi-value-field>select,.sb-routing-modal .cbi-value-field>.cbi-dropdown{width:100%;max-width:none;box-sizing:border-box;min-height:32px}.sb-routing-modal .sb-routing-editor-flags{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px;margin:16px 0}.sb-routing-modal .sb-routing-check{display:flex;align-items:center;gap:8px;margin:0;min-height:28px;line-height:1.5}.sb-routing-modal .sb-routing-check input{flex-shrink:0;margin:0}.sb-routing-modal .sb-routing-toggle-card{border:1px solid rgba(128,128,128,.3);border-radius:6px;padding:12px 14px;min-width:0;box-sizing:border-box}.sb-routing-modal .sb-routing-match-all{border:1px solid rgba(128,128,128,.3);border-radius:6px;padding:12px 14px;margin:0 0 16px}.sb-routing-modal .sb-routing-field-help{margin:6px 0 0;line-height:1.5;font-size:12px;opacity:.8}.sb-routing-modal .sb-routing-editor-note{padding:0 0 12px;line-height:1.5;opacity:.8}.sb-routing-modal .sb-routing-editor-note p{margin:0 0 4px}.sb-routing-modal .sb-routing-grid{gap:14px;align-items:stretch;margin-bottom:16px}.sb-routing-modal .sb-routing-condition{display:flex;flex-direction:column;gap:8px;border:1px solid rgba(128,128,128,.25);border-radius:6px;padding:12px;box-sizing:border-box}.sb-routing-modal .sb-routing-condition>label{display:block;margin:0;line-height:1.5;min-height:21px;font-weight:600}.sb-routing-modal .sb-routing-condition textarea{display:block;margin:0;min-height:84px;width:100%;box-sizing:border-box}.sb-routing-modal .sb-routing-category-actions{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:stretch}.sb-routing-modal .sb-routing-category-actions select{margin:0;min-width:0;height:34px;min-height:34px;box-sizing:border-box}.sb-routing-modal a.sb-routing-catalog{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;white-space:nowrap;text-decoration:none;margin:0;height:34px;min-height:34px;padding:5px 10px}.sb-routing-modal .sb-routing-toolbar.sb-routing-end{padding-top:14px;border-top:1px solid rgba(128,128,128,.25);margin-top:18px;gap:8px}@media(max-width:720px){.sb-routing-modal .cbi-value{grid-template-columns:minmax(0,1fr);gap:6px}.sb-routing-modal .cbi-value label.cbi-value-title{text-align:left;padding:0}.sb-routing-modal .sb-routing-editor-flags{grid-template-columns:minmax(0,1fr);gap:8px}.sb-routing-modal .sb-routing-category-actions{grid-template-columns:minmax(0,1fr)}.sb-routing-modal .sb-routing-toolbar.sb-routing-end button{flex:1}}.sb-routing-modal .sb-routing-ip-options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:0 0 16px;align-items:stretch}.sb-routing-modal .sb-routing-ip-version{display:flex;flex-direction:column;gap:8px;align-items:stretch}.sb-routing-modal .sb-routing-ip-version>label{margin:0;line-height:28px;font-weight:600}.sb-routing-modal .sb-routing-ip-version>select{width:100%;min-width:0;height:34px;margin:0;box-sizing:border-box}.sb-routing-modal .sb-routing-ip-version .sb-routing-field-help{margin:0}@media(max-width:900px){.sb-routing-modal .sb-routing-ip-options{grid-template-columns:minmax(0,1fr)}}'));
        root.appendChild(E('div',{'class':'cbi-section'},[E('h3',{},T('Sing-Box routing')),
            E('p',{},T('Traffic enters TUN through PBR policies or automatic routes. Rules are evaluated from top to bottom. Managed DNS rules remain first.')),
            data.manual?E('p',{'class':'sb-source-error'},T('Manual JSON mode is active. You can save a routing profile, but return to GUI configuration before applying it.')):'',settings]));
        root.appendChild(E('div',{'class':'cbi-section'},[E('h3',{},T('Ordered rules')),E('div',{'class':'sb-routing-toolbar'},[button('Add rule',function(){editRule(null);},'cbi-button-add'),preset,addPreset,button('Import',importProfile),button('Export',exportProfile)]),table]));
        root.appendChild(E('div',{'class':'cbi-section'},[E('h3',{},T('Custom rule-sets')),sets,button('Add rule-set',function(){editSet(null);},'cbi-button-add')]));
        root.appendChild(E('div',{'class':'cbi-section sb-routing-footer'},[E('div',{'class':'sb-routing-toolbar sb-routing-end'},[button('Validate / preview',function(){return execute('check');}),button('Save routing',function(){return execute('save');}),button('Save and apply',function(){return execute('apply');},'cbi-button-apply',data.manual)]),E('p',{'class':'sb-routing-footer-status'},status),preview]));
        renderSettings();renderRules();renderSets();
        if(data.job)execute(data.job.mode,data.job.id);
        return root;
    }
});
