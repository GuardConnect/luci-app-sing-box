'use strict';
'require view';
'require singbox-ui as singbox';
'require singbox-routing as routing';
return view.extend({
    load:function() { return Promise.all([singbox.load.call({tab:'routing'}),routing.load()]); },
    render:function(data) { return singbox.render.call({tab:'routing',extraContent:routing.render(data[1])},data[0]); },
    handleSaveApply:null,
    handleSave:null,
    handleReset:null
});
