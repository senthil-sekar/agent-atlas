import type { Atlas, AtlasEdge, AtlasNode, Flow } from './model.js';

export interface Hop { node: AtlasNode; edge: AtlasEdge; depth: number }

/** Read-only queries over an atlas. Used by the CLI and the MCP server. */
export class AtlasGraph {
  readonly nodes: Map<string, AtlasNode>;
  private readonly out = new Map<string, AtlasEdge[]>();
  private readonly in = new Map<string, AtlasEdge[]>();

  constructor(readonly atlas: Atlas) {
    this.nodes = new Map(atlas.nodes.map((n) => [n.id, n]));
    for (const e of atlas.edges) {
      (this.out.get(e.from) ?? this.out.set(e.from, []).get(e.from)!).push(e);
      (this.in.get(e.to) ?? this.in.set(e.to, []).get(e.to)!).push(e);
    }
  }

  /** Find a node by id, name, or unique partial match. */
  resolve(query: string): { node?: AtlasNode; candidates: AtlasNode[] } {
    const q = query.trim().toLowerCase();
    const exact = this.nodes.get(q) ?? this.atlas.nodes.find((n) => n.name?.toLowerCase() === q);
    if (exact) return { node: exact, candidates: [] };
    const partial = this.atlas.nodes.filter((n) => n.id.includes(q) || n.name?.toLowerCase().includes(q));
    return partial.length === 1 ? { node: partial[0], candidates: [] } : { candidates: partial };
  }

  outgoing(id: string): AtlasEdge[] { return this.out.get(id) ?? []; }
  incoming(id: string): AtlasEdge[] { return this.in.get(id) ?? []; }

  /** Breadth-first walk. `direction: "out"` = what id depends on; `"in"` = what depends on id. */
  walk(id: string, direction: 'out' | 'in', maxDepth: number): Hop[] {
    const seen = new Set([id]);
    const hops: Hop[] = [];
    let frontier = [id];
    for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const edges = direction === 'out' ? this.outgoing(cur) : this.incoming(cur);
        for (const edge of edges) {
          const other = direction === 'out' ? edge.to : edge.from;
          if (seen.has(other)) continue;
          seen.add(other);
          next.push(other);
          hops.push({ node: this.nodes.get(other)!, edge, depth });
        }
      }
      frontier = next;
    }
    return hops;
  }

  dependencies(id: string, depth = 1) { return this.walk(id, 'out', depth); }
  callers(id: string, depth = 1) { return this.walk(id, 'in', depth); }

  /** Everything that could break if `id` changes: transitive dependents. */
  impact(id: string, maxDepth = 5) { return this.walk(id, 'in', maxDepth); }

  /**
   * Shortest dependency path from `from` to `to`. Messaging edges are followed in the direction
   * data moves (publisher → topic → consumer), so paths cross async hops.
   */
  path(from: string, to: string): AtlasEdge[] | undefined {
    const moves = (id: string): Array<[string, AtlasEdge]> => [
      ...this.outgoing(id).filter((e) => e.kind !== 'consumes').map((e): [string, AtlasEdge] => [e.to, e]),
      ...this.incoming(id).filter((e) => e.kind === 'consumes').map((e): [string, AtlasEdge] => [e.from, e]),
    ];
    const prev = new Map<string, [string, AtlasEdge]>();
    const queue = [from];
    const seen = new Set([from]);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === to) break;
      for (const [next, edge] of moves(cur)) {
        if (seen.has(next)) continue;
        seen.add(next);
        prev.set(next, [cur, edge]);
        queue.push(next);
      }
    }
    if (!seen.has(to) || from === to) return from === to ? [] : undefined;
    const path: AtlasEdge[] = [];
    for (let cur = to; cur !== from; cur = prev.get(cur)![0]) path.unshift(prev.get(cur)![1]);
    return path;
  }

  flowsFor(id: string): Flow[] {
    return this.atlas.flows.filter((f) => f.steps.some((s) => s.from === id || s.to === id));
  }

  findFlow(query: string): Flow | undefined {
    const q = query.toLowerCase();
    return this.atlas.flows.find((f) => f.id === q) ?? this.atlas.flows.find((f) => f.name.toLowerCase().includes(q) || f.id.includes(q));
  }

  search(query: string): AtlasNode[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const score = (n: AtlasNode) => {
      const hay = [n.id, n.name, n.description, n.kind, n.owner, n.hosting, ...(n.tech ?? []), ...(n.tags ?? []),
        ...(n.endpoints ?? []).map((e) => `${e.method} ${e.path} ${e.summary ?? ''}`)].join(' ').toLowerCase();
      return terms.filter((t) => hay.includes(t)).length;
    };
    return this.atlas.nodes.map((n) => [n, score(n)] as const).filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1] || a[0].id.localeCompare(b[0].id)).map(([n]) => n);
  }
}
