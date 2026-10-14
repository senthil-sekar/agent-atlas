import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildAtlas } from './build.js';
import { readAtlas } from './io.js';
import type { MergeInput } from './merge.js';

export interface WorkspaceSource extends MergeInput {
  /** False when there was no committed atlas and this repo was scanned in memory instead. */
  committed: boolean;
}

/** Does this directory look like one repo in the workspace: a git checkout, or an already-configured AgentAtlas project? */
function looksLikeRepo(path: string): boolean {
  return existsSync(join(path, '.git')) || existsSync(join(path, '.agentatlas', 'atlas.yaml')) || existsSync(join(path, 'agentatlas.yaml'));
}

/** Immediate subdirectories of `dir` that look like a repo. One level deep: siblings checked out in a workspace folder. */
export function discoverRepos(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))
    .filter(looksLikeRepo)
    .sort();
}

/** Loads each repo's committed atlas; scans a repo in memory when it has none yet, same fallback the MCP server and CLI use for a single repo. */
export function loadWorkspaceSources(dirs: string[]): WorkspaceSource[] {
  return dirs.map((dir) => {
    const resolved = resolve(dir);
    const committed = readAtlas(resolved);
    return committed ? { dir: resolved, atlas: committed, committed: true } : { dir: resolved, atlas: buildAtlas(resolved).atlas, committed: false };
  });
}
