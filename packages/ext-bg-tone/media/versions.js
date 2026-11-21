// Webview script for the Versions view of Source Control. Strict CSP: no inline styles, DOM APIs only.
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const root = document.getElementById('card');
	const post = message => vscode.postMessage(message);

	function show(state) {
		vscode.setState(state);
		const section = window.bgToneVersions.render(state && state.versions, post, false);
		root.replaceChildren(...(section ? [section] : []));
	}

	window.addEventListener('message', event => {
		const message = event.data;
		if (message && message.type === 'state') {
			show(message.state);
		}
	});

	// The last list this page drew shows at once; the fresh one replaces it when the extension answers.
	const saved = vscode.getState();
	if (saved && typeof saved === 'object') {
		show(saved);
	}
	post({ type: 'ready' });
})();
