/** The AgentAtlas graph model. */

export const NODE_KINDS = [
  'service', 'function', 'gateway', 'frontend',
  'database', 'cache', 'storage', 'search',
  'queue', 'topic', 'stream',
  'external',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Edge direction always follows dependency: `from` depends on `to`.
 * - calls:     from sends requests to `to`
 * - publishes: from sends messages to the queue/topic/stream `to`
 * - consumes:  from receives messages from the queue/topic/stream `to`
 * - stores:    from reads and writes the data store `to`
 * - depends:   any other dependency
 */
export const EDGE_KINDS = ['calls', 'publishes', 'consumes', 'stores', 'depends'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const SOURCES = ['manual', 'dotnet', 'node', 'compose', 'openapi', 'bicep', 'otel'] as const;
export type Source = (typeof SOURCES)[number];

export const STORE_KINDS: ReadonlySet<NodeKind> = new Set(['database', 'cache', 'storage', 'search']);
export const MESSAGING_KINDS: ReadonlySet<NodeKind> = new Set(['queue', 'topic', 'stream']);
export const COMPUTE_KINDS: ReadonlySet<NodeKind> = new Set(['service', 'function', 'gateway', 'frontend']);

export interface Endpoint {
  method: string;
  path: string;
  summary?: string;
}

export interface AtlasNode {
  id: string;
  kind: NodeKind;
  name?: string;
  description?: string;
  owner?: string;
  tech?: string[];
  hosting?: string;
  repoPath?: string;
  endpoints?: Endpoint[];
  tags?: string[];
  sources: Source[];
}

export interface AtlasEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  protocol?: string;
  description?: string;
  /** Number of times this interaction appeared in traces. */
  observed?: number;
  sources: Source[];
}

export interface FlowStep {
  from: string;
  to: string;
  action: string;
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  steps: FlowStep[];
  sources: Source[];
}

export interface SystemInfo {
  name: string;
  description?: string;
  owner?: string;
}

export interface Atlas {
  version: 1;
  system: SystemInfo;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  flows: Flow[];
}

/** What a scanner returns before ids are canonicalized and merged. */
export interface ScanResult {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  flows: Flow[];
  /** Pairs of [scannedId, canonicalId] the scanner discovered (for example, compose build contexts). */
  aliases?: Array<[string, string]>;
  warnings?: string[];
}

export const emptyResult = (): ScanResult => ({ nodes: [], edges: [], flows: [], aliases: [], warnings: [] });

/** Turn any name ("Contoso.Quote.Api", "QuoteDb", "quote_api") into a kebab-case id. */
export function normalizeId(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
