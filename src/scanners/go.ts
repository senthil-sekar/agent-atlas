import { join, posix } from 'node:path';
import { type NodeKind, emptyResult, normalizeId } from '../model.js';
import { readText, uniq } from '../util.js';
import type { Scanner } from './types.js';

interface Hint { tech: string; kind?: NodeKind; messaging?: boolean }

/** Import path prefix → what it tells us. Longest prefix wins. */
const HINTS: Array<[string, Hint]> = [
  ['github.com/lib/pq', { tech: 'PostgreSQL', kind: 'database' }],
  ['github.com/jackc/pgx', { tech: 'PostgreSQL', kind: 'database' }],
  ['github.com/go-sql-driver/mysql', { tech: 'MySQL', kind: 'database' }],
  ['github.com/denisenkom/go-mssqldb', { tech: 'SQL Server', kind: 'database' }],
  ['github.com/microsoft/go-mssqldb', { tech: 'SQL Server', kind: 'database' }],
  ['go.mongodb.org/mongo-driver', { tech: 'MongoDB', kind: 'database' }],
  ['github.com/redis/go-redis', { tech: 'Redis', kind: 'cache' }],
  ['github.com/go-redis/redis', { tech: 'Redis', kind: 'cache' }],
  ['github.com/segmentio/kafka-go', { tech: 'Kafka', messaging: true }],
  ['github.com/confluentinc/confluent-kafka-go', { tech: 'Kafka', messaging: true }],
  ['github.com/rabbitmq/amqp091-go', { tech: 'RabbitMQ', messaging: true }],
  ['github.com/streadway/amqp', { tech: 'RabbitMQ', messaging: true }],
  ['github.com/aws/aws-sdk-go-v2/service/sqs', { tech: 'Amazon SQS', messaging: true }],
  ['github.com/aws/aws-sdk-go-v2/service/s3', { tech: 'Amazon S3', kind: 'storage' }],
  ['github.com/aws/aws-sdk-go/service/sqs', { tech: 'Amazon SQS', messaging: true }],
  ['github.com/aws/aws-sdk-go/service/s3', { tech: 'Amazon S3', kind: 'storage' }],
  ['github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus', { tech: 'Azure Service Bus', messaging: true }],
  ['github.com/Azure/azure-sdk-for-go/sdk/storage/azblob', { tech: 'Azure Blob Storage', kind: 'storage' }],
  ['github.com/Azure/azure-sdk-for-go/sdk/data/azcosmos', { tech: 'Azure Cosmos DB', kind: 'database' }],
  ['github.com/elastic/go-elasticsearch', { tech: 'Elasticsearch', kind: 'search' }],
];

const FRAMEWORKS: Array<[string, string]> = [
  ['github.com/gin-gonic/gin', 'Gin'],
  ['github.com/labstack/echo', 'Echo'],
  ['github.com/gofiber/fiber', 'Fiber'],
  ['github.com/go-chi/chi', 'chi'],
  ['github.com/gorilla/mux', 'gorilla/mux'],
  ['google.golang.org/grpc', 'gRPC'],
];

function matches(mod: string, prefix: string): boolean {
  return mod === prefix || mod.startsWith(`${prefix}/`);
}

function hintFor(mod: string): Hint | undefined {
  let best: [string, Hint] | undefined;
  for (const entry of HINTS) {
    if (matches(mod, entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1];
}

interface GoModule { dir: string; name: string; requires: string[] }

function parseGoMod(root: string, rel: string): GoModule | undefined {
  const text = readText(join(root, rel));
  if (!text) return undefined;
  const name = text.match(/^module\s+(\S+)/m)?.[1] ?? posix.basename(posix.dirname(rel));
  const requires: string[] = [];
  const block = text.match(/require\s*\(([\s\S]*?)\)/);
  if (block) for (const m of block[1]!.matchAll(/^\s*(\S+)\s+v[\d.]/gm)) requires.push(m[1]!);
  for (const m of text.matchAll(/^require\s+(\S+)\s+v[\d.]/gm)) requires.push(m[1]!);
  return { dir: posix.dirname(rel), name, requires };
}

export const scanGo: Scanner = (ctx) => {
  const result = emptyResult();
  const modules = ctx.files
    .filter((f) => posix.basename(f) === 'go.mod')
    .map((f) => parseGoMod(ctx.root, f))
    .filter((m): m is GoModule => !!m)
    .sort((a, b) => b.dir.length - a.dir.length);
  const moduleFor = (dir: string) => modules.find((m) => dir === m.dir || dir.startsWith(`${m.dir}/`) || m.dir === '.');

  const mainDirs = uniq(
    ctx.files
      .filter((f) => f.endsWith('.go'))
      .filter((f) => /^package\s+main\b/m.test(readText(join(ctx.root, f)) ?? ''))
      .map((f) => posix.dirname(f)),
  );

  for (const dir of mainDirs) {
    const mod = moduleFor(dir);
    if (!mod) continue;
    const id = normalizeId(dir === mod.dir ? posix.basename(mod.name) : posix.basename(dir));
    const hints = mod.requires.map(hintFor).filter((h): h is Hint => !!h);
    const fw = FRAMEWORKS.find(([d]) => mod.requires.some((r) => matches(r, d)));
    result.nodes.push({
      id,
      kind: 'service',
      tech: uniq(['Go', ...(fw ? [fw[1]] : []), ...hints.map((h) => h.tech)]),
      repoPath: dir,
      sources: ['go'],
    });
    const namedKinds = new Set<NodeKind>();
    for (const h of hints) {
      if (h.messaging || !h.kind || namedKinds.has(h.kind)) continue;
      const storeId = `${id}-${normalizeId(h.tech)}`;
      if (result.nodes.some((n) => n.id === storeId)) continue;
      result.nodes.push({ id: storeId, kind: h.kind, tech: [h.tech], description: `Inferred from a ${h.tech} import in ${mod.name}; add a manual node or alias to name it.`, sources: ['go'] });
      result.edges.push({ from: id, to: storeId, kind: 'stores', sources: ['go'] });
      namedKinds.add(h.kind);
    }
  }
  return result;
};
