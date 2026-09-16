import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'quote-to-bind');

/** Create a temporary project from a { relativePath: content } map. */
export function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'agentatlas-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}
