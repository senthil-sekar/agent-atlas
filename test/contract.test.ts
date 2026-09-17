import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { project } from './helpers.js';

describe('AsyncAPI', () => {
  it('reads v3 channel messages onto the topic node', () => {
    const root = project({
      'asyncapi.yaml': `
asyncapi: 3.0.0
info: { title: t, version: 1.0.0 }
channels:
  quote-bound:
    address: quote-bound
    messages:
      QuoteBound:
        name: QuoteBound
        summary: A quote was accepted and bound.
`,
    });
    const { atlas } = buildAtlas(root);
    const topic = atlas.nodes.find((n) => n.id === 'quote-bound')!;
    expect(topic.kind).toBe('topic');
    expect(topic.messages).toEqual([{ name: 'QuoteBound', summary: 'A quote was accepted and bound.' }]);
  });

  it('reads v2 publish/subscribe message shapes, including oneOf', () => {
    const root = project({
      'asyncapi.yaml': `
asyncapi: 2.6.0
info: { title: t, version: 1.0.0 }
channels:
  policy-events:
    publish:
      message:
        oneOf:
          - name: PolicyIssued
          - name: PolicyCancelled
`,
    });
    const { atlas } = buildAtlas(root);
    const topic = atlas.nodes.find((n) => n.id === 'policy-events')!;
    expect(topic.messages?.map((m) => m.name).sort()).toEqual(['PolicyCancelled', 'PolicyIssued']);
  });

  it('lets an IaC-declared queue/topic kind win over the default topic guess', () => {
    const root = project({
      'asyncapi.yaml': 'asyncapi: 3.0.0\ninfo: { title: t, version: 1.0.0 }\nchannels:\n  orders:\n    messages:\n      Order: { name: Order }\n',
      'main.bicep': `
resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: 'sb'
}
resource q 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  parent: sb
  name: 'orders'
}
`,
    });
    const { atlas } = buildAtlas(root);
    const node = atlas.nodes.find((n) => n.id === 'orders')!;
    expect(node.kind).toBe('queue'); // bicep is authoritative on kind
    expect(node.messages?.map((m) => m.name)).toEqual(['Order']); // asyncapi's messages still merge in
  });

  it('auto-attaches an unambiguous message type to the edges that touch the topic', () => {
    const root = project({
      'asyncapi.yaml': 'asyncapi: 3.0.0\ninfo: { title: t, version: 1.0.0 }\nchannels:\n  quote-bound:\n    messages:\n      QuoteBound: { name: QuoteBound }\n',
      'services/quote/pom.xml': `
<project><artifactId>quote-api</artifactId><dependencies>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
  <dependency><groupId>org.springframework.kafka</groupId><artifactId>spring-kafka</artifactId></dependency>
</dependencies></project>`,
      'services/quote/src/main/resources/application.yml': 'spring:\n  cloud:\n    stream:\n      bindings:\n        quoteBound-out-0:\n          destination: quote-bound\n',
    });
    const { atlas } = buildAtlas(root);
    const edge = atlas.edges.find((e) => e.from === 'quote-api' && e.to === 'quote-bound' && e.kind === 'publishes')!;
    expect(edge.messageTypes).toEqual(['QuoteBound']);
  });

  it('does not guess a message type when the topic carries more than one', () => {
    const root = project({
      'asyncapi.yaml': `
asyncapi: 3.0.0
info: { title: t, version: 1.0.0 }
channels:
  policy-events:
    messages:
      PolicyIssued: { name: PolicyIssued }
      PolicyCancelled: { name: PolicyCancelled }
`,
      'agentatlas.yaml': 'version: 1\nsystem: { name: t }\nedges:\n  - { from: quote-api, to: policy-events, kind: publishes }\nnodes:\n  - { id: quote-api, kind: service }\n',
    });
    const { atlas } = buildAtlas(root);
    const edge = atlas.edges.find((e) => e.from === 'quote-api' && e.to === 'policy-events')!;
    expect(edge.messageTypes).toBeUndefined();
  });
});

describe('OpenTelemetry contract info', () => {
  const attr = (key: string, v: string) => ({ key, value: { stringValue: v } });

  it('records the callee endpoint on a calls edge', () => {
    const root = project({
      'traces/t.json': JSON.stringify({
        resourceSpans: [
          { resource: { attributes: [attr('service.name', 'Gateway')] }, scopeSpans: [{ spans: [
            { traceId: 't', spanId: '1', name: 'client-call', kind: 'SPAN_KIND_CLIENT', startTimeUnixNano: '1' },
          ] }] },
          { resource: { attributes: [attr('service.name', 'QuoteApi')] }, scopeSpans: [{ spans: [
            { traceId: 't', spanId: '2', parentSpanId: '1', name: 'POST /v1/quotes', kind: 'SPAN_KIND_SERVER', startTimeUnixNano: '2' },
          ] }] },
        ],
      }),
    });
    const { atlas } = buildAtlas(root);
    const edge = atlas.edges.find((e) => e.from === 'gateway' && e.to === 'quote-api')!;
    expect(edge.endpoints).toEqual(['POST /v1/quotes']);
  });

  it('records a messaging.message.type attribute on publish/consume edges', () => {
    const root = project({
      'traces/t.json': JSON.stringify({
        resourceSpans: [
          { resource: { attributes: [attr('service.name', 'QuoteApi')] }, scopeSpans: [{ spans: [
            { traceId: 't', spanId: '1', name: 'send', kind: 'SPAN_KIND_PRODUCER', startTimeUnixNano: '1', attributes: [
              attr('messaging.destination.name', 'quote-bound'), attr('messaging.message.type', 'QuoteBound'),
            ] },
          ] }] },
        ],
      }),
    });
    const { atlas } = buildAtlas(root);
    const edge = atlas.edges.find((e) => e.from === 'quote-api' && e.to === 'quote-bound')!;
    expect(edge.messageTypes).toEqual(['QuoteBound']);
  });
});
