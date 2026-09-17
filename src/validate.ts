/**
 * Checks a proposed design against the live atlas: broken references, an id reused for something
 * different, edges that cross from one team's node to another's, and cycles the proposal would add.
 *
 * Two input shapes are understood:
 * - A Mermaid flowchart — either Draftsman's own "Container / component view" (its design.md
 *   template embeds one), or any other tool's, including AgentAtlas's own `render_diagram` output.
 *   Draftsman produces Markdown design docs with Mermaid diagrams, not a machine schema, so this is
 *   necessarily best-effort text parsing, not a stable contract.
 * - A structured `{ nodes, edges }` fragment, the same shape as `agentatlas.yaml`'s manual overlay,
 *   for any tool that does emit structured output.
 */
import { parse } from 'yaml';
import { z } from 'zod';
import type { AtlasGraph } from './graph.js';
import { EDGE_KINDS, NODE_KINDS } from './model.js';

export interface ProposedNode { id: string; label: string; kind?: string; owner?: string }
export interface ProposedEdge { from: string; to: string; kind?: string; label?: string }
export interface ProposedDesign { nodes: ProposedNode[]; edges: ProposedEdge[] }

// --- Mermaid flowchart parsing ---

/** Matched longest-opening-delimiter first, since `(` is a prefix of `((` and `([`. */
const OPEN_CLOSE: Array<[string, string]> = [
  ['[(', ')]'], ['((', '))'], ['{{', '}}'], ['[/', '/]'], ['([', '])'], ['>', ']'], ['[', ']'], ['(', ')'],
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripLabel = (raw: string) => raw.replace(/^"(.*)"$/, '$1').replace(/<br\s*\/?>.*$/i, '').replace(/<[^>]+>/g, '').trim();

const isFlowchart = (block: string) => /^\s*flowchart\s+(TB|TD|BT|RL|LR)\b/m.test(block);

/** A design doc often has other diagram kinds too (sequence, ER); only flowcharts describe topology. */
export function extractMermaidBlocks(text: string): string[] {
  const fenced = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!).filter(isFlowchart);
  if (fenced.length) return fenced;
  return isFlowchart(text) ? [text] : [];
}

/** Drop a node's inline shape (`user([Actor])` -> `user`) so the edge regex sees a bare id before the arrow. */
function stripInlineShapes(text: string): string {
  return text.replace(/(\w[\w.-]*)(\[\([^)]*\)\]|\(\([^)]*\)\)|\{\{[^}]*\}\}|\[\/[^/]*\/\]|\(\[[^\]]*\]\)|>[^\]\n]*\]|\[[^\[\]\n]*\]|\([^()\n]*\))/g, '$1');
}

export function parseMermaidFlowchart(text: string): ProposedDesign {
  const nodes = new Map<string, string>();
  for (const [open, close] of OPEN_CLOSE) {
    const re = new RegExp(`(\\w[\\w.-]*)${esc(open)}([^\\n]*?)${esc(close)}`, 'g');
    for (const m of text.matchAll(re)) if (!nodes.has(m[1]!)) nodes.set(m[1]!, stripLabel(m[2]!));
  }
  const edges: ProposedEdge[] = [];
  // Covers AgentAtlas's own arrow() output (-->|label|, -. label .->, -.->) and a plain --> .
  const edgeRe = /(\w[\w.-]*)\s+(?:-->\|([^|]*)\|\s*|-\.\s*([^.]*?)\s*\.->\s*|-\.->\s*|-->\s*)(\w[\w.-]*)/g;
  for (const m of stripInlineShapes(text).matchAll(edgeRe)) edges.push({ from: m[1]!, to: m[4]!, label: m[2] ?? m[3] });
  for (const e of edges) {
    if (!nodes.has(e.from)) nodes.set(e.from, e.from);
    if (!nodes.has(e.to)) nodes.set(e.to, e.to);
  }
  return { nodes: [...nodes.entries()].map(([id, label]) => ({ id, label: label || id })), edges };
}

// --- Structured fragment parsing (agentatlas.yaml's node/edge shape) ---

const endpoint = z.object({ method: z.string(), path: z.string(), summary: z.string().optional() });
const message = z.object({ name: z.string(), summary: z.string().optional() });
const fragmentNode = z.object({
  id: z.string().min(1), kind: z.enum(NODE_KINDS).optional(), name: z.string().optional(),
  description: z.string().optional(), owner: z.string().optional(), tech: z.array(z.string()).optional(),
  hosting: z.string().optional(), endpoints: z.array(endpoint).optional(), messages: z.array(message).optional(),
});
const fragmentEdge = z.object({ from: z.string().min(1), to: z.string().min(1), kind: z.enum(EDGE_KINDS).default('calls') });
const designFragmentSchema = z.object({ nodes: z.array(fragmentNode).default([]), edges: z.array(fragmentEdge).default([]) });

export function parseDesignFragment(text: string): ProposedDesign {
  const parsed = designFragmentSchema.parse(parse(text) ?? {});
  return {
    nodes: parsed.nodes.map((n) => ({ id: n.id, label: n.name ?? n.id, kind: n.kind, owner: n.owner })),
    edges: parsed.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
  };
}

export function parseProposedDesign(text: string): ProposedDesign {
  const blocks = extractMermaidBlocks(text);
  if (!blocks.length) return parseDesignFragment(text);
  const merged: ProposedDesign = { nodes: [], edges: [] };
  for (const block of blocks) {
    const d = parseMermaidFlowchart(block);
    merged.nodes.push(...d.nodes.filter((n) => !merged.nodes.some((x) => x.id === n.id)));
    merged.edges.push(...d.edges);
  }
  return merged;
}

// --- Validation against the live atlas ---

export interface ValidationFinding { level: 'info' | 'warning'; message: string }

const CYCLE_KINDS = new Set(['calls', 'depends']);

function findCycle(edges: Array<[string, string]>): string[] | undefined {
  const adj = new Map<string, string[]>();
  for (const [from, to] of edges) adj.set(from, [...(adj.get(from) ?? []), to]);
  const state = new Map<string, 1 | 2>(); // 1 = in progress, 2 = done
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      const s = state.get(next);
      if (s === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!s) { const found = visit(next); if (found) return found; }
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of adj.keys()) if (!state.get(id)) { const found = visit(id); if (found) return found; }
  return undefined;
}

/**
 * A Mermaid-derived id (`n_quote_api`, from AgentAtlas's own `mid()`) rarely matches the atlas's
 * real id directly. AgentAtlas's own diagrams put the real id at the start of the label, so try
 * that first, then the diagram id with the `n_` prefix and underscores undone, then the raw id —
 * each through `graph.resolve()` so a partial or case-different match still lands.
 */
function resolveProposedId(graph: AtlasGraph, node: ProposedNode): string {
  for (const candidate of [node.label, node.id.replace(/^n_/, '').replace(/_/g, '-'), node.id]) {
    const { node: found } = graph.resolve(candidate);
    if (found) return found.id;
  }
  return node.id;
}

export function validateDesign(graph: AtlasGraph, design: ProposedDesign): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const normalized = new Map(design.nodes.map((n) => [n.id, resolveProposedId(graph, n)]));
  const normId = (id: string) => normalized.get(id) ?? graph.resolve(id).node?.id ?? id;
  const proposedIds = new Set(normalized.values());
  const knownId = (id: string) => proposedIds.has(id) || graph.nodes.has(id);

  for (const n of design.nodes) {
    const id = normalized.get(n.id)!;
    const existing = graph.nodes.get(id);
    if (!existing) continue;
    if (n.kind && n.kind !== existing.kind) {
      findings.push({ level: 'warning', message: `"${id}" already exists as a ${existing.kind}, but the design declares it as ${n.kind} — likely an accidental id reuse, not the same thing.` });
    } else {
      findings.push({ level: 'info', message: `"${id}" matches the existing ${existing.kind}${existing.owner ? ` (owned by ${existing.owner})` : ''}.` });
    }
  }

  const edges = design.edges.map((e) => ({ ...e, from: normId(e.from), to: normId(e.to) }));
  for (const e of edges) {
    if (!knownId(e.from)) findings.push({ level: 'warning', message: `Edge references unknown node "${e.from}".` });
    if (!knownId(e.to)) findings.push({ level: 'warning', message: `Edge references unknown node "${e.to}".` });
  }

  for (const e of edges) {
    const from = graph.nodes.get(e.from);
    const to = graph.nodes.get(e.to);
    if (from?.owner && to?.owner && from.owner !== to.owner) {
      findings.push({ level: 'info', message: `"${e.from}" (${from.owner}) would depend on "${e.to}" (${to.owner}) — make sure ${to.owner} is looped in.` });
    }
  }

  const existingEdges: Array<[string, string]> = graph.atlas.edges.filter((e) => CYCLE_KINDS.has(e.kind)).map((e) => [e.from, e.to]);
  const proposedEdges: Array<[string, string]> = edges.filter((e) => !e.kind || CYCLE_KINDS.has(e.kind)).map((e) => [e.from, e.to]);
  const cycle = findCycle([...existingEdges, ...proposedEdges]);
  if (cycle) findings.push({ level: 'warning', message: `This design would introduce a dependency cycle: ${cycle.join(' → ')}.` });

  return findings;
}

export function describeValidation(findings: ValidationFinding[]): string {
  if (!findings.length) return 'No issues found: every reference resolves, no ownership crossings, no new cycles.';
  const warnings = findings.filter((f) => f.level === 'warning');
  const infos = findings.filter((f) => f.level === 'info');
  const lines: string[] = [];
  if (warnings.length) lines.push(`Warnings (${warnings.length}):`, ...warnings.map((f) => `  - ${f.message}`), '');
  if (infos.length) lines.push(`Notes (${infos.length}):`, ...infos.map((f) => `  - ${f.message}`));
  return lines.join('\n').trimEnd();
}
