const fs=require('fs'),vm=require('vm'),assert=require('assert');
const options={},deferred=[],requests=[];let cancellations=0,fail=false,cancelFailure=false,cancelResolve=null;
const map={section:()=>({option(type,name){const o={choices:[],value(k,v){this.choices.push([k,v]);},depends(){},formvalue(){return this.current??this.default??'';}};options[name]=o;return o;}}),render:async()=>({}),lookupOption:name=>[options[name]]};
function E(tag,attrs,children){return {tag,attrs:attrs||{},children:children||[],disabled:false,removeAttribute(n){delete this.attrs[n];},replaceChildren(...v){this.children=v;}};}
const jobs={};const sample={icmp_ms:1,tcp_ms:2,test_ms:3,url:'https://example.org'};
const rpc={declare(spec){return async(payload)=>{
 if(spec.method==='probe_cancel'){cancellations++;if(cancelResolve===true)return new Promise(resolve=>{cancelResolve=resolve;});if(cancelFailure)return {ok:false,error:'cancel failure'};return {ok:true,state:'cancelled'};}
 if(spec.method==='probe_start'){const p=JSON.parse(payload);assert.equal(p.ids.length,2,'One job contains the server list');assert(p.options.probe_dns);requests.push(p);const job='job'+requests.length;jobs[job]=p.ids;return {ok:true,job};}
 if(spec.method==='probe_poll')return new Promise((resolve,reject)=>deferred.push(response=>fail?reject(Error(typeof fail==='string'?fail:'failure')):resolve(response||{ok:true,state:'done',completed:2,latency:Object.fromEntries(jobs[payload].map(id=>[id,sample]))})));
 return {};
}}};
const ctx={E,rpc,baseclass:{extend:x=>x},form:{Map:function(){return map;}},uci:{get:()=>''},ui:{addNotification(){}},L:{url:()=>''},choices:{label:name=>E('span',{},name)},i18n:{tr:x=>x,setLanguage(){},locale:()=> 'ru-RU'},setTimeout:fn=>queueMicrotask(fn)};
const view=vm.runInNewContext('(function(){'+fs.readFileSync('luci-app-sing-box/htdocs/luci-static/resources/singbox-ui.js','utf8')+'})()',ctx);view.tab='all';
function find(node,p,out=[]){if(node&&typeof node==='object'){if(p(node))out.push(node);for(const c of [].concat(node.children||[]))find(c,p,out);}return out;}
const flush=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
(async()=>{
 await view.render([{}, {nodes:[{id:'a',name:'🇦🇷 Server',latency:{tcp_ms:999,test_ms:999}},{id:'b',name:'🇩🇪 Server'}]}, {}]);
 assert(!options.selected);
 const panel=options._latency.renderWidget(),buttons=find(panel,n=>n.tag==='button'),probe=buttons[0],stop=buttons[1],metrics=find(panel,n=>n.tag==='td'&&/sb-(connect|url)-metric/.test(n.attrs.class));
 assert(stop.disabled);assert(metrics.every(c=>c.children==='—'));
 for(const key of ['probe_method','probe_dns','probe_url_preset','probe_custom_url','probe_timeout'])options[key].onchange(null,'main',key==='probe_method'?'url_test':'1.1.1.1');
 assert.equal(requests.length,0);options.probe_dns.current='1.1.1.1';
 probe.attrs.click();await flush();assert.equal(requests.length,1);
 deferred.shift()({ok:true,state:'running',completed:1,total:2,latency:{a:sample}});await flush();
 assert(probe.disabled);assert.equal(metrics[1].textContent,'2.0 мс');assert.equal(metrics[4].textContent,'—');assert.equal(requests.length,1,'Progress must not create another job');
 deferred.shift()();await flush();assert(!probe.disabled);assert.equal(metrics[4].textContent,'2.0 мс');
 for(let i=0;i<2;i++){
  fail=i===0;const before=requests.length;probe.attrs.click();await flush();probe.attrs.click();assert.equal(requests.length,before+1);
  deferred.shift()();await flush();assert(!probe.disabled);assert(stop.disabled);
 }
 fail=false;probe.attrs.click();await flush();options.probe_url_preset.onchange();deferred.shift()();await flush();assert(metrics.every(c=>c.textContent==='—'));
 probe.attrs.click();await flush();const obsolete=deferred.shift();const beforeStop=cancellations;await stop.attrs.click();assert(!probe.disabled);assert(stop.disabled);assert.equal(cancellations,beforeStop+1);
 const count=requests.length;probe.attrs.click();await flush();assert.equal(requests.length,count+1);assert(probe.disabled);
 obsolete();await flush();assert(probe.disabled);deferred.shift()();await flush();assert(!probe.disabled);assert(stop.disabled);
 // A failed poll is not a cancelled backend task: await server acknowledgement before restart.
 probe.attrs.click();await flush();fail='XHR request timed out';cancelResolve=true;
 for(let i=0;i<3;i++){deferred.shift()();await flush();}
 assert.equal(typeof cancelResolve,'function');assert(probe.disabled);assert(stop.disabled);
 fail=false;cancelResolve({ok:true,state:'cancelled'});cancelResolve=null;await flush();assert(!probe.disabled);
 // A settings change cancels the old worker; a failed cancellation keeps Stop available for retry.
 probe.attrs.click();await flush();const oldReply=deferred.shift();cancelFailure=true;options.probe_dns.onchange();await flush();
 assert(probe.disabled);assert(!stop.disabled);cancelFailure=false;await stop.attrs.click();assert(!probe.disabled);
 oldReply();await flush();assert(!probe.disabled);
 console.log('PASS: one mass job, progressive per-server results, no auto-start, cancellation/restart, stale reply protection and repeat after failure');
})().catch(e=>{console.error(e);process.exit(1)});
