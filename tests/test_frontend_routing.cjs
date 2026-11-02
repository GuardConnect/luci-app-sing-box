const fs=require('fs'),vm=require('vm'),assert=require('assert');
const i18n=vm.runInNewContext('(function(){'+fs.readFileSync('luci-app-sing-box/htdocs/luci-static/resources/singbox-i18n.js','utf8')+'})()',{baseclass:{extend:x=>x}});
let modal,notifications=[],calls=[],pollError=false;
function children(node){return [].concat(node?.children||[]);}
function visit(node,out=[]){if(node&&typeof node==='object'){out.push(node);for(const c of children(node))visit(c,out);}return out;}
function E(tag,attrs,content){
 const node={tag,attrs:attrs||{},children:content||[],style:{display:attrs?.style?.includes('display:none')?'none':''},value:attrs?.value??'',checked:!!attrs?.checked,disabled:attrs?.disabled!=null,events:{},appendChild(c){this.children=children(this);this.children.push(c);return c;},replaceChildren(...v){this.children=v;},addEventListener(name,fn){this.events[name]=fn;},querySelectorAll(selectors){return visit(this).filter(n=>selectors.split(',').includes(n.tag));},click(){return this.attrs.click?.call(this);}};
 if(tag==='select'){const option=children(node).find(n=>n.attrs?.selected)||children(node)[0];node.value=option?.attrs.value??'';}
 return node;
}
const context={E,i18n,baseclass:{extend:x=>x},uci:{get:()=> 'en'},ui:{showModal(title,body){modal=E('div',{},body);},hideModal(){},addNotification(a,b){notifications.push(b);}},rpc:{declare:s=>async(...args)=>{calls.push([s.method,args]);if(s.method==='routing_start')return {ok:true,job:'test'};if(pollError)return {ok:false,error:'Routing job expired; run the operation again'};return {ok:true,state:'done',message:'Routing profile saved',preview:{rules:[]}};}},window:{addEventListener(){}}};
context.choices={label:text=>E('span',{},text),dropdown:(value,items,onchange,label)=>E('select',{'aria-label':label,change:function(){onchange(this.value);}},items.map(item=>E('option',{value:item[0],selected:item[0]===value?true:null},item[1])))};
const view=vm.runInNewContext('(function(){'+fs.readFileSync('luci-app-sing-box/htdocs/luci-static/resources/singbox-routing.js','utf8')+'})()',context);
const find=(root,p)=>visit(root).find(p),button=(root,label)=>find(root,n=>n.tag==='button'&&n.children===label),input=(root,label)=>find(root,n=>n.attrs?.['aria-label']===label);
function content(n){if(typeof n==='string')return n;return children(n).map(content).join(' ');}
(async()=>{
 const profile={version:1,enabled:true,sniff:true,final:'direct',capture_mode:'pbr',mirror:'github',rule_set_interval:24,rules:[],rule_sets:[]};
 const root=view.render({profile,nodes:[],manual:false});
 assert(!input(root,'Profile name'));assert(!content(root).includes('Selected server'));
 button(root,'Add rule').click();
 const matchLabel=find(modal,n=>n.tag==='label'&&content(n).trim()==='Match all traffic');
 const matchInput=children(matchLabel)[0],conditionPanel=find(modal,n=>n.attrs?.class==='sb-routing-condition-panel');
 assert(content(modal).includes('Place this rule last.'));
 matchInput.attrs.change.call({checked:true});assert.equal(conditionPanel.style.display,'none');assert(input(modal,'Condition logic').disabled);
 matchInput.attrs.change.call({checked:false});assert.equal(conditionPanel.style.display,'');assert(!input(modal,'Condition logic').disabled);
 input(modal,'Rule name').value='Regex and geosite';input(modal,'Domain regular expressions').value='^test\\.example$';input(modal,'Geosite categories').value='google';
 button(modal,'Save rule').click();assert(content(root).includes('Regex and geosite'));
 button(root,'Edit').click();assert.equal(input(modal,'Domain regular expressions').value,'^test\\.example$');assert.equal(input(modal,'Geosite categories').value,'google');
 button(modal,'Cancel').click();button(root,'Duplicate').click();assert(content(root).includes('copy'));
 button(root,'↓').click();
 button(root,'Add rule-set').click();input(modal,'Rule-set tag').value='custom';input(modal,'Rule-set URL').value='https://example.org/rules.srs';button(modal,'Save rule-set').click();assert(content(root).includes('https://example.org/rules.srs'));
 input(root,'Default outbound').attrs.change.call({value:'block'});
 await button(root,'Validate / preview').click();
 const requested=JSON.parse(calls.find(c=>c[0]==='routing_start')[1][0]);assert.equal(requested.final,'block');assert.equal(requested.rules.length,2);assert(requested.rules[0].name.includes('copy'));assert.deepStrictEqual(requested.rules[0].conditions.geosite,['google']);
 assert.equal(input(root,'Generated routing JSON').style.display,'');
 button(root,'Import').click();input(modal,'Routing profile JSON').value='{}';button(modal,'Import').click();assert.equal(notifications.length,1);assert(content(root).includes('Regex and geosite'));
 const malformed=[
  {version:1,rules:[{mode:0}],rule_sets:[]},
  {version:1,rules:[{conditions:{domain:5}}],rule_sets:[]},
  {version:1,rules:[{conditions:null}],rule_sets:[]},
  {version:1,enabled:'true',rules:[],rule_sets:[]},
  {version:1,rules:[],rule_sets:[{tag:'bad',url:'https://example.org',format:0}]}
 ];
 for(const value of malformed){
  const notices=notifications.length;button(root,'Import').click();input(modal,'Routing profile JSON').value=JSON.stringify(value);button(modal,'Import').click();
  assert.equal(notifications.length,notices+1);assert(content(root).includes('Regex and geosite'),'Invalid imports must preserve the existing table');
 }
 await button(root,'Validate / preview').click();
 const preserved=JSON.parse(calls.filter(c=>c[0]==='routing_start').at(-1)[1][0]);assert.equal(preserved.final,'block');assert.equal(preserved.rules.length,2);
 const imported=view.render({profile,nodes:[],manual:false});
 button(imported,'Import').click();input(modal,'Routing profile JSON').value=JSON.stringify({version:1,rules:[{name:'Imported string list',conditions:{domain:'one.example\ntwo.example'}}],rule_sets:[]});button(modal,'Import').click();
 button(imported,'Edit').click();assert.equal(input(modal,'Exact domains').value,'one.example\ntwo.example');button(modal,'Cancel').click();
 pollError=true;await button(root,'Validate / preview').click();pollError=false;
 assert.equal(find(root,n=>n.attrs?.role==='status').textContent,'Routing job expired; run the operation again');
 const absent='node:'+('a'.repeat(24)),available='b'.repeat(24),name='Есть несохранённые изменения маршрутизации · provider';
 const unavailable=view.render({profile:{...profile,final:absent},nodes:[{id:available,name,server:'2001:db8::1',port:443}],manual:false});
 const dropdown=input(unavailable,'Default outbound');assert.equal(dropdown.value,absent,'Missing nodes must not visually become direct');
 assert(content(dropdown).includes('Unavailable server'));assert(content(dropdown).includes(name+' · [2001:db8::1]:443'));
 const manual=view.render({profile,nodes:[],manual:true});assert(button(manual,'Save and apply').disabled);
 console.log('PASS: routing CRUD, regex/geosite persistence, duplicate/reorder, rule-set editor, async preview, invalid import preservation and manual-mode guard');
})().catch(e=>{console.error(e);process.exit(1)});
