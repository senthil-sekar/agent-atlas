# Contributing

## Setup

```bash
npm install
npm run build
npm test
```

## Adding a scanner

1. Create `src/scanners/<name>.ts` exporting a `Scanner` that returns `{ nodes, edges, flows }`.
2. Scanners must be deterministic and read-only. Don't execute project code or call the network.
3. Emit ids with `normalizeId`; the build step applies `stripPrefixes`, aliases, and merging.
4. Register it in `SCANNERS` in `src/build.ts`, in `SCANNER_NAMES` in `src/config.ts`, and in `SOURCES` in `src/model.ts`. Code scanners go first so later scanners can attach to their nodes.
5. Add tests in `test/scanners.test.ts` (or `test/edges.test.ts` for config- and route-derived edges) using the `project()` helper.

## Turning configuration into edges

Anything that reads key/value configuration should hand it to `interpretSettings` in
`src/scanners/settings.ts` rather than matching connection strings itself. Pass keys through
`normalizeEnvKey` first so environment-variable style reaches the same heuristics. Scanners that
attach to a service's folder (`env`, `routes`) use `ownerOf` from `src/scanners/types.ts`.

A store guessed from a dependency rather than named by configuration is tagged `inferred`. The build
drops it once a real store of the same kind and technology is found, so guesses never outlive facts.

## Contract info: endpoints and message types

`AtlasEdge.endpoints` (which route of the target a `calls` edge hits) and `AtlasEdge.messageTypes`
(which message a `publishes`/`consumes` edge carries) are additive evidence, not something every
scanner needs to fill in. Today `otel` sources both from real traffic, and `assemble()` auto-attaches
a topic's message type to its edges when the topic's `messages` catalog (from `asyncapi`) is
unambiguous. Don't guess a specific endpoint or message type from static analysis alone — a call
site rarely proves which of a target's several endpoints it hits.

## Talking to a live backend (never from a scanner)

Scanners are read-only and network-free on purpose (see above), so anything that fetches from a live
service — `src/traces/jaeger.ts`, `src/traces/appinsights.ts` — is a separate CLI action
(`fetch-traces`) that writes a file a scanner then reads, never a scanner itself. Keep the network
call and the pure conversion-to-OTLP-JSON in separate functions; the converter should be trivially
unit-testable with a dependency-injected `fetchImpl`, with no real network access required to test it.

## Changing the example

The example's generated files are committed and checked by the tests. After changing anything in `examples/quote-to-bind`, run `npm run build && npm run example` and commit the regenerated files.

## Output stability

`atlas.yaml` is committed by users, so keep its ordering deterministic and avoid gratuitous format changes. Diffs should reflect real topology changes.
