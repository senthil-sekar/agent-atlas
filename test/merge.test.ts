import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { configSchema } from '../src/config.js';
import { writeOutputs } from '../src/io.js';
import { emptyMergeConfig, loadMergeSources, mergeAtlases } from '../src/merge.js';
import { project } from './helpers.js';

function scannedRepo(files: Record<string, string>): string {
  const root = project(files);
  const { atlas } = buildAtlas(root);
  writeOutputs(root, atlas);
  return root;
}

describe('merge', () => {
  it('combines two repos into one system, sharing a node both repos reference by the same id', () => {
    const repoA = scannedRepo({
      'services/quote/pyproject.toml': '[project]\nname = "quote-api"\ndependencies = ["fastapi"]\n',
      'services/quote/.env': 'QUOTE_BOUND_TOPIC=quote-bound\n',
    });
    const repoB = scannedRepo({
      'services/policy/pyproject.toml': '[project]\nname = "policy-worker"\ndependencies = ["flask", "pika"]\n',
      'agentatlas.yaml': 'version: 1\nsystem: { name: policy }\nedges:\n  - { from: policy-worker, to: quote-bound, kind: consumes }\n',
    });
    const inputs = loadMergeSources([repoA, repoB]);
    const merged = mergeAtlases(inputs, emptyMergeConfig('combined'));

    expect(merged.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['quote-api', 'policy-worker', 'quote-bound']));
    // quote-bound is the SAME node in both repos' graphs, so publishing and consuming both land on it.
    const edges = merged.edges.map((e) => `${e.from}-${e.kind}-${e.to}`);
    expect(edges).toEqual(expect.arrayContaining(['quote-api-publishes-quote-bound', 'policy-worker-consumes-quote-bound']));
  });

  it('silently merges two repos that coincidentally reuse the same id for different things', () => {
    const repoA = scannedRepo({ 'services/a/pyproject.toml': '[project]\nname = "gateway"\ndependencies = ["flask"]\n' });
    const repoB = scannedRepo({ 'services/b/pyproject.toml': '[project]\nname = "gateway"\ndependencies = ["fastapi"]\n' });
    const merged = mergeAtlases(loadMergeSources([repoA, repoB]), emptyMergeConfig('combined'));
    const gateways = merged.nodes.filter((n) => n.id === 'gateway');
    // This is the real risk of a shared id namespace: separating them requires each repo to pick a
    // distinct id in its OWN agentatlas.yaml before committing its atlas -- merge can't tell
    // same-name-different-thing apart after the fact, only rename what's already unambiguous.
    expect(gateways).toHaveLength(1);
    expect(gateways[0]!.tech).toEqual(expect.arrayContaining(['Flask', 'FastAPI']));
  });

  it('unifies two repos that call the same real resource by different ids, via a merge-level alias', () => {
    const repoA = scannedRepo({
      'services/quote/pyproject.toml': '[project]\nname = "quote-api"\ndependencies = ["fastapi"]\n',
      'services/quote/.env': 'AUDIT_LOG_URL=http://audit-log-svc:8080\n', // repoA's guess at the hostname
    });
    const repoB = scannedRepo({ 'services/audit/pyproject.toml': '[project]\nname = "audit-service"\ndependencies = ["flask"]\n' }); // its real name

    const inputs = loadMergeSources([repoA, repoB]);
    const unlinked = mergeAtlases(inputs, emptyMergeConfig('combined'));
    expect(unlinked.nodes.some((n) => n.id === 'audit-log-svc')).toBe(true);
    expect(unlinked.edges.some((e) => e.from === 'quote-api' && e.to === 'audit-service')).toBe(false);

    const configured = configSchema.parse({ system: { name: 'combined' }, aliases: { 'audit-log-svc': 'audit-service' } });
    const linked = mergeAtlases(inputs, configured);
    expect(linked.nodes.some((n) => n.id === 'audit-log-svc')).toBe(false);
    expect(linked.edges.some((e) => e.from === 'quote-api' && e.to === 'audit-service')).toBe(true);
  });

  it('requires each directory to already have a committed atlas', () => {
    const empty = project({});
    expect(() => loadMergeSources([empty])).toThrow(/Run `agentatlas scan`/);
  });
});
