import { join, posix } from 'node:path';
import { parse } from 'yaml';
import { type AtlasNode, type NodeKind, STORE_KINDS, MESSAGING_KINDS, emptyResult, normalizeId } from '../model.js';
import { readText } from '../util.js';
import { interpretSettings } from './settings.js';
import type { Scanner } from './types.js';

const IMAGES: Array<[RegExp, NodeKind, string]> = [
  [/postgres|postgis/, 'database', 'PostgreSQL'],
  [/mysql|mariadb/, 'database', 'MySQL'],
  [/mssql|sql-?server|azure-sql-edge/, 'database', 'SQL Server'],
  [/mongo/, 'database', 'MongoDB'],
  [/cosmos/, 'database', 'Azure Cosmos DB emulator'],
  [/redis|valkey|garnet/, 'cache', 'Redis'],
  [/rabbitmq/, 'queue', 'RabbitMQ'],
  [/servicebus/, 'queue', 'Azure Service Bus emulator'],
  [/kafka|redpanda/, 'stream', 'Kafka'],
  [/elasticsearch|opensearch/, 'search', 'Elasticsearch'],
  [/azurite/, 'storage', 'Azurite'],
  [/minio/, 'storage', 'MinIO'],
  [/nginx|traefik|envoy|haproxy|kong/, 'gateway', 'Reverse proxy'],
  [/jaeger|otel|prometheus|grafana|seq|zipkin|aspire-dashboard/, 'external', 'Observability'],
];

export const OBSERVABILITY = /jaeger|otel|prometheus|grafana|seq|zipkin|aspire-dashboard/;

/** What a container image says a node is, shared with the Kubernetes scanner. */
export const imageHint = (image: string): [NodeKind, string] | undefined => {
  const match = IMAGES.find(([re]) => re.test(image.toLowerCase()));
  return match ? [match[1], match[2]] : undefined;
};

function envEntries(env: unknown): Array<[string, string]> {
  if (Array.isArray(env)) {
    return env.map(String).filter((e) => e.includes('=')).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]);
  }
  if (env && typeof env === 'object') return Object.entries(env).map(([k, v]) => [k, String(v ?? '')]);
  return [];
}

export const scanCompose: Scanner = (ctx) => {
  const result = emptyResult();
  const files = ctx.files.filter((f) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(posix.basename(f)));
  for (const f of files) {
    let doc: any;
    try { doc = parse(readText(join(ctx.root, f)) ?? ''); } catch { result.warnings!.push(`${f}: invalid YAML`); continue; }
    const services: Record<string, any> = doc?.services ?? {};
    const base = posix.dirname(f);
    const ids = new Map(Object.keys(services).map((name) => [name, normalizeId(name)]));
    const kinds = new Map<string, NodeKind>();

    for (const [name, svc] of Object.entries(services)) {
      const id = ids.get(name)!;
      const image = String(svc?.image ?? '').toLowerCase();
      if (OBSERVABILITY.test(image)) { ids.delete(name); continue; }
      const match = IMAGES.find(([re]) => re.test(image));
      const built = svc?.build !== undefined;
      const kind: NodeKind = built ? 'service' : match?.[1] ?? 'service';
      kinds.set(name, kind);
      const node: AtlasNode = { id, kind, sources: ['compose'] };
      if (!built && match) node.tech = [match[2]];
      else if (!built && image) node.tech = [`image: ${image}`];
      result.nodes.push(node);

      if (built) {
        const context = typeof svc.build === 'string' ? svc.build : svc.build.context ?? '.';
        const dockerfile = typeof svc.build === 'object' ? svc.build.dockerfile : undefined;
        const contextDir = posix.normalize(posix.join(base, context));
        const dockerDir = dockerfile ? posix.normalize(posix.join(contextDir, posix.dirname(dockerfile))) : contextDir;
        // Link code projects to this compose service by folder.
        const inside = (p?: string) => !!p && (p === dockerDir || p.startsWith(`${dockerDir}/`));
        let candidates = ctx.codeNodes.filter((n) => inside(n.repoPath));
        if (candidates.length > 1) candidates = candidates.filter((n) => n.repoPath === dockerDir);
        if (candidates.length === 1 && candidates[0]!.id !== id) result.aliases!.push([candidates[0]!.id, id]);
      }
    }

    for (const [name, svc] of Object.entries(services)) {
      const id = ids.get(name);
      if (!id) continue;
      const kind = kinds.get(name)!;
      if (kind !== 'service' && kind !== 'gateway') continue;

      const deps = Array.isArray(svc?.depends_on) ? svc.depends_on : Object.keys(svc?.depends_on ?? {});
      for (const dep of deps.map(String)) {
        const target = ids.get(dep);
        if (!target) continue;
        const tk = kinds.get(dep)!;
        const edgeKind = STORE_KINDS.has(tk) ? 'stores' : MESSAGING_KINDS.has(tk) ? 'depends' : 'calls';
        result.edges.push({ from: id, to: target, kind: edgeKind, sources: ['compose'] });
      }

      const env = envEntries(svc?.environment);
      // ASP.NET Core style keys: ConnectionStrings__X, Section__Key
      const settings = interpretSettings(env.map(([k, v]) => [k.replace(/__/g, ':'), v]), {
        serviceId: id, source: 'compose', isWorker: /worker|processor|consumer/.test(id),
      });
      result.nodes.push(...settings.nodes);
      result.edges.push(...settings.edges);

      // Any other value mentioning another compose service by hostname.
      for (const [, v] of env) {
        for (const [otherName, otherId] of ids) {
          if (otherId === id) continue;
          const re = new RegExp(`(^|[/@=;,\\s])${otherName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(:\\d+|[;/,\\s]|$)`);
          if (!re.test(v)) continue;
          const tk = kinds.get(otherName)!;
          const edgeKind = STORE_KINDS.has(tk) ? 'stores' : MESSAGING_KINDS.has(tk) ? 'depends' : 'calls';
          result.edges.push({ from: id, to: otherId, kind: edgeKind, sources: ['compose'] });
        }
      }
    }
  }
  return result;
};
