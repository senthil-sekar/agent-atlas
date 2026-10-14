import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { writeOutputs } from '../src/io.js';
import { emptyMergeConfig, mergeAtlases } from '../src/merge.js';
import { discoverRepos, loadWorkspaceSources } from '../src/workspace.js';
import { project } from './helpers.js';

const markGitRepo = (dir: string) => writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

describe('workspace', () => {
  it('discovers git checkouts under a workspace dir, ignoring plain subdirectories', () => {
    const root = project({
      'repo-a/pyproject.toml': '[project]\nname = "a"\n',
      'repo-b/pyproject.toml': '[project]\nname = "b"\n',
      'not-a-repo/README.md': 'just a folder\n',
    });
    mkdirSync(join(root, 'repo-a', '.git'), { recursive: true });
    mkdirSync(join(root, 'repo-b', '.git'), { recursive: true });
    markGitRepo(join(root, 'repo-a'));
    markGitRepo(join(root, 'repo-b'));

    expect(discoverRepos(root)).toEqual([join(root, 'repo-a'), join(root, 'repo-b')]);
  });

  it('also recognizes a repo that has no .git but is already configured for agentatlas', () => {
    const root = project({ 'configured/agentatlas.yaml': 'version: 1\nsystem: { name: t }\n' });
    expect(discoverRepos(root)).toEqual([join(root, 'configured')]);
  });

  it('prefers a committed atlas over scanning, and falls back to an in-memory scan when none is committed', () => {
    const root = project({
      'scanned/pyproject.toml': '[project]\nname = "quote-api"\ndependencies = ["fastapi"]\n',
      'committed/pyproject.toml': '[project]\nname = "policy-worker"\ndependencies = ["flask"]\n',
    });
    mkdirSync(join(root, 'scanned', '.git'), { recursive: true });
    markGitRepo(join(root, 'scanned'));
    mkdirSync(join(root, 'committed', '.git'), { recursive: true });
    markGitRepo(join(root, 'committed'));
    writeOutputs(join(root, 'committed'), buildAtlas(join(root, 'committed')).atlas);

    const repos = discoverRepos(root);
    const sources = loadWorkspaceSources(repos);
    expect(sources.find((s) => s.dir.endsWith('scanned'))!.committed).toBe(false);
    expect(sources.find((s) => s.dir.endsWith('committed'))!.committed).toBe(true);

    const merged = mergeAtlases(sources, emptyMergeConfig('combined'));
    expect(merged.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['quote-api', 'policy-worker']));
  });
});
