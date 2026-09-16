import { describe, expect, it } from 'vitest';
import { normalizeId } from '../src/model.js';
import { bicepName } from '../src/scanners/bicep.js';
import { classifyConnectionString, interpretSettings } from '../src/scanners/settings.js';
import { flatten, globToRegExp, parseLooseJson } from '../src/util.js';

describe('normalizeId', () => {
  it.each([
    ['Contoso.Quote.Api', 'contoso-quote-api'],
    ['QuoteDb', 'quote-db'],
    ['quote_api', 'quote-api'],
    ['HTTPGateway', 'http-gateway'],
    ['  --Rating Engine-- ', 'rating-engine'],
  ])('%s → %s', (input, expected) => expect(normalizeId(input)).toBe(expected));
});

describe('globToRegExp', () => {
  it('matches ** across folders and * within one', () => {
    expect(globToRegExp('**/*.otlp.json').test('a/b/trace.otlp.json')).toBe(true);
    expect(globToRegExp('**/*.otlp.json').test('trace.otlp.json')).toBe(true);
    expect(globToRegExp('traces/*.json').test('traces/sub/x.json')).toBe(false);
    expect(globToRegExp('**/bin/**').test('src/App/bin/')).toBe(true);
  });
});

describe('parseLooseJson', () => {
  it('accepts comments and trailing commas but keeps // inside strings', () => {
    const doc = parseLooseJson('{ // c\n "url": "http://x/y", /* block */ "a": [1,2,], }') as any;
    expect(doc).toEqual({ url: 'http://x/y', a: [1, 2] });
    expect(flatten(doc)).toEqual([['url', 'http://x/y'], ['a:0', '1'], ['a:1', '2']]);
  });
});

describe('bicepName', () => {
  it('drops interpolations', () => {
    expect(bicepName('${prefix}-quote-api')).toBe('quote-api');
    expect(bicepName('${prefix}${env}-sb-${location}')).toBe('sb');
  });
});

describe('settings heuristics', () => {
  it('classifies connection strings', () => {
    expect(classifyConnectionString('Db', 'Server=x;Database=y')?.tech).toBe('SQL Server');
    expect(classifyConnectionString('Db', 'Host=x;Database=y;Username=u')?.tech).toBe('PostgreSQL');
    expect(classifyConnectionString('Cache', 'cache.internal:6379')?.kind).toBe('cache');
    expect(classifyConnectionString('Docs', 'AccountEndpoint=https://x.documents.azure.com')?.tech).toBe('Azure Cosmos DB');
    expect(classifyConnectionString('Bus', 'Endpoint=sb://x.servicebus.windows.net/;SharedAccessKey=k')).toBeNull();
  });

  it('turns URLs, topics, queues, and subscriptions into edges', () => {
    const { edges, nodes } = interpretSettings([
      ['Pricing:BaseUrl', 'http://pricing-svc:8080'],
      ['Partner:Endpoint', 'https://api.partner.example.com/v2'],
      ['Local:Url', 'http://localhost:5000'],
      ['Bus:OrdersTopic', 'orders-placed'],
      ['Bus:WorkQueue', 'work-items'],
      ['Bus:BillingSubscription', 'orders-placed/billing'],
    ], { serviceId: 'orders', source: 'dotnet', isWorker: false, messagingTech: 'Azure Service Bus' });
    const simple = edges.map((e) => `${e.kind}:${e.to}`);
    expect(simple).toEqual([
      'calls:pricing-svc', 'calls:partner', 'publishes:orders-placed', 'publishes:work-items', 'consumes:orders-placed',
    ]);
    expect(nodes.find((n) => n.id === 'partner')?.kind).toBe('external');
    expect(nodes.find((n) => n.id === 'work-items')?.tech).toEqual(['Azure Service Bus']);
  });

  it('treats queues as consumed by workers', () => {
    const { edges } = interpretSettings([['Queue', 'jobs']], { serviceId: 'w', source: 'dotnet', isWorker: true });
    expect(edges[0]?.kind).toBe('consumes');
  });
});
