import { existsSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { EDGE_KINDS, NODE_KINDS } from './model.js';
import { readText } from './util.js';

export const CONFIG_FILE = 'agentatlas.yaml';
export const OUTPUT_DIR = '.agentatlas';
export const ATLAS_FILE = 'atlas.yaml';
export const SYSTEM_FILE = 'SYSTEM.md';

export const SCANNER_NAMES = [
  'dotnet', 'java', 'go', 'python', 'node', 'env', 'routes', 'codeowners',
  'compose', 'openapi', 'bicep', 'terraform', 'k8s', 'asyncapi', 'otel',
] as const;
export type ScannerName = (typeof SCANNER_NAMES)[number];

const endpoint = z.object({ method: z.string(), path: z.string(), summary: z.string().optional() });
const message = z.object({ name: z.string(), summary: z.string().optional() });

const manualNode = z.object({
  id: z.string().min(1),
  kind: z.enum(NODE_KINDS).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  owner: z.string().optional(),
  tech: z.array(z.string()).optional(),
  hosting: z.string().optional(),
  repoPath: z.string().optional(),
  endpoints: z.array(endpoint).optional(),
  messages: z.array(message).optional(),
  tags: z.array(z.string()).optional(),
});

const manualEdge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(EDGE_KINDS).default('calls'),
  protocol: z.string().optional(),
  endpoints: z.array(z.string()).optional(),
  messageTypes: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const manualFlow = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(z.object({ from: z.string(), to: z.string(), action: z.string() })).min(1),
});

export const configSchema = z.object({
  version: z.literal(1).default(1),
  system: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    owner: z.string().optional(),
  }),
  scan: z
    .object({
      exclude: z.array(z.string()).default([]),
      scanners: z.array(z.enum(SCANNER_NAMES)).default([...SCANNER_NAMES]),
      traces: z.array(z.string()).default(['**/*.otlp.json', 'traces/**/*.json']),
      /** Prefixes removed from scanned ids, e.g. "contoso-" turns contoso-quote-api into quote-api. */
      stripPrefixes: z.array(z.string()).default([]),
    })
    .prefault({}),
  /** Map scanned ids to the id you want: { "quoteapi": "quote-api" }. */
  aliases: z.record(z.string(), z.string()).default({}),
  /** Ids to drop from the atlas, with their edges. */
  ignore: z.array(z.string()).default([]),
  nodes: z.array(manualNode).default([]),
  edges: z.array(manualEdge).default([]),
  flows: z.array(manualFlow).default([]),
});

export type AtlasConfig = z.infer<typeof configSchema>;
export type ManualNode = z.infer<typeof manualNode>;

export class ConfigError extends Error {}

/** Parse and validate config text, labeling errors with `label` (a file name or path). */
export function parseConfigText(text: string, label = CONFIG_FILE): AtlasConfig {
  const raw = parse(text) ?? {};
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid ${label}:\n${issues}`);
  }
  return result.data;
}

export function loadConfig(dir: string): AtlasConfig {
  const path = join(dir, CONFIG_FILE);
  const text = readText(path);
  if (text === undefined) {
    return configSchema.parse({ system: { name: basename(resolve(dir)) } });
  }
  return parseConfigText(text, CONFIG_FILE);
}

/** Load a config file at an arbitrary path, not tied to a project directory (used by `merge`). */
export function loadConfigFile(path: string): AtlasConfig {
  const text = readText(path);
  if (text === undefined) throw new ConfigError(`Config file not found: ${path}`);
  return parseConfigText(text, path);
}

export function initConfig(dir: string, force = false): string {
  const path = join(dir, CONFIG_FILE);
  if (existsSync(path) && !force) throw new ConfigError(`${CONFIG_FILE} already exists (use --force to overwrite)`);
  const doc = {
    version: 1,
    system: { name: basename(resolve(dir)), description: 'Describe the system in one sentence.' },
    scan: { exclude: [], stripPrefixes: [] },
    aliases: {},
    ignore: [],
    nodes: [],
    edges: [],
    flows: [],
  };
  const header = [
    '# AgentAtlas configuration. Scanners find most of the map; use this file to',
    '# name the system, add what scanners cannot see, and correct what they get wrong.',
    '# Docs: https://github.com/senthil-sekar/agent-atlas#configuration',
    '',
  ].join('\n');
  writeFileSync(path, header + stringify(doc));
  return path;
}
