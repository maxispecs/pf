// Webview script for the Repo Identity card. Strict CSP: no inline styles, DOM APIs only.
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const root = document.getElementById('card');

	function h(tag, className, text) {
		const el = document.createElement(tag);
		if (className) {
			el.className = className;
		}
		if (text !== undefined) {
			el.textContent = text;
		}
		return el;
	}

	function render(state) {
		const logo = h('div', 'logo');
		if (state.logoSrc) {
			const img = document.createElement('img');
			img.src = state.logoSrc;
			img.alt = '';
			logo.append(img);
		} else {
			logo.textContent = (state.name || '?').trim().charAt(0).toUpperCase();
		}

		const info = h('div', 'info');
		info.append(h('div', 'name', state.name));

		const card = h('div', 'card');
		card.append(logo, info);
		const children = [card];

		agentTimes = [];
		const agents = Array.isArray(state.agents) ? state.agents : [];
		if (agents.length) {
			const list = h('div', 'agents');
			for (const run of agents) {
				const row = h('div', 'agent');
				row.title = run.title;
				const time = h('span', 'agent-time');
				row.append(h('span', 'agent-title', run.title), time);
				agentTimes.push({ el: time, run });
				list.append(row);
			}
			children.push(list);
		}
		updateAgentTime();
		root.replaceChildren(...children);
	}

	let agentTimes = [];

	function ago(ms) {
		const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
		if (s < 45) { return 'just now'; }
		const m = Math.round(s / 60);
		if (m < 60) { return m + 'm ago'; }
		const hrs = Math.round(m / 60);
		if (hrs < 24) { return hrs + 'h ago'; }
		return Math.round(hrs / 24) + 'd ago';
	}

	function updateAgentTime() {
		for (const { el, run } of agentTimes) {
			el.textContent = run.status === 'running' ? 'running' : ago(run.updatedAt);
		}
	}

	setInterval(updateAgentTime, 30000);

	window.addEventListener('message', event => {
		const message = event.data;
		if (message && message.type === 'state') {
			render(message.state);
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
