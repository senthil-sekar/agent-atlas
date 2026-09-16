import type { AtlasGraph } from '../graph.js';
import type { Atlas, AtlasEdge, AtlasNode, Flow } from '../model.js';

const mid = (id: string) => `n_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;
const label = (s: string) => s.replace(/"/g, "'");

const FRAMEWORK = /YARP|Ocelot|API Management|Front Door|Application Gateway|Azure Functions|NestJS|Express|Fastify|Koa|Hono|Next\.js|Nuxt|ASP\.NET Core|Worker Service/;
const MANAGED = /^(Azure|Amazon|AWS|Google|Cloud)/;

/** One short label under the node id: hosting or framework for compute, the most specific product for resources. */
export function subtitle(n: AtlasNode): string | undefined {
  const tech = n.tech ?? [];
  if (['service', 'function', 'gateway', 'frontend'].includes(n.kind)) {
    return n.hosting ?? tech.find((t) => FRAMEWORK.test(t)) ?? tech[0];
  }
  return tech.find((t) => MANAGED.test(t)) ?? tech[0];
}

function shape(n: AtlasNode): string {
  const tech = subtitle(n);
  const text = label(tech ? `${n.id}<br/><small>${tech}</small>` : n.id);
  switch (n.kind) {
    case 'database': case 'cache': case 'storage': case 'search': return `${mid(n.id)}[("${text}")]`;
    case 'queue': case 'topic': case 'stream': return `${mid(n.id)}[["${text}"]]`;
    case 'gateway': return `${mid(n.id)}{{"${text}"}}`;
    case 'function': return `${mid(n.id)}(["${text}"])`;
    case 'frontend': return `${mid(n.id)}[/"${text}"/]`;
    case 'external': return `${mid(n.id)}>"${text}"]`;
    default: return `${mid(n.id)}["${text}"]`;
  }
}

function arrow(e: AtlasEdge): string {
  const text = e.protocol && e.kind === 'calls' ? `calls ${e.protocol}` : e.kind;
  switch (e.kind) {
    case 'publishes': case 'consumes': return `-. ${text} .->`;
    case 'depends': return `-.->`;
    default: return `-->|${text}|`;
  }
}

export interface DiagramOptions { focus?: string; depth?: number; direction?: 'LR' | 'TB' }

/** Topology diagram. With `focus`, only nodes within `depth` hops (either direction) are shown. */
export function topologyDiagram(graph: AtlasGraph, opts: DiagramOptions = {}): string {
  const { atlas } = graph;
  let keep: Set<string>;
  if (opts.focus) {
    const depth = opts.depth ?? 1;
    keep = new Set([opts.focus,
      ...graph.walk(opts.focus, 'out', depth).map((h) => h.node.id),
      ...graph.walk(opts.focus, 'in', depth).map((h) => h.node.id)]);
  } else keep = new Set(atlas.nodes.map((n) => n.id));

  const lines = [`flowchart ${opts.direction ?? 'LR'}`];
  const groups: Array<[string, (n: AtlasNode) => boolean]> = [
    ['Services', (n) => ['service', 'function', 'gateway', 'frontend'].includes(n.kind)],
    ['Messaging', (n) => ['queue', 'topic', 'stream'].includes(n.kind)],
    ['Data', (n) => ['database', 'cache', 'storage', 'search'].includes(n.kind)],
  ];
  const nodes = atlas.nodes.filter((n) => keep.has(n.id));
  for (const [title, test] of groups) {
    const members = nodes.filter(test);
    if (!members.length) continue;
    lines.push(`  subgraph ${title.toLowerCase()}["${title}"]`);
    members.forEach((n) => lines.push(`    ${shape(n)}`));
    lines.push('  end');
  }
  nodes.filter((n) => n.kind === 'external').forEach((n) => lines.push(`  ${shape(n)}`));
  for (const e of atlas.edges) {
    if (keep.has(e.from) && keep.has(e.to)) lines.push(`  ${mid(e.from)} ${arrow(e)} ${mid(e.to)}`);
  }
  if (opts.focus && graph.nodes.has(opts.focus)) lines.push(`  style ${mid(opts.focus)} stroke-width:3px`);
  return lines.join('\n');
}

export function flowDiagram(flow: Flow, atlas: Atlas): string {
  const ids = [...new Set(flow.steps.flatMap((s) => [s.from, s.to]))];
  const kindOf = new Map(atlas.nodes.map((n) => [n.id, n.kind]));
  const pid = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '_');
  const lines = ['sequenceDiagram'];
  // Plain participants: typed ones (database, queue) are not parsed by every Mermaid version.
  for (const id of ids) lines.push(`  participant ${pid(id)} as ${id}`);
  for (const s of flow.steps) {
    const async = ['queue', 'topic', 'stream'].includes(kindOf.get(s.to) ?? '') || ['queue', 'topic', 'stream'].includes(kindOf.get(s.from) ?? '');
    lines.push(`  ${pid(s.from)}${async ? '-)' : '->>'}${pid(s.to)}: ${s.action.replace(/[;#]/g, ' ')}`);
  }
  return lines.join('\n');
}
