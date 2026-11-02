'use strict';
'require view';
'require singbox-ui as singbox';
return view.extend({
	load: function() { return singbox.load.call({tab: 'subscription'}); },
	render: function(data) { return singbox.render.call({tab: 'subscription'}, data); },
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
