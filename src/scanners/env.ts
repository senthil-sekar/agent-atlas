import { join, posix } from 'node:path';
import { emptyResult } from '../model.js';
import { readText } from '../util.js';
import { interpretSettings, normalizeEnvKey } from './settings.js';
import { isWorker, ownerOf, type Scanner } from './types.js';

const ENV_FILE = /^\.env(\.[\w.-]+)?$/;

/** Parse KEY=VALUE lines, tolerating `export`, quotes, comments, and blank lines. */
export function parseEnvFile(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][\w.]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted ? quoted[2]! : value.split(/\s+#/)[0]!.trim();
    out.push([m[1]!, value]);
  }
  return out;
}

/**
 * `.env` files describe how a service reaches everything else, in every language.
 * Values stay local: only ids, tech, and external origins reach the atlas.
 */
export const scanEnv: Scanner = (ctx) => {
  const result = emptyResult();
  for (const f of ctx.files.filter((f) => ENV_FILE.test(posix.basename(f)))) {
    const dir = posix.dirname(f);
    // A root-level .env in a single-service repo belongs to that service.
    const owner = ownerOf(ctx, dir) ?? (ctx.codeNodes.length === 1 ? ctx.codeNodes[0] : undefined);
    if (!owner) continue;
    const entries = parseEnvFile(readText(join(ctx.root, f)) ?? '')
      .map(([k, v]) => [normalizeEnvKey(k), v] as [string, string]);
    const found = interpretSettings(entries, { serviceId: owner.id, source: 'env', isWorker: isWorker(owner) });
    result.nodes.push(...found.nodes);
    result.edges.push(...found.edges);
  }
  return result;
};
