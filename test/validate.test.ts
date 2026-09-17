import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { AtlasGraph } from '../src/graph.js';
import {
  describeValidation, extractMermaidBlocks, parseDesignFragment, parseMermaidFlowchart,
  parseProposedDesign, validateDesign,
} from '../src/validate.js';
import { EXAMPLE } from './helpers.js';

const graph = new AtlasGraph(buildAtlas(EXAMPLE).atlas);

describe('Mermaid flowchart parsing', () => {
  it('reads AgentAtlas\'s own shape and arrow dialect', () => {
    const text = `flowchart LR
  n_apim{{"apim<br/><small>Azure API Management</small>"}}
  n_gateway["gateway<br/><small>ASP.NET Core</small>"]
  n_redis[("redis<br/><small>Redis</small>")]
  n_apim -->|calls https| n_gateway
  n_gateway -. publishes .-> n_redis`;
    const design = parseMermaidFlowchart(text);
    expect(design.nodes.find((n) => n.id === 'n_apim')?.label).toBe('apim');
    expect(design.nodes.find((n) => n.id === 'n_redis')?.label).toBe('redis');
    expect(design.edges).toEqual(expect.arrayContaining([
      { from: 'n_apim', to: 'n_gateway', label: 'calls https' },
      { from: 'n_gateway', to: 'n_redis', label: 'publishes' },
    ]));
  });

  it('reads Draftsman\'s simple template dialect', () => {
    const text = `flowchart LR
  user([Actor]) --> sys[System]
  sys --> ext[(External system)]`;
    const design = parseMermaidFlowchart(text);
    expect(design.nodes.map((n) => n.id).sort()).toEqual(['ext', 'sys', 'user']);
    expect(design.edges).toEqual([{ from: 'user', to: 'sys', label: undefined }, { from: 'sys', to: 'ext', label: undefined }]);
  });

  it('extracts only fenced flowchart blocks, ignoring sequence diagrams', () => {
    const markdown = `# Design
\`\`\`mermaid
flowchart LR
  a --> b
\`\`\`
\`\`\`mermaid
sequenceDiagram
  participant A
  A->>B: hello
\`\`\`
`;
    const blocks = extractMermaidBlocks(markdown);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('flowchart');
  });

  it('falls back to a structured fragment when there is no flowchart', () => {
    const design = parseProposedDesign('nodes:\n  - { id: new-svc, kind: service }\nedges:\n  - { from: new-svc, to: quote-db }\n');
    expect(design.nodes).toEqual([{ id: 'new-svc', label: 'new-svc', kind: 'service', owner: undefined }]);
    expect(design.edges).toEqual([{ from: 'new-svc', to: 'quote-db', kind: 'calls' }]);
  });

  it('parses a structured fragment directly', () => {
    const design = parseDesignFragment('nodes:\n  - { id: x, name: X }\nedges: []\n');
    expect(design.nodes).toEqual([{ id: 'x', label: 'X', kind: undefined, owner: undefined }]);
  });
});

describe('validateDesign', () => {
  it('reports no issues for a design that only adds genuinely new nodes', () => {
    const design = parseMermaidFlowchart('flowchart LR\n  new_a[new-analytics] --> new_b[new-analytics-db]');
    const findings = validateDesign(graph, design);
    expect(findings).toEqual([]);
    expect(describeValidation(findings)).toContain('No issues found');
  });

  it('recognizes an existing node via its AgentAtlas-style label, not the diagram id', () => {
    const design = parseMermaidFlowchart('flowchart LR\n  n_quote_api["quote-api<br/><small>ASP.NET Core</small>"] --> n_redis["redis"]');
    const findings = validateDesign(graph, design);
    expect(findings.some((f) => f.message.includes('"quote-api" matches the existing service'))).toBe(true);
    expect(findings.some((f) => f.message.includes('"redis" matches the existing cache'))).toBe(true);
  });

  it('flags an edge to an unknown node', () => {
    const design = { nodes: [{ id: 'new-svc', label: 'new-svc' }], edges: [{ from: 'new-svc', to: 'totally-unknown-thing' }] };
    const findings = validateDesign(graph, design);
    expect(findings.some((f) => f.level === 'warning' && f.message.includes('totally-unknown-thing'))).toBe(true);
  });

  it('flags a kind mismatch as a likely accidental id reuse', () => {
    const design = { nodes: [{ id: 'quote-api', label: 'quote-api', kind: 'database' }], edges: [] };
    const findings = validateDesign(graph, design);
    expect(findings.some((f) => f.level === 'warning' && f.message.includes('accidental id reuse'))).toBe(true);
  });

  it('flags an edge crossing from one owner to another', () => {
    const design = { nodes: [], edges: [{ from: 'quote-api', to: 'policy-worker' }] }; // owned by different teams in the example
    const findings = validateDesign(graph, design);
    expect(findings.some((f) => f.message.includes('make sure') && f.message.includes('looped in'))).toBe(true);
  });

  it('detects a cycle the design would introduce', () => {
    // quote-api already calls rating-engine; proposing the reverse closes a loop.
    const design = { nodes: [], edges: [{ from: 'rating-engine', to: 'quote-api', kind: 'calls' }] };
    const findings = validateDesign(graph, design);
    expect(findings.some((f) => f.level === 'warning' && f.message.includes('dependency cycle'))).toBe(true);
  });
});
