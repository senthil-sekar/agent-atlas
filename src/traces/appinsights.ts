/**
 * Fetches recent request/dependency telemetry from an Application Insights workspace and converts
 * it to the OTLP JSON shape the `otel` scanner already reads. Like the Jaeger fetcher, this is a
 * CLI action, never a scanner: it makes a network call, which scanners never do (see
 * CONTRIBUTING.md), so `agentatlas scan` stays deterministic. Run `agentatlas fetch-traces` to
 * write the result under the traces directory.
 *
 * Best-effort: Application Insights' `dependencies.type` is free text ("SQL", "Azure Service Bus",
 * "HTTP", ...). It's mapped to the same db.system/messaging.system vocabulary `otel.ts` already
 * understands; a type this doesn't recognize is still captured as a plain outbound call.
 */

const QUERY = `let req = requests | project timestamp, id, operation_Id, operation_ParentId, name, service=cloud_RoleName, spanKind='server', target='', depType='';
let dep = dependencies | project timestamp, id, operation_Id, operation_ParentId, name, service=cloud_RoleName, spanKind='client', target, depType=type;
req | union dep | order by timestamp asc | take {take}`;

function classifyDependency(depType: string): { messaging?: string; db?: string } {
  const t = depType.toLowerCase();
  if (t.includes('service bus')) return { messaging: 'servicebus' };
  if (t.includes('event hub')) return { messaging: 'eventhubs' };
  if (t.includes('queue')) return { messaging: 'aws_sqs' };
  if (t === 'sql' || t.includes('sql')) return { db: 'mssql' };
  if (t.includes('documentdb') || t.includes('cosmos')) return { db: 'cosmosdb' };
  if (t.includes('postgres')) return { db: 'postgresql' };
  if (t.includes('mysql')) return { db: 'mysql' };
  if (t.includes('redis')) return { db: 'redis' };
  return {};
}

interface AiTable { columns: Array<{ name: string }>; rows: unknown[][] }
interface AiResult { tables?: AiTable[] }

function rowToSpan(row: unknown[], col: Record<string, number>): any {
  const get = (name: string) => row[col[name]!];
  const spanKind = String(get('spanKind') ?? '');
  const depType = String(get('depType') ?? '');
  const target = String(get('target') ?? '');
  const attrs: Record<string, string> = {};
  let kind = 'SPAN_KIND_INTERNAL';

  if (spanKind === 'server') {
    kind = 'SPAN_KIND_SERVER';
  } else if (spanKind === 'client') {
    const cls = classifyDependency(depType);
    if (cls.messaging) {
      kind = 'SPAN_KIND_PRODUCER';
      attrs['messaging.destination.name'] = target;
      attrs['messaging.system'] = cls.messaging;
    } else if (cls.db) {
      kind = 'SPAN_KIND_CLIENT';
      attrs['db.system'] = cls.db;
      attrs['db.name'] = target;
    } else {
      kind = 'SPAN_KIND_CLIENT';
      attrs['peer.service'] = target;
      if (depType.toLowerCase().includes('grpc')) attrs['rpc.system'] = 'grpc';
    }
  }

  const operationParentId = get('operation_ParentId');
  return {
    traceId: String(get('operation_Id') ?? ''),
    spanId: String(get('id') ?? ''),
    ...(operationParentId ? { parentSpanId: String(operationParentId) } : {}),
    name: String(get('name') ?? ''),
    kind,
    startTimeUnixNano: String(new Date(String(get('timestamp'))).getTime() * 1e6),
    attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
    service: String(get('service') ?? 'unknown'),
  };
}

/** Convert an Application Insights query result (the `tables` response shape) into OTLP JSON. */
export function applicationInsightsResultToOtlp(result: AiResult): any {
  const table = result.tables?.[0];
  if (!table) return { resourceSpans: [] };
  const col = Object.fromEntries(table.columns.map((c, i) => [c.name, i]));
  const byService = new Map<string, any[]>();
  for (const row of table.rows) {
    const span = rowToSpan(row, col);
    const { service, ...rest } = span;
    const list = byService.get(service) ?? [];
    list.push(rest);
    byService.set(service, list);
  }
  return {
    resourceSpans: [...byService.entries()].map(([service, spans]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [{ spans }],
    })),
  };
}

export interface FetchAppInsightsOptions {
  timespan?: string;
  take?: number;
  fetchImpl?: typeof fetch;
}

/** Fetch recent requests and dependencies from an Application Insights app via its REST query API. */
export async function fetchApplicationInsightsTraces(appId: string, apiKey: string, opts: FetchAppInsightsOptions = {}): Promise<any> {
  const doFetch = opts.fetchImpl ?? fetch;
  const query = QUERY.replace('{take}', String(opts.take ?? 200));
  const url = new URL(`https://api.applicationinsights.io/v1/apps/${appId}/query`);
  if (opts.timespan) url.searchParams.set('timespan', opts.timespan);
  const res = await doFetch(url.toString(), {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Application Insights query failed: ${res.status} ${res.statusText}`);
  return applicationInsightsResultToOtlp((await res.json()) as AiResult);
}
