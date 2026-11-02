'use strict';
'require view';
'require singbox-ui as singbox';
return view.extend({
	load: function() { return singbox.load(); },
	render: function(data) { return singbox.render.call({tab: 'versions'}, data); },
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
