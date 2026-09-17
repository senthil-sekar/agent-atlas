import { COMPUTE_KINDS, UNRESOLVED_EXTERNAL, type Atlas, type AtlasNode } from './model.js';

export interface DoctorReport {
  /** Stores guessed from a dependency; still unnamed once configuration had its say. */
  inferredStores: AtlasNode[];
  /** Compute nodes with no edges at all: likely a scanner blind spot, not a real dead end. */
  disconnected: AtlasNode[];
  /** External systems with nothing said about them. */
  undescribedExternals: AtlasNode[];
}

export function diagnose(atlas: Atlas): DoctorReport {
  const touched = new Set<string>();
  for (const e of atlas.edges) { touched.add(e.from); touched.add(e.to); }
  return {
    inferredStores: atlas.nodes.filter((n) => n.tags?.includes('inferred')),
    disconnected: atlas.nodes.filter((n) => COMPUTE_KINDS.has(n.kind) && !touched.has(n.id)),
    undescribedExternals: atlas.nodes.filter((n) => n.kind === 'external' && (!n.description || n.description === UNRESOLVED_EXTERNAL)),
  };
}

export const hasIssues = (r: DoctorReport) =>
  r.inferredStores.length + r.disconnected.length + r.undescribedExternals.length > 0;

export function describeDoctor(r: DoctorReport): string {
  if (!hasIssues(r)) {
    return 'No issues found: every guessed store has been named, every compute node has an edge, and every external system is described.';
  }
  const lines: string[] = [];

  if (r.inferredStores.length) {
    lines.push(
      `Stores guessed from a dependency, not named by any configuration (${r.inferredStores.length}):`,
      ...r.inferredStores.map((n) => `  - ${n.id} [${n.kind}]${n.tech?.length ? ` — ${n.tech.join(', ')}` : ''}`),
      '  Point the guess at the real thing:',
      ...r.inferredStores.map((n) => `    aliases: { ${n.id}: <the-real-service-or-store-id> }`),
      '',
    );
  }

  if (r.disconnected.length) {
    lines.push(
      `Compute nodes with no dependencies and no callers — a likely scanner blind spot (${r.disconnected.length}):`,
      ...r.disconnected.map((n) => `  - ${n.id} [${n.kind}]${n.repoPath ? ` (${n.repoPath})` : ''}`),
      '',
    );
  }

  if (r.undescribedExternals.length) {
    lines.push(
      `External systems with no description (${r.undescribedExternals.length}):`,
      ...r.undescribedExternals.map((n) => `  - ${n.id}`),
      '  Paste into agentatlas.yaml:',
      '    nodes:',
      ...r.undescribedExternals.map((n) => `      - { id: ${n.id}, description: "TODO: describe ${n.id}" }`),
      '',
    );
  }

  return lines.join('\n').trimEnd();
}
