const fs = require('fs'), vm = require('vm'), assert = require('assert');
const calls = [];
const map = { section: () => ({ option: () => ({ value() {}, depends() {} }) }),
    save: async () => calls.push('save'), render: async () => ({tag:'form'}) };
const rpc = { declare(spec) { return async () => {
    calls.push(spec.object + '/' + spec.method);
    if (spec.method === 'commit') return 0;
    if (spec.method === 'status') return {version:'test', interface:'sb0'};
    return {ok:true};
} } };
const context = { view:{extend:x=>x}, form:{Map:function(){return map;}}, rpc,
    uci:{get:()=>''}, ui:{changes:{init:async()=>calls.push('refresh-changes')},addNotification(){}}, L:{url:()=>''}, window:{location:{reload(){}}},
    E:(tag,attrs,children)=>({tag,attrs:attrs||{},children:children||[],replaceChildren(...v){this.children=v;}}) };
const code = fs.readFileSync('luci-app-sing-box/htdocs/luci-static/resources/singbox-ui.js','utf8');
context.choices={label:function(name){return context.E('span',{},name);}};
context.baseclass=context.view;
context.i18n={tr:x=>x,setLanguage(){},locale:()=> 'ru-RU'};
const view = vm.runInNewContext('(function(){'+code+'})()', context);
view.tab='all';
function buttons(node, out=[]) {
    if (!node || typeof node !== 'object') return out;
    if (node.tag==='button') out.push(node);
    for (const child of [].concat(node.children||[])) buttons(child,out);
    return out;
}
(async()=>{
    const page = await view.render([{}, {nodes:[]}, {}]);
    const all = buttons(page);
    const actions=all.filter(b=>['Остановить','Перезапустить','Сохранить и применить'].includes(b.children));
    assert.deepStrictEqual(actions.map(b=>b.children),['Остановить','Перезапустить','Сохранить и применить']);
    calls.length=0;
    await actions[1].attrs.click.call(actions[1]);
    assert(calls.includes('luci.singbox/restart'));
    assert(!calls.includes('save') && !calls.includes('uci/commit'));
    for (const label of ['Импортировать / обновить подписку', 'Сохранить и применить']) {
        calls.length=0;
        const b=all.find(b=>b.children===label); assert(b,label);
        await b.attrs.click.call(b);
        assert.deepStrictEqual(calls.slice(0,2), ['save','uci/commit']);
        assert(calls.includes(label.startsWith('Импорт')?'luci.singbox/import':'luci.singbox/apply'));
        assert(calls.includes('refresh-changes'));
        if (!label.startsWith('Импорт')) {
            assert(calls.lastIndexOf('refresh-changes') > calls.indexOf('luci.singbox/apply'));
        }
    }
    map.save=()=>{throw Error('synchronous validation error');};
    const apply=all.find(b=>b.children==='Сохранить и применить');await apply.attrs.click.call(apply);assert.equal(apply.disabled,false,'Sync errors must restore the action button');
    console.log('PASS: import and apply save through RPC when uci.commit is absent');
})().catch(e=>{console.error(e);process.exit(1)});
