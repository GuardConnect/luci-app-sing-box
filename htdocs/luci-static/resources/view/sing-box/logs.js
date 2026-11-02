'use strict';
'require view';
'require singbox-ui as singbox';
return view.extend({
	load: function() { return singbox.load.call({tab: 'logs'}); },
	render: function(data) { return singbox.render.call({tab: 'logs'}, data); },
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
