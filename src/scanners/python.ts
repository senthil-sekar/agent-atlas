import { join, posix } from 'node:path';
import { type NodeKind, emptyResult, normalizeId } from '../model.js';
import { readText, uniq } from '../util.js';
import type { Scanner } from './types.js';

interface Hint { tech: string; kind?: NodeKind; messaging?: boolean }

const HINTS: Array<[string, Hint]> = [
  ['psycopg2', { tech: 'PostgreSQL', kind: 'database' }],
  ['psycopg2-binary', { tech: 'PostgreSQL', kind: 'database' }],
  ['psycopg', { tech: 'PostgreSQL', kind: 'database' }],
  ['asyncpg', { tech: 'PostgreSQL', kind: 'database' }],
  ['pymysql', { tech: 'MySQL', kind: 'database' }],
  ['mysqlclient', { tech: 'MySQL', kind: 'database' }],
  ['mysql-connector-python', { tech: 'MySQL', kind: 'database' }],
  ['pymongo', { tech: 'MongoDB', kind: 'database' }],
  ['motor', { tech: 'MongoDB', kind: 'database' }],
  ['redis', { tech: 'Redis', kind: 'cache' }],
  ['aioredis', { tech: 'Redis', kind: 'cache' }],
  ['kafka-python', { tech: 'Kafka', messaging: true }],
  ['confluent-kafka', { tech: 'Kafka', messaging: true }],
  ['aiokafka', { tech: 'Kafka', messaging: true }],
  ['pika', { tech: 'RabbitMQ', messaging: true }],
  ['aio-pika', { tech: 'RabbitMQ', messaging: true }],
  ['elasticsearch', { tech: 'Elasticsearch', kind: 'search' }],
  ['azure-cosmos', { tech: 'Azure Cosmos DB', kind: 'database' }],
  ['azure-servicebus', { tech: 'Azure Service Bus', messaging: true }],
  ['azure-storage-blob', { tech: 'Azure Blob Storage', kind: 'storage' }],
  ['boto3', { tech: 'AWS SDK' }],
];

/** Web frameworks that mark a module as a deployable, not a library or script. */
const FRAMEWORKS: Array<[string, string]> = [
  ['django', 'Django'],
  ['flask', 'Flask'],
  ['fastapi', 'FastAPI'],
  ['tornado', 'Tornado'],
  ['aiohttp', 'aiohttp'],
  ['starlette', 'Starlette'],
];

const normalizePkg = (name: string) => name.toLowerCase().replace(/_/g, '-');

function hintFor(pkg: string): Hint | undefined {
  return HINTS.find(([d]) => d === pkg)?.[1];
}

function depName(requirementLine: string): string | undefined {
  const trimmed = requirementLine.split('#')[0]!.trim();
  if (!trimmed || trimmed.startsWith('-')) return undefined;
  const name = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
  return name ? normalizePkg(name) : undefined;
}

function parsePyproject(text: string): { name?: string; deps: string[] } {
  const deps: string[] = [];
  const name = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  const array = text.match(/\bdependencies\s*=\s*\[([\s\S]*?)\]/);
  if (array) for (const m of array[1]!.matchAll(/["']([^"']+)["']/g)) {
    const d = depName(m[1]!);
    if (d) deps.push(d);
  }
  const poetry = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
  if (poetry) for (const m of poetry[1]!.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) {
    const d = normalizePkg(m[1]!);
    if (d !== 'python') deps.push(d);
  }
  return { name, deps: uniq(deps) };
}

interface PyProject { dir: string; name: string; deps: string[] }

export const scanPython: Scanner = (ctx) => {
  const result = emptyResult();
  const pyprojectDirs = new Set(ctx.files.filter((f) => posix.basename(f) === 'pyproject.toml').map((f) => posix.dirname(f)));
  const projects: PyProject[] = [];

  for (const f of ctx.files.filter((f) => posix.basename(f) === 'pyproject.toml')) {
    const text = readText(join(ctx.root, f));
    if (!text) continue;
    const dir = posix.dirname(f);
    const { name, deps } = parsePyproject(text);
    projects.push({ dir, name: name ?? posix.basename(dir === '.' ? ctx.root : dir), deps });
  }
  for (const f of ctx.files.filter((f) => posix.basename(f) === 'requirements.txt')) {
    const dir = posix.dirname(f);
    if (pyprojectDirs.has(dir)) continue; // pyproject.toml already claimed this module
    const text = readText(join(ctx.root, f));
    if (!text) continue;
    const deps = uniq(text.split(/\r?\n/).map(depName).filter((d): d is string => !!d));
    projects.push({ dir, name: posix.basename(dir === '.' ? ctx.root : dir), deps });
  }

  for (const p of projects) {
    const fw = FRAMEWORKS.find(([d]) => p.deps.includes(d));
    if (!fw) continue;
    const id = normalizeId(p.name);
    const hints = p.deps.map(hintFor).filter((h): h is Hint => !!h);
    result.nodes.push({
      id,
      kind: 'service',
      name: p.name,
      tech: uniq(['Python', fw[1], ...hints.map((h) => h.tech)]),
      repoPath: p.dir,
      sources: ['python'],
    });
    const namedKinds = new Set<NodeKind>();
    for (const h of hints) {
      if (h.messaging || !h.kind || namedKinds.has(h.kind)) continue;
      const storeId = `${id}-${normalizeId(h.tech)}`;
      if (result.nodes.some((n) => n.id === storeId)) continue;
      result.nodes.push({ id: storeId, kind: h.kind, tech: [h.tech], description: `Inferred from a ${h.tech} package in ${p.name}; add a manual node or alias to name it.`, sources: ['python'] });
      result.edges.push({ from: id, to: storeId, kind: 'stores', sources: ['python'] });
      namedKinds.add(h.kind);
    }
  }
  return result;
};
