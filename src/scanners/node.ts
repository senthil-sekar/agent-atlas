import { join, posix } from 'node:path';
import { type NodeKind, emptyResult, normalizeId } from '../model.js';
import { readText, uniq } from '../util.js';
import type { Scanner } from './types.js';

const FRAMEWORKS: Array<[string, string, NodeKind]> = [
  ['@nestjs/core', 'NestJS', 'service'],
  ['express', 'Express', 'service'],
  ['fastify', 'Fastify', 'service'],
  ['koa', 'Koa', 'service'],
  ['hono', 'Hono', 'service'],
  ['@hapi/hapi', 'hapi', 'service'],
  ['next', 'Next.js', 'frontend'],
  ['nuxt', 'Nuxt', 'frontend'],
  ['@remix-run/node', 'Remix', 'frontend'],
  ['@azure/functions', 'Azure Functions', 'function'],
  ['@angular/core', 'Angular', 'frontend'],
  ['vue', 'Vue', 'frontend'],
  ['svelte', 'Svelte', 'frontend'],
  ['react-dom', 'React', 'frontend'],
];

const INFRA: Array<[string, string, NodeKind | 'messaging']> = [
  ['pg', 'PostgreSQL', 'database'], ['postgres', 'PostgreSQL', 'database'], ['mysql2', 'MySQL', 'database'],
  ['mssql', 'SQL Server', 'database'], ['tedious', 'SQL Server', 'database'], ['mongodb', 'MongoDB', 'database'],
  ['mongoose', 'MongoDB', 'database'], ['@azure/cosmos', 'Azure Cosmos DB', 'database'],
  ['redis', 'Redis', 'cache'], ['ioredis', 'Redis', 'cache'],
  ['@azure/storage-blob', 'Azure Blob Storage', 'storage'], ['@aws-sdk/client-s3', 'Amazon S3', 'storage'],
  ['@elastic/elasticsearch', 'Elasticsearch', 'search'],
  ['@azure/service-bus', 'Azure Service Bus', 'messaging'], ['kafkajs', 'Kafka', 'messaging'],
  ['amqplib', 'RabbitMQ', 'messaging'], ['@aws-sdk/client-sqs', 'Amazon SQS', 'messaging'],
  ['bullmq', 'BullMQ', 'messaging'], ['@prisma/client', 'Prisma', 'database'],
];

export const scanNode: Scanner = (ctx) => {
  const result = emptyResult();
  for (const f of ctx.files.filter((f) => posix.basename(f) === 'package.json')) {
    let pkg: any;
    try { pkg = JSON.parse(readText(join(ctx.root, f)) ?? ''); } catch { continue; }
    const deps: Record<string, string> = { ...pkg.dependencies };
    const fw = FRAMEWORKS.find(([d]) => d in deps);
    if (!fw) continue;
    const dir = posix.dirname(f);
    const id = normalizeId(pkg.agentatlas?.id ?? String(pkg.name ?? posix.basename(dir)).replace(/^@[^/]+\//, ''));
    const infra = INFRA.filter(([d]) => d in deps);
    result.nodes.push({
      id,
      kind: fw[2],
      name: pkg.name,
      ...(pkg.description ? { description: pkg.description } : {}),
      tech: uniq(['Node.js', fw[1], ...infra.map((i) => i[1])]),
      repoPath: dir,
      sources: ['node'],
    });
    for (const [, tech, kind] of infra) {
      if (kind === 'messaging') continue;
      const storeId = `${id}-${normalizeId(tech)}`;
      if (result.nodes.some((n) => n.id === storeId)) continue;
      result.nodes.push({ id: storeId, kind, tech: [tech], description: `Inferred from a ${tech} package in ${pkg.name}; add a manual node or alias to name it.`, tags: ['inferred'], sources: ['node'] });
      result.edges.push({ from: id, to: storeId, kind: 'stores', sources: ['node'] });
    }
  }
  return result;
};
