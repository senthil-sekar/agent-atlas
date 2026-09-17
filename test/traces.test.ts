import { describe, expect, it } from 'vitest';
import { applicationInsightsResultToOtlp } from '../src/traces/appinsights.js';
import { fetchJaegerTraces, jaegerTraceToOtlp } from '../src/traces/jaeger.js';

describe('Jaeger trace conversion', () => {
  const trace = {
    traceID: 't1',
    processes: { p1: { serviceName: 'gateway' }, p2: { serviceName: 'quote-api' } },
    spans: [
      { traceID: 't1', spanID: 's1', operationName: 'POST /v1/quotes', startTime: 1000, processID: 'p1', tags: [{ key: 'span.kind', value: 'client' }] },
      { traceID: 't1', spanID: 's2', operationName: 'POST /v1/quotes', startTime: 1010, processID: 'p2',
        references: [{ refType: 'CHILD_OF', spanID: 's1' }],
        tags: [{ key: 'span.kind', value: 'server' }] },
    ],
  };

  it('converts to the resourceSpans shape the otel scanner reads', () => {
    const otlp = jaegerTraceToOtlp(trace);
    expect(otlp.resourceSpans).toHaveLength(2);
    const services = otlp.resourceSpans.map((rs: any) => rs.resource.attributes[0].value.stringValue);
    expect(services.sort()).toEqual(['gateway', 'quote-api']);
    const server = otlp.resourceSpans.find((rs: any) => rs.resource.attributes[0].value.stringValue === 'quote-api');
    expect(server.scopeSpans[0].spans[0].kind).toBe('SPAN_KIND_SERVER');
    expect(server.scopeSpans[0].spans[0].parentSpanId).toBe('s1');
  });

  it('fetches from the Jaeger Query API and flattens all traces', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [trace] }) } as Response;
    }) as typeof fetch;
    const otlp = await fetchJaegerTraces('http://jaeger:16686', 'quote-api', { limit: 5, fetchImpl });
    expect(calls[0]).toContain('service=quote-api');
    expect(calls[0]).toContain('limit=5');
    expect(otlp.resourceSpans.length).toBe(2);
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch;
    await expect(fetchJaegerTraces('http://jaeger:16686', 'x', { fetchImpl })).rejects.toThrow(/500/);
  });
});

describe('Application Insights trace conversion', () => {
  it('unions requests and dependencies into per-service resourceSpans', () => {
    const result = {
      tables: [{
        columns: [
          { name: 'timestamp' }, { name: 'id' }, { name: 'operation_Id' }, { name: 'operation_ParentId' },
          { name: 'name' }, { name: 'service' }, { name: 'spanKind' }, { name: 'target' }, { name: 'depType' },
        ],
        rows: [
          ['2024-01-01T00:00:00Z', 'req1', 'op1', null, 'POST /v1/quotes', 'quote-api', 'server', '', ''],
          ['2024-01-01T00:00:01Z', 'dep1', 'op1', 'req1', 'SELECT', 'quote-api', 'client', 'quote-db', 'SQL'],
          ['2024-01-01T00:00:02Z', 'dep2', 'op1', 'req1', 'publish', 'quote-api', 'client', 'quote-bound', 'Azure Service Bus'],
        ],
      }],
    };
    const otlp = applicationInsightsResultToOtlp(result);
    expect(otlp.resourceSpans).toHaveLength(1);
    const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(3);
    const server = spans.find((s: any) => s.spanId === 'req1');
    expect(server.kind).toBe('SPAN_KIND_SERVER');
    const sql = spans.find((s: any) => s.spanId === 'dep1');
    expect(sql.kind).toBe('SPAN_KIND_CLIENT');
    expect(sql.attributes).toEqual(expect.arrayContaining([{ key: 'db.system', value: { stringValue: 'mssql' } }]));
    expect(sql.parentSpanId).toBe('req1');
    const sb = spans.find((s: any) => s.spanId === 'dep2');
    expect(sb.kind).toBe('SPAN_KIND_PRODUCER');
    expect(sb.attributes).toEqual(expect.arrayContaining([
      { key: 'messaging.destination.name', value: { stringValue: 'quote-bound' } },
      { key: 'messaging.system', value: { stringValue: 'servicebus' } },
    ]));
  });

  it('returns no spans for an empty result', () => {
    expect(applicationInsightsResultToOtlp({}).resourceSpans).toEqual([]);
  });
});
