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

	/** The tag: opens the category picker for a package. Filled and colored when it has a category (the stack has none). */
	function tag(row, canEdit, post) {
		const label = row.category ? 'Category of ' + row.label + ': ' + row.category + ' (click to change)' : 'Set a category for ' + row.label;
		const button = h('button', 'ver-tag' + (row.category ? ' ver-tag-on' : ''));
		button.type = 'button';
		button.title = canEdit ? label : label + ' (trust this workspace to edit versions)';
		button.setAttribute('aria-label', label);
		button.disabled = !canEdit;
		button.append(h('span', 'codicon codicon-tag'));
		// Only the package path leaves the page; the extension opens the picker and checks everything it writes.
		button.addEventListener('click', () => post({ type: 'categorize', target: row.target }));
		return button;
	}

	/** The card's title row: "Versions" and a button for the category manager (the Versions view has it in its toolbar). */
	function cardTitle(canEdit, post) {
		const title = h('div', 'versions-title');
		title.append(h('span', undefined, 'Versions'));
		const button = h('button', 'ver-manage');
		button.type = 'button';
		button.title = canEdit ? 'Manage version categories' : 'Manage version categories (trust this workspace to edit versions)';
		button.setAttribute('aria-label', 'Manage version categories');
		button.disabled = !canEdit;
		button.append(h('span', 'codicon codicon-tag'));
		button.addEventListener('click', () => post({ type: 'manageCategories' }));
		title.append(button);
		return title;
	}

	/** A category color, only when it is a plain hex color: the one value that ever reaches a style property. */
	function tintOf(color) {
		return typeof color === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color) ? color : '';
	}

	/** The line that starts a group of rows: a dot in the category color and its name. */
	function groupHeader(text, color) {
		const el = h('div', 'ver-group', text);
		el.setAttribute('role', 'presentation');
		const tint = tintOf(color);
		if (tint) {
			el.classList.add('ver-tinted');
			el.style.setProperty('--ver-cat', tint);
		}
		return el;
	}

	let key = '';
	let element = null;

	/**
	 * The versions section, or null when there is nothing to show. The same element is reused while the
	 * state is unchanged, so the periodic refresh does not rebuild buttons under the pointer.
	 */
	function render(versions, post, inCard) {
		const v = versions && Array.isArray(versions.rows) ? versions : { rows: [], pending: null, canBump: false, stackDone: false, hint: '', categories: [] };
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
			section.append(cardTitle(v.canBump, post));
		}
		// Shown at the top while a bump waits for a commit (versions.json differs from HEAD). No payload leaves
		// the page: the extension works out the files and the message itself and commits without asking.
		if (v.pending && typeof v.pending.message === 'string') {
			const commit = h('button', 'ver-commit');
			commit.type = 'button';
			commit.title = v.canBump ? v.pending.message : v.pending.message + ' (trust this workspace to commit versions)';
			commit.setAttribute('aria-label', 'Commit versions: ' + v.pending.message);
			commit.disabled = !v.canBump;
			commit.append(h('span', 'codicon codicon-git-commit'), h('span', undefined, 'Commit versions'));
			commit.addEventListener('click', () => post({ type: 'commitVersions' }));
			section.append(commit);
		}
		const list = h('div', 'versions-list');
		list.setAttribute('role', 'list');
		// With categories, a header starts each group of rows: the featured block (whatever the category), each
		// category, then the packages with none. Rows come in that order already (see versionsState).
		const grouped = Array.isArray(v.categories) && v.categories.length > 0;
		let group;
		for (const row of v.rows) {
			if (grouped && row.target !== 'stack') {
				const key = row.featured ? '\0featured' : row.category || '\0other';
				if (key !== group) {
					group = key;
					list.append(groupHeader(row.featured ? 'Featured' : row.category || 'Other', row.featured ? undefined : row.color));
				}
			}
			const tint = tintOf(row.color);
			const el = h('div', 'ver-row' + (row.target === 'stack' ? ' ver-stack' : '') + (row.featured ? ' ver-featured' : '') + (tint ? ' ver-tinted' : ''));
			el.setAttribute('role', 'listitem');
			if (tint) {
				el.style.setProperty('--ver-cat', tint);
			}
			// Left-aligned and cut from the left (see .ver-name): the end of a path is the name that matters.
			const name = h('span', 'ver-name');
			name.append(h('bdi', undefined, row.label));
			name.title = row.target + (row.featured ? ' (featured)' : '') + (row.category ? ' (' + row.category + ')' : '') + (row.since ? ' (since ' + row.since + ')' : '');
			const control = h('span', 'ver-control');
			control.append(plus(row, 'major', v.canBump, post), h('span', 'ver-version', row.version), plus(row, 'minor', v.canBump, post));
			// The stack cannot be featured: an empty slot keeps the rows lined up.
			el.append(row.target === 'stack' ? h('span', 'ver-star-slot') : star(row, v.canBump, post), name);
			// The stack has no category: an empty slot keeps the version columns lined up.
			el.append(row.target === 'stack' ? h('span', 'ver-tag-slot') : tag(row, v.canBump, post), control);
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
