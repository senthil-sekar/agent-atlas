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

## Changing the example

The example's generated files are committed and checked by the tests. After changing anything in `examples/quote-to-bind`, run `npm run build && npm run example` and commit the regenerated files.

## Output stability

`atlas.yaml` is committed by users, so keep its ordering deterministic and avoid gratuitous format changes. Diffs should reflect real topology changes.
