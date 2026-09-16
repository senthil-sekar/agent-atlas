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
      add(normalizeId(value), 'topic', ctx.messagingTech, 'publishes');
    } else if (QUEUE_KEY.test(last)) {
      const consumes = ctx.isWorker || /(listen|consume|receive|input|inbound)/i.test(key);
      add(normalizeId(value), 'queue', ctx.messagingTech, consumes ? 'consumes' : 'publishes');
    } else if (HUB_KEY.test(last)) {
      const consumes = ctx.isWorker || /(consum|process|receive|input)/i.test(key);
      add(normalizeId(value), 'stream', ctx.messagingTech, consumes ? 'consumes' : 'publishes');
    }
  }
  return { nodes, edges };
}
