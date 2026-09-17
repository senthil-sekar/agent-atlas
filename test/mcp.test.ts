import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp.js';
import { EXAMPLE } from './helpers.js';

let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
};

beforeAll(async () => {
  const server = createServer(EXAMPLE);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(async () => client?.close());

describe('MCP server', () => {
  it('lists read-only tools and resources', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'find_callers', 'get_dependencies', 'get_service', 'impact_of_change', 'list_flows',
      'pack_context', 'render_diagram', 'search_atlas', 'system_overview', 'trace_flow',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(['atlas://atlas.yaml', 'atlas://system.md']);
  });

  it('answers overview, service, impact, and flow questions', async () => {
    expect((await call('system_overview', { level: 'brief' })).text).toContain('Quote-to-Bind');
    const svc = await call('get_service', { id: 'policy worker' });
    expect(svc.isError).toBe(true);
    expect((await call('get_service', { id: 'policy-worker' })).text).toContain('consumes from quote-bound');
    expect((await call('impact_of_change', { id: 'quote-db' })).text).toContain('Direct dependents:\n- quote-api');
    const path = await call('trace_flow', { from: 'gateway', to: 'policy-admin' });
    expect(path.text).toContain('quote-bound delivers to policy-worker');
    const flow = await call('trace_flow', { flow: 'bind', diagram: true });
    expect(flow.text).toContain('sequenceDiagram');
    expect((await call('search_atlas', { query: 'redis' })).text).toContain('redis [cache]');
    expect((await call('trace_flow', {})).isError).toBe(true);
  });

  it('packs context for one node, trimmed to a token budget', async () => {
    const full = await call('pack_context', { id: 'quote-api' });
    expect(full.text).toContain('## quote-api');
    expect(full.text).toContain('Flow detail:');
    const small = await call('pack_context', { id: 'quote-api', maxTokens: 40 });
    expect(small.text.length).toBeLessThan(full.text.length);
    expect(small.text).toContain('## quote-api'); // the essential section always survives
  });

  it('truncates the overview to a token budget', async () => {
    const full = await call('system_overview', { level: 'full' });
    const small = await call('system_overview', { level: 'full', maxTokens: 100 });
    expect(small.text.length).toBeLessThan(full.text.length);
    expect(small.text).toContain('Truncated');
  });

  it('serves SYSTEM.md as a resource', async () => {
    const r = await client.readResource({ uri: 'atlas://system.md' });
    expect((r.contents[0] as { text: string }).text).toContain('# System map: Quote-to-Bind');
  });
});
