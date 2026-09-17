# Changelog

## Unreleased
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
