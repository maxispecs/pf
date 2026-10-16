import os from 'node:os';
import path from 'node:path';

export const PACKAGE_NAME = 'pulpfixer';
export const REGISTRY_URL = 'https://cellars.staging.pangenea.com/';
export const REGISTRY_HOST = 'cellars.staging.pangenea.com';
export const AUTH_LINE = `//${REGISTRY_HOST}/:_authToken=\${NPM_TOKEN}`;

/** Per-user state directory. PF_HOME overrides it (used by tests). */
export function pfHome(): string {
  return process.env.PF_HOME ?? path.join(os.homedir(), '.pf');
}
