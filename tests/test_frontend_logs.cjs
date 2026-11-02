const fs=require('fs'),vm=require('vm'),assert=require('assert');
const timers=[],pending=[];let requests=0;
function E(tag,attrs,children){return {tag,attrs:attrs||{},children:children||[],style:{},value:'',scrollTop:20,scrollHeight:500,replaceChildren(...v){this.children=v;},removeAttribute(){}};}
const map={section(){const s={children:[],option(type,name){const o={option:name,value(){},depends(){}};s.children.push(o);return o;}};return s;},render:async()=>({})};
const context={E,baseclass:{extend:x=>x},form:{Map:function(){return map;}},uci:{get:()=>''},ui:{addNotification(){}},L:{url:()=>''},document:{hidden:false},poll:{add(fn,seconds){timers.push({fn,seconds});}},rpc:{declare:s=>()=>{if(s.method==='logs'){requests++;return new Promise((resolve,reject)=>pending.push({resolve,reject}));}return Promise.resolve({ok:true});}}};
context.i18n={tr:x=>x,setLanguage(){},locale:()=> 'ru-RU'};
const view=vm.runInNewContext('(function(){'+fs.readFileSync('luci-app-sing-box/htdocs/luci-static/resources/singbox-ui.js','utf8')+'})()',context);
function find(n,p){if(!n||typeof n!=='object')return;if(p(n))return n;for(const c of [].concat(n.children||[])){const r=find(c,p);if(r)return r;}}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 view.tab='logs';
 const page=await view.render([{}, {nodes:[]}, {}, {}, {text:'initial'}]);
 const text=find(page,n=>n.attrs?.['aria-label']==='Журнал Sing-box');
 const live=find(page,n=>n.attrs?.['aria-label']==='Журнал в реальном времени');
 const follow=find(page,n=>n.attrs?.['aria-label']==='Автопрокрутка журнала');
 const timer=timers.find(t=>t.seconds===1);assert(timer);
 timer.fn();assert.equal(requests,1,'overlapping reads must be coalesced');
 live.attrs.change.call({checked:false});pending.shift().resolve({ok:true,text:'late'});await flush();
 assert.equal(text.value,'initial','pausing must discard in-flight update');
 await timer.fn();assert.equal(requests,1);
 live.attrs.change.call({checked:true});pending.shift().resolve({ok:true,text:'new'});await flush();
 assert.equal(text.value,'new');assert.equal(text.scrollTop,500);
 follow.attrs.change.call({checked:false});text.scrollTop=42;
 const next=timer.fn();pending.shift().resolve({ok:true,text:'newer'});await next;
 assert.equal(text.scrollTop,42);
 const failed=timer.fn();pending.shift().reject(Error('network'));await failed;
 assert.equal(text.value,'newer','failed reads must preserve displayed log');
 const count=requests;context.document.hidden=true;await timer.fn();assert.equal(requests,count);
 console.log('PASS: live log polling, pause/resume, no overlaps, stale reply guard, scrolling and error preservation');
})().catch(e=>{console.error(e);process.exit(1)});
