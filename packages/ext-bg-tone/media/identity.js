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

	let logoKey = '';
	let logoEl = null;

	/** The logo box, reused while its image is unchanged so a refresh never reloads the picture. */
	function logoBox(state) {
		const letter = (state.name || '?').trim().charAt(0).toUpperCase();
		const key = state.logoSrc ? 'img:' + state.logoSrc : 'letter:' + letter;
		if (key === logoKey && logoEl) {
			return logoEl;
		}
		const logo = h('div', 'logo');
		logo.title = 'Repo logo. To change it, drag an image from the Explorer here and hold Shift while you drop it.';
		if (state.logoSrc) {
			const img = document.createElement('img');
			img.src = state.logoSrc;
			img.alt = '';
			logo.append(img);
		} else {
			logo.textContent = letter;
		}
		logoKey = key;
		logoEl = logo;
		return logo;
	}

	let stateKey = '';

	function render(state) {
		const { at, ...content } = state;
		const key = JSON.stringify(content);
		vscode.setState(state);
		if (key === stateKey) {
			return;
		}
		stateKey = key;
		const logo = logoBox(state);

		const info = h('div', 'info');
		const name = h('div', 'name', state.name);
		info.append(name);
		// The line below the name: the stack version and, beside it, the files with uncommitted changes.
		const hasChanges = typeof state.changes === 'number' && state.changes > 0;
		if (state.version || hasChanges) {
			const meta = h('div', 'meta');
			if (state.version) {
				const version = h('span', 'version', 'v' + state.version);
				version.title = 'Stack version ' + state.version;
				meta.append(version);
			}
			if (hasChanges) {
				const label = state.changes + (state.changes === 1 ? ' uncommitted file' : ' uncommitted files') + ' - click to commit them';
				const changes = h('button', 'changes');
				changes.type = 'button';
				changes.title = label;
				changes.addEventListener('click', () => vscode.postMessage({ type: 'commit' }));
				changes.setAttribute('aria-label', label);
				changes.append(h('span', 'codicon codicon-git-commit'), h('span', 'changes-count', String(state.changes)));
				meta.append(changes);
			}
			info.append(meta);
		}

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
				const dot = h('span', 'agent-dot');
				row.append(dot, h('span', 'agent-title', run.title), time);
				agentTimes.push({ el: time, dot, run });
				list.append(row);
			}
			children.push(list);
		}
		const commits = Array.isArray(state.commits) ? state.commits : [];
		if (commits.length) {
			const list = h('div', 'agents');
			for (const commit of commits) {
				const row = h('div', 'agent');
				const state = commit.pushed === true ? 'Pushed' : commit.pushed === false ? 'Not pushed' : '';
				row.title = String(commit.hash).slice(0, 7) + ' ' + commit.title + (state ? ' (' + state.toLowerCase() + ')' : '');
				const time = h('span', 'agent-time');
				const icon = h('span', 'codicon codicon-git-commit commit-icon' + (commit.pushed === true ? ' commit-pushed' : commit.pushed === false ? ' commit-local' : ''));
				row.append(icon, h('span', 'agent-title', commit.title), time);
				agentTimes.push({ el: time, run: { status: 'success', updatedAt: commit.updatedAt }, commit: true });
				list.append(row);
			}
			children.push(list);
		}
		// The Source Control card can carry the versions list (the `bgTone.versions` = `card` setting).
		const versions = window.bgToneVersions ? window.bgToneVersions.render(state.versions, message => vscode.postMessage(message), true) : null;
		if (versions) {
			children.push(versions);
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

	/** A finished chat keeps its status circle for this long; older chats get none (the slot stays empty). */
	const FRESH_MS = 30 * 60 * 1000;

	/** The circle: pulsing while the chat is running, solid green / red for a chat that just finished. */
	function dotClass(run) {
		if (run.status === 'running') {
			return 'agent-dot agent-dot-running';
		}
		if (Date.now() - run.updatedAt > FRESH_MS) {
			return 'agent-dot';
		}
		if (run.status === 'success') {
			return 'agent-dot agent-dot-done';
		}
		return run.status === 'error' ? 'agent-dot agent-dot-error' : 'agent-dot';
	}

	function dotLabel(run) {
		const cls = dotClass(run);
		return cls.includes('running') ? 'Running'
			: cls.includes('done') ? 'Finished'
			: cls.includes('error') ? 'Finished with an error'
			: '';
	}

	function updateAgentTime() {
		for (const { el, dot, run } of agentTimes) {
			el.textContent = run.status === 'running' ? 'running' : ago(run.updatedAt);
			if (!dot) {
				continue; // a commit row has no status circle
			}
			dot.className = dotClass(run);
			const label = dotLabel(run);
			if (label) {
				dot.title = label;
			} else {
				dot.removeAttribute('title');
			}
		}
	}

	setInterval(updateAgentTime, 30000);

	// Dropping an image on the card makes it the repo logo. The workbench only lets a drag from the Explorer into a
	// webview while Shift is held. Only the dropped paths go to the extension, which checks them.
	const DROP_TYPES = ['application/vnd.code.uri-list', 'text/uri-list', 'resourceurls', 'text/plain'];
	let dropTimer = 0;

	function canDrop(dataTransfer) {
		const types = Array.from((dataTransfer && dataTransfer.types) || [], t => String(t).toLowerCase());
		return types.includes('files') || DROP_TYPES.some(t => types.includes(t));
	}

	function droppedItems(dataTransfer) {
		const items = [];
		for (const type of DROP_TYPES) {
			let text = '';
			try {
				text = dataTransfer.getData(type) || '';
			} catch {
				text = '';
			}
			if (!text) {
				continue;
			}
			if (type === 'resourceurls') {
				try {
					const list = JSON.parse(text);
					if (Array.isArray(list)) {
						items.push(...list.filter(item => typeof item === 'string'));
					}
				} catch {
					// not a list: ignore it
				}
				continue;
			}
			items.push(...text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
		}
		return items.slice(0, 50);
	}

	/** The drop highlight goes away shortly after the last dragover (dragleave is unreliable across nested elements). */
	function showDropTarget() {
		document.body.classList.add('logo-drop');
		clearTimeout(dropTimer);
		dropTimer = setTimeout(() => document.body.classList.remove('logo-drop'), 150);
	}

	window.addEventListener('dragover', event => {
		if (!canDrop(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
		showDropTarget();
	});
	window.addEventListener('drop', event => {
		if (!canDrop(event.dataTransfer)) {
			return;
		}
		event.preventDefault();
		clearTimeout(dropTimer);
		document.body.classList.remove('logo-drop');
		vscode.postMessage({ type: 'dropLogo', items: droppedItems(event.dataTransfer) });
	});

	window.addEventListener('message', event => {
		const message = event.data;
		if (message && message.type === 'state') {
			render(message.state);
		}
	});

	/** The last known card: the one in the HTML, or the one this page saved if that is newer. */
	function initialState() {
		let fromHtml = null;
		try {
			fromHtml = root.dataset.state ? JSON.parse(root.dataset.state) : null;
		} catch {
			fromHtml = null;
		}
		const saved = vscode.getState();
		if (saved && typeof saved === 'object' && (!fromHtml || (saved.at || 0) > (fromHtml.at || 0))) {
			return saved;
		}
		return fromHtml;
	}

	const initial = initialState();
	if (initial) {
		render(initial);
	}
	vscode.postMessage({ type: 'ready' });
})();
