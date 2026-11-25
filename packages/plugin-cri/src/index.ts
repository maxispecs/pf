import type { Plugin } from '@pulpfixer/kit/plugin';
import type { Entry } from '@pulpfixer/kit/types';
import { criCommand } from './commands/cri.js';
import { loadPublishers } from './config.js';

export { dispatch, emit, type DispatchOptions, type DispatchResult } from './dispatch.js';
export { selectPublisher } from './select.js';
export { CriError } from './errors.js';
export type { Identity, Publisher } from './config.js';

/**
 * The CRI event system: publishers (route prefix -> EventBridge bus, region, AWS profile, source) in
 * `~/.pf/cri/publishers.json`, the stack identity in the repo's `pulpfixer.json`, `pf cri send`, and the
 * `dispatch(route, payload)` helper in `./api`. The transport is plugin-aws's EventBridge sender.
 * No agent tools: events can hold user data.
 */
export const criPlugin: Plugin = {
  name: 'cri',
  summary: 'CRI event system: publishers and dispatching events to routes',
  commands: [criCommand],
  entries(ctx): Entry[] {
    let detail = 'pf cri publisher add --bus <bus>';
    try {
      const n = loadPublishers().length;
      if (n) detail = `${n} publisher${n === 1 ? '' : 's'}: pf cri send <route> --args <json>`;
    } catch {
      detail = 'publishers file unreadable: pf cri';
    }
    return [
      {
        name: 'cri',
        summary: 'CRI events: publishers and send',
        group: 'AWS',
        detail,
        run: () => criCommand.run(ctx, []),
      },
    ];
  },
};
