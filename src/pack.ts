/** The smallest map an agent needs before touching one node, trimmed to a token budget. */
import type { AtlasGraph } from './graph.js';
import { describeFlow, describeNode, hopList } from './render/text.js';
import { estimateTokens } from './util.js';

export interface PackOptions {
  /** Hop depth for the transitive dependency/impact sections beyond describeNode's direct edges. */
  depth?: number;
  maxTokens?: number;
}

export class UnknownNodeError extends Error {}

/**
 * `describeNode` (id, tech, direct dependencies and callers, endpoints, flow ids) is never dropped.
 * Everything past it is ordered least to most important, and trimmed from the front when the
 * result would exceed maxTokens: full flow detail goes first, then transitive dependencies, then
 * transitive impact — the section most likely to change what an agent does survives longest.
 */
export function pack(graph: AtlasGraph, id: string, opts: PackOptions = {}): string {
  const node = graph.nodes.get(id);
  if (!node) throw new UnknownNodeError(`No node "${id}" in the atlas.`);
  const depth = opts.depth ?? 2;

  const essential = describeNode(graph, node);

  const optional: string[] = [];
  const flows = graph.flowsFor(id);
  if (flows.length) optional.push(['Flow detail:', ...flows.map((f) => describeFlow(f))].join('\n\n'));

  const deeperDeps = graph.dependencies(id, depth).filter((h) => h.depth > 1);
  if (deeperDeps.length) optional.push([`Transitive dependencies (up to depth ${depth}):`, hopList(deeperDeps)].join('\n'));

  const deeperCallers = graph.callers(id, depth).filter((h) => h.depth > 1);
  if (deeperCallers.length) optional.push([`Transitive impact (up to depth ${depth}):`, hopList(deeperCallers)].join('\n'));

  let included = optional;
  let text = [essential, ...included].join('\n\n');
  if (!opts.maxTokens) return text;

  while (included.length && estimateTokens(text) > opts.maxTokens) {
    included = included.slice(1); // drop the least important remaining section
    text = [essential, ...included].join('\n\n');
  }
  if (estimateTokens(text) > opts.maxTokens) {
    const budget = opts.maxTokens * 4 - 60;
    text = `${text.slice(0, Math.max(0, budget))}\n…\n[Truncated to about ${opts.maxTokens} tokens. Use get_service for the full node.]`;
  }
  return text;
}
