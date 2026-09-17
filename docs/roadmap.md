# Roadmap

## 0.1 (shipped)
- Scanners: .NET, Java, Go, Python, Node.js (incl. React/Vue/Angular/Svelte SPAs), Docker Compose, OpenAPI, Bicep, OpenTelemetry (OTLP JSON)
- Outputs: `SYSTEM.md`, `.agentatlas/atlas.yaml`, Mermaid diagrams
- MCP server with 9 read-only tools and 2 resources
- Drift check for CI
- Claude Code plugin

## 0.2 — edges, not just nodes

A service inventory is not a map. The value of the atlas is in its edges: which
service calls which, who consumes a message, what breaks downstream. Today only
.NET (via `appsettings.json`), Docker Compose, and OpenTelemetry traces produce
those edges. Every other scanner contributes nodes and little else — Bicep finds
resources but no wiring, and the Java, Go, Python, and Node scanners find
services but no dependencies between them.

0.2 closes that gap.

- **Configuration as a first-class source.** `interpretSettings` becomes the
  shared spine every scanner feeds, with key normalization so environment-variable
  style (`QUOTE_API_URL`, `SPRING_DATASOURCE_URL`, `ConnectionStrings__Quote`)
  and nested config reach the same heuristics:
  - a `.env` scanner that serves every language
  - Spring `application.yml` / `application.properties`, including profile variants
    and `spring.cloud.stream` bindings
  - URL and connection-string literals from source configuration modules
- **Edges from infrastructure.** Container Apps `env:`, App Service `appSettings`,
  and `connectionStrings` in Bicep, plus a **Kubernetes/Helm** scanner
  (Deployments, Services, Ingress, ConfigMaps, and `image:` links to code projects).
- **Routes without a spec.** Endpoints read from source — Spring `@GetMapping`,
  ASP.NET `[HttpGet]`/`MapGet`, FastAPI and Flask decorators, Express and Nest
  routes, Gin/Echo/chi registrations — so services without an OpenAPI document
  still publish their contracts, and route changes show up in `agentatlas check`.

## 0.3 — sharper answers for agents

- **Token-aware context packs** (shipped): `agentatlas pack <id>` and the `pack_context`
  MCP tool produce the smallest map an agent needs for a task — direct dependencies and
  callers always included, transitive impact and dependency and full flow detail added
  and trimmed by priority under a token budget.
- **Ownership from CODEOWNERS** (shipped): the `codeowners` scanner attributes each
  service so `impact` and `get_service` can say who to tell. A manual `owner` still wins.
- **`agentatlas doctor`** (shipped): reports what the scanners could not resolve —
  stores guessed from a dependency but never named, compute nodes with no edges at all,
  external systems with no real description — with a paste-ready fix for each.

Still open:
- **Contract info on edges**: which endpoints and message types each edge uses, for finer impact analysis
- **Terraform** scanner, mirroring the Bicep work
- **AsyncAPI** for message schemas on topic nodes

## Later
- **Multi-repo atlases**: merge the atlases of several repositories into one system view
- **Trace sources beyond files**: Application Insights and Jaeger queries
- **Draftsman integration**: validate new designs against the live topology
- **Roslyn-based .NET analysis** (a companion `dotnet tool`) for `HttpClient` registrations, MassTransit/Wolverine consumers, and EF `DbContext`s. Deprioritized: configuration and route scanning reach most of the same edges without shipping a second toolchain.
