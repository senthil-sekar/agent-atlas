import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { project } from './helpers.js';

describe('node + compose projects', () => {
  const root = project({
    'services/orders/package.json': JSON.stringify({ name: '@shop/orders', dependencies: { express: '4', pg: '8', kafkajs: '2' } }),
    'services/web/package.json': JSON.stringify({ name: 'storefront', dependencies: { next: '14' } }),
    'packages/utils/package.json': JSON.stringify({ name: '@shop/utils', dependencies: { lodash: '4' } }),
    'services/orders/node_modules/express/package.json': JSON.stringify({ name: 'express', dependencies: { koa: '1' } }),
    'compose.yaml': `
services:
  orders-api:
    build: ./services/orders
    environment:
      DATABASE_URL: postgres://app@db:5432/orders
      PAYMENTS_URL: https://api.payments.example.com
    depends_on:
      db:
        condition: service_healthy
  storefront:
    build: { context: ./services/web }
    environment: ["API_URL=http://orders-api:3000"]
  db:
    image: postgres:16
`,
  });
  const { atlas } = buildAtlas(root);
  const ids = atlas.nodes.map((n) => `${n.id}:${n.kind}`);

  it('links code to compose services by build context', () => {
    expect(ids).toContain('orders-api:service');
    expect(ids).toContain('storefront:frontend');
    expect(ids).not.toContain('orders:service');
    expect(atlas.nodes.find((n) => n.id === 'orders-api')!.tech).toEqual(expect.arrayContaining(['Express', 'PostgreSQL', 'Kafka']));
  });

  it('ignores libraries and node_modules', () => {
    expect(ids.some((i) => i.startsWith('utils') || i.startsWith('express'))).toBe(false);
  });

  it('turns depends_on and env hostnames into edges', () => {
    const edges = atlas.edges.map((e) => `${e.from}-${e.kind}-${e.to}`);
    expect(edges).toContain('orders-api-stores-db');
    expect(edges).toContain('storefront-calls-orders-api');
  });
});

describe('bicep', () => {
  it('reads resources and function apps, skipping existing and non-literal names', () => {
    const root = project({
      'main.bicep': `
resource fn 'Microsoft.Web/sites@2023-12-01' = {
  name: 'claims-intake-func'
  kind: 'functionapp,linux'
}
resource shared 'Microsoft.Cache/redis@2024-03-01' existing = {
  name: 'shared-redis'
}
resource dyn 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
}
resource q 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: ns
  name: 'claims-received'
}
`,
    });
    const { atlas, warnings } = buildAtlas(root);
    expect(atlas.nodes.map((n) => `${n.id}:${n.kind}:${n.hosting ?? n.tech?.[0]}`)).toEqual([
      'claims-intake-func:function:Azure Functions',
      'claims-received:queue:Azure Service Bus',
    ]);
    expect(warnings[0]).toMatch(/non-literal name/);
  });
});

describe('otel', () => {
  it('accepts string span kinds and gRPC', () => {
    const attr = (key: string, v: string) => ({ key, value: { stringValue: v } });
    const root = project({
      'traces/t.json': JSON.stringify({
        resourceSpans: [
          { resource: { attributes: [attr('service.name', 'Web')] }, scopeSpans: [{ spans: [
            { traceId: 't', spanId: '1', name: 'GET /', kind: 'SPAN_KIND_SERVER', startTimeUnixNano: '1' },
            { traceId: 't', spanId: '2', parentSpanId: '1', name: 'Pricing/Get', kind: 'SPAN_KIND_CLIENT', startTimeUnixNano: '2' },
          ] }] },
          { resource: { attributes: [attr('service.name', 'Pricing')] }, scopeSpans: [{ spans: [
            { traceId: 't', spanId: '3', parentSpanId: '2', name: 'Pricing/Get', kind: 'SPAN_KIND_SERVER', startTimeUnixNano: '3', attributes: [attr('rpc.system', 'grpc')] },
          ] }] },
        ],
      }),
    });
    const { atlas } = buildAtlas(root);
    expect(atlas.edges).toEqual([{ from: 'web', to: 'pricing', kind: 'calls', protocol: 'grpc', observed: 1, sources: ['otel'] }]);
    expect(atlas.flows[0]!.steps).toEqual([{ from: 'web', to: 'pricing', action: 'Pricing/Get' }]);
  });
});

describe('config', () => {
  it('reports invalid config clearly', () => {
    const root = project({ 'agentatlas.yaml': 'version: 1\nsystem: {}\nnodes:\n  - id: x\n    kind: banana\n' });
    expect(() => loadConfig(root)).toThrow(ConfigError);
    expect(() => loadConfig(root)).toThrow(/system\.name[\s\S]*nodes\.0\.kind/);
  });

  it('defaults the system name to the folder name', () => {
    const root = project({ 'README.md': '# hi' });
    expect(loadConfig(root).system.name).toMatch(/^agentatlas-/);
  });

  it('applies aliases and creates external nodes for unknown edge targets', () => {
    const root = project({
      'agentatlas.yaml': 'version: 1\nsystem: { name: t }\naliases: { svc-a: alpha }\nedges:\n  - { from: svc-a, to: mystery }\n',
    });
    const { atlas } = buildAtlas(root);
    expect(atlas.edges).toEqual([{ from: 'alpha', to: 'mystery', kind: 'calls', sources: ['manual'] }]);
    expect(atlas.nodes.map((n) => `${n.id}:${n.kind}`)).toEqual(['alpha:external', 'mystery:external']);
  });
});
