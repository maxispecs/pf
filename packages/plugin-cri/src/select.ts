import { publisherName, type Publisher } from './config.js';
import { CriError } from './errors.js';

/** A route is the DetailType of the event: one token, no whitespace. */
export function checkRoute(route: unknown): string {
  if (typeof route !== 'string' || route === '') throw new CriError('a route is required (e.g. "users/create" or "@payments/charge")');
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(route)) throw new CriError(`the route "${route}" may not contain whitespace`);
  return route;
}

/**
 * The publisher for a route (landscape spec, "Publisher Selection"): publishers whose prefix starts the
 * route are candidates and the longest prefix wins, so `@payments/refunds/` overrides `@payments/`.
 * Without a match the default publisher (the one with no prefix) takes it, `@domain/...` routes included.
 */
export function selectPublisher(publishers: readonly Publisher[], route: string): Publisher {
  let best: Publisher | undefined;
  for (const p of publishers) {
    if (p.prefix && route.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix!.length)) best = p;
  }
  if (best) return best;
  const fallback = publishers.find((p) => !p.prefix);
  if (fallback) return fallback;
  const named = publishers.map(publisherName).join(', ');
  throw new CriError(
    `no publisher for the route "${route}"${named ? ` (publishers: ${named})` : ' (none configured)'}`,
    route.startsWith('@')
      ? `pf cri publisher add ${route.split('/')[0]}/ --bus <bus>  (or add a default publisher)`
      : 'pf cri publisher add --bus <bus>  (a default publisher), or add one for this route prefix',
  );
}
