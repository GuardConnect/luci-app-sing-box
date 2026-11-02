'use strict';
'require view';
'require singbox-ui as singbox';
return view.extend({
	load: function() { return singbox.load(); },
	render: function(data) { return singbox.render.call({tab: 'servers', subscription: new URLSearchParams(window.location.search).get('subscription') || ''}, data); },
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
