import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**', '**/bin/**', '**/obj/**', '**/dist/**', '**/.git/**',
  '**/.vs/**', '**/.idea/**', '**/coverage/**', '**/.agentatlas/**', '**/TestResults/**',
];

/** Convert a glob (`**`, `*`, `?`) to a RegExp matched against forward-slash relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const toPosix = (p: string) => p.split(sep).join('/');

export function matchesAny(relPath: string, globs: RegExp[]): boolean {
  return globs.some((g) => g.test(relPath) || g.test(`${relPath}/`));
}

/** Recursively list files under root, returning posix paths relative to root. */
export function walk(root: string, excludes: string[] = DEFAULT_EXCLUDES): string[] {
  const ex = excludes.map(globToRegExp);
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = toPosix(relative(root, abs));
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (!matchesAny(`${rel}/`, ex)) visit(abs);
      } else if (!matchesAny(rel, ex)) out.push(rel);
    }
  };
  visit(root);
  return out.sort();
}

export function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').replace(/^\uFEFF/, ''); } catch { return undefined; }
}

/** Parse JSON that may contain comments and trailing commas (appsettings.json style). */
export function parseLooseJson(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Flatten nested objects into [colon:separated:key, stringValue] pairs. */
export function flatten(value: unknown, prefix = ''): Array<[string, string]> {
  if (value === null || value === undefined) return [];
  if (typeof value !== 'object') return [[prefix, String(value)]];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(...flatten(v, prefix ? `${prefix}:${k}` : k));
  }
  return out;
}

export const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

/** Rough token estimate (about 4 characters per token). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
