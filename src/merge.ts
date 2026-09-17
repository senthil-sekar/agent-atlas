import { basename, resolve } from 'node:path';
import { assemble } from './build.js';
import { type AtlasConfig, configSchema } from './config.js';
import { readAtlas } from './io.js';
import type { Atlas, ScanResult } from './model.js';

export interface MergeInput {
  dir: string;
  atlas: Atlas;
}

/**
 * Read the committed atlas from each directory. Each must already have run `agentatlas scan` --
 * merging never re-scans code, only the graphs repos have already published.
 */
export function loadMergeSources(dirs: string[]): MergeInput[] {
  return dirs.map((dir) => {
    const resolved = resolve(dir);
    const atlas = readAtlas(resolved);
    if (!atlas) throw new Error(`No .agentatlas/atlas.yaml in ${resolved}. Run \`agentatlas scan\` there first.`);
    return { dir: resolved, atlas };
  });
}

/**
 * Combine several repos' committed atlases into one system view, using the same id-canonicalization,
 * merge, and cleanup rules a single scan applies. Ids that collide across repos are treated as the
 * same node, which is exactly right for a resource genuinely shared between them (a topic every
 * team's service touches) and exactly wrong for coincidental reuse of a common name (two repos
 * both naming a service "gateway"). Merge only sees the already-canonical ids each repo committed,
 * so it can unify two different ids that name the same real thing (`config.aliases`), but it cannot
 * un-merge two identical ids that turn out to mean different things -- that has to be fixed at the
 * source, by giving the repo a distinct id in its own agentatlas.yaml before committing its atlas.
 */
export function mergeAtlases(inputs: MergeInput[], config: AtlasConfig): Atlas {
  const raw: ScanResult = { nodes: [], edges: [], flows: [], aliases: [] };
  for (const { atlas } of inputs) {
    raw.nodes.push(...atlas.nodes);
    raw.edges.push(...atlas.edges);
    raw.flows.push(...atlas.flows);
  }
  return assemble(config, raw);
}

export const defaultMergeName = (inputs: MergeInput[]) => inputs.map((i) => basename(i.dir)).join(' + ');

export const emptyMergeConfig = (name: string): AtlasConfig => configSchema.parse({ system: { name } });
