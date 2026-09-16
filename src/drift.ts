import type { Atlas, AtlasEdge, AtlasNode } from './model.js';

export interface Drift {
  addedNodes: string[];
  removedNodes: string[];
  changedNodes: Array<{ id: string; changes: string[] }>;
  addedEdges: string[];
  removedEdges: string[];
}

const edgeKey = (e: AtlasEdge) => `${e.from} -${e.kind}-> ${e.to}`;

function nodeChanges(a: AtlasNode, b: AtlasNode): string[] {
  const changes: string[] = [];
  if (a.kind !== b.kind) changes.push(`kind ${a.kind} → ${b.kind}`);
  const at = new Set(a.tech ?? []), bt = new Set(b.tech ?? []);
  const added = [...bt].filter((t) => !at.has(t)), removed = [...at].filter((t) => !bt.has(t));
  if (added.length) changes.push(`tech +${added.join(', +')}`);
  if (removed.length) changes.push(`tech -${removed.join(', -')}`);
  const ae = new Set((a.endpoints ?? []).map((e) => `${e.method} ${e.path}`));
  const be = new Set((b.endpoints ?? []).map((e) => `${e.method} ${e.path}`));
  const addedE = [...be].filter((e) => !ae.has(e)), removedE = [...ae].filter((e) => !be.has(e));
  if (addedE.length) changes.push(`endpoints +${addedE.join(', +')}`);
  if (removedE.length) changes.push(`endpoints -${removedE.join(', -')}`);
  return changes;
}

/** Compare the committed atlas (`before`) with a fresh scan (`after`). Trace counts are ignored. */
export function diffAtlas(before: Atlas, after: Atlas): Drift {
  const bn = new Map(before.nodes.map((n) => [n.id, n]));
  const an = new Map(after.nodes.map((n) => [n.id, n]));
  const be = new Set(before.edges.map(edgeKey));
  const ae = new Set(after.edges.map(edgeKey));
  return {
    addedNodes: [...an.keys()].filter((k) => !bn.has(k)),
    removedNodes: [...bn.keys()].filter((k) => !an.has(k)),
    changedNodes: [...an.values()].filter((n) => bn.has(n.id))
      .map((n) => ({ id: n.id, changes: nodeChanges(bn.get(n.id)!, n) }))
      .filter((c) => c.changes.length),
    addedEdges: [...ae].filter((k) => !be.has(k)),
    removedEdges: [...be].filter((k) => !ae.has(k)),
  };
}

export const hasDrift = (d: Drift) =>
  d.addedNodes.length + d.removedNodes.length + d.changedNodes.length + d.addedEdges.length + d.removedEdges.length > 0;

export function describeDrift(d: Drift): string {
  if (!hasDrift(d)) return 'No drift: the committed atlas matches the code.';
  const lines = ['Drift detected between .agentatlas/atlas.yaml and the current code:'];
  const section = (title: string, items: string[]) => { if (items.length) lines.push(`${title}:`, ...items.map((i) => `  ${i}`)); };
  section('Nodes added', d.addedNodes.map((i) => `+ ${i}`));
  section('Nodes removed', d.removedNodes.map((i) => `- ${i}`));
  section('Nodes changed', d.changedNodes.map((c) => `~ ${c.id}: ${c.changes.join('; ')}`));
  section('Edges added', d.addedEdges.map((i) => `+ ${i}`));
  section('Edges removed', d.removedEdges.map((i) => `- ${i}`));
  lines.push('Run `agentatlas scan` and commit the result if these changes are intended.');
  return lines.join('\n');
}
