import { compareVersions } from '@pulpfixer/kit/util';

/**
 * Parsers for `ykman info`, `oath info`, `fido info`, `piv info` and `openpgp info`, and the
 * security findings drawn from them. Everything here is pure (text in, data out) so it can be tested
 * without a key. Parsers are tolerant: a field they cannot read is left out, and a missing field
 * never produces a finding.
 */

export type AppName = 'Yubico OTP' | 'FIDO U2F' | 'FIDO2' | 'OATH' | 'PIV' | 'OpenPGP' | 'YubiHSM Auth';

export interface DeviceInfo {
  type?: string;
  serial?: string;
  firmware?: string;
  formFactor?: string;
  /** Application name -> true when enabled (over USB or NFC), false when disabled or not available. */
  apps: Partial<Record<string, boolean>>;
}

/** `Key: value` lines, keyed by lowercase name. The first occurrence wins. */
export function keyValues(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^\s*([^:]+?):\s*(.*?)\s*$/.exec(line);
    if (m && !map.has(m[1]!.toLowerCase())) map.set(m[1]!.toLowerCase(), m[2]!);
  }
  return map;
}

const APPS = ['Yubico OTP', 'FIDO U2F', 'FIDO2', 'OATH', 'PIV', 'OpenPGP', 'YubiHSM Auth'];

export function parseInfo(text: string): DeviceInfo {
  const kv = keyValues(text);
  const info: DeviceInfo = { apps: {} };
  const type = kv.get('device type');
  const serial = kv.get('serial number');
  const firmware = /\d+\.\d+\.\d+/.exec(kv.get('firmware version') ?? '')?.[0];
  const formFactor = kv.get('form factor');
  if (type) info.type = type;
  if (serial) info.serial = serial;
  if (firmware) info.firmware = firmware;
  if (formFactor) info.formFactor = formFactor;
  // The table has one status column per transport (USB, NFC): enabled when any says so.
  for (const line of text.split('\n')) {
    const cols = line.split(/\t+| {2,}/).map((s) => s.trim()).filter(Boolean);
    if (cols.length >= 2 && APPS.includes(cols[0]!)) info.apps[cols[0]!] = cols.slice(1).some((s) => /^enabled$/i.test(s));
  }
  return info;
}

/** True when the application is enabled, or when the table was not readable (assume it is). */
export function appEnabled(info: DeviceInfo, app: AppName): boolean {
  return Object.keys(info.apps).length === 0 ? true : info.apps[app] === true;
}

export interface OathInfo {
  passwordProtected?: boolean;
}

export function parseOathInfo(text: string): OathInfo {
  const v = /password protection:\s*(\w+)/i.exec(text)?.[1]?.toLowerCase();
  return v === 'enabled' ? { passwordProtected: true } : v === 'disabled' ? { passwordProtected: false } : {};
}

export interface FidoInfo {
  pinSet?: boolean;
  attempts?: number;
  minPinLength?: number;
}

export function parseFidoInfo(text: string): FidoInfo {
  const r: FidoInfo = {};
  if (/PIN(?: is not set|:\s*not set)/i.test(text)) r.pinSet = false;
  const tries = /PIN(?::| is set,?)\s*(?:with\s+)?(\d+)\s+attempt/i.exec(text)?.[1];
  if (tries) {
    r.pinSet = true;
    r.attempts = Number(tries);
  }
  const min = /minimum PIN length:\s*(\d+)/i.exec(text)?.[1];
  if (min) r.minPinLength = Number(min);
  return r;
}

export interface PivInfo {
  pinTries?: number;
  managementKey?: string;
}

export function parsePivInfo(text: string): PivInfo {
  const r: PivInfo = {};
  const tries = /^PIN tries remaining:\s*(\d+)/im.exec(text)?.[1];
  if (tries) r.pinTries = Number(tries);
  const alg = /^Management key algorithm:\s*(\S+)/im.exec(text)?.[1];
  if (alg) r.managementKey = alg.toUpperCase();
  return r;
}

export interface PgpInfo {
  pinTries?: number;
  adminPinTries?: number;
  kdf?: boolean;
  signaturePin?: string;
}

export function parsePgpInfo(text: string): PgpInfo {
  const r: PgpInfo = {};
  const pin = /^PIN tries remaining:\s*(\d+)/im.exec(text)?.[1];
  const admin = /^Admin PIN tries remaining:\s*(\d+)/im.exec(text)?.[1];
  const kdf = /^KDF enabled:\s*(\w+)/im.exec(text)?.[1]?.toLowerCase();
  const sig = /^Require PIN for signature:\s*(\w+)/im.exec(text)?.[1];
  if (pin) r.pinTries = Number(pin);
  if (admin) r.adminPinTries = Number(admin);
  if (kdf === 'true' || kdf === 'false') r.kdf = kdf === 'true';
  if (sig) r.signaturePin = sig;
  return r;
}

/** What `pf yk audit` read from the key. An application that could not be read is in `unreadable`. */
export interface Snapshot {
  info: DeviceInfo;
  oath?: OathInfo;
  fido?: FidoInfo;
  piv?: PivInfo;
  pgp?: PgpInfo;
  unreadable?: { app: string; reason: string }[];
}

export type Level = 'ok' | 'warn' | 'info';

export interface Finding {
  level: Level;
  /** Application the finding is about, or `Key` for the device itself. */
  area: string;
  msg: string;
  /** A command that fixes it (or explains it better). */
  fix?: string;
}

/** Firmware before this has the Infineon ECDSA side channel (EUCLEAK, YSA-2024-03). */
export const EUCLEAK_FIXED_IN = '5.7.0';

const device = (s: Snapshot): string[] => (s.info.serial ? ['--device', s.info.serial] : []);
const yk = (s: Snapshot, ...args: string[]): string => ['ykman', ...device(s), ...args].join(' ');

export function findings(s: Snapshot): Finding[] {
  const out: Finding[] = [];
  const add = (level: Level, area: string, msg: string, fix?: string) => out.push({ level, area, msg, ...(fix ? { fix } : {}) });
  const fw = s.info.firmware;

  if (fw) {
    if (compareVersions(fw, EUCLEAK_FIXED_IN) < 0) {
      add('warn', 'Key', `firmware ${fw} predates ${EUCLEAK_FIXED_IN}: ECDSA keys on it are open to the EUCLEAK side channel (needs physical access and lab gear). Firmware cannot be updated, so replace the key for high-value PIV/FIDO use`, 'https://www.yubico.com/support/security-advisories/ysa-2024-03/');
    } else add('ok', 'Key', `firmware ${fw} has the EUCLEAK fix`);
  }

  if (s.info.apps['Yubico OTP'] === true) {
    add('info', 'Yubico OTP', 'enabled: touching the key can type a one-time string into whatever has focus. Disable it if you do not use Yubico OTP', yk(s, 'config', 'usb', '--disable', 'otp'));
  }

  if (s.oath && s.oath.passwordProtected !== undefined) {
    if (s.oath.passwordProtected) add('ok', 'OATH', 'accounts are password protected');
    else add('warn', 'OATH', 'no password: anyone who can plug in this key can read its codes (except accounts that require touch)', yk(s, 'oath', 'access', 'change'));
  }

  if (s.fido && s.fido.pinSet !== undefined) {
    if (!s.fido.pinSet) {
      add('warn', 'FIDO2', 'no PIN set: passkeys on this key need only a touch, so a stolen key is a usable key', yk(s, 'fido', 'access', 'change-pin'));
    } else {
      if (s.fido.attempts !== undefined && s.fido.attempts < 8) add('warn', 'FIDO2', `PIN has ${s.fido.attempts} of 8 attempts left: someone may have been guessing it`);
      else add('ok', 'FIDO2', 'PIN is set');
      if (s.fido.minPinLength !== undefined && s.fido.minPinLength < 6) add('info', 'FIDO2', `minimum PIN length is ${s.fido.minPinLength}: raise it to 6 or more`, yk(s, 'fido', 'access', 'set-min-length', '6'));
    }
  }

  if (s.piv) {
    if (s.piv.pinTries !== undefined && s.piv.pinTries < 3) add('warn', 'PIV', `PIN has ${s.piv.pinTries} of 3 attempts left: someone may have been guessing it`);
    else if (s.piv.pinTries !== undefined) add('ok', 'PIV', 'PIN has all its attempts');
    if (s.piv.managementKey === 'TDES' && fw && compareVersions(fw, '5.4.2') >= 0) {
      add('info', 'PIV', 'management key is TDES: AES is the default on this firmware', yk(s, 'piv', 'access', 'change-management-key', '--algorithm', 'AES256', '--generate', '--protect'));
    }
    add('info', 'PIV', 'ykman cannot tell whether the default PIN (123456), PUK (12345678) and management key are still in use. If you never changed them, do it now', yk(s, 'piv', 'access', 'change-pin'));
  }

  if (s.pgp) {
    if ((s.pgp.pinTries !== undefined && s.pgp.pinTries < 3) || (s.pgp.adminPinTries !== undefined && s.pgp.adminPinTries < 3)) {
      add('warn', 'OpenPGP', 'a PIN has fewer than 3 attempts left: someone may have been guessing it');
    }
    if (s.pgp.kdf === false) {
      add('info', 'OpenPGP', 'KDF is off, so the PIN is sent to the key as typed. Turn it on, best before you set your own PINs', 'gpg --card-edit  # then: admin, kdf-setup');
    } else if (s.pgp.kdf === true) add('ok', 'OpenPGP', 'KDF is on: the PIN is hashed before it reaches the key');
    if (s.pgp.signaturePin && /^once$/i.test(s.pgp.signaturePin)) {
      add('info', 'OpenPGP', 'one PIN entry unlocks signing until the key is removed. Require it for every signature', yk(s, 'openpgp', 'access', 'set-signature-policy', 'always'));
    }
  }

  for (const u of s.unreadable ?? []) add('info', u.app, `could not read: ${u.reason}`);
  return out;
}

/** How many findings are warnings: used for the summary line and `--strict`. */
export const warnings = (list: Finding[]): number => list.filter((f) => f.level === 'warn').length;
