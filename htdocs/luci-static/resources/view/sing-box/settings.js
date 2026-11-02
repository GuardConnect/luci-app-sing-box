'use strict';
'require view';
'require singbox-ui as singbox';
return view.extend({
	load: function() { return singbox.load.call({tab: 'settings'}); },
	render: function(data) { return singbox.render.call({tab: 'settings'}, data); },
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
