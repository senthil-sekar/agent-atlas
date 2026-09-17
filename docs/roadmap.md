# Roadmap

## 0.1 (this release)
- Scanners: .NET, Java, Go, Python, Node.js (incl. React/Vue/Angular/Svelte SPAs), Docker Compose, OpenAPI, Bicep, OpenTelemetry (OTLP JSON)
- Outputs: `SYSTEM.md`, `.agentatlas/atlas.yaml`, Mermaid diagrams
- MCP server with 9 read-only tools and 2 resources
- Drift check for CI
- Claude Code plugin

## 0.2
- **Roslyn-based .NET analysis** (a companion `dotnet tool`) to find `HttpClient` registrations, MassTransit/Wolverine consumers, and EF `DbContext`s from code rather than config
- **Terraform** and **Kubernetes/Helm** scanners
- **AsyncAPI** for message schemas on topic nodes
- **Trace sources beyond files**: Application Insights and Jaeger queries
- **Contract info on edges** (which endpoints and message types each edge uses) for finer impact analysis

## 0.3
- **Multi-repo atlases**: merge the atlases of several repositories into one system view
- **Token-aware context packs**: `agentatlas pack <id>` produces the smallest map an agent needs for a task
- **Ownership** from CODEOWNERS
- **Draftsman integration**: validate new designs against the live topology
