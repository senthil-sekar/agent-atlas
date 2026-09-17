import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { classifyDsn, normalizeEnvKey } from '../src/scanners/settings.js';
import { project } from './helpers.js';

const edges = (atlas: { edges: Array<{ from: string; to: string; kind: string }> }) =>
  atlas.edges.map((e) => `${e.from}-${e.kind}-${e.to}`);

describe('configuration key normalization', () => {
  it('maps environment-variable style onto canonical keys', () => {
    expect(normalizeEnvKey('QUOTE_API_URL')).toBe('QUOTE_API:URL');
    expect(normalizeEnvKey('RATING_ENGINE_BASE_URL')).toBe('RATING_ENGINE:BASEURL');
    expect(normalizeEnvKey('ConnectionStrings__QuoteDb')).toBe('ConnectionStrings:QuoteDb');
    expect(normalizeEnvKey('QUOTE_BOUND_TOPIC_NAME')).toBe('QUOTE_BOUND:TOPICNAME');
    expect(normalizeEnvKey('LOG_LEVEL')).toBe('LOG_LEVEL');
  });
});

describe('DSN classification', () => {
  it('names a store from its hostname, or its database when the host is not a service', () => {
    expect(classifyDsn('postgres://app@quote-db:5432/quotes')).toEqual({ kind: 'database', tech: 'PostgreSQL', id: 'quote-db' });
    expect(classifyDsn('jdbc:postgresql://claims.postgres.database.azure.com:5432/claims'))
      .toEqual({ kind: 'database', tech: 'PostgreSQL', id: 'claims' });
    expect(classifyDsn('Server=sql;Database=PolicyDb')).toEqual({ kind: 'database', tech: 'SQL Server', id: 'policy-db' });
    expect(classifyDsn('redis://localhost:6379')).toBeNull(); // a local host names nothing
    expect(classifyDsn('https://api.example.com')).toBeNull();
    expect(classifyDsn('not a connection string')).toBeNull();
  });
});

describe('.env files', () => {
  const root = project({
    'services/claims/pyproject.toml': '[project]\nname = "claims-api"\ndependencies = ["fastapi"]\n',
    'services/claims/.env': [
      '# local development',
      'DATABASE_URL=postgresql://claims-db:5432/claims',
      'REDIS_URL=redis://claims-cache:6379',
      'RATING_ENGINE_BASE_URL=https://rating-engine',
      'QUOTE_BOUND_TOPIC=quote-bound',
      'export PAYMENTS_URL="https://api.payments.example.com"',
      'LOG_LEVEL=debug',
    ].join('\n'),
  });
  const { atlas } = buildAtlas(root);

  it('turns connection strings and service URLs into edges', () => {
    expect(edges(atlas)).toEqual(expect.arrayContaining([
      'claims-api-stores-claims-db',
      'claims-api-stores-claims-cache',
      'claims-api-calls-rating-engine',
      'claims-api-publishes-quote-bound',
      'claims-api-calls-payments',
    ]));
  });

  it('records what each store is without inventing nodes for plain settings', () => {
    const byId = new Map(atlas.nodes.map((n) => [n.id, n]));
    expect(byId.get('claims-db')!.tech).toEqual(['PostgreSQL']);
    expect(byId.get('claims-cache')!.kind).toBe('cache');
    expect(byId.get('payments')!.kind).toBe('external');
    expect(byId.has('log-level')).toBe(false);
  });
});

describe('inferred stores', () => {
  const goModule = {
    'go.mod': 'module github.com/contoso/rating-engine\n\nrequire github.com/redis/go-redis/v9 v9.3.0\n',
    'main.go': 'package main\n\nfunc main() {}\n',
  };

  it('keeps a placeholder when nothing names the store', () => {
    const { atlas } = buildAtlas(project(goModule));
    expect(atlas.nodes.map((n) => n.id)).toContain('rating-engine-redis');
  });

  it('drops the placeholder once configuration names the real store', () => {
    const { atlas } = buildAtlas(project({ ...goModule, '.env': 'REDIS_URL=redis://rating-cache:6379\n' }));
    const ids = atlas.nodes.map((n) => n.id);
    expect(ids).toContain('rating-cache');
    expect(ids).not.toContain('rating-engine-redis');
    expect(edges(atlas)).toEqual(['rating-engine-stores-rating-cache']);
  });
});

describe('spring configuration', () => {
  const pom = (artifact: string, extra = '') => `
<project>
  <artifactId>${artifact}</artifactId>
  <dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.springframework.kafka</groupId><artifactId>spring-kafka</artifactId></dependency>
    ${extra}
  </dependencies>
</project>`;

  it('reads datasources, stream bindings, and client URLs', () => {
    const root = project({
      'services/quote/pom.xml': pom('quote-api'),
      'services/quote/src/main/resources/application.yml': `
spring:
  datasource:
    url: jdbc:postgresql://quote-db:5432/quotes
  cloud:
    stream:
      bindings:
        quoteBound-out-0:
          destination: quote-bound
        policyIssued-in-0:
          destination: policy-issued
rating:
  engine:
    url: http://rating-engine:8080
`,
    });
    const { atlas } = buildAtlas(root);
    expect(edges(atlas)).toEqual(expect.arrayContaining([
      'quote-api-stores-quote-db',
      'quote-api-publishes-quote-bound',
      'quote-api-consumes-policy-issued',
      'quote-api-calls-rating-engine',
    ]));
    expect(atlas.nodes.find((n) => n.id === 'quote-bound')!.tech).toContain('Kafka');
  });

  it('resolves placeholders and reads .properties files', () => {
    const root = project({
      'pom.xml': pom('policy-worker'),
      'src/main/resources/application.properties': [
        'spring.datasource.url=jdbc:postgresql://${DB_HOST:policy-db}:5432/policies',
        'spring.data.redis.host=policy-cache',
        '# a comment',
      ].join('\n'),
    });
    const { atlas } = buildAtlas(root);
    expect(edges(atlas)).toEqual(expect.arrayContaining(['policy-worker-stores-policy-db', 'policy-worker-stores-policy-cache']));
  });
});

describe('kubernetes', () => {
  const root = project({
    'deploy/quote-api.yaml': `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: quote-api
spec:
  template:
    metadata:
      labels: { app: quote-api }
    spec:
      containers:
        - name: api
          image: contoso.azurecr.io/quote-api:1.2.3
          env:
            - { name: RATING_ENGINE_URL, value: "http://rating-engine:8080" }
            - { name: DATABASE_URL, value: "postgres://quote-db:5432/quotes" }
          envFrom:
            - configMapRef: { name: shared-config }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: shared-config
data:
  QUOTE_BOUND_TOPIC: quote-bound
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: rating-engine-deployment
spec:
  template:
    metadata:
      labels: { app: rating-engine }
    spec:
      containers:
        - name: engine
          image: contoso.azurecr.io/rating-engine:1.0.0
---
apiVersion: v1
kind: Service
metadata:
  name: rating-engine
spec:
  selector: { app: rating-engine }
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: edge
spec:
  rules:
    - host: quotes.contoso.com
      http:
        paths:
          - path: /v1/quotes
            backend: { service: { name: quote-api } }
`,
  });
  const { atlas } = buildAtlas(root);

  it('reads env, envFrom, and ingress backends', () => {
    expect(edges(atlas)).toEqual(expect.arrayContaining([
      'quote-api-calls-rating-engine',
      'quote-api-stores-quote-db',
      'quote-api-publishes-quote-bound',
      'edge-calls-quote-api',
    ]));
    expect(atlas.nodes.find((n) => n.id === 'quote-api')!.hosting).toBe('Kubernetes');
  });

  it('names a workload by the Service that selects it', () => {
    const ids = atlas.nodes.map((n) => n.id);
    expect(ids).toContain('rating-engine');
    expect(ids).not.toContain('rating-engine-deployment');
  });
});

describe('routes read from source', () => {
  it('finds endpoints without an OpenAPI document', () => {
    const root = project({
      'services/quote/pom.xml': `
<project><artifactId>quote-api</artifactId><dependencies>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
</dependencies></project>`,
      'services/quote/src/main/java/QuoteController.java': `
@RestController
@RequestMapping("/v1/quotes")
public class QuoteController {
  @PostMapping
  public Quote create(@RequestBody QuoteRequest request) { return null; }

  @GetMapping("/{quoteId}")
  public Quote get(@PathVariable String quoteId) { return null; }
}`,
      'services/quote/src/test/java/QuoteControllerTest.java': '@GetMapping("/should-not-appear") class QuoteControllerTest {}',
      'services/claims/pyproject.toml': '[project]\nname = "claims-api"\ndependencies = ["fastapi"]\n',
      'services/claims/main.py': [
        'app = FastAPI()',
        '@app.get("/health")',
        'def health(): return {}',
        '@app.post("/v1/claims")',
        'def create(): return {}',
      ].join('\n'),
      'services/notify/go.mod': 'module github.com/contoso/notify\n\nrequire github.com/gin-gonic/gin v1.9.1\n',
      'services/notify/main.go': 'package main\n\nfunc main() {\n  r.POST("/v1/notifications", send)\n  r.GET("/healthz", ok)\n}\n',
    });
    const { atlas } = buildAtlas(root);
    const endpoints = (id: string) =>
      atlas.nodes.find((n) => n.id === id)!.endpoints!.map((e) => `${e.method} ${e.path}`);

    expect(endpoints('quote-api')).toEqual(['POST /v1/quotes', 'GET /v1/quotes/{quoteId}']);
    expect(endpoints('claims-api')).toEqual(['GET /health', 'POST /v1/claims']);
    expect(endpoints('notify')).toEqual(['GET /healthz', 'POST /v1/notifications']);
  });

  it('reads ASP.NET controllers and minimal APIs', () => {
    const root = project({
      'src/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><AssemblyName>policy-api</AssemblyName></PropertyGroup></Project>',
      'src/Api/PoliciesController.cs': `
[ApiController]
[Route("api/[controller]")]
public class PoliciesController : ControllerBase {
  [HttpGet("{id}")]
  public Policy Get(string id) => null;

  [HttpPost]
  public Policy Create() => null;
}`,
      'src/Api/Program.cs': 'var app = builder.Build();\napp.MapGet("/healthz", () => "ok");\n',
    });
    const { atlas } = buildAtlas(root);
    expect(atlas.nodes.find((n) => n.id === 'policy-api')!.endpoints!.map((e) => `${e.method} ${e.path}`))
      .toEqual(['POST /api/Policies', 'GET /api/Policies/{id}', 'GET /healthz']);
  });
});
