import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { diffAtlas, hasDrift } from '../src/drift.js';
import { AtlasGraph } from '../src/graph.js';
import { readAtlas } from '../src/io.js';
import { EXAMPLE } from './helpers.js';

const { atlas, warnings } = buildAtlas(EXAMPLE);
const graph = new AtlasGraph(atlas);
const edge = (from: string, kind: string, to: string) =>
  atlas.edges.find((e) => e.from === from && e.to === to && e.kind === kind);

describe('quote-to-bind example', () => {
  it('finds exactly the expected nodes', () => {
    expect(atlas.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual([
      'apim:gateway', 'gateway:gateway', 'policy-admin:external', 'policy-db:database', 'policy-worker:service',
      'quote-api:service', 'quote-bound:topic', 'quote-db:database', 'rating-engine:service', 'redis:cache',
    ]);
    expect(warnings).toEqual([]);
  });

  it('skips test projects and folds libraries into the services that use them', () => {
    expect(graph.nodes.has('quote-api-tests')).toBe(false);
    expect(graph.nodes.has('shared')).toBe(false);
    expect(graph.nodes.get('policy-worker')!.tech).toContain('Azure Service Bus');
  });

  it('merges evidence from every source', () => {
    const q = graph.nodes.get('quote-api')!;
    expect(q.sources).toEqual(['dotnet', 'compose', 'openapi', 'bicep', 'otel', 'manual']);
    expect(q.hosting).toBe('Azure Container Apps');
    expect(q.owner).toBe('Quoting Team');
    expect(q.endpoints?.map((e) => `${e.method} ${e.path}`)).toContain('POST /v1/quotes/{quoteId}/bind');
  });

  it('lets manual config override scanned descriptions', () => {
    expect(graph.nodes.get('rating-engine')!.description).toBe('Calculates premiums from rating factors.');
  });

  it('applies ignore and excludes observability containers', () => {
    expect(graph.nodes.has('sqlserver')).toBe(false);
    expect(graph.nodes.has('aspire-dashboard')).toBe(false);
  });

  it('finds sync, async, and data edges', () => {
    expect(edge('gateway', 'calls', 'quote-api')?.observed).toBe(1);
    expect(edge('quote-api', 'calls', 'rating-engine')?.protocol).toBe('http');
    expect(edge('quote-api', 'publishes', 'quote-bound')).toBeDefined();
    expect(edge('policy-worker', 'consumes', 'quote-bound')).toBeDefined();
    expect(edge('quote-api', 'stores', 'quote-db')?.observed).toBe(2);
    expect(edge('policy-worker', 'calls', 'policy-admin')).toBeDefined();
    expect(edge('apim', 'calls', 'gateway')?.sources).toEqual(['manual']);
    expect(atlas.edges.filter((e) => e.kind === 'depends')).toEqual([]);
  });

  it('builds flows from traces', () => {
    expect(atlas.flows.map((f) => f.id)).toEqual(['post-v1-quotes', 'post-v1-quotes-bind']);
    const bind = graph.findFlow('bind')!;
    expect(bind.steps.map((s) => `${s.from}>${s.to}`)).toEqual([
      'quote-api>quote-db', 'quote-api>quote-bound', 'quote-bound>policy-worker', 'policy-worker>policy-admin', 'policy-worker>policy-db',
    ]);
  });

  it('computes impact and paths across async hops', () => {
    expect(graph.impact('quote-bound').map((h) => h.node.id).sort()).toEqual(['apim', 'gateway', 'policy-worker', 'quote-api']);
    expect(graph.path('apim', 'policy-db')!.map((e) => `${e.from}-${e.kind}-${e.to}`)).toEqual([
      'apim-calls-gateway', 'gateway-calls-quote-api', 'quote-api-publishes-quote-bound',
      'policy-worker-consumes-quote-bound', 'policy-worker-stores-policy-db',
    ]);
    expect(graph.path('policy-db', 'apim')).toBeUndefined();
  });

  it('resolves names and reports ambiguity', () => {
    expect(graph.resolve('Contoso.Quote.Api').node?.id).toBe('quote-api');
    expect(graph.resolve('rating').node?.id).toBe('rating-engine');
    expect(graph.resolve('quote').candidates.map((c) => c.id)).toEqual(['quote-api', 'quote-bound', 'quote-db']);
  });

  it('matches the committed atlas (no drift)', () => {
    const committed = readAtlas(EXAMPLE)!;
    expect(hasDrift(diffAtlas(committed, atlas))).toBe(false);
  });

  it('detects drift', () => {
    const changed = structuredClone(atlas);
    changed.nodes = changed.nodes.filter((n) => n.id !== 'redis');
    changed.edges = changed.edges.filter((e) => e.to !== 'redis');
    changed.nodes.find((n) => n.id === 'quote-api')!.tech!.push('Kafka');
    const d = diffAtlas(atlas, changed);
    expect(d.removedNodes).toEqual(['redis']);
    expect(d.removedEdges).toHaveLength(2);
    expect(d.changedNodes).toEqual([{ id: 'quote-api', changes: ['tech +Kafka'] }]);
  });
});
