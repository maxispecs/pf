/** workspaceState key of the last Repo Identity card the extension drew in this workspace. */
export const CARD_SNAPSHOT_KEY = 'bgTone.cardSnapshot';

export interface CardLogo {
	/** The logo's URI as a string; each webview turns it into its own resource URL. */
	uri: string;
	mtime: number;
}

export interface CardAgent {
	title: string;
	status: string;
	updatedAt: number;
}

export interface CardActions {
	buttons: Array<{ id: string; label: string; icon: string }>;
	canEdit: boolean;
	hint: string;
}

/** What the card shows, independent of any one webview. */
export interface CardSnapshot {
	name: string;
	/** The repo's stack version (`versions.json`), shown small beside the name; empty when the repo has none. */
	version: string;
	/** Files with uncommitted changes (`git status`), shown beside the version; null when unknown (no git, no repo). */
	changes: number | null;
	color: string;
	logo: CardLogo | null;
	agents: CardAgent[];
	actions: CardActions;
}

/** The parts known right now; `undefined` means "not loaded yet", so the cached value stands in. */
export interface FreshCard {
	name: string;
	version: string;
	changes: number | null | undefined;
	color: string;
	logo: CardLogo | null | undefined;
	agents: CardAgent[] | undefined;
	actions: CardActions | undefined;
}

export const NO_ACTIONS: CardActions = { buttons: [], canEdit: false, hint: '' };

export function composeSnapshot(fresh: FreshCard, cached: CardSnapshot | undefined): CardSnapshot {
	return {
		name: fresh.name,
		version: fresh.version,
		changes: fresh.changes !== undefined ? fresh.changes : cached?.changes ?? null,
		color: fresh.color,
		logo: fresh.logo !== undefined ? fresh.logo : cached?.logo ?? null,
		agents: fresh.agents ?? cached?.agents ?? [],
		actions: fresh.actions ?? cached?.actions ?? NO_ACTIONS,
	};
}

/** Accepts only a well-formed snapshot (workspaceState may hold one written by an older version). */
export function parseSnapshot(raw: unknown): CardSnapshot | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const s = raw as Partial<CardSnapshot>;
	if (typeof s.name !== 'string' || typeof s.color !== 'string' || !Array.isArray(s.agents) || !s.actions || !Array.isArray(s.actions.buttons)) {
		return undefined;
	}
	const logo = s.logo && typeof s.logo.uri === 'string' && typeof s.logo.mtime === 'number' ? s.logo : null;
	const version = typeof s.version === 'string' ? s.version : '';
	const changes = typeof s.changes === 'number' && Number.isInteger(s.changes) && s.changes >= 0 ? s.changes : null;
	return { name: s.name, version, changes, color: s.color, logo, agents: s.agents, actions: s.actions };
}

/** Escapes a value for a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Memento {
	get(key: string): unknown;
	update(key: string, value: unknown): Thenable<void>;
}

/** The last snapshot, in memory and in workspaceState, shared by every copy of the card. */
export class CardCache {
	private current: CardSnapshot | undefined;
	private json = '';

	constructor(private readonly memento: Memento) {
		this.current = parseSnapshot(memento.get(CARD_SNAPSHOT_KEY));
		this.json = this.current ? JSON.stringify(this.current) : '';
	}

	get snapshot(): CardSnapshot | undefined {
		return this.current;
	}

	set(snapshot: CardSnapshot): void {
		const json = JSON.stringify(snapshot);
		if (json === this.json) {
			return;
		}
		this.current = snapshot;
		this.json = json;
		void this.memento.update(CARD_SNAPSHOT_KEY, snapshot);
	}
}
