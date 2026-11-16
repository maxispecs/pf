import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appEnabled, findings, parseFidoInfo, parseInfo, parseOathInfo, parsePgpInfo, parsePivInfo, warnings, type Snapshot } from '../src/audit.js';
import { accountsArgv, clipboardTools, codeArgv, copyText, isCode, parseAccounts, ykArgv, ykError } from '../src/ykman.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, '..', 'pulpfixer', 'src', 'bin', 'pf.ts');
const loader = path.join(root, '..', '..', 'node_modules', 'tsx', 'dist', 'loader.mjs');

// Output captured from ykman 5.9.2 and a YubiKey 5C Nano (firmware 5.2.4).
const INFO = `Device type: YubiKey 5C Nano
Serial number: 11447176
Firmware version: 5.2.4
Form factor: Nano (USB-C)
Enabled USB interfaces: OTP, FIDO, CCID

Applications
Yubico OTP  \tEnabled
FIDO U2F    \tEnabled
FIDO2       \tEnabled
OATH        \tEnabled
PIV         \tEnabled
OpenPGP     \tEnabled
YubiHSM Auth\tNot available
`;
const OATH = 'OATH version:        5.2.4\nPassword protection: disabled\n';
const FIDO = 'AAGUID:             ee882879-721c-4913-9775-3dfcce97072a\nPIN:                8 attempt(s) remaining\nMinimum PIN length: 4\n';
const PIV = 'PIV version:              5.2.4\nPIN tries remaining:      3\nManagement key algorithm: TDES\nCHUID: No data available\nCCC:   No data available\n';
const PGP = `OpenPGP version:            3.4
Application version:        5.2.4
PIN tries remaining:        3
Reset code tries remaining: 0
Admin PIN tries remaining:  3
Require PIN for signature:  Once
KDF enabled:                False
`;

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return { info: parseInfo(INFO), oath: parseOathInfo(OATH), fido: parseFidoInfo(FIDO), piv: parsePivInfo(PIV), pgp: parsePgpInfo(PGP), ...over };
}

test('parseInfo reads the device and the application table', () => {
  const info = parseInfo(INFO);
  assert.equal(info.type, 'YubiKey 5C Nano');
  assert.equal(info.serial, '11447176');
  assert.equal(info.firmware, '5.2.4');
  assert.equal(info.apps['OATH'], true);
  assert.equal(info.apps['YubiHSM Auth'], false);
  assert.equal(appEnabled(info, 'PIV'), true);
  assert.equal(appEnabled(info, 'YubiHSM Auth'), false);
});

test('parseInfo handles a USB and NFC table and an unreadable one', () => {
  const nfc = parseInfo('Firmware version: 5.7.1\n\nApplications\tUSB    \tNFC\nFIDO2       \tEnabled\tDisabled\nPIV         \tDisabled\tDisabled\n');
  assert.equal(nfc.apps['FIDO2'], true);
  assert.equal(nfc.apps['PIV'], false);
  // No table at all: assume everything is on rather than skipping the checks.
  assert.equal(appEnabled(parseInfo('Firmware version: 5.7.1\n'), 'FIDO2'), true);
});

test('per-application parsers', () => {
  assert.deepEqual(parseOathInfo(OATH), { passwordProtected: false });
  assert.deepEqual(parseOathInfo('Password protection: enabled'), { passwordProtected: true });
  assert.deepEqual(parseOathInfo('nothing useful'), {});
  assert.deepEqual(parseFidoInfo(FIDO), { pinSet: true, attempts: 8, minPinLength: 4 });
  assert.deepEqual(parseFidoInfo('PIN is not set.'), { pinSet: false });
  assert.deepEqual(parseFidoInfo('PIN is set, with 5 attempt(s) remaining.'), { pinSet: true, attempts: 5 });
  assert.deepEqual(parsePivInfo(PIV), { pinTries: 3, managementKey: 'TDES' });
  assert.deepEqual(parsePgpInfo(PGP), { pinTries: 3, adminPinTries: 3, kdf: false, signaturePin: 'Once' });
});

test('the audit flags what is weak on an old, unconfigured key', () => {
  const list = findings(snapshot());
  const warn = list.filter((f) => f.level === 'warn').map((f) => f.area);
  assert.deepEqual(warn, ['Key', 'OATH']);
  assert.equal(warnings(list), 2);
  const text = list.map((f) => `${f.area}: ${f.msg} ${f.fix ?? ''}`).join('\n');
  assert.match(text, /EUCLEAK/);
  assert.match(text, /ykman --device 11447176 oath access change/);
  assert.match(text, /Yubico OTP/);
  assert.match(text, /KDF is off/);
  assert.match(text, /set-signature-policy always/);
  // TDES is all this firmware can do, so no nagging about AES.
  assert.doesNotMatch(text, /management key is TDES/);
  assert.ok(list.some((f) => f.area === 'FIDO2' && f.level === 'ok'));
});

test('the audit is quiet for a well set up current key', () => {
  const list = findings({
    info: parseInfo('Firmware version: 5.7.2\n\nApplications\nFIDO2\tEnabled\nOATH\tEnabled\nPIV\tDisabled\n'),
    oath: { passwordProtected: true },
    fido: { pinSet: true, attempts: 8, minPinLength: 8 },
  });
  assert.equal(warnings(list), 0);
  assert.ok(list.every((f) => f.level === 'ok'), JSON.stringify(list));
});

test('the audit warns about a missing FIDO2 PIN, used-up attempts and TDES on new firmware', () => {
  const noPin = findings({ info: parseInfo('Firmware version: 5.7.2\n'), fido: { pinSet: false } });
  assert.ok(noPin.some((f) => f.level === 'warn' && f.area === 'FIDO2' && /fido access change-pin/.test(f.fix ?? '')));
  const guessed = findings({ info: parseInfo('Firmware version: 5.7.2\n'), fido: { pinSet: true, attempts: 5 }, piv: { pinTries: 1, managementKey: 'TDES' }, pgp: { pinTries: 3, adminPinTries: 2, kdf: true } });
  assert.deepEqual(guessed.filter((f) => f.level === 'warn').map((f) => f.area), ['FIDO2', 'PIV', 'OpenPGP']);
  assert.ok(guessed.some((f) => /management key is TDES/.test(f.msg)));
  assert.ok(guessed.some((f) => f.area === 'OpenPGP' && f.level === 'ok' && /KDF is on/.test(f.msg)));
});

test('an application that could not be read is reported, not guessed at', () => {
  const list = findings({ info: parseInfo('Firmware version: 5.7.2\n'), unreadable: [{ app: 'FIDO2', reason: 'Failed to open device' }] });
  assert.ok(list.some((f) => f.area === 'FIDO2' && f.level === 'info' && /Failed to open device/.test(f.msg)));
});

test('argv builders', () => {
  assert.deepEqual(ykArgv(['info']), ['ykman', 'info']);
  assert.deepEqual(ykArgv(['info'], { device: '123' }), ['ykman', '--device', '123', 'info']);
  assert.deepEqual(accountsArgv({}, { hidden: true }), ['ykman', 'oath', 'accounts', 'list', '-H']);
  assert.deepEqual(codeArgv({ device: '1' }, { query: 'git hub', single: true }), ['ykman', '--device', '1', 'oath', 'accounts', 'code', '-s', '--', 'git hub']);
  assert.deepEqual(codeArgv({}), ['ykman', 'oath', 'accounts', 'code']);
  // A name starting with a dash must not turn into an option.
  assert.deepEqual(codeArgv({}, { query: '-x', single: true }).slice(-2), ['--', '-x']);
});

test('codes, accounts and errors', () => {
  assert.ok(isCode('123456') && isCode('12345678') && isCode('K7VQB'));
  assert.ok(!isCode('') && !isCode('1234') && !isCode('123456789') && !isCode('Touch your YubiKey'));
  assert.deepEqual(parseAccounts('AWS:me\n\n  GitHub:me  \n'), ['AWS:me', 'GitHub:me']);
  const run = (stderr: string) => ({ ok: false, status: 1, stdout: '', stderr });
  assert.equal(ykError(run('WARNING: PC/SC not available\nERROR: Failed to connect to YubiKey.\n')), 'Failed to connect to YubiKey.');
  assert.equal(ykError(run('Error: Multiple matches, make the query more specific.\n')), 'Multiple matches, make the query more specific.');
  assert.equal(ykError(run('WARNING: x\nsomething broke\n')), 'something broke');
  assert.equal(ykError(run('')), 'ykman exited with 1');
});

test('clipboard tools by platform', () => {
  assert.deepEqual(clipboardTools('darwin'), [['pbcopy']]);
  assert.deepEqual(clipboardTools('win32'), [['clip']]);
  assert.equal(clipboardTools('linux', { WAYLAND_DISPLAY: 'wayland-0' })[0]![0], 'wl-copy');
  assert.equal(clipboardTools('linux', {})[0]![0], 'xclip');
  assert.equal(copyText('x', [['nope-clip']], () => false), null);
});

// ---- CLI with a fake ykman on PATH ----

function mkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-yk-'));
}

const FAKE = (log: string) => `#!/bin/sh
echo "$@" >> "${log}"
case "$*" in
  *"oath accounts code -s -- github"*) echo 123456 ;;
  *"oath accounts code -s -- nope"*) echo "ERROR: No matching account found." >&2; exit 1 ;;
  *"oath accounts list"*) printf 'AWS:me\\nGitHub:me\\n' ;;
  *"oath accounts code"*) printf 'GitHub:me  123456\\n' ;;
  *"oath info"*) printf 'OATH version: 5.7.2\\nPassword protection: enabled\\n' ;;
  *"fido info"*) printf 'PIN: 8 attempt(s) remaining\\nMinimum PIN length: 8\\n' ;;
  *"piv info"*|*"openpgp info"*) exit 1 ;;
  *"info"*) printf 'Device type: YubiKey 5 NFC\\nSerial number: 42\\nFirmware version: 5.7.2\\n\\nApplications\\tUSB\\tNFC\\nYubico OTP\\tDisabled\\tDisabled\\nFIDO2\\tEnabled\\tEnabled\\nOATH\\tEnabled\\tEnabled\\nPIV\\tEnabled\\tEnabled\\nOpenPGP\\tDisabled\\tDisabled\\n' ;;
  *"list"*) echo "YubiKey 5 NFC (5.7.2) [OTP+FIDO+CCID] Serial: 42" ;;
esac
`;

function fakeYkman(): { bin: string; log: string } {
  const dir = mkdir();
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'ykman'), FAKE(log), { mode: 0o755 });
  return { bin: dir, log };
}

function pf(path_: string, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', PF_NO_UPDATE_CHECK: '1', PF_HOME: mkdir(), PATH: path_ };
  delete env.FORCE_COLOR;
  const r = spawnSync(process.execPath, ['--conditions=source', '--import', loader, entry, ...args], { cwd: mkdir(), encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const withFake = (fake: { bin: string }) => `${fake.bin}${path.delimiter}${process.env.PATH}`;

test('pf otp <account> prints the code on stdout and nothing else there', () => {
  const fake = fakeYkman();
  const r = pf(withFake(fake), 'otp', 'github');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '123456\n');
  assert.match(fs.readFileSync(fake.log, 'utf8'), /oath accounts code -s -- github/);
});

test('pf otp --device and a multi-word account reach ykman', () => {
  const fake = fakeYkman();
  pf(withFake(fake), 'otp', '-d', '42', 'git', 'hub');
  assert.match(fs.readFileSync(fake.log, 'utf8'), /--device 42 oath accounts code -s -- git hub/);
});

test('pf otp fails with a non-zero code when ykman finds no account', () => {
  const r = pf(withFake(fakeYkman()), 'otp', 'nope');
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
});

test('pf otp with no account lists names when piped, and --all shows ykman\'s table', () => {
  const fake = fakeYkman();
  assert.equal(pf(withFake(fake), 'otp').out, 'AWS:me\nGitHub:me\n');
  assert.equal(pf(withFake(fake), 'otp', '--list').out, 'AWS:me\nGitHub:me\n');
  assert.match(pf(withFake(fake), 'otp', '--all').out, /GitHub:me\s+123456/);
  assert.equal(pf(withFake(fake), 'otp', '--all', 'github').code, 2);
});

test('pf otp --dry-run runs nothing and works without ykman', () => {
  const empty = mkdir();
  const r = pf(empty, 'otp', 'github', '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /would run ykman oath accounts code -s -- github/);
  const bare = pf(empty, 'otp', '--dry-run');
  assert.match(bare.err, /would run ykman oath accounts list/);
  assert.match(bare.err, /<account>/);
});

test('pf otp without ykman says how to install it', () => {
  const r = pf(mkdir(), 'otp', 'github');
  assert.equal(r.code, 127);
  assert.match(r.err, /ykman .* not on PATH/);
  assert.match(r.err, /brew install ykman/);
});

test('pf yk audit reads the key and prints findings', () => {
  const fake = fakeYkman();
  const r = pf(withFake(fake), 'yk', 'audit');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /YubiKey 5 NFC\s+firmware 5\.7\.2\s+serial 42/);
  assert.match(r.out, /OATH\s+accounts are password protected/);
  assert.match(r.out, /FIDO2\s+PIN is set/);
  // piv info fails in the fake: reported, not fatal. Applications that are off are not read.
  assert.match(r.out, /PIV\s+could not read/);
  assert.doesNotMatch(fs.readFileSync(fake.log, 'utf8'), /openpgp info/);
  assert.match(r.out, /no warnings/);
  assert.equal(pf(withFake(fake), 'yk', 'check', '--strict').code, 0);
});

test('pf yk audit --strict exits 1 on a warning, and --dry-run reads nothing', () => {
  const fake = fakeYkman();
  fs.writeFileSync(path.join(fake.bin, 'ykman'), FAKE(fake.log).replace('Firmware version: 5.7.2', 'Firmware version: 5.2.4'), { mode: 0o755 });
  const r = pf(withFake(fake), 'yk', 'audit', '--strict');
  assert.equal(r.code, 1);
  assert.match(r.out, /EUCLEAK/);
  const dry = pf(mkdir(), 'yk', 'audit', '--dry-run');
  assert.equal(dry.code, 0);
  assert.match(dry.err, /would run ykman fido info/);
});

test('pf yk subcommands run the matching ykman view', () => {
  const fake = fakeYkman();
  assert.match(pf(withFake(fake), 'yk').out, /Serial number: 42/);
  assert.match(pf(withFake(fake), 'yk', 'list', '-d', '42').out, /Serial: 42/);
  assert.match(fs.readFileSync(fake.log, 'utf8'), /^list$/m);
  assert.match(pf(withFake(fake), 'yk', 'fido', '--device', '42').out, /Minimum PIN length: 8/);
  assert.match(fs.readFileSync(fake.log, 'utf8'), /--device 42 fido info/);
  assert.equal(pf(withFake(fake), 'yk', 'bogus').code, 2);
});

test('pf yk without ykman or a key fails clearly', () => {
  assert.equal(pf(mkdir(), 'yk', 'audit').code, 127);
});
