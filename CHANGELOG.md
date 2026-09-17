# Changelog

## Unreleased

### Edges, not just nodes
- Configuration is now a first-class source of edges. `interpretSettings` normalizes environment-variable keys (`QUOTE_API_URL`, `ConnectionStrings__Quote`), recognizes connection strings and DSNs wherever they appear, and decides messaging direction from the key and the service's role
- New `env` scanner: `.env` files name stores, service URLs, topics, and queues for every language
- The `java` scanner reads `application.yml`/`.properties`, including profile documents, `${PLACEHOLDER:default}` resolution, Spring Cloud Stream bindings, and Redis hosts
- The `bicep` scanner emits edges from Container Apps `env:`, App Service `appSettings`, and `connectionStrings`, resolving `${resource.properties…}` references to the resource they name
- New `k8s` scanner: Deployments, StatefulSets, DaemonSets, Jobs, and CronJobs with `env`/`envFrom`; Services resolve to the workload they select; Ingress backends become gateway edges; Helm templates render best-effort from `values.yaml`
- New `routes` scanner: endpoints read from Spring, ASP.NET, FastAPI/Flask, Express/Nest, and Gin/Echo/chi source, so services without an OpenAPI document still publish their contracts
- A store inferred from a package (`quote-api-redis`) is now dropped once configuration names the real one
- Scanners: Java (Maven/Gradle, Spring Boot/Micronaut/Quarkus), Go (`go.mod` + `package main` directories, Gin/Echo/Fiber/chi/gorilla/gRPC), Python (`pyproject.toml`/`requirements.txt`, Django/Flask/FastAPI/Tornado/aiohttp/Starlette)
- `node` scanner now recognizes plain React, Vue, Angular, and Svelte SPAs as frontend nodes, not just meta-frameworks
- Default excludes cover Java/Go/Python build and dependency directories (`target`, `vendor`, `.venv`, `venv`, `__pycache__`, `build`, `.gradle`, `site-packages`)

## 0.1.0 — 2026-09-16

First release.

- Scanners: .NET, Node.js, Docker Compose, OpenAPI, Bicep, OpenTelemetry traces
- Graph merge with source tracking, aliases, prefix stripping, ignore list, and manual overlay
- Outputs: `SYSTEM.md`, `.agentatlas/atlas.yaml`, Mermaid topology and sequence diagrams
- CLI: `init`, `scan`, `check`, `summary`, `show`, `deps`, `callers`, `impact`, `path`, `flow`, `diagram`, `mcp`
- MCP server: 9 read-only tools, 2 resources, hot reload of the committed atlas
- Claude Code plugin with the MCP server, a `system-map` skill, and `/agentatlas:map`
- Example: quote-to-bind (auto insurance)
