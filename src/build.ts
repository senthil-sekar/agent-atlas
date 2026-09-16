import { resolve } from 'node:path';
import { type AtlasConfig, type ScannerName, loadConfig } from './config.js';
import {
  type Atlas, type AtlasEdge, type AtlasNode, type Flow, type ScanResult, type Source,
  COMPUTE_KINDS, SOURCES, normalizeId,
} from './model.js';
import { scanBicep } from './scanners/bicep.js';
import { scanCompose } from './scanners/compose.js';
import { scanDotnet } from './scanners/dotnet.js';
import { scanNode } from './scanners/node.js';
import { scanOpenApi } from './scanners/openapi.js';
import { scanOtel } from './scanners/otel.js';
import type { Scanner } from './scanners/types.js';
import { DEFAULT_EXCLUDES, uniq, walk } from './util.js';

/** Order matters: code scanners run first so later scanners can attach to their nodes. */
const SCANNERS: Array<[ScannerName, Scanner]> = [
  ['dotnet', scanDotnet],
  ['node', scanNode],
  ['compose', scanCompose],
  ['openapi', scanOpenApi],
  ['bicep', scanBicep],
  ['otel', scanOtel],
];

/** Lower rank wins when sources disagree on a single-valued field. */
const RANK: Record<Source, number> = Object.fromEntries(SOURCES.map((s, i) => [s, i])) as Record<Source, number>;
const rankOf = (n: AtlasNode) => Math.min(...n.sources.map((s) => RANK[s]));

export interface BuildResult {
  atlas: Atlas;
  warnings: string[];
  stats: Record<string, { nodes: number; edges: number; flows: number }>;
}

export function buildAtlas(dir: string, config: AtlasConfig = loadConfig(dir)): BuildResult {
  const root = resolve(dir);
  const files = walk(root, [...DEFAULT_EXCLUDES, ...config.scan.exclude]);
  const warnings: string[] = [];
  const stats: BuildResult['stats'] = {};
  const raw: ScanResult = { nodes: [], edges: [], flows: [], aliases: [] };

  for (const [name, scanner] of SCANNERS) {
    if (!config.scan.scanners.includes(name)) continue;
    const codeNodes = raw.nodes.filter((n) => COMPUTE_KINDS.has(n.kind) && n.repoPath !== undefined);
    const r = scanner({ root, files, config, codeNodes });
    stats[name] = { nodes: r.nodes.length, edges: r.edges.length, flows: r.flows.length };
    raw.nodes.push(...r.nodes);
    raw.edges.push(...r.edges);
    raw.flows.push(...r.flows);
    raw.aliases!.push(...(r.aliases ?? []));
    warnings.push(...(r.warnings ?? []));
  }

  return { atlas: assemble(config, raw, warnings), warnings, stats };
}

/** Canonicalize ids, merge duplicates, apply the manual overlay, and sort. */
export function assemble(config: AtlasConfig, raw: ScanResult, warnings: string[] = []): Atlas {
  const strip = (id: string) => {
    for (const p of config.scan.stripPrefixes) {
      const prefix = normalizeId(p);
      if (id.startsWith(`${prefix}-`) && id.length > prefix.length + 1) return id.slice(prefix.length + 1);
    }
    return id;
  };
  const aliases = new Map<string, string>();
  for (const [from, to] of raw.aliases ?? []) aliases.set(strip(normalizeId(from)), strip(normalizeId(to)));
  for (const [from, to] of Object.entries(config.aliases)) aliases.set(normalizeId(from), normalizeId(to));
  const canon = (id: string) => {
    let cur = strip(normalizeId(id));
    for (let i = 0; i < 10 && aliases.has(cur); i++) cur = aliases.get(cur)!;
    return cur;
  };
  const ignored = new Set(config.ignore.map(canon));

  // Nodes
  const nodes = new Map<string, AtlasNode>();
  const mergeNode = (incoming: AtlasNode) => {
    const n = { ...incoming, id: canon(incoming.id) };
    if (ignored.has(n.id)) return;
    const cur = nodes.get(n.id);
    if (!cur) { nodes.set(n.id, { ...n, sources: [...n.sources] }); return; }
    const incomingWins = rankOf(n) < rankOf(cur);
    const pick = <K extends keyof AtlasNode>(k: K) => (incomingWins ? n[k] ?? cur[k] : cur[k] ?? n[k]);
    const kind = cur.kind === 'external' ? n.kind : n.kind === 'external' ? cur.kind
      : incomingWins ? n.kind : cur.kind;
    const endpoints = [...(cur.endpoints ?? []), ...(n.endpoints ?? [])];
    const merged: AtlasNode = {
      id: n.id,
      kind,
      name: pick('name'),
      description: pick('description'),
      owner: pick('owner'),
      tech: uniq([...(cur.tech ?? []), ...(n.tech ?? [])]),
      hosting: pick('hosting'),
      repoPath: pick('repoPath'),
      endpoints: [...new Map(endpoints.map((e) => [`${e.method} ${e.path}`, e])).values()],
      tags: uniq([...(cur.tags ?? []), ...(n.tags ?? [])]),
      sources: uniq([...cur.sources, ...n.sources]),
    };
    nodes.set(n.id, merged);
  };
  raw.nodes.forEach(mergeNode);
  for (const m of config.nodes) {
    mergeNode({ ...m, kind: m.kind ?? nodes.get(canon(m.id))?.kind ?? 'service', sources: ['manual'] });
  }

  // Edges
  const edges = new Map<string, AtlasEdge>();
  const addEdge = (incoming: AtlasEdge) => {
    const e = { ...incoming, from: canon(incoming.from), to: canon(incoming.to) };
    if (e.from === e.to || ignored.has(e.from) || ignored.has(e.to)) return;
    for (const end of [e.from, e.to]) {
      if (!nodes.has(end)) nodes.set(end, { id: end, kind: 'external', description: 'Referenced but not found by any scanner.', sources: [...e.sources] });
    }
    const key = `${e.from}|${e.to}|${e.kind}`;
    const cur = edges.get(key);
    if (!cur) { edges.set(key, { ...e, sources: [...e.sources] }); return; }
    edges.set(key, {
      ...cur,
      protocol: cur.protocol ?? e.protocol,
      description: e.sources.includes('manual') ? e.description ?? cur.description : cur.description ?? e.description,
      observed: cur.observed !== undefined || e.observed !== undefined ? (cur.observed ?? 0) + (e.observed ?? 0) : undefined,
      sources: uniq([...cur.sources, ...e.sources]),
    });
  };
  raw.edges.forEach(addEdge);
  config.edges.forEach((e) => addEdge({ ...e, sources: ['manual'] }));

  // A generic "depends" edge is redundant when a more specific edge exists between the same pair.
  for (const [key, e] of edges) {
    if (e.kind !== 'depends') continue;
    const specific = [...edges.values()].find((o) => o !== e && o.from === e.from && o.to === e.to);
    if (specific) {
      specific.sources = uniq([...specific.sources, ...e.sources]);
      edges.delete(key);
    }
  }

  // Flows
  const flows = new Map<string, Flow>();
  const addFlow = (f: Flow) => {
    const steps = f.steps.map((s) => ({ ...s, from: canon(s.from), to: canon(s.to) }))
      .filter((s) => !ignored.has(s.from) && !ignored.has(s.to));
    if (steps.length) flows.set(f.id, { ...f, steps });
  };
  raw.flows.forEach(addFlow);
  config.flows.forEach((f) => addFlow({ ...f, sources: ['manual'] }));
  for (const f of flows.values()) {
    for (const s of f.steps) for (const end of [s.from, s.to]) {
      if (!nodes.has(end)) warnings.push(`flow ${f.id}: unknown node "${end}"`);
    }
  }

  const clean = (n: AtlasNode): AtlasNode => {
    const out: any = {};
    for (const [k, v] of Object.entries(n)) {
      if (v === undefined || (Array.isArray(v) && v.length === 0 && k !== 'sources')) continue;
      out[k] = v;
    }
    return out;
  };
  const EDGE_ORDER: Array<keyof AtlasEdge> = ['from', 'to', 'kind', 'protocol', 'description', 'observed', 'sources'];
  const cleanEdge = (e: AtlasEdge): AtlasEdge =>
    Object.fromEntries(EDGE_ORDER.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])) as unknown as AtlasEdge;

  return {
    version: 1,
    system: config.system,
    nodes: [...nodes.values()].map(clean).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].map(cleanEdge).sort((a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind)),
    flows: [...flows.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
