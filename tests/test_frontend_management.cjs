const fs=require('fs'),vm=require('vm'),assert=require('assert');
const opts={},calls=[];
let state={running:true,interface:'sb0',interface_created:true,firewall_ready:true,user_agent:'sing-box/1.14.4',core_version:'1.14.4'};
const core={ok:true,current:'1.14.4',system:'1.14.4',supported:true,architecture:'x86_64',managed:false,user_agent:'sing-box/1.14.4',versions:[{version:'1.14.4'}]};
function E(tag,attrs,children){return {tag,attrs:attrs||{},children:children||[],style:{},replaceChildren(...v){this.children=v;},removeAttribute(){}};}
const map={section:()=>({option(type,name,title){const o={title,choices:[],value(k,v){this.choices.push([k,v]);},depends(){},renderWidget(){return E('input',{});}};opts[name]=o;return o;}}),save:async()=>calls.push('save'),render:async()=>{map.root=E('form',{});return map.root;},lookupOption:k=>{if(!map.root)throw Error('Cannot read properties of undefined (reading querySelectorAll)');return [opts[k]];}};
const rpc={declare(s){return async(...args)=>{calls.push(s.object+'/'+s.method);if(s.object==='luci.singbox.core')return s.method==='status'?core:(s.method==='poll'?{ok:true,state:'done'}:{ok:true});if(s.method==='status')return state;return {ok:true,message:'done'};}}};
const ctx={E,rpc,view:{extend:x=>x},form:{Map:function(){return map;}},uci:{get:(c,s,o)=>o==='selected'?'a':''},ui:{changes:{init:async()=>{}},addNotification(){}},L:{url:()=>''}};
ctx.choices={label:function(name){return E('span',{},name);}};
ctx.baseclass=ctx.view;
ctx.i18n={tr:x=>x,setLanguage(){},locale:()=> 'ru-RU'};
const view=vm.runInNewContext('(function(){'+fs.readFileSync('luci-app-sing-box/htdocs/luci-static/resources/singbox-ui.js','utf8')+'})()',ctx);
view.tab='all';
function find(n,p){if(!n||typeof n!=='object')return;if(p(n))return n;for(const c of [].concat(n.children||[])){const r=find(c,p);if(r)return r;}}
function text(n){if(typeof n==='string')return n;if(!n||typeof n!=='object')return '';return (n.textContent||'')+[].concat(n.children||[]).map(text).join(' ');}
(async()=>{
 const nodes=[{id:'a',name:'🇩🇪 DE',server:'192.0.2.1',port:443},{id:'b',name:'🇫🇷 FR',server:'2001:db8::1',port:8443}];
 const page=await view.render([{}, {nodes},state,core]);
 assert(text(opts._service_status.renderWidget()).includes('Запущен'));
 assert(Object.keys(opts).indexOf('_service_status')<Object.keys(opts).indexOf('enabled'));
 assert(!text(opts._service_status.renderWidget()).includes('version'));
 assert(!opts.selected,'Global server selector has been removed');
 const iface=await opts.interface.renderWidget('main',0,'sb0');assert(text(iface).includes('Создан'));
 assert.equal(iface.children[1].tag,'button');assert.equal(iface.children[2].textContent,'Создан');
 state={...state,interface_created:false};const create=find(iface,n=>n.tag==='button');
 await create.attrs.click.call(create);assert(calls.includes('luci.singbox/create_interface'));assert(text(iface).includes('Отсутствует'));
 const firewall=opts._firewall.renderWidget(),fw=find(firewall,n=>n.tag==='button');await fw.attrs.click.call(fw);assert(calls.includes('luci.singbox/create_firewall'));
 assert.equal(firewall.children[0].tag,'button');assert.equal(firewall.children[1].textContent,'Правила созданы');
 const check=find(page,n=>n.tag==='button'&&n.children==='Проверить обновления');await check.attrs.click();
 assert(calls.includes('luci.singbox.core/check'));assert(calls.includes('luci.singbox.core/poll'));
 assert(!text(page).includes('Открыть PBR'));assert(!text(page).includes('Сетевые интерфейсы'));
 console.log('PASS: separate status, server counts/endpoints, interface/firewall creation, core controls, removed footer links');
})().catch(e=>{console.error(e);process.exit(1)});
