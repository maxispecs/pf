// Shared by the Repo Identity card and the Versions view: draws the version rows with their [+] buttons.
// Strict CSP: no inline styles, DOM APIs only. Exposes window.bgToneVersions.render(versions, post, inCard).
(function () {
	'use strict';

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

	/** One [+] button: major sits before the version, minor after it (as in `pf v`). */
	function plus(row, part, canBump, post) {
		const tip = row.tips[part] || part;
		const label = 'Bump ' + row.label + ' ' + part + ': ' + tip;
		const button = h('button', 'ver-plus ver-' + part);
		button.type = 'button';
		button.title = canBump ? label : label + ' (trust this workspace to bump versions)';
		button.setAttribute('aria-label', label);
		button.disabled = !canBump;
		button.append(h('span', 'codicon codicon-add'));
		// Only the target and the part leave the page; the extension checks both against versions.json.
		button.addEventListener('click', () => post({ type: 'bump', target: row.target, part }));
		return button;
	}

	let key = '';
	let element = null;

	/**
	 * The versions section, or null when there is nothing to show. The same element is reused while the
	 * state is unchanged, so the periodic refresh does not rebuild buttons under the pointer.
	 */
	function render(versions, post, inCard) {
		const v = versions && Array.isArray(versions.rows) ? versions : { rows: [], canBump: false, stackDone: false, hint: '' };
		const next = JSON.stringify([v, !!inCard]);
		if (next === key) {
			return element;
		}
		key = next;
		if (!v.rows.length) {
			element = null;
			return null;
		}
		const section = h('div', 'versions' + (inCard ? ' versions-card' : ''));
		if (inCard) {
			section.append(h('div', 'versions-title', 'Versions'));
		}
		const list = h('div', 'versions-list');
		list.setAttribute('role', 'list');
		for (const row of v.rows) {
			const el = h('div', 'ver-row' + (row.target === 'stack' ? ' ver-stack' : ''));
			el.setAttribute('role', 'listitem');
			const name = h('span', 'ver-name', row.label);
			name.title = row.target + (row.since ? ' (since ' + row.since + ')' : '');
			const control = h('span', 'ver-control');
			control.append(plus(row, 'major', v.canBump, post), h('span', 'ver-version', row.version), plus(row, 'minor', v.canBump, post));
			el.append(name, control);
			list.append(el);
		}
		section.append(list);
		if (v.hint) {
			section.append(h('div', 'versions-hint', v.hint));
		}
		element = section;
		return section;
	}

	window.bgToneVersions = { render };
})();
