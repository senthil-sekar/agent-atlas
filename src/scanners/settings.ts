/**
 * Heuristics that turn configuration key/value pairs (appsettings.json, environment
 * variables) into topology: connection strings become data stores, URLs become calls,
 * and topic/queue settings become messaging edges.
 */
import { type AtlasEdge, type AtlasNode, type NodeKind, type Source, normalizeId } from '../model.js';

export interface SettingsContext {
  serviceId: string;
  source: Source;
  /** Whether the service is a background worker (queues default to "consumes"). */
  isWorker: boolean;
  /** Messaging technology inferred from packages, e.g. "Azure Service Bus". */
  messagingTech?: string;
}

interface Classified { kind: NodeKind; tech?: string }

/** Schemes that mark a value as a data store or broker DSN rather than a service URL. */
const DSN_SCHEME = /^(postgres(ql)?|mysql|mariadb|sqlserver|mssql|mongodb(\+srv)?|rediss?|amqps?):\/\//i;
const KEY_VALUE_DSN = /(^|;)\s*(Server|Data Source|Host|AccountEndpoint|DefaultEndpointsProtocol)\s*=/i;
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|host\.docker\.internal)/i;

/**
 * A connection string or DSN, wherever it appears, names a store. Prefer a bare hostname as the id
 * (in compose, Kubernetes, and .env that hostname *is* the service), and fall back to the database name.
 */
export function classifyDsn(value: string): (Classified & { id: string }) | null {
  const raw = value.trim().replace(/^jdbc:/i, '');
  if (!DSN_SCHEME.test(raw) && !KEY_VALUE_DSN.test(raw)) return null;
  const classified = classifyConnectionString('', raw);
  if (!classified) return null;

  const named = raw.match(/(?:databaseName|Database|Initial Catalog|AccountName)\s*=\s*([^;,\s]+)/i)?.[1];
  let host: string | undefined;
  let path: string | undefined;
  try {
    const url = new URL(raw.replace(/^(\w+)(\+\w+)?:\/\//, 'http://'));
    host = url.hostname;
    path = url.pathname.replace(/^\//, '').split('/')[0];
  } catch { /* key=value form, no URL to parse */ }

  const id = host && !host.includes('.') && !LOCAL_HOST.test(host) ? host : named ?? path ?? undefined;
  return id ? { ...classified, id: normalizeId(id) } : null;
}

/**
 * Canonicalize a configuration key so environment-variable style reaches the same heuristics as
 * nested config: `QUOTE_API_BASE_URL` → `QUOTE_API:BASEURL`, `ConnectionStrings__Quote` → `ConnectionStrings:Quote`.
 */
const KEY_SUFFIXES = [
  'CONNECTION_STRING', 'SUBSCRIPTION_NAME', 'BASE_ADDRESS', 'BASE_URL', 'BASE_URI', 'TOPIC_NAME',
  'QUEUE_NAME', 'STREAM_NAME', 'EVENT_HUB', 'HUB_NAME', 'SUBSCRIPTION', 'EVENTHUB', 'ENDPOINT',
  'ADDRESS', 'STREAM', 'TOPIC', 'QUEUE', 'HOST', 'URL', 'URI',
].sort((a, b) => b.length - a.length);

export function normalizeEnvKey(key: string): string {
  if (key.includes('__')) return key.replace(/__/g, ':');
  if (key.includes(':')) return key;
  const upper = key.toUpperCase();
  for (const suffix of KEY_SUFFIXES) {
    if (upper === suffix) return suffix.replace(/_/g, '');
    if (upper.endsWith(`_${suffix}`)) return `${key.slice(0, key.length - suffix.length - 1)}:${suffix.replace(/_/g, '')}`;
  }
  return key;
}

export function classifyConnectionString(name: string, value: string): Classified | null {
  const v = value.trim();
  if (/Endpoint=sb:\/\//i.test(v)) return null; // Service Bus namespace, not an entity
  if (/EntityPath=/i.test(v) || /servicebus\.windows\.net/i.test(v)) return null;
  if (/AccountEndpoint=/i.test(v)) return { kind: 'database', tech: 'Azure Cosmos DB' };
  if (/^mongodb(\+srv)?:\/\//i.test(v)) return { kind: 'database', tech: 'MongoDB' };
  if (/^rediss?:\/\//i.test(v) || /:6379\b/.test(v) || /redis/i.test(name)) return { kind: 'cache', tech: 'Redis' };
  if (/DefaultEndpointsProtocol=|BlobEndpoint=|UseDevelopmentStorage=/i.test(v)) return { kind: 'storage', tech: 'Azure Storage' };
  if (/^amqps?:\/\//i.test(v)) return { kind: 'queue', tech: 'RabbitMQ' };
  if (/Host=/i.test(v) && /Database=/i.test(v)) return { kind: 'database', tech: 'PostgreSQL' };
  if (/^postgres(ql)?:\/\//i.test(v)) return { kind: 'database', tech: 'PostgreSQL' };
  if (/^mysql:\/\//i.test(v)) return { kind: 'database', tech: 'MySQL' };
  if (/(Server|Data Source)=/i.test(v)) return { kind: 'database', tech: 'SQL Server' };
  if (!v) return null;
  return { kind: 'database' };
}

/** Which way a messaging setting points: the key says so, otherwise a worker consumes and a service publishes. */
const CONSUMER_HINT = /(listen|consume|receive|input|inbound|subscri)/i;
const PRODUCER_HINT = /(publish|send|output|outbound|produce)/i;
const direction = (key: string, isWorker: boolean): 'consumes' | 'publishes' =>
  CONSUMER_HINT.test(key) ? 'consumes' : PRODUCER_HINT.test(key) ? 'publishes' : isWorker ? 'consumes' : 'publishes';

const URL_KEY = /(BaseUrl|BaseUri|BaseAddress|Url|Uri|Endpoint|Address|Host)$/i;
const TOPIC_KEY = /(Topic|TopicName)$/i;
const QUEUE_KEY = /(Queue|QueueName)$/i;
const SUBSCRIPTION_KEY = /(Subscription|SubscriptionName)$/i;
const HUB_KEY = /(EventHub|EventHubName|HubName|Stream|StreamName)$/i;

export function interpretSettings(entries: Array<[string, string]>, ctx: SettingsContext) {
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];
  const add = (id: string, kind: NodeKind, tech: string | undefined, edgeKind: AtlasEdge['kind'], protocol?: string, description?: string) => {
    if (!id || id === ctx.serviceId) return;
    nodes.push({ id, kind, ...(tech ? { tech: [tech] } : {}), ...(description ? { description } : {}), sources: [ctx.source] });
    edges.push({ from: ctx.serviceId, to: id, kind: edgeKind, ...(protocol ? { protocol } : {}), sources: [ctx.source] });
  };

  for (const [key, raw] of entries) {
    const value = raw.trim();
    if (!value) continue;
    const parts = key.split(':').filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    const parent = parts[parts.length - 2];

    if (parts[0]?.toLowerCase() === 'connectionstrings' && parts.length === 2) {
      const c = classifyConnectionString(last, value);
      if (!c) continue;
      const edgeKind = c.kind === 'queue' ? 'depends' : 'stores';
      add(normalizeId(last), c.kind, c.tech, edgeKind);
      continue;
    }

    // A DSN identifies a store wherever it appears, whatever the key is called.
    const dsn = classifyDsn(value);
    if (dsn) {
      add(dsn.id, dsn.kind, dsn.tech, dsn.kind === 'queue' ? 'depends' : 'stores');
      continue;
    }

    if (URL_KEY.test(last) && /^(https?|grpc):\/\//i.test(value)) {
      let url: URL;
      try { url = new URL(value); } catch { continue; }
      const host = url.hostname;
      if (!host || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host)) continue;
      const protocol = /grpc/i.test(key) || url.protocol === 'grpc:' ? 'grpc' : url.protocol.replace(':', '');
      if (!host.includes('.')) {
        add(normalizeId(host), 'service', undefined, 'calls', protocol);
      } else {
        const name = parent && !/^(services|endpoints|clients|destinations|d\d+)$/i.test(parent) ? parent : host.split('.')[0]!;
        add(normalizeId(name), 'external', undefined, 'calls', protocol, `External endpoint ${url.origin}`);
      }
      continue;
    }

    if (value.includes(' ') || value.includes('=') || value.length > 120) continue;

    if (SUBSCRIPTION_KEY.test(last)) {
      const topic = value.includes('/') ? value.split('/')[0]! : undefined;
      if (topic) add(normalizeId(topic), 'topic', ctx.messagingTech, 'consumes');
    } else if (TOPIC_KEY.test(last)) {
      add(normalizeId(value), 'topic', ctx.messagingTech, direction(key, ctx.isWorker));
    } else if (QUEUE_KEY.test(last)) {
      add(normalizeId(value), 'queue', ctx.messagingTech, direction(key, ctx.isWorker));
    } else if (HUB_KEY.test(last)) {
      add(normalizeId(value), 'stream', ctx.messagingTech, direction(key, ctx.isWorker));
    }
  }
  return { nodes, edges };
}
