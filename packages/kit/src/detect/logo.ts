import fs from 'node:fs';
import path from 'node:path';
import { capture } from '../exec.js';
import { readText } from '../util.js';

/**
 * Finds the image that stands for a repo: a logo file in the usual places, else the first local image in
 * the README. `pf rp` writes it to `pulpfixer.json` (`bgTone.logo`), where the Background Tone extension shows it.
 * Only the formats the extension can show are accepted, and only paths inside the repo.
 */

/** Image types the extension can show, best first (SVG is crisp at any size). */
export const LOGO_EXTENSIONS: readonly string[] = ['.svg', '.png', '.webp', '.jpg', '.jpeg', '.gif', '.ico'];

/** File names to look for, best first. */
const NAMES = ['logo', 'icon', 'favicon'];
/** Folders to look in, best first (the repo root first). */
const DIRS = ['', 'assets', 'public', 'static', 'media', 'images', 'img', 'docs', '.github', 'assets/images', 'assets/img', 'src/assets', 'branding', 'art', 'app'];
const READMES = ['README.md', 'Readme.md', 'readme.md', 'README.markdown', 'README.MD'];

export interface RepoLogo {
  /** Repo-relative path with forward slashes. */
  path: string;
  /** Why this one, for the `pf rp` summary. */
  reason: string;
}

/** What `findRepoLogo` needs from the disk, so tests can run without one. */
export interface LogoIo {
  isFile(rel: string): boolean;
  readText(rel: string): string | null;
  /** True for a path git ignores (a build output, a download). */
  ignored(rel: string): boolean;
}

export function diskIo(root: string): LogoIo {
  return {
    isFile: (rel) => {
      try {
        return fs.statSync(path.join(root, rel)).isFile();
      } catch {
        return false;
      }
    },
    readText: (rel) => readText(root, rel),
    ignored: (rel) => capture(['git', 'check-ignore', '-q', '--', rel], { cwd: root }).status === 0,
  };
}

/** A usable logo path: relative, inside the repo, a supported image type. Returns it normalized, or null. */
export function normalizeLogoPath(raw: string): string | null {
  const value = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/(?!\/)/, '');
  if (!value || value.includes('\0') || /^[a-zA-Z]:/.test(value) || value.startsWith('~') || value.startsWith('//')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.endsWith('/')) return null;
  if (!LOGO_EXTENSIONS.includes(path.posix.extname(normalized).toLowerCase())) return null;
  return normalized;
}

/** Local image references in markdown or HTML, in document order: `![alt](path "title")` and `<img src="path">`. */
export function readmeImages(markdown: string): string[] {
  const found: { at: number; ref: string }[] = [];
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) found.push({ at: m.index ?? 0, ref: m[1]! });
  for (const m of markdown.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) found.push({ at: m.index ?? 0, ref: m[1]! });
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.ref.split(/[?#]/)[0]!)
    .filter((ref) => !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('//'))
    .map((ref) => {
      try {
        return decodeURIComponent(ref);
      } catch {
        return ref;
      }
    });
}

export function findRepoLogo(root: string, io: LogoIo = diskIo(root)): RepoLogo | null {
  const usable = (rel: string): boolean => !rel.split('/').includes('node_modules') && io.isFile(rel) && !io.ignored(rel);
  for (const name of NAMES) {
    for (const dir of DIRS) {
      for (const ext of LOGO_EXTENSIONS) {
        const rel = dir ? `${dir}/${name}${ext}` : `${name}${ext}`;
        if (usable(rel)) return { path: rel, reason: `${name}${ext} in ${dir || 'the repo root'}` };
      }
    }
  }
  for (const readme of READMES) {
    const text = io.readText(readme);
    if (text === null) continue;
    for (const ref of readmeImages(text)) {
      const rel = normalizeLogoPath(ref);
      if (rel && usable(rel)) return { path: rel, reason: `the first image in ${readme}` };
    }
    break;
  }
  return null;
}
