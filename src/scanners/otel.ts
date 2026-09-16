import { join } from 'node:path';
import { type AtlasEdge, type Flow, type FlowStep, type NodeKind, emptyResult, normalizeId } from '../model.js';
import { globToRegExp, readText } from '../util.js';
import type { Scanner } from './types.js';

const KIND_NAMES: Record<string, number> = {
  SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2, SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5,
};
const SERVER = 2, CLIENT = 3, PRODUCER = 4, CONSUMER = 5;

const MESSAGING_TECH: Record<string, string> = {
  servicebus: 'Azure Service Bus', 'azure.servicebus': 'Azure Service Bus', eventhubs: 'Azure Event Hubs',
  kafka: 'Kafka', rabbitmq: 'RabbitMQ', aws_sqs: 'Amazon SQS', activemq: 'ActiveMQ',
};
const DB_TECH: Record<string, string> = {
  mssql: 'SQL Server', 'microsoft.sql_server': 'SQL Server', postgresql: 'PostgreSQL', mysql: 'MySQL',
  mongodb: 'MongoDB', redis: 'Redis', cosmosdb: 'Azure Cosmos DB', 'azure.cosmosdb': 'Azure Cosmos DB',
};

interface Span {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  service: string; attrs: Record<string, string>; start: bigint;
}

function attrValue(v: any): string {
  if (!v) return '';
  return String(v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? '');
}

function readSpans(doc: any): Span[] {
  const spans: Span[] = [];
  const batches = doc?.resourceSpans ?? doc?.batches ?? [];
  for (const rs of batches) {
    const resAttrs = Object.fromEntries((rs.resource?.attributes ?? []).map((a: any) => [a.key, attrValue(a.value)]));
    const service = resAttrs['service.name'];
    if (!service) continue;
    for (const ss of rs.scopeSpans ?? rs.instrumentationLibrarySpans ?? []) {
      for (const s of ss.spans ?? []) {
        spans.push({
          traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId || undefined, name: s.name ?? '',
          kind: typeof s.kind === 'number' ? s.kind : KIND_NAMES[s.kind] ?? 1,
          service: normalizeId(service),
          attrs: Object.fromEntries((s.attributes ?? []).map((a: any) => [a.key, attrValue(a.value)])),
          start: BigInt(s.startTimeUnixNano ?? 0),
        });
      }
    }
  }
  return spans;
}

export const scanOtel: Scanner = (ctx) => {
  const result = emptyResult();
  const globs = ctx.config.scan.traces.map(globToRegExp);
  const files = ctx.files.filter((f) => globs.some((g) => g.test(f)));
  const edges = new Map<string, AtlasEdge>();
  const flows = new Map<string, Flow>();
  const nodeKinds = new Map<string, { kind: NodeKind; tech?: string }>();

  const bump = (from: string, to: string, kind: AtlasEdge['kind'], protocol?: string) => {
    if (!from || !to || from === to) return;
    const key = `${from}|${to}|${kind}`;
    const e = edges.get(key) ?? { from, to, kind, ...(protocol ? { protocol } : {}), observed: 0, sources: ['otel'] };
    e.observed = (e.observed ?? 0) + 1;
    edges.set(key, e);
  };

  for (const f of files) {
    let doc: any;
    try { doc = JSON.parse(readText(join(ctx.root, f)) ?? ''); } catch { continue; }
    const spans = readSpans(doc);
    if (!spans.length) continue;
    const byId = new Map(spans.map((s) => [`${s.traceId}/${s.spanId}`, s]));
    const hasRemoteChild = new Set<string>();
    for (const s of spans) {
      const p = s.parentSpanId && byId.get(`${s.traceId}/${s.parentSpanId}`);
      if (p && p.service !== s.service) hasRemoteChild.add(`${p.traceId}/${p.spanId}`);
    }

    const traceSteps = new Map<string, Array<FlowStep & { t: bigint }>>();
    const step = (s: Span, from: string, to: string, action: string) => {
      const list = traceSteps.get(s.traceId) ?? [];
      list.push({ from, to, action, t: s.start });
      traceSteps.set(s.traceId, list);
    };

    for (const s of spans) {
      nodeKinds.set(s.service, nodeKinds.get(s.service) ?? { kind: 'service' });
      const parent = s.parentSpanId ? byId.get(`${s.traceId}/${s.parentSpanId}`) : undefined;
      const a = s.attrs;
      const dest = a['messaging.destination.name'] ?? a['messaging.destination'];
      const msgSystem = a['messaging.system'];

      if (s.kind === SERVER && parent && parent.service !== s.service) {
        const protocol = a['rpc.system'] === 'grpc' ? 'grpc' : 'http';
        bump(parent.service, s.service, 'calls', protocol);
        step(s, parent.service, s.service, s.name);
      } else if (s.kind === PRODUCER && dest) {
        const id = normalizeId(dest);
        nodeKinds.set(id, { kind: /queue/i.test(a['messaging.destination.kind'] ?? '') ? 'queue' : 'topic', tech: MESSAGING_TECH[msgSystem ?? ''] });
        bump(s.service, id, 'publishes');
        step(s, s.service, id, `publish ${dest}`);
      } else if (s.kind === CONSUMER && dest) {
        const id = normalizeId(dest);
        if (!nodeKinds.has(id)) nodeKinds.set(id, { kind: 'topic', tech: MESSAGING_TECH[msgSystem ?? ''] });
        bump(s.service, id, 'consumes');
        step(s, id, s.service, s.name || `consume ${dest}`);
      } else if (s.kind === CLIENT && (a['db.system'] || a['db.system.name'])) {
        const system = a['db.system'] ?? a['db.system.name']!;
        const id = normalizeId(a['db.name'] ?? a['db.namespace'] ?? system);
        nodeKinds.set(id, { kind: system === 'redis' ? 'cache' : 'database', tech: DB_TECH[system] ?? system });
        bump(s.service, id, 'stores');
        step(s, s.service, id, a['db.operation'] ?? a['db.operation.name'] ?? s.name);
      } else if (s.kind === CLIENT && !hasRemoteChild.has(`${s.traceId}/${s.spanId}`)) {
        const peer = a['peer.service'] ?? a['server.address'] ?? a['net.peer.name'];
        if (!peer || /^(localhost|127\.)/.test(peer)) continue;
        const id = normalizeId(peer.includes('.') && !a['peer.service'] ? peer.split('.')[0]! : peer);
        if (!nodeKinds.has(id)) nodeKinds.set(id, { kind: 'external' });
        bump(s.service, id, 'calls', a['rpc.system'] === 'grpc' ? 'grpc' : 'http');
        step(s, s.service, id, s.name);
      }
    }

    for (const [traceId, list] of traceSteps) {
      const root = spans.find((s) => s.traceId === traceId && (!s.parentSpanId || !byId.has(`${s.traceId}/${s.parentSpanId}`)));
      if (!root) continue;
      const name = `${root.name} (${root.service})`;
      const id = normalizeId(root.name.replace(/\{[^}]*\}/g, '')) || normalizeId(name);
      if (flows.has(id)) continue;
      list.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
      flows.set(id, { id, name, description: `Observed in ${f}`, steps: list.map(({ from, to, action }) => ({ from, to, action })), sources: ['otel'] });
    }
  }

  for (const [id, info] of nodeKinds) {
    result.nodes.push({ id, kind: info.kind, ...(info.tech ? { tech: [info.tech] } : {}), sources: ['otel'] });
  }
  result.edges.push(...edges.values());
  result.flows.push(...flows.values());
  return result;
};
