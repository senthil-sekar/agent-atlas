# Roadmap

## 0.1 (shipped)
- Scanners: .NET, Java, Go, Python, Node.js (incl. React/Vue/Angular/Svelte SPAs), Docker Compose, OpenAPI, Bicep, OpenTelemetry (OTLP JSON)
- Outputs: `SYSTEM.md`, `.agentatlas/atlas.yaml`, Mermaid diagrams
- MCP server with 9 read-only tools and 2 resources
- Drift check for CI
- Claude Code plugin

## 0.2 — edges, not just nodes (shipped)

A service inventory is not a map. The value of the atlas is in its edges: which
service calls which, who consumes a message, what breaks downstream.

- **Configuration as a first-class source.** `interpretSettings` is the shared spine
  every scanner feeds, with key normalization so environment-variable style
  (`QUOTE_API_URL`, `ConnectionStrings__Quote`) and nested config reach the same
  heuristics: a `.env` scanner serving every language, Spring `application.yml`/
  `.properties` (profile variants, `spring.cloud.stream` bindings), and connection
  strings recognized by shape wherever they appear.
- **Edges from infrastructure.** Container Apps `env:`, App Service `appSettings`,
  and `connectionStrings` in Bicep; a Kubernetes/Helm scanner (Deployments, Services,
  Ingress, ConfigMaps, `image:` links to code projects).
- **Routes without a spec.** Endpoints read from Spring, ASP.NET, FastAPI/Flask,
  Express/Nest, and Gin/Echo/chi source, so services without an OpenAPI document
  still publish their contracts and route changes show up in `agentatlas check`.

## 0.3 — sharper answers for agents (shipped)

- **Token-aware context packs.** `agentatlas pack <id>` and the `pack_context` MCP
  tool produce the smallest map an agent needs for a task — direct dependencies and
  callers always included, transitive impact/dependencies and full flow detail added
  and trimmed by priority under a token budget.
- **Ownership from CODEOWNERS.** The `codeowners` scanner attributes each service so
  `impact` and `get_service` can say who to tell. A manual `owner` still wins.
- **`agentatlas doctor`.** Reports what scanners could not resolve — stores guessed
  from a dependency but never named, compute nodes with no edges at all, external
  systems with no real description — with a paste-ready fix for each.
- **Contract info on edges.** `otel` records the callee's own endpoint on `calls`
  edges from real traffic, and a topic's message type on `publishes`/`consumes`
  edges when unambiguous.
- **AsyncAPI**, mirroring `openapi`: a topic or queue's `messages` catalog (v2 and v3).
- **Terraform**, mirroring `bicep`: the same resource families for `azurerm_*` and
  `aws_*` types, with `environment`/`app_settings`/`env` blocks becoming edges the
  same way.

## Later (shipped this round)

- **Multi-repo atlases** (shipped): `agentatlas merge` combines several repos'
  committed atlases into one system view, reusing the same canonicalize/merge/cleanup
  pass a single scan applies. A shared id across repos is one node — right for a
  resource genuinely shared, wrong for a coincidence; `config.aliases` unifies two
  different ids for the same real thing, but can't un-merge an identical id that
  turns out to mean different things (fix that at the source, before committing).
- **Trace sources beyond files** (shipped, as a CLI action, not a scanner):
  `agentatlas fetch-traces --source jaeger` and `--source appinsights` write OTLP
  JSON that `otel` then reads. This is deliberately **not** a scanner — scanners stay
  read-only and network-free (see CONTRIBUTING.md) so `agentatlas scan` stays
  deterministic; fetching is a separate, explicit step, same as committing a trace
  file today. Best-effort: Jaeger conversion assumes OpenTelemetry semantic-convention
  attributes; Application Insights' free-text dependency `type` is mapped to the same
  vocabulary `otel` understands, falling back to a plain call for an unrecognized type.
- **Draftsman integration** (shipped, rescoped): investigated Draftsman directly —
  it's a Claude Code plugin that produces Markdown design docs with Mermaid diagrams
  (`design.md`), not a machine schema, and its own docs already describe the read
  direction (`surveyor` starts from `SYSTEM.md`/`atlas.yaml`). There's nothing
  structured on Draftsman's side to validate against, so the other direction is
  `agentatlas validate` / the `validate_design` MCP tool: best-effort Mermaid
  flowchart parsing (works against Draftsman's real `examples/fnol-intake/design.md`,
  and against AgentAtlas's own `render_diagram` output) plus a structured
  `{nodes, edges}` fragment path for tools that do emit one. Checks broken
  references, an id reused for something else, edges crossing team ownership, and
  cycles a design would introduce.

## Next
- Contract-aware impact analysis: use `endpoints`/`messageTypes` on edges to scope
  `impact_of_change` to only the dependents that actually touch the changed contract,
  not everything downstream.
- Terraform coverage for Google Cloud resource types.
- `agentatlas validate` against a *committed* fragment in CI (not just ad hoc), so a
  team's own service-boundary rules (no direct cross-team calls, no cycles) gate PRs.
