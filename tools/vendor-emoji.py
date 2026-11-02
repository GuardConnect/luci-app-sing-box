from pathlib import Path
import urllib.request,json,zipfile,io
root=Path(__file__).resolve().parents[1]
tag='v17.0.3'; print('Twemoji',tag)
data=urllib.request.urlopen('https://codeload.github.com/jdecked/twemoji/zip/refs/tags/'+tag,timeout=90).read()
assets=root/'htdocs/luci-static/resources/singbox-emoji'; assets.mkdir(exist_ok=True)
mapping={}
with zipfile.ZipFile(io.BytesIO(data)) as z:
 for info in z.infolist():
  if '/assets/svg/' in info.filename and info.filename.endswith('.svg'):
   name=Path(info.filename).name; (assets/name).write_bytes(z.read(info))
   key=''.join(chr(int(cp,16)) for cp in name[:-4].split('-') if cp!='fe0f'); mapping[key]=name
 for name in ('LICENSE','LICENSE-GRAPHICS'):
  member=next((s for s in z.namelist() if s.endswith('/'+name)),None)
  if member:(assets/(name+'.txt')).write_bytes(z.read(member))
(assets/'NOTICE.txt').write_text('Twemoji '+tag+'\nhttps://github.com/jdecked/twemoji\nGraphics: CC-BY 4.0. Code: MIT.\n',encoding='utf8')
code="""'use strict';
'require baseclass';
'require ui';
var emoji=MAP;
var keys=Object.keys(emoji).sort(function(a,b){return Array.from(b).length-Array.from(a).length;});
function escape(s){return s.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&');}
var pattern=new RegExp(keys.map(function(key){return Array.from(key).map(escape).join('\\ufe0f?')+'\\ufe0f?';}).join('|'),'gu');
function label(text){
 text=String(text);var parts=[],last=0;
 text.replace(pattern,function(match,offset){if(offset>last)parts.push(text.slice(last,offset));var key=match.replace(/\\ufe0f/g,'');parts.push(E('img',{src:L.resource('singbox-emoji/'+emoji[key]),alt:match,width:20,height:20,style:'display:inline-block;vertical-align:middle;object-fit:contain;margin-right:5px;'}));last=offset+match.length;return match;});
 if(last<text.length)parts.push(text.slice(last));return E('span',{'class':'sb-emoji-label'},parts);
}
return baseclass.extend({label:label,dropdown:function(value,choices,onchange,ariaLabel){
 var labels={};choices.forEach(function(item){labels[item[0]]=label(item[1]);});
 var control=new ui.Dropdown(value,labels,{sort:choices.map(function(item){return item[0];}),optional:false,multiple:false,display_items:8,dropdown_items:12});
 var element=control.render();element.setAttribute('aria-label',ariaLabel || '');element.style.width='100%';element.addEventListener('cbi-dropdown-change',function(){onchange(control.getValue());});return element;
}});
""".replace('MAP',json.dumps(mapping,ensure_ascii=False,separators=(',',':')))
(root/'htdocs/luci-static/resources/singbox-choices.js').write_text(code,encoding='utf8')
print('Assets',len(mapping),'bytes',sum(p.stat().st_size for p in assets.iterdir()))
