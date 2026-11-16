// Webview script for the Repo Settings page. Plain DOM only: the page runs under a strict CSP
// (no inline styles/scripts), so styles are applied through the CSSOM and text via textContent.
(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const app = document.getElementById('app');

	/** @type {any} */
	let state = null;
	/** Elements that are updated in place after the first render. */
	const ui = {};

	const EMOJI_CHOICES = ['🟦', '🟩', '🟥', '🟧', '🟪', '🟨', '⬛', '🚀', '🧪', '🛠️', '📦', '🔥'];

	// ---------- helpers ----------

	function h(tag, props, ...children) {
		const el = document.createElement(tag);
		for (const [key, value] of Object.entries(props || {})) {
			if (value === undefined || value === null || value === false) {
				continue;
			}
			if (key === 'class') {
				el.className = value;
			} else if (key === 'style') {
				for (const [prop, v] of Object.entries(value)) {
					el.style.setProperty(prop, v);
				}
			} else if (key.startsWith('on')) {
				el.addEventListener(key.slice(2).toLowerCase(), value);
			} else if (key === 'text') {
				el.textContent = value;
			} else {
				el.setAttribute(key, value === true ? '' : String(value));
			}
		}
		for (const child of children.flat()) {
			if (child === undefined || child === null || child === false) {
				continue;
			}
			el.append(child.nodeType ? child : document.createTextNode(String(child)));
		}
		return el;
	}

	function post(message) {
		vscode.postMessage(message);
	}

	function setSetting(key, value) {
		post({ type: 'set', key, value });
	}

	function isHex(value) {
		return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test((value || '').trim());
	}

	function expandHex(value) {
		const v = value.trim().toLowerCase();
		return v.length === 4 ? '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3] : v;
	}

	/** Picks a readable text color for a background hex. */
	function textOn(hex) {
		if (!isHex(hex)) {
			return 'inherit';
		}
		const v = expandHex(hex);
		const r = parseInt(v.slice(1, 3), 16);
		const g = parseInt(v.slice(3, 5), 16);
		const b = parseInt(v.slice(5, 7), 16);
		return (r * 299 + g * 587 + b * 114) / 1000 > 140 ? '#1e1e1e' : '#f3f3f3';
	}

	function skipIfFocused(el) {
		return document.activeElement === el;
	}

	// ---------- structure (built once) ----------

	function build() {
		ui.logoBox = h('div', { class: 'logo-box' });
		ui.repoTitle = h('h1');
		ui.enabled = h('input', { type: 'checkbox', onchange: e => setSetting('enabled', e.target.checked) });

		ui.banner = h('div', { class: 'banner hidden' });
		ui.noWorkspace = h('div', { class: 'banner hidden', text: 'Open a folder or workspace to change repo settings.' });

		// Color
		ui.selectedLabel = h('span', { class: 'muted' });
		ui.palette = h('div');
		ui.colorPicker = h('input', {
			type: 'color',
			title: 'Pick any color',
			onchange: e => setSetting('color', e.target.value),
		});
		ui.colorText = h('input', {
			type: 'text',
			class: 'grow',
			placeholder: '#3b82f6',
			spellcheck: 'false',
			'aria-label': 'Hex color',
			onchange: e => commitHex(e.target.value),
			onkeydown: e => {
				if (e.key === 'Enter') {
					commitHex(e.target.value);
				}
			},
		});
		ui.colorError = h('p', { class: 'error-text hidden' });
		ui.paletteLabel = h('input', { type: 'text', placeholder: 'Name (optional)', 'aria-label': 'Palette color name', style: { width: '140px' } });

		// Strength
		ui.strength = h('input', {
			type: 'range',
			min: '0',
			max: '0.3',
			step: '0.005',
			'aria-label': 'Tone strength',
			oninput: e => {
				ui.strengthValue.textContent = Number(e.target.value).toFixed(3);
				post({ type: 'preview', input: { strength: Number(e.target.value) } });
			},
			onchange: e => setSetting('strength', Number(e.target.value)),
		});
		ui.strengthValue = h('span', { class: 'muted' });

		ui.surfaces = h('div');
		ui.accent = h('input', { type: 'checkbox', onchange: e => setSetting('accentBorder', e.target.checked) });

		// Logo
		ui.logoPreview = h('div', { class: 'logo-box big' });
		ui.logoPath = h('code');
		ui.logoMessage = h('p', { class: 'error-text hidden' });
		ui.clearLogo = h('button', { class: 'danger', text: 'Clear', onclick: () => post({ type: 'clearLogo' }) });
		ui.locations = h('div');
		ui.emoji = h('input', {
			type: 'text',
			placeholder: '🟦',
			maxlength: '16',
			style: { width: '90px' },
			'aria-label': 'Window title prefix',
			onchange: e => setSetting('titleEmoji', e.target.value),
		});
		ui.emojiChips = h('div', { class: 'chips' }, EMOJI_CHOICES.map(e =>
			h('button', { type: 'button', text: e, title: 'Use ' + e, onclick: () => setSetting('titleEmoji', e) })));

		ui.mock = h('div', { class: 'mock', 'aria-hidden': 'true' });
		ui.previewNote = h('p', { class: 'muted small hidden' });

		app.replaceChildren(
			h('header', { class: 'page' },
				ui.logoBox,
				h('div', { class: 'titles' },
					ui.repoTitle,
					h('div', { class: 'muted small' }, 'Saved in this repo\u2019s ', h('code', { text: 'pulpfixer.json' }), ' (bgTone), so it is committed.')),
				h('label', { class: 'check' }, ui.enabled, h('span', { text: 'Tone on' }))),
			ui.noWorkspace,
			ui.banner,

			h('section', { class: 'card' },
				h('h2', { text: 'Color' }),
				h('p', { class: 'hint muted small' }, 'The tone mixed into the window chrome. ', ui.selectedLabel),
				h('div', { class: 'row' }, ui.colorPicker, ui.colorText,
					h('button', { text: 'Randomize', title: 'Stable color from the repo name', onclick: () => post({ type: 'randomize' }) }),
					h('button', { text: 'No color', onclick: () => post({ type: 'clearTone' }) })),
				ui.colorError,
				ui.palette,
				h('div', { class: 'row' }, ui.paletteLabel,
					h('button', { text: 'Save current color to palette', onclick: savePalette }),
					h('span', { class: 'muted small', text: 'Saved colors are stored in bgTone.palette for this repo.' }))),

			h('section', { class: 'card' },
				h('h2', { text: 'Intensity' }),
				h('p', { class: 'hint muted small', text: 'How much of the color is mixed into each area (0 to 0.3).' }),
				h('div', { class: 'row' }, ui.strength, ui.strengthValue)),

			h('section', { class: 'card' },
				h('h2', { text: 'Areas to tint' }),
				h('p', { class: 'hint muted small' }, 'The base is the color each area is blended onto. Change it if your theme differs from Dark+/Light+.'),
				ui.surfaces,
				h('div', { class: 'row' },
					h('label', { class: 'check' }, ui.accent,
						h('span', { class: 'text' }, 'Accent border',
							h('span', { class: 'muted small', text: 'Draw the raw color on the title bar bottom border and the active tab.' }))))),

			h('section', { class: 'card' },
				h('h2', { text: 'Repo logo' }),
				h('p', { class: 'hint muted small' },
					'Pick an image that lives inside this repo. The path is stored relative to the repo root, so everyone who clones it sees the same logo.'),
				h('div', { class: 'row' },
					ui.logoPreview,
					h('div', { class: 'grow' },
						h('div', { class: 'row tight' }, ui.logoPath),
						h('div', { class: 'row tight' },
							h('button', { class: 'primary', text: 'Choose image from repo...', onclick: () => post({ type: 'pickLogo' }) }),
							ui.clearLogo),
						ui.logoMessage)),
				h('h2', { text: 'Show the logo in' }),
				ui.locations,
				h('div', { class: 'row' }, h('span', { text: 'Window title prefix' }), ui.emoji, ui.emojiChips),
				h('p', { class: 'muted small', text: 'The native title bar can only show text, so the window title uses this emoji or text instead of the image. The logo itself shows in the Repo Identity view, the Explorer item and this tab\u2019s icon.' })),

			h('section', { class: 'card' },
				h('h2', { text: 'Preview' }),
				ui.mock,
				ui.previewNote),

			h('div', { class: 'row', style: { 'margin-top': '16px' } },
				h('button', { text: 'Open pulpfixer.json', onclick: () => post({ type: 'openSettingsJson' }) }),
				h('button', { class: 'danger', text: 'Reset all for this repo', onclick: () => post({ type: 'reset' }) })),
		);
	}

	function commitHex(value) {
		const trimmed = value.trim();
		if (trimmed === '') {
			setSetting('color', '');
			return;
		}
		const withHash = trimmed.startsWith('#') ? trimmed : '#' + trimmed;
		if (!isHex(withHash)) {
			ui.colorError.textContent = 'Enter a valid hex color, e.g. #3b82f6.';
			ui.colorError.classList.remove('hidden');
			return;
		}
		setSetting('color', expandHex(withHash));
	}

	function savePalette() {
		const color = state && isHex(state.config.color) ? state.config.color : '';
		post({ type: 'addPalette', color, label: ui.paletteLabel.value });
		ui.paletteLabel.value = '';
	}

	// ---------- updates ----------

	function renderPalette() {
		const current = (state.config.color || '').toLowerCase();
		const groups = new Map();
		for (const p of state.palette) {
			if (!groups.has(p.group)) {
				groups.set(p.group, []);
			}
			groups.get(p.group).push(p);
		}
		const none = h('button', {
			class: 'swatch none' + (current === '' ? ' selected' : ''),
			title: 'No color',
			'aria-label': 'No color',
			'aria-pressed': String(current === ''),
			onclick: () => post({ type: 'clearTone' }),
		});
		const children = [h('div', { class: 'swatches' }, h('span', { class: 'swatch-wrap' }, none))];
		for (const [group, items] of groups) {
			children.push(h('div', { class: 'palette-group muted', text: group }));
			children.push(h('div', { class: 'swatches' }, items.map(p => swatch(p, current))));
		}
		ui.palette.replaceChildren(...children);
	}

	function swatch(p, current) {
		const selected = p.color.toLowerCase() === current;
		const button = h('button', {
			class: 'swatch' + (selected ? ' selected' : ''),
			style: { background: p.color },
			title: p.label === p.color ? p.color : p.label + ' ' + p.color,
			'aria-label': p.label + ' ' + p.color,
			'aria-pressed': String(selected),
			onclick: () => setSetting('color', p.color),
		});
		const wrap = h('span', { class: 'swatch-wrap' }, button);
		if (p.group === 'Custom') {
			wrap.append(h('button', {
				class: 'remove',
				text: '\u00d7',
				title: 'Remove from palette',
				'aria-label': 'Remove ' + p.color + ' from palette',
				onclick: () => post({ type: 'removePalette', color: p.color }),
			}));
		}
		return wrap;
	}

	function renderSurfaces() {
		const selected = new Set(state.config.surfaces);
		const rows = state.surfaceMeta.map(meta => {
			const override = state.config.baseColors[meta.id];
			const checkbox = h('input', {
				type: 'checkbox',
				onchange: e => {
					const next = new Set(state.config.surfaces);
					if (e.target.checked) {
						next.add(meta.id);
					} else {
						next.delete(meta.id);
					}
					setSetting('surfaces', state.surfaceMeta.map(m => m.id).filter(id => next.has(id)));
				},
			});
			checkbox.checked = selected.has(meta.id);
			const base = h('input', {
				type: 'color',
				title: 'Base color for ' + meta.label,
				'aria-label': 'Base color for ' + meta.label,
				onchange: e => setSetting('baseColors', { ...state.config.baseColors, [meta.id]: e.target.value }),
			});
			base.value = override || meta.defaultBase;
			return h('div', { class: 'surface-row' },
				h('label', { class: 'check' }, checkbox,
					h('span', { class: 'text' }, meta.label, h('span', { class: 'muted small', text: meta.hint }))),
				h('div', { class: 'base' },
					h('span', { class: 'muted small', text: override ? 'Base (custom)' : 'Base (theme default)' }),
					base,
					override && h('button', {
						class: 'link',
						text: 'reset',
						onclick: () => {
							const next = { ...state.config.baseColors };
							delete next[meta.id];
							setSetting('baseColors', next);
						},
					})));
		});
		ui.surfaces.replaceChildren(...rows);
	}

	const LOCATION_LABELS = [
		['identityCard', 'Repo Identity view', 'A card in the Explorer with the logo, repo name and tone.'],
		['explorerItem', 'Explorer item', 'A tree item that uses the logo as its icon.'],
		['windowTitle', 'Window title', 'Prefix the window title with the emoji or text below.'],
	];

	function renderLocations() {
		const selected = new Set(state.config.logoLocations);
		ui.locations.replaceChildren(...LOCATION_LABELS.map(([id, label, hint]) => {
			const cb = h('input', {
				type: 'checkbox',
				onchange: e => {
					const next = new Set(state.config.logoLocations);
					if (e.target.checked) {
						next.add(id);
					} else {
						next.delete(id);
					}
					setSetting('logoLocations', LOCATION_LABELS.map(l => l[0]).filter(x => next.has(x)));
				},
			});
			cb.checked = selected.has(id);
			return h('div', { class: 'row tight' },
				h('label', { class: 'check' }, cb,
					h('span', { class: 'text' }, label, h('span', { class: 'muted small', text: hint }))));
		}));
	}

	function logoNode(logo, fallbackText) {
		return logo.status === 'ok' && logo.src
			? h('img', { src: logo.src, alt: '' })
			: h('span', { class: 'muted', text: fallbackText });
	}

	function renderLogo() {
		const letter = (state.repoName || '?').trim().charAt(0).toUpperCase();
		ui.logoBox.replaceChildren(logoNode(state.logo, letter));
		ui.logoPreview.replaceChildren(logoNode(state.logo, 'No logo'));
		ui.logoPath.textContent = state.logo.relPath || 'No logo selected';
		ui.clearLogo.disabled = !state.logo.relPath;
		if (state.logo.status === 'error') {
			ui.logoMessage.textContent = state.logo.message;
			ui.logoMessage.classList.remove('hidden');
		} else {
			ui.logoMessage.classList.add('hidden');
		}
	}

	function renderMock(preview) {
		const s = preview.surfaces;
		const colored = (el, bg) => {
			el.style.setProperty('background', bg);
			el.style.setProperty('color', textOn(bg));
			return el;
		};
		const logoImg = state.logo.status === 'ok' && state.logo.src
			? h('img', { src: state.logo.src, alt: '' })
			: null;
		const showTitle = state.config.logoLocations.includes('windowTitle') && state.config.titleEmoji;
		const tabs = colored(h('div', { class: 'tabs' }, h('span', { text: 'index.ts' }), h('span', { class: 'active', text: 'app.ts' })), s.tabBar);
		const activeTab = tabs.querySelector('.active');
		if (activeTab) {
			activeTab.style.setProperty('border-bottom-color', preview.accent || 'transparent');
		}
		const titlebar = colored(h('div', { class: 'titlebar' },
			h('div', { class: 'dots' }, h('i'), h('i'), h('i')),
			showTitle ? h('span', { text: state.config.titleEmoji }) : null,
			h('span', { text: 'app.ts \u2014 ' + state.repoName })), s.titleBar);
		titlebar.style.setProperty('border-bottom-color', preview.accent || 'transparent');

		ui.mock.replaceChildren(
			titlebar,
			h('div', { class: 'middle' },
				colored(h('div', { class: 'activity' }, h('i'), h('i'), h('i')), s.activityBar),
				colored(h('div', { class: 'sidebar' },
					state.config.logoLocations.includes('identityCard')
						? h('div', { class: 'id' }, logoImg, h('span', { text: state.repoName }))
						: h('div', { class: 'id' }, h('span', { text: 'EXPLORER' })),
					h('div', { class: 'line' }), h('div', { class: 'line' }), h('div', { class: 'line' })), s.sideBar),
				h('div', { class: 'main' },
					tabs,
					colored(h('div', { class: 'editor' }, h('div', { class: 'line' }), h('div', { class: 'line' }), h('div', { class: 'line' })), s.editor),
					colored(h('div', { class: 'panel', text: 'TERMINAL' }), s.panel))),
			colored(h('div', { class: 'statusbar', text: 'main' }), s.statusBar));

		const notes = [];
		if (!preview.tinted && !preview.error) {
			notes.push(state.kind.startsWith('highContrast')
				? 'High contrast themes are not tinted.'
				: 'No tone is applied right now (turned off or no color selected).');
		}
		ui.previewNote.textContent = notes.join(' ');
		ui.previewNote.classList.toggle('hidden', notes.length === 0);

		if (preview.error) {
			ui.banner.textContent = preview.error;
			ui.banner.className = 'banner error';
		} else {
			ui.banner.className = 'banner hidden';
		}
	}

	function update() {
		const c = state.config;
		ui.noWorkspace.classList.toggle('hidden', state.hasWorkspace);
		ui.repoTitle.textContent = state.repoName;
		ui.enabled.checked = c.enabled;
		ui.accent.checked = c.accentBorder;

		const validColor = isHex(c.color);
		ui.selectedLabel.textContent = validColor ? 'Selected: ' + c.color : c.color ? 'Not a valid hex color.' : 'No color selected.';
		ui.colorPicker.value = validColor ? expandHex(c.color) : '#3b82f6';
		if (!skipIfFocused(ui.colorText)) {
			ui.colorText.value = c.color;
		}
		ui.colorError.classList.add('hidden');

		if (!skipIfFocused(ui.strength)) {
			ui.strength.value = String(c.strength);
		}
		ui.strengthValue.textContent = Number(c.strength).toFixed(3);

		if (!skipIfFocused(ui.emoji)) {
			ui.emoji.value = c.titleEmoji;
		}

		renderPalette();
		renderSurfaces();
		renderLocations();
		renderLogo();
		renderMock(state.preview);
	}

	// ---------- messaging ----------

	window.addEventListener('message', event => {
		const message = event.data;
		if (!message || typeof message.type !== 'string') {
			return;
		}
		if (message.type === 'state') {
			state = message.state;
			update();
		} else if (message.type === 'preview' && state) {
			state.preview = message.preview;
			renderMock(message.preview);
		}
	});

	build();
	post({ type: 'ready' });
})();
