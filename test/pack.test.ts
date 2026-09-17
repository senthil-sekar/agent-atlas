import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { AtlasGraph } from '../src/graph.js';
import { pack, UnknownNodeError } from '../src/pack.js';
import { EXAMPLE } from './helpers.js';

const { atlas } = buildAtlas(EXAMPLE);
const graph = new AtlasGraph(atlas);

describe('pack', () => {
  it('always includes the essential node detail', () => {
    const text = pack(graph, 'quote-api');
    expect(text).toContain('## quote-api');
    expect(text).toContain('Depends on:');
    expect(text).toContain('Used by:');
    expect(text).toContain('Endpoints:');
  });

  it('adds transitive impact, dependencies, and flow detail beyond the direct hop', () => {
    const text = pack(graph, 'quote-bound', { depth: 3 });
    expect(text).toContain('Transitive impact (up to depth 3):');
    expect(text).toContain('Flow detail:');
    expect(text).toContain('## Flow:');
  });

  it('drops the least important sections first under a token budget, never the essential one', () => {
    const full = pack(graph, 'quote-api');
    const tight = pack(graph, 'quote-api', { maxTokens: 60 });
    expect(tight.length).toBeLessThan(full.length);
    expect(tight).toContain('## quote-api');
    expect(tight).not.toContain('Flow detail:');
  });

  it('throws a typed error for an unknown node', () => {
    expect(() => pack(graph, 'nope')).toThrow(UnknownNodeError);
  });
});
