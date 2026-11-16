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

	const ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
	let actionsKey = '';
	let actionsEl = null;

	/** One flat icon button; the tooltip is the native `title`, which also names it for screen readers. */
	function iconButton(icon, label, onClick, extraClass) {
		const button = h('button', 'act' + (extraClass ? ' ' + extraClass : ''));
		button.type = 'button';
		button.title = label;
		button.setAttribute('aria-label', label);
		button.append(h('span', 'codicon codicon-' + (ICON_NAME.test(icon) ? icon : 'terminal')));
		button.addEventListener('click', onClick);
		return button;
	}

	/**
	 * The row of featured repo actions. The same element is reused while the actions are unchanged, so the
	 * periodic refresh does not rebuild the buttons under the pointer (that would drop a tooltip or focus).
	 */
	function actionsRow(actions) {
		const a = actions || { buttons: [], canEdit: false, hint: '' };
		const key = JSON.stringify(a);
		if (key === actionsKey) {
			return actionsEl;
		}
		actionsKey = key;
		const buttons = Array.isArray(a.buttons) ? a.buttons : [];
		if (!buttons.length && !a.canEdit && !a.hint) {
			actionsEl = null;
			return null;
		}
		// With buttons the row sits beside the name; a hint alone gets its own line under the card.
		const row = h('div', buttons.length || a.canEdit ? 'actions actions-inline' : 'actions');
		row.setAttribute('role', 'toolbar');
		row.setAttribute('aria-label', 'Repo actions');
		for (const b of buttons) {
			row.append(iconButton(b.icon, b.label, () => vscode.postMessage({ type: 'run', id: b.id })));
		}
		if (a.canEdit) {
			row.append(iconButton('edit', 'Choose featured actions...', () => vscode.postMessage({ type: 'editActions' }), 'act-edit'));
		}
		if (a.hint) {
			row.append(h('span', 'actions-hint', a.hint));
		}
		actionsEl = row;
		return row;
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

		const actions = actionsRow(state.actions);
		if (actions) {
			if (actions.classList.contains('actions-inline')) {
				card.append(actions);
			} else {
				children.push(actions);
			}
		}

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
