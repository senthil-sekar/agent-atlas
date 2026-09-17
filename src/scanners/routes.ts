import { join, posix } from 'node:path';
import { type Endpoint, emptyResult } from '../model.js';
import { readText } from '../util.js';
import { ownerOf, type Scanner } from './types.js';

/**
 * Routes declared in code, for services that ship no OpenAPI document. Only literal paths are read;
 * a path built at runtime is left to the spec or the manual overlay.
 */
type Extractor = (text: string) => Endpoint[];

const TEST_FILE = /(^|\/)(tests?|__tests__|testdata)\/|[._-](test|spec)\.[\w]+$|_test\.go$|Tests?\.(java|kt|cs)$/i;

/** Join a class- or router-level prefix with a method path. */
function route(prefix: string, path: string): string | undefined {
  if (!path && !prefix) return undefined;
  if (!path.startsWith('/') && !prefix) return undefined; // a bare word is not a route
  const joined = `/${prefix}/${path}`.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  return joined;
}

const collect = (out: Endpoint[], method: string, path: string | undefined) => {
  if (path) out.push({ method: method.toUpperCase(), path });
};

/** Everything before the class declaration, where class-level mapping annotations live. */
const beforeClass = (text: string) => text.slice(0, text.search(/\b(class|record)\s+\w/) + 1 || undefined);

const springRoutes: Extractor = (text) => {
  const out: Endpoint[] = [];
  const prefix = beforeClass(text).match(/@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?"([^"]*)"/)?.[1] ?? '';
  for (const m of text.matchAll(/@(Get|Post|Put|Delete|Patch)Mapping\s*(?:\(\s*(?:(?:value|path)\s*=\s*)?"([^"]*)")?/g)) {
    collect(out, m[1]!, route(prefix, m[2] ?? ''));
  }
  for (const m of text.matchAll(/@RequestMapping\s*\(([^)]*RequestMethod\.(GET|POST|PUT|DELETE|PATCH)[^)]*)\)/g)) {
    collect(out, m[2]!, route(prefix, m[1]!.match(/"([^"]*)"/)?.[1] ?? ''));
  }
  return out;
};

const aspnetRoutes: Extractor = (text) => {
  const out: Endpoint[] = [];
  const controller = text.match(/class\s+(\w+?)Controller\b/)?.[1] ?? '';
  const prefix = (beforeClass(text).match(/\[Route\(\s*"([^"]*)"/)?.[1] ?? '').replace(/\[controller\]/gi, controller);
  for (const m of text.matchAll(/\[Http(Get|Post|Put|Delete|Patch)(?:\s*\(\s*"([^"]*)")?/g)) {
    collect(out, m[1]!, route(prefix, m[2] ?? ''));
  }
  for (const m of text.matchAll(/\bMap(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/g)) {
    collect(out, m[1]!, route('', m[2]!));
  }
  return out;
};

const pythonRoutes: Extractor = (text) => {
  const out: Endpoint[] = [];
  for (const m of text.matchAll(/@\w+\.(get|post|put|delete|patch|route)\s*\(\s*["']([^"']+)["']([^)]*)\)/g)) {
    const path = route('', m[2]!);
    if (m[1] !== 'route') { collect(out, m[1]!, path); continue; }
    const methods = [...m[3]!.matchAll(/["'](GET|POST|PUT|DELETE|PATCH)["']/gi)].map((x) => x[1]!);
    (methods.length ? methods : ['GET']).forEach((method) => collect(out, method, path));
  }
  return out;
};

const jsRoutes: Extractor = (text) => {
  const out: Endpoint[] = [];
  for (const m of text.matchAll(/\b(?:app|router|server|api|fastify)\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
    collect(out, m[1]!, route('', m[2]!));
  }
  const prefix = text.match(/@Controller\s*\(\s*["']([^"']*)["']/)?.[1] ?? '';
  for (const m of text.matchAll(/@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:["']([^"']*)["'])?\s*\)/g)) {
    collect(out, m[1]!, route(prefix, m[2] ?? ''));
  }
  return out;
};

const goRoutes: Extractor = (text) => {
  const out: Endpoint[] = [];
  for (const m of text.matchAll(/\b\w+\.(GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/g)) {
    collect(out, m[1]!, route('', m[2]!));
  }
  for (const m of text.matchAll(/\b\w+\.Handle(?:Func)?\s*\(\s*"([^"]+)"[^\n]*/g)) {
    const method = m[0].match(/\.Methods\(\s*"(\w+)"/)?.[1] ?? 'ANY';
    collect(out, method, route('', m[1]!));
  }
  return out;
};

const EXTRACTORS: Array<[RegExp, Extractor]> = [
  [/\.(java|kt)$/, springRoutes],
  [/\.cs$/, aspnetRoutes],
  [/\.py$/, pythonRoutes],
  [/\.[cm]?[jt]sx?$/, jsRoutes],
  [/\.go$/, goRoutes],
];

export const scanRoutes: Scanner = (ctx) => {
  const result = emptyResult();
  const byService = new Map<string, Map<string, Endpoint>>();

  for (const f of ctx.files) {
    if (TEST_FILE.test(f)) continue;
    const extractor = EXTRACTORS.find(([re]) => re.test(f))?.[1];
    if (!extractor) continue;
    const owner = ownerOf(ctx, posix.dirname(f));
    if (!owner) continue;
    const text = readText(join(ctx.root, f));
    if (!text) continue;
    const endpoints = extractor(text);
    if (!endpoints.length) continue;
    const existing = byService.get(owner.id) ?? new Map<string, Endpoint>();
    for (const e of endpoints) existing.set(`${e.method} ${e.path}`, e);
    byService.set(owner.id, existing);
  }

  for (const [id, endpoints] of byService) {
    result.nodes.push({
      id,
      kind: ctx.codeNodes.find((n) => n.id === id)?.kind ?? 'service',
      endpoints: [...endpoints.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
      sources: ['routes'],
    });
  }
  return result;
};
