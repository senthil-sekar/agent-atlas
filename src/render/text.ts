/** Compact, token-aware text views shared by the CLI and the MCP server. */
import type { AtlasGraph, Hop } from '../graph.js';
import type { AtlasEdge, AtlasNode, Flow } from '../model.js';
import { estimateTokens } from '../util.js';
import { topologyDiagram } from './mermaid.js';

const verb: Record<AtlasEdge['kind'], [string, string]> = {
  calls: ['calls', 'called by'],
  publishes: ['publishes to', 'published to by'],
  consumes: ['consumes from', 'consumed by'],
  stores: ['stores data in', 'stores data for'],
  depends: ['depends on', 'depended on by'],
};

export function nodeLine(n: AtlasNode): string {
  const tech = n.tech?.length ? ` — ${n.tech.join(', ')}` : '';
  return `${n.id} [${n.kind}]${tech}`;
}

function edgeText(e: AtlasEdge, dir: 'out' | 'in'): string {
  const extra = [e.protocol, e.observed ? `seen ${e.observed}x` : ''].filter(Boolean).join(', ');
  const other = dir === 'out' ? e.to : e.from;
  return `${verb[e.kind][dir === 'out' ? 0 : 1]} ${other}${extra ? ` (${extra})` : ''}`;
}

export function hopList(hops: Hop[]): string {
  if (!hops.length) return '(none)';
  return hops
    .map((h) => `${'  '.repeat(h.depth - 1)}- ${nodeLine(h.node)}  (${h.edge.from} ${verb[h.edge.kind][0]} ${h.edge.to})`)
    .join('\n');
}

export function describeNode(graph: AtlasGraph, n: AtlasNode): string {
  const lines = [`## ${n.id}`, `Kind: ${n.kind}`];
  if (n.name && n.name !== n.id) lines.push(`Name: ${n.name}`);
  if (n.description) lines.push(`Description: ${n.description}`);
  if (n.owner) lines.push(`Owner: ${n.owner}`);
  if (n.tech?.length) lines.push(`Tech: ${n.tech.join(', ')}`);
  if (n.hosting) lines.push(`Hosting: ${n.hosting}`);
  if (n.repoPath) lines.push(`Code: ${n.repoPath}`);
  lines.push(`Found by: ${n.sources.join(', ')}`);
  const out = graph.outgoing(n.id), inc = graph.incoming(n.id);
  lines.push('', 'Depends on:', ...(out.length ? out.map((e) => `- ${edgeText(e, 'out')}`) : ['- (nothing)']));
  lines.push('', 'Used by:', ...(inc.length ? inc.map((e) => `- ${edgeText(e, 'in')}`) : ['- (nothing)']));
  if (n.endpoints?.length) {
    lines.push('', 'Endpoints:', ...n.endpoints.map((e) => `- ${e.method} ${e.path}${e.summary ? ` — ${e.summary}` : ''}`));
  }
  const flows = graph.flowsFor(n.id);
  if (flows.length) lines.push('', 'Flows:', ...flows.map((f) => `- ${f.id}: ${f.name}`));
  return lines.join('\n');
}

export function describeFlow(f: Flow): string {
  return [`## Flow: ${f.name} (${f.id})`, ...(f.description ? [f.description] : []),
    ...f.steps.map((s, i) => `${i + 1}. ${s.from} → ${s.to}: ${s.action}`)].join('\n');
}

export function describePath(path: AtlasEdge[]): string {
  if (!path.length) return '(same node)';
  return path.map((e, i) => {
    const [a, b] = e.kind === 'consumes' ? [e.to, e.from] : [e.from, e.to];
    const how = e.kind === 'consumes' ? 'delivers to' : verb[e.kind][0];
    return `${i + 1}. ${a} ${how} ${b}${e.protocol ? ` (${e.protocol})` : ''}`;
  }).join('\n');
}

export function describeImpact(graph: AtlasGraph, n: AtlasNode, hops: Hop[]): string {
  if (!hops.length) return `Nothing in the atlas depends on ${n.id}.`;
  const byDepth = new Map<number, Hop[]>();
  hops.forEach((h) => byDepth.set(h.depth, [...(byDepth.get(h.depth) ?? []), h]));
  const lines = [`Changing ${n.id} can affect ${hops.length} node(s):`];
  for (const [depth, list] of byDepth) {
    lines.push(depth === 1 ? 'Direct dependents:' : `${depth} hops away:`);
    list.forEach((h) => lines.push(`- ${h.node.id} [${h.node.kind}] (${h.edge.from} ${verb[h.edge.kind][0]} ${h.edge.to})`));
  }
  const flows = graph.flowsFor(n.id);
  if (flows.length) lines.push(`Flows that pass through ${n.id}: ${flows.map((f) => f.id).join(', ')}`);
  return lines.join('\n');
}

export type SummaryLevel = 'brief' | 'standard' | 'full';

export function summary(graph: AtlasGraph, level: SummaryLevel = 'standard', maxTokens?: number): string {
  const { atlas } = graph;
  const count = (k: (n: AtlasNode) => boolean) => atlas.nodes.filter(k).length;
  const lines = [
    `# ${atlas.system.name}`,
    ...(atlas.system.description ? [atlas.system.description] : []),
    `${atlas.nodes.length} nodes (${count((n) => ['service', 'function', 'gateway', 'frontend'].includes(n.kind))} compute, ` +
      `${count((n) => ['database', 'cache', 'storage', 'search'].includes(n.kind))} data, ` +
      `${count((n) => ['queue', 'topic', 'stream'].includes(n.kind))} messaging, ${count((n) => n.kind === 'external')} external), ` +
      `${atlas.edges.length} edges, ${atlas.flows.length} flows.`,
    '',
  ];
  for (const n of atlas.nodes) {
    if (level === 'brief') { lines.push(`- ${nodeLine(n)}`); continue; }
    lines.push(`- ${nodeLine(n)}${n.description ? `: ${n.description}` : ''}`);
    const out = graph.outgoing(n.id);
    if (out.length) lines.push(`  - ${out.map((e) => edgeText(e, 'out')).join('; ')}`);
    if (level === 'full' && n.endpoints?.length) lines.push(`  - endpoints: ${n.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  }
  if (level !== 'brief' && atlas.flows.length) {
    lines.push('', 'Flows:');
    for (const f of atlas.flows) {
      lines.push(level === 'full' ? describeFlow(f) : `- ${f.id}: ${f.steps.map((s) => s.to).join(' → ')}`);
    }
  }
  if (level === 'full') lines.push('', '```mermaid', topologyDiagram(graph), '```');

  let text = lines.join('\n');
  if (maxTokens && estimateTokens(text) > maxTokens) {
    const budget = maxTokens * 4 - 120;
    text = `${text.slice(0, Math.max(0, budget))}\n…\n[Truncated to about ${maxTokens} tokens. Use get_service or a lower level for detail.]`;
  }
  return text;
}
