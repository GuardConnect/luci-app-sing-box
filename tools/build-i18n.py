"""Build the package-local Russian/English LuCI translation module."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
catalogue = json.loads((root / 'tools/i18n.json').read_text(encoding='utf-8'))
catalogue.update(json.loads((root / 'tools/i18n-messages.json').read_text(encoding='utf-8')))
catalogue.update(json.loads((root / 'tools/i18n-routing.json').read_text(encoding='utf-8')))
code = r'''"use strict";
'require baseclass';
var catalogue = CATALOGUE;
var language = 'ru', reverse = {}, pairs = [], templates = [];
function escapeRegex(s) { return Array.from(s).map(function(c) { return c.charCodeAt(0) === 92 || '^$.*+?()[]{}|'.indexOf(c) >= 0 ? String.fromCharCode(92) + c : c; }).join(''); }
Object.keys(catalogue).forEach(function(ru) {
    var en = catalogue[ru];
    reverse[en] = ru;
    [ [ru, en], [en, ru] ].forEach(function(pair) {
        if (/%[sd]/.test(pair[0])) {
            var parts = pair[0].split(/(%[sd])/);
            var pattern = parts.map(function(p) { return p === '%d' ? '([0-9]+)' : p === '%s' ? '(.+?)' : escapeRegex(p); }).join('');
            templates.push({ source:pair[0], target:pair[1], re:new RegExp('^' + pattern + '$') });
        }
    });
    pairs.push([ru, en]);
});
pairs.sort(function(a,b) { return Math.max(b[0].length,b[1].length)-Math.max(a[0].length,a[1].length); });
function tr(text, depth) {
    if (text == null) return '';
    var value = String(text);
    if (Object.prototype.hasOwnProperty.call(catalogue,value)) return language === 'en' ? catalogue[value] : value;
    if (Object.prototype.hasOwnProperty.call(reverse,value)) return language === 'ru' ? reverse[value] : value;
    if ((depth || 0) > 4) return value;
    for (var i=0;i<templates.length;i++) {
        var t=templates[i], match=value.match(t.re);
        if (!match) continue;
        var target=language === 'en' ? (catalogue[t.source] || t.source) : (reverse[t.source] || t.source);
        var index=0;
        return target.replace(/%[sd]/g,function() { return tr(match[++index],(depth||0)+1); });
    }
    for (var j=0;j<pairs.length;j++) {
        var source=language === 'en' ? pairs[j][0] : pairs[j][1];
        var target=language === 'en' ? pairs[j][1] : pairs[j][0];
        if (source.length >= 8 && value.indexOf(source) === 0)
            return target + tr(value.slice(source.length),(depth||0)+1);
    }
    return value;
}
return baseclass.extend({
    setLanguage:function(value) { language=value === 'en' ? 'en' : 'ru'; },
    locale:function() { return language === 'en' ? 'en-US' : 'ru-RU'; },
    tr:tr,
    catalogue:catalogue
});
'''.replace('CATALOGUE', json.dumps(catalogue, ensure_ascii=False, indent=2))
(root / 'htdocs/luci-static/resources/singbox-i18n.js').write_text(code, encoding='utf-8')
print('Built', len(catalogue), 'translation entries')
