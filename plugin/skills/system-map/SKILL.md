---
name: system-map
description: How to use the AgentAtlas system map. Use before changing code that crosses a service boundary (APIs, message contracts, database schemas, shared config), when asked how services connect, what calls or depends on something, what a change could break, or how a request flows through the system.
user-invocable: false
---

# Using the system map

This project has an AgentAtlas map of its services, data stores, messaging, and external systems. Use it instead of guessing from the files you happen to have open.

## When to consult it

| Situation | Tool |
|---|---|
| Starting work in an unfamiliar system | `system_overview` (level `brief` first; `standard` if you need edges) |
| About to change a service | `get_service`, then `find_callers` |
| Changing an API, message, event, or schema | `impact_of_change` on the service, topic, or database |
| "How does X reach Y?" or debugging a request | `trace_flow` with `from`/`to`, or `list_flows` then `trace_flow` with `flow` |
| Looking for where something lives | `search_atlas` |
| Explaining architecture to the user | `render_diagram` (optionally with `focus`) |

If the MCP tools are unavailable, read `SYSTEM.md` at the project root, or `.agentatlas/atlas.yaml` for the full graph.

## How to read it

- Edges point from the dependent to the dependency: `quote-api calls rating-engine` means quote-api breaks if rating-engine changes.
- `publishes` and `consumes` edges are contracts too. A change to a message shape affects every consumer, even though no HTTP call links them.
- `observed` counts come from traces; edges without them come from code and config and may be less certain.
- `external` nodes are systems outside this codebase. Treat their contracts as fixed.

## Rules

1. Before editing a public contract (route, request/response shape, message schema, table used by more than one service), run `impact_of_change` and tell the user which dependents are affected.
2. If the map looks wrong or stale (for example, you find a call the map doesn't show), say so and suggest `/agentatlas:map` to rescan.
3. Don't edit `SYSTEM.md` or `.agentatlas/atlas.yaml` by hand. Corrections go in `agentatlas.yaml`.
