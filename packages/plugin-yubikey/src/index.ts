import type { Entry } from '@pulpfixer/kit/types';
import type { Plugin } from '@pulpfixer/kit/plugin';
import { otpCommand } from './commands/otp.js';
import { ykCommand } from './commands/yk.js';
import { hasYkman } from './ykman.js';

/**
 * YubiKey helpers on top of the `ykman` CLI: OATH codes (`pf otp`) and a read-only security check
 * plus the per-application info views (`pf yk`). pf never reads or stores secrets: ykman holds the
 * OATH password prompt and the touch requirement, and the YubiKey itself does the work.
 * Add new commands under `commands/` and list them here.
 */
export const yubikeyPlugin: Plugin = {
  name: 'yubikey',
  summary: 'YubiKey: OATH codes and a security check',
  commands: [otpCommand, ykCommand],
  entries(ctx): Entry[] {
    const missing = hasYkman() ? null : 'ykman not installed (brew install ykman)';
    return [
      {
        name: 'otp',
        summary: 'Six-digit codes from your YubiKey',
        group: 'Security',
        detail: missing ?? 'ykman oath accounts code',
        run: () => otpCommand.run(ctx, []),
      },
      {
        name: 'yk',
        summary: 'YubiKey status and security check',
        group: 'Security',
        detail: missing ?? 'ykman info, audit and per-application views',
        run: () => ykCommand.run(ctx, []),
      },
    ];
  },
};
