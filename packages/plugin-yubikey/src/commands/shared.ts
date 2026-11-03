import { err } from '@pulpfixer/kit/ui/palette';
import { badgeLabel } from '@pulpfixer/kit/ui/text';
import { YKMAN_INSTALL, hasYkman } from '../ykman.js';

/** True when ykman is installed. Otherwise says how to get it and returns false. */
export function needYkman(): boolean {
  if (hasYkman()) return true;
  process.stderr.write(`${badgeLabel('error', err())} ykman (YubiKey Manager CLI) is not on PATH. Install it: ${YKMAN_INSTALL}\n`);
  return false;
}
