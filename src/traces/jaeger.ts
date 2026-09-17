/**
 * Fetches recent traces from a Jaeger Query API and converts them to the OTLP JSON shape the
 * `otel` scanner already reads. This is a CLI action, never a scanner: scanners stay read-only and
 * network-free (see CONTRIBUTING.md) so `agentatlas scan` stays deterministic. Run
 * `agentatlas fetch-traces` to write the result under the traces directory, then `agentatlas scan`
 * picks it up like any other committed trace file.
 *
 * Best-effort: this reads OpenTelemetry semantic-convention attributes (`rpc.system`,
 * `messaging.destination.name`, `db.system`, ...), which is what a Jaeger instance fed by an OTel
 * Collector stores. Traces from older OpenTracing-only instrumentation may use different tag names
 * and won't be interpreted as richly.
 */

interface JaegerTag { key: string; value: unknown }
interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  startTime: number; // microseconds since epoch
  references?: Array<{ refType: string; spanID: string }>;
  tags?: JaegerTag[];
  processID: string;
}
interface JaegerProcess { serviceName: string }
interface JaegerTrace { traceID: string; spans: JaegerSpan[]; processes: Record<string, JaegerProcess> }
interface JaegerResponse { data: JaegerTrace[] }

const KIND_MAP: Record<string, string> = {
  server: 'SPAN_KIND_SERVER', client: 'SPAN_KIND_CLIENT', producer: 'SPAN_KIND_PRODUCER', consumer: 'SPAN_KIND_CONSUMER',
};

function attrValue(value: unknown) {
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return { stringValue: String(value) };
}

/** Convert one Jaeger API trace into the `resourceSpans` shape `otel.ts` parses. */
export function jaegerTraceToOtlp(trace: JaegerTrace): any {
  const byService = new Map<string, any[]>();
  for (const span of trace.spans) {
    const service = trace.processes[span.processID]?.serviceName ?? 'unknown';
    const tags = Object.fromEntries((span.tags ?? []).map((t) => [t.key, t.value]));
    const kind = KIND_MAP[String(tags['span.kind'] ?? '').toLowerCase()] ?? 'SPAN_KIND_INTERNAL';
    const parentSpanId = span.references?.find((r) => r.refType === 'CHILD_OF')?.spanID;
    const list = byService.get(service) ?? [];
    list.push({
      traceId: span.traceID, spanId: span.spanID, ...(parentSpanId ? { parentSpanId } : {}),
      name: span.operationName, kind,
      startTimeUnixNano: String(Math.round(span.startTime * 1000)),
      attributes: Object.entries(tags).map(([key, value]) => ({ key, value: attrValue(value) })),
    });
    byService.set(service, list);
  }
  return {
    resourceSpans: [...byService.entries()].map(([service, spans]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [{ spans }],
    })),
  };
}

export interface FetchJaegerOptions {
  limit?: number;
  lookback?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

/** Fetch recent traces for one service from a Jaeger Query API (`GET /api/traces`). */
export async function fetchJaegerTraces(baseUrl: string, service: string, opts: FetchJaegerOptions = {}): Promise<any> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = new URL('/api/traces', baseUrl);
  url.searchParams.set('service', service);
  url.searchParams.set('limit', String(opts.limit ?? 20));
  if (opts.lookback) url.searchParams.set('lookback', opts.lookback);
  const res = await doFetch(url.toString(), opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined);
  if (!res.ok) throw new Error(`Jaeger query failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as JaegerResponse;
  return { resourceSpans: body.data.flatMap((trace) => jaegerTraceToOtlp(trace).resourceSpans) };
}
