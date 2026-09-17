import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildAtlas } from './build.js';
import { AtlasGraph } from './graph.js';
import { atlasPath, readAtlas, serializeAtlas } from './io.js';
import { pack } from './pack.js';
import { flowDiagram, topologyDiagram } from './render/mermaid.js';
import { describeValidation, parseProposedDesign, validateDesign } from './validate.js';
import { renderSystemMd } from './render/system-md.js';
import { describeFlow, describeImpact, describeNode, describePath, hopList, summary } from './render/text.js';
import { VERSION } from './version.js';

/** Loads the committed atlas, reloading when the file changes; falls back to an in-memory scan. */
export class AtlasSource {
  private graph?: AtlasGraph;
  private mtime = -1;
  note = '';
  constructor(readonly dir: string) {}

  get(): AtlasGraph {
    let mtime = -2;
    try { mtime = statSync(atlasPath(this.dir)).mtimeMs; } catch { /* no committed atlas */ }
    if (this.graph && mtime === this.mtime) return this.graph;
    const committed = mtime >= 0 ? readAtlas(this.dir) : undefined;
    if (committed) {
      this.graph = new AtlasGraph(committed);
      this.note = '';
    } else {
      this.graph = new AtlasGraph(buildAtlas(this.dir).atlas);
      this.note = '\n\n_Note: no .agentatlas/atlas.yaml found, so this map was scanned on the fly. Run `agentatlas scan` and commit the result._';
    }
    this.mtime = mtime;
    return this.graph;
  }
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const fail = (s: string) => ({ content: [{ type: 'text' as const, text: s }], isError: true });

export function createServer(dir: string): McpServer {
  const source = new AtlasSource(resolve(dir));
  const server = new McpServer(
    { name: 'agentatlas', version: VERSION },
    {
      instructions:
        'AgentAtlas describes how the services in this system connect. Call system_overview first. ' +
        'Once you know which node you are changing, prefer pack_context over get_service — it adds transitive ' +
        'impact and flow detail, trimmed to a token budget. Call impact_of_change before changing a contract, schema, or message.',
    },
  );

  const lookup = (g: AtlasGraph, query: string) => {
    const { node, candidates } = g.resolve(query);
    if (node) return { node };
    const hint = candidates.length
      ? `"${query}" matches several nodes: ${candidates.slice(0, 10).map((c) => c.id).join(', ')}`
      : `No node matches "${query}". Use search_atlas or system_overview to find ids.`;
    return { error: hint };
  };

  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool('system_overview', {
    title: 'System overview',
    description: 'Summarize the whole system: services, data stores, messaging, external systems, and flows. Start here.',
    inputSchema: {
      level: z.enum(['brief', 'standard', 'full']).default('standard').describe('brief = one line per node; full = endpoints, flows, and a Mermaid diagram'),
      maxTokens: z.number().int().positive().optional().describe('Truncate the answer to roughly this many tokens'),
    },
    annotations: readOnly,
  }, async ({ level, maxTokens }) => {
    const g = source.get();
    return text(summary(g, level, maxTokens) + source.note);
  });

  server.registerTool('pack_context', {
    title: 'Pack context',
    description: 'The smallest map you need before changing one node: its direct dependencies and callers, transitive impact and dependencies, and flows through it — trimmed to a token budget. Cheaper than system_overview when you already know which node you are touching.',
    inputSchema: {
      id: z.string().describe('Node id or name, e.g. "quote-api"'),
      depth: z.number().int().min(1).max(6).default(2).describe('How many hops of transitive dependencies and impact to include'),
      maxTokens: z.number().int().positive().optional().describe('Truncate the answer to roughly this many tokens, dropping the least important sections first'),
    },
    annotations: readOnly,
  }, async ({ id, depth, maxTokens }) => {
    const g = source.get();
    const r = lookup(g, id);
    return r.node ? text(pack(g, r.node.id, { depth, maxTokens }) + source.note) : fail(r.error!);
  });

  server.registerTool('get_service', {
    title: 'Get service',
    description: 'Details for one node (service, database, topic, external system): tech, hosting, code location, what it depends on, what uses it, endpoints, and flows.',
    inputSchema: { id: z.string().describe('Node id or name, e.g. "quote-api"') },
    annotations: readOnly,
  }, async ({ id }) => {
    const g = source.get();
    const r = lookup(g, id);
    return r.node ? text(describeNode(g, r.node)) : fail(r.error!);
  });

  server.registerTool('get_dependencies', {
    title: 'Get dependencies',
    description: 'What a node depends on (calls, publishes to, consumes from, stores data in), optionally several hops deep.',
    inputSchema: { id: z.string(), depth: z.number().int().min(1).max(6).default(1) },
    annotations: readOnly,
  }, async ({ id, depth }) => {
    const g = source.get();
    const r = lookup(g, id);
    return r.node ? text(`${r.node.id} depends on:\n${hopList(g.dependencies(r.node.id, depth))}`) : fail(r.error!);
  });

  server.registerTool('find_callers', {
    title: 'Find callers',
    description: 'What depends on a node: callers of a service, publishers and consumers of a topic, users of a database.',
    inputSchema: { id: z.string(), depth: z.number().int().min(1).max(6).default(1) },
    annotations: readOnly,
  }, async ({ id, depth }) => {
    const g = source.get();
    const r = lookup(g, id);
    return r.node ? text(`Used by (${r.node.id}):\n${hopList(g.callers(r.node.id, depth))}`) : fail(r.error!);
  });

  server.registerTool('impact_of_change', {
    title: 'Impact of change',
    description: 'Blast radius: everything that directly or transitively depends on a node, grouped by distance, plus affected flows. Use before changing an API, schema, or message contract.',
    inputSchema: { id: z.string(), maxDepth: z.number().int().min(1).max(10).default(5) },
    annotations: readOnly,
  }, async ({ id, maxDepth }) => {
    const g = source.get();
    const r = lookup(g, id);
    return r.node ? text(describeImpact(g, r.node, g.impact(r.node.id, maxDepth))) : fail(r.error!);
  });

  server.registerTool('trace_flow', {
    title: 'Trace flow',
    description: 'Either show a named flow step by step (pass `flow`), or find how a request or message gets from one node to another (pass `from` and `to`). Async hops through topics are followed.',
    inputSchema: {
      flow: z.string().optional().describe('Flow id or part of its name'),
      from: z.string().optional(),
      to: z.string().optional(),
      diagram: z.boolean().default(false).describe('Include a Mermaid sequence diagram for named flows'),
    },
    annotations: readOnly,
  }, async ({ flow, from, to, diagram }) => {
    const g = source.get();
    if (flow) {
      const f = g.findFlow(flow);
      if (!f) return fail(`No flow matches "${flow}". Known flows: ${g.atlas.flows.map((x) => x.id).join(', ') || '(none)'}`);
      return text(describeFlow(f) + (diagram ? `\n\n\`\`\`mermaid\n${flowDiagram(f, g.atlas)}\n\`\`\`` : ''));
    }
    if (!from || !to) return fail('Pass either `flow`, or both `from` and `to`.');
    const a = lookup(g, from), b = lookup(g, to);
    if (!a.node) return fail(a.error!);
    if (!b.node) return fail(b.error!);
    const path = g.path(a.node.id, b.node.id);
    return path ? text(`Path from ${a.node.id} to ${b.node.id}:\n${describePath(path)}`)
      : text(`No dependency path from ${a.node.id} to ${b.node.id}. Try the reverse direction.`);
  });

  server.registerTool('list_flows', {
    title: 'List flows',
    description: 'List the known end-to-end flows (from traces or the manual config).',
    annotations: readOnly,
  }, async () => {
    const g = source.get();
    return text(g.atlas.flows.length ? g.atlas.flows.map((f) => `- ${f.id}: ${f.name} (${f.steps.length} steps)`).join('\n') : 'No flows recorded.');
  });

  server.registerTool('search_atlas', {
    title: 'Search atlas',
    description: 'Find nodes by keyword across ids, names, descriptions, tech, and endpoints, e.g. "policy", "redis", "POST /quotes".',
    inputSchema: { query: z.string().min(1) },
    annotations: readOnly,
  }, async ({ query }) => {
    const hits = source.get().search(query).slice(0, 20);
    return text(hits.length ? hits.map((n) => `- ${n.id} [${n.kind}]${n.description ? ` — ${n.description}` : ''}`).join('\n') : `Nothing matches "${query}".`);
  });

  server.registerTool('render_diagram', {
    title: 'Render diagram',
    description: 'Mermaid topology diagram of the whole system, or of the neighborhood around one node.',
    inputSchema: { focus: z.string().optional(), depth: z.number().int().min(1).max(4).default(1) },
    annotations: readOnly,
  }, async ({ focus, depth }) => {
    const g = source.get();
    let id: string | undefined;
    if (focus) {
      const r = lookup(g, focus);
      if (!r.node) return fail(r.error!);
      id = r.node.id;
    }
    return text(`\`\`\`mermaid\n${topologyDiagram(g, { focus: id, depth })}\n\`\`\``);
  });

  server.registerTool('validate_design', {
    title: 'Validate design',
    description: 'Check a proposed design against the live system: broken references, an id reused for something different, edges crossing team ownership, and cycles the design would add. Pass a Mermaid flowchart (a design doc\'s container/component view) or a {nodes, edges} fragment.',
    inputSchema: { design: z.string().min(1).describe('A Mermaid flowchart, a Markdown doc containing one, or a YAML/JSON {nodes, edges} fragment') },
    annotations: readOnly,
  }, async ({ design }) => {
    const g = source.get();
    let parsed;
    try { parsed = parseProposedDesign(design); } catch (err) { return fail(`Could not parse the design: ${err instanceof Error ? err.message : String(err)}`); }
    if (!parsed.nodes.length) return fail('No nodes found: pass a Mermaid flowchart (```mermaid fenced or bare) or a {nodes, edges} fragment.');
    return text(describeValidation(validateDesign(g, parsed)));
  });

  server.registerResource('system-map', 'atlas://system.md', {
    title: 'System map (SYSTEM.md)', description: 'Human- and agent-readable system map', mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderSystemMd(source.get()) }] }));

  server.registerResource('atlas-graph', 'atlas://atlas.yaml', {
    title: 'Atlas graph (YAML)', description: 'The full topology graph', mimeType: 'application/yaml',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/yaml', text: serializeAtlas(source.get().atlas) }] }));

  return server;
}

export async function runStdioServer(dir: string): Promise<void> {
  const server = createServer(dir);
  await server.connect(new StdioServerTransport());
  console.error(`agentatlas MCP server ${VERSION} serving ${resolve(dir)}`);
}
