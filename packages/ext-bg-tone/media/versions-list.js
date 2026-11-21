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

	/** The star: filled for a featured package, click to feature or unfeature it (the stack has none). */
	function star(row, canEdit, post) {
		const label = row.featured ? 'Unfeature ' + row.label + ' (stop listing it first)' : 'Feature ' + row.label + ' (list it first, in bold)';
		const button = h('button', 'ver-star' + (row.featured ? ' ver-star-on' : ''));
		button.type = 'button';
		button.title = canEdit ? label : label + ' (trust this workspace to edit versions)';
		button.setAttribute('aria-label', label);
		button.setAttribute('aria-pressed', row.featured ? 'true' : 'false');
		button.disabled = !canEdit;
		button.append(h('span', 'codicon codicon-star-' + (row.featured ? 'full' : 'empty')));
		button.addEventListener('click', () => post({ type: 'feature', target: row.target, on: !row.featured }));
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
			const el = h('div', 'ver-row' + (row.target === 'stack' ? ' ver-stack' : '') + (row.featured ? ' ver-featured' : ''));
			el.setAttribute('role', 'listitem');
			// Right-aligned and cut from the left (see .ver-name): the end of a path is the name that matters.
			const name = h('span', 'ver-name');
			name.append(h('bdi', undefined, row.label));
			name.title = row.target + (row.featured ? ' (featured)' : '') + (row.since ? ' (since ' + row.since + ')' : '');
			const control = h('span', 'ver-control');
			control.append(plus(row, 'major', v.canBump, post), h('span', 'ver-version', row.version), plus(row, 'minor', v.canBump, post));
			// The stack cannot be featured: an empty slot keeps the rows lined up.
			el.append(row.target === 'stack' ? h('span', 'ver-star-slot') : star(row, v.canBump, post), name, control);
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
