import { join } from 'node:path';
import { emptyResult } from '../model.js';
import { globToRegExp, readText } from '../util.js';
import type { Scanner } from './types.js';

/** Checked in GitHub's own priority order; only the first one found is used. */
const LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/**
 * A CODEOWNERS pattern, best-effort: an unanchored pattern (no leading `/`) matches at any depth,
 * like gitignore; a bare directory name (no `/` or `*`) also covers everything inside it.
 */
function toMatcher(pattern: string): (path: string) => boolean {
  let p = pattern;
  if (p === '*') return () => true;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.endsWith('/')) p += '**';
  else if (!p.includes('*')) p += '/**';
  const re = globToRegExp(anchored ? p : `**/${p}`);
  return (path: string) => re.test(path) || re.test(`${path}/`);
}

interface Rule { test: (path: string) => boolean; owners: string }

function parseCodeowners(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [pattern, ...owners] = trimmed.split(/\s+/);
    if (!pattern || !owners.length) continue;
    rules.push({ test: toMatcher(pattern), owners: owners.join(', ') });
  }
  return rules;
}

/** GitHub CODEOWNERS names who to tell when a node changes, so `impact` can answer that too. */
export const scanCodeowners: Scanner = (ctx) => {
  const result = emptyResult();
  const file = LOCATIONS.find((loc) => ctx.files.includes(loc));
  if (!file) return result;
  const rules = parseCodeowners(readText(join(ctx.root, file)) ?? '');

  for (const node of ctx.codeNodes) {
    if (node.repoPath === undefined) continue;
    let owner: string | undefined;
    for (const rule of rules) if (rule.test(node.repoPath)) owner = rule.owners; // last match wins
    if (owner) result.nodes.push({ id: node.id, kind: node.kind, owner, sources: ['codeowners'] });
  }
  return result;
};
