import { join, posix } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { type NodeKind, emptyResult, normalizeId } from '../model.js';
import { flatten, readText, uniq } from '../util.js';
import { interpretSettings } from './settings.js';
import type { Scanner } from './types.js';

interface Hint { tech: string; kind?: NodeKind; messaging?: boolean; role?: 'gateway' }

/** groupId:artifactId prefix → what it tells us. Longest prefix wins. */
const HINTS: Array<[string, Hint]> = [
  ['org.postgresql:postgresql', { tech: 'PostgreSQL', kind: 'database' }],
  ['mysql:mysql-connector-java', { tech: 'MySQL', kind: 'database' }],
  ['com.mysql:mysql-connector-j', { tech: 'MySQL', kind: 'database' }],
  ['com.microsoft.sqlserver:mssql-jdbc', { tech: 'SQL Server', kind: 'database' }],
  ['org.mongodb:mongodb-driver', { tech: 'MongoDB', kind: 'database' }],
  ['org.springframework.boot:spring-boot-starter-data-mongodb', { tech: 'MongoDB', kind: 'database' }],
  ['org.springframework.boot:spring-boot-starter-data-redis', { tech: 'Redis', kind: 'cache' }],
  ['redis.clients:jedis', { tech: 'Redis', kind: 'cache' }],
  ['io.lettuce:lettuce-core', { tech: 'Redis', kind: 'cache' }],
  ['org.apache.kafka:kafka-clients', { tech: 'Kafka', messaging: true }],
  ['org.springframework.kafka:spring-kafka', { tech: 'Kafka', messaging: true }],
  ['com.rabbitmq:amqp-client', { tech: 'RabbitMQ', messaging: true }],
  ['org.springframework.boot:spring-boot-starter-amqp', { tech: 'RabbitMQ', messaging: true }],
  ['software.amazon.awssdk:sqs', { tech: 'Amazon SQS', messaging: true }],
  ['software.amazon.awssdk:s3', { tech: 'Amazon S3', kind: 'storage' }],
  ['com.azure:azure-messaging-servicebus', { tech: 'Azure Service Bus', messaging: true }],
  ['com.azure:azure-storage-blob', { tech: 'Azure Blob Storage', kind: 'storage' }],
  ['com.azure:azure-cosmos', { tech: 'Azure Cosmos DB', kind: 'database' }],
  ['co.elastic.clients:elasticsearch-java', { tech: 'Elasticsearch', kind: 'search' }],
  ['org.elasticsearch.client:elasticsearch-rest', { tech: 'Elasticsearch', kind: 'search' }],
  ['org.springframework.cloud:spring-cloud-gateway', { tech: 'Spring Cloud Gateway', role: 'gateway' }],
  ['io.grpc:grpc', { tech: 'gRPC' }],
];

/** Web-serving starters that mark a module as a deployable, not a library. */
const FRAMEWORKS: Array<[string, string]> = [
  ['org.springframework.boot:spring-boot-starter-web', 'Spring Boot'],
  ['org.springframework.boot:spring-boot-starter-webflux', 'Spring Boot (WebFlux)'],
  ['org.springframework.boot:spring-boot-starter', 'Spring Boot'],
  ['io.micronaut:micronaut-http-server-netty', 'Micronaut'],
  ['io.quarkus:quarkus-resteasy', 'Quarkus'],
  ['io.quarkus:quarkus-resteasy-reactive', 'Quarkus'],
  ['io.quarkus:quarkus-rest', 'Quarkus'],
];

function hintFor(dep: string): Hint | undefined {
  let best: [string, Hint] | undefined;
  for (const entry of HINTS) {
    if ((dep === entry[0] || dep.startsWith(`${entry[0]}-`)) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1];
}

interface JavaProject {
  dir: string;
  name: string;
  deps: string[];
}

function stripBlock(text: string, tag: string): string {
  return text.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), '');
}

function parsePom(root: string, rel: string): JavaProject | undefined {
  const text = readText(join(root, rel));
  if (!text) return undefined;
  if (/<packaging>\s*pom\s*<\/packaging>/.test(text)) return undefined; // aggregator, no app code
  const withoutParent = stripBlock(text, 'parent');
  const depMgmt = withoutParent.match(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/)?.[0] ?? '';
  const body = withoutParent.replace(depMgmt, '');
  const name = body.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim() ?? posix.basename(posix.dirname(rel));
  const deps: string[] = [];
  for (const m of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = m[1]!.match(/<groupId>([^<]+)<\/groupId>/)?.[1]?.trim();
    const a = m[1]!.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim();
    if (g && a) deps.push(`${g}:${a}`);
  }
  return { dir: posix.dirname(rel), name, deps };
}

function parseGradle(root: string, rel: string): JavaProject | undefined {
  const text = readText(join(root, rel));
  if (!text) return undefined;
  const dir = posix.dirname(rel);
  const settings = readText(join(root, dir, 'settings.gradle')) ?? readText(join(root, dir, 'settings.gradle.kts'));
  const name = settings?.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? posix.basename(dir === '.' ? root : dir);
  const deps: string[] = [];
  for (const m of text.matchAll(/\b(?:implementation|api|compile|runtimeOnly|compileOnly)\s*[(]?\s*['"]([\w.-]+):([\w.-]+)(?::[\w.\-+]+)?['"]/g)) {
    deps.push(`${m[1]}:${m[2]}`);
  }
  return { dir, name, deps };
}

const CONFIG_FILE = /^(application|bootstrap)(-[\w-]+)?\.(ya?ml|properties)$/i;
const STREAM_BINDING = /^spring:cloud:stream:bindings:([\w.-]+):destination$/i;
const REDIS_HOST = /^spring:(data:)?redis:host$/i;

/** Spring placeholders: ${DB_HOST:localhost} resolves to its default so the value stays parseable. */
const resolvePlaceholders = (value: string) => value.replace(/\$\{([^}:]+)(?::-?([^}]*))?\}/g, (_m, _name, def) => def ?? '');

/** Read application.yml/.properties into canonical colon-separated keys. */
function configEntries(root: string, rel: string): Array<[string, string]> {
  const text = readText(join(root, rel));
  if (!text) return [];
  const raw: Array<[string, string]> = [];
  if (/\.properties$/i.test(rel)) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const split = trimmed.indexOf('=');
      if (split > 0) raw.push([trimmed.slice(0, split).trim(), trimmed.slice(split + 1).trim()]);
    }
  } else {
    try {
      for (const doc of parseAllDocuments(text)) {            // Spring profiles are separate YAML documents
        const value = doc.toJS({ maxAliasCount: -1 });
        if (value && typeof value === 'object') raw.push(...flatten(value));
      }
    } catch { return []; }
  }
  return raw.map(([k, v]) => [k.replace(/\./g, ':'), resolvePlaceholders(v)]);
}

export const scanJava: Scanner = (ctx) => {
  const result = emptyResult();
  const projects = new Map<string, JavaProject>();
  for (const f of ctx.files.filter((f) => posix.basename(f) === 'pom.xml')) {
    const p = parsePom(ctx.root, f);
    if (p) projects.set(f, p);
  }
  for (const f of ctx.files.filter((f) => /^build\.gradle(\.kts)?$/.test(posix.basename(f)))) {
    const dir = posix.dirname(f);
    if ([...projects.values()].some((p) => p.dir === dir)) continue; // pom.xml already claimed this module
    const p = parseGradle(ctx.root, f);
    if (p) projects.set(f, p);
  }

  // Config files belong to the deepest module that contains them.
  const moduleDirs = [...projects.values()].map((p) => p.dir).sort((a, b) => b.length - a.length);
  const moduleFor = (dir: string) => moduleDirs.find((d) => dir === d || dir.startsWith(`${d}/`) || d === '.');

  for (const p of projects.values()) {
    const fw = FRAMEWORKS.find(([d]) => p.deps.includes(d));
    if (!fw) continue;
    const id = normalizeId(p.name);
    const hints = p.deps.map(hintFor).filter((h): h is Hint => !!h);
    const kind: NodeKind = hints.some((h) => h.role === 'gateway') ? 'gateway' : 'service';
    const worker = /worker|processor|consumer|job/.test(id);
    const messagingTech = hints.find((h) => h.messaging)?.tech;
    result.nodes.push({
      id,
      kind,
      name: p.name,
      tech: uniq(['Java', fw[1], ...hints.map((h) => h.tech)]),
      repoPath: p.dir,
      sources: ['java'],
    });

    const entries = ctx.files
      .filter((f) => CONFIG_FILE.test(posix.basename(f)) && moduleFor(posix.dirname(f)) === p.dir)
      .flatMap((f) => configEntries(ctx.root, f));
    const found = interpretSettings(entries, { serviceId: id, source: 'java', isWorker: worker, messagingTech });
    result.nodes.push(...found.nodes);
    result.edges.push(...found.edges);

    for (const [key, value] of entries) {
      if (!value) continue;
      const binding = key.match(STREAM_BINDING)?.[1];
      if (binding) {
        // Spring Cloud Stream functional bindings: <function>-in-0 consumes, <function>-out-0 publishes.
        const consumes = /-in-\d+$/i.test(binding) || (!/-out-\d+$/i.test(binding) && worker);
        result.nodes.push({ id: normalizeId(value), kind: 'topic', ...(messagingTech ? { tech: [messagingTech] } : {}), sources: ['java'] });
        result.edges.push({ from: id, to: normalizeId(value), kind: consumes ? 'consumes' : 'publishes', sources: ['java'] });
      } else if (REDIS_HOST.test(key) && !/^(localhost|127\.)/.test(value)) {
        result.nodes.push({ id: normalizeId(value), kind: 'cache', tech: ['Redis'], sources: ['java'] });
        result.edges.push({ from: id, to: normalizeId(value), kind: 'stores', sources: ['java'] });
      }
    }

    const namedKinds = new Set<NodeKind>(found.nodes.map((n) => n.kind));
    for (const h of hints) {
      if (h.messaging || !h.kind || namedKinds.has(h.kind)) continue;
      const storeId = `${id}-${normalizeId(h.tech)}`;
      if (result.nodes.some((n) => n.id === storeId)) continue;
      result.nodes.push({ id: storeId, kind: h.kind, tech: [h.tech], description: `Inferred from a ${h.tech} dependency in ${p.name}; add a manual node or alias to name it.`, tags: ['inferred'], sources: ['java'] });
      result.edges.push({ from: id, to: storeId, kind: 'stores', sources: ['java'] });
      namedKinds.add(h.kind);
    }
  }
  return result;
};
