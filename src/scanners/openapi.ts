import { join, posix } from 'node:path';
import { parse } from 'yaml';
import { type Endpoint, emptyResult, normalizeId } from '../model.js';
import { readText } from '../util.js';
import type { Scanner } from './types.js';

const NAME = /(^|[./-])(openapi|swagger)([.-][\w-]+)?\.(ya?ml|json)$/i;
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export const scanOpenApi: Scanner = (ctx) => {
  const result = emptyResult();
  for (const f of ctx.files.filter((f) => NAME.test(posix.basename(f)))) {
    let doc: any;
    try { doc = parse(readText(join(ctx.root, f)) ?? ''); } catch { result.warnings!.push(`${f}: invalid OpenAPI document`); continue; }
    if (!doc || !(doc.openapi || doc.swagger) || !doc.paths) continue;

    const endpoints: Endpoint[] = [];
    for (const [path, ops] of Object.entries<any>(doc.paths)) {
      for (const m of METHODS) {
        const op = ops?.[m];
        if (!op) continue;
        endpoints.push({ method: m.toUpperCase(), path, ...(op.summary || op.operationId ? { summary: op.summary ?? op.operationId } : {}) });
      }
    }

    // Owner: explicit extension, else the code project containing the file, else the API title.
    const dir = posix.dirname(f);
    const containing = ctx.codeNodes
      .filter((n) => n.repoPath !== undefined && (dir === n.repoPath || dir.startsWith(`${n.repoPath}/`) || n.repoPath === '.'))
      .sort((a, b) => (b.repoPath!.length - a.repoPath!.length))[0];
    const explicit = doc['x-agentatlas-service'] ?? doc.info?.['x-agentatlas-service'];
    const id = explicit ? normalizeId(String(explicit)) : containing?.id ?? normalizeId(String(doc.info?.title ?? posix.basename(dir)));

    result.nodes.push({
      id,
      kind: containing?.kind ?? 'service',
      ...(doc.info?.description && !containing ? { description: String(doc.info.description).split('\n')[0] } : {}),
      tech: [doc.openapi ? `OpenAPI ${doc.openapi}` : `Swagger ${doc.swagger}`],
      endpoints,
      sources: ['openapi'],
    });
  }
  return result;
};
