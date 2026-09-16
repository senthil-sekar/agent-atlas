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
4. Register it in `SCANNERS` in `src/build.ts` and in `SCANNER_NAMES` in `src/config.ts`. Code scanners go first so later scanners can attach to their nodes.
5. Add tests in `test/scanners.test.ts` using the `project()` helper.

## Changing the example

The example's generated files are committed and checked by the tests. After changing anything in `examples/quote-to-bind`, run `npm run build && npm run example` and commit the regenerated files.

## Output stability

`atlas.yaml` is committed by users, so keep its ordering deterministic and avoid gratuitous format changes. Diffs should reflect real topology changes.
