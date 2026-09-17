import { join } from 'node:path';
import { COMPUTE_KINDS, type NodeKind, emptyResult, normalizeId } from '../model.js';
import { readText } from '../util.js';
import { interpretSettings, normalizeEnvKey } from './settings.js';
import type { Scanner } from './types.js';

interface TypeHint { kind: NodeKind; tech?: string; hosting?: string }

const TYPES: Array<[RegExp, TypeHint]> = [
  [/^Microsoft\.App\/containerApps$/i, { kind: 'service', hosting: 'Azure Container Apps' }],
  [/^Microsoft\.App\/jobs$/i, { kind: 'service', hosting: 'Azure Container Apps Jobs' }],
  [/^Microsoft\.Web\/sites$/i, { kind: 'service', hosting: 'Azure App Service' }],
  [/^Microsoft\.Web\/staticSites$/i, { kind: 'frontend', hosting: 'Azure Static Web Apps' }],
  [/^Microsoft\.ContainerInstance\/containerGroups$/i, { kind: 'service', hosting: 'Azure Container Instances' }],
  [/^Microsoft\.ApiManagement\/service$/i, { kind: 'gateway', tech: 'Azure API Management' }],
  [/^Microsoft\.Network\/applicationGateways$/i, { kind: 'gateway', tech: 'Azure Application Gateway' }],
  [/^Microsoft\.Cdn\/profiles$/i, { kind: 'gateway', tech: 'Azure Front Door' }],
  [/^Microsoft\.Sql\/servers\/databases$/i, { kind: 'database', tech: 'Azure SQL Database' }],
  [/^Microsoft\.DBforPostgreSQL\/flexibleServers\/databases$/i, { kind: 'database', tech: 'Azure Database for PostgreSQL' }],
  [/^Microsoft\.DBforMySQL\/flexibleServers\/databases$/i, { kind: 'database', tech: 'Azure Database for MySQL' }],
  [/^Microsoft\.DocumentDB\/databaseAccounts\/sqlDatabases$/i, { kind: 'database', tech: 'Azure Cosmos DB' }],
  [/^Microsoft\.Cache\/redis$/i, { kind: 'cache', tech: 'Azure Cache for Redis' }],
  [/^Microsoft\.Cache\/redisEnterprise$/i, { kind: 'cache', tech: 'Azure Managed Redis' }],
  [/^Microsoft\.ServiceBus\/namespaces\/topics$/i, { kind: 'topic', tech: 'Azure Service Bus' }],
  [/^Microsoft\.ServiceBus\/namespaces\/queues$/i, { kind: 'queue', tech: 'Azure Service Bus' }],
  [/^Microsoft\.EventHub\/namespaces\/eventhubs$/i, { kind: 'stream', tech: 'Azure Event Hubs' }],
  [/^Microsoft\.Storage\/storageAccounts$/i, { kind: 'storage', tech: 'Azure Storage' }],
  [/^Microsoft\.Search\/searchServices$/i, { kind: 'search', tech: 'Azure AI Search' }],
];

/** Turn a Bicep string literal into an id: '${prefix}-quote-api' → quote-api. */
export function bicepName(literal: string): string {
  return normalizeId(literal.replace(/\$\{[^}]*\}/g, '-'));
}

/** The `env:`, `appSettings:`, and `connectionStrings:` arrays of a resource, as raw text. */
function settingRegions(block: string): string[] {
  const regions: string[] = [];
  for (const m of block.matchAll(/\b(?:env|appSettings|connectionStrings)\s*:\s*\[/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < block.length && depth > 0; i++) {
      if (block[i] === '[') depth++;
      else if (block[i] === ']') depth--;
    }
    regions.push(block.slice(start, i - 1));
  }
  return regions;
}

/**
 * Each `name:` claims the text up to the next one, so a value containing `${…}` cannot confuse the
 * boundaries. Values are string literals or references to another resource in the same file.
 */
function settingsOf(block: string, idBySymbol: Map<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const region of settingRegions(block)) {
    const names = [...region.matchAll(/name:\s*'([^']+)'/g)];
    names.forEach((m, i) => {
      const slice = region.slice(m.index! + m[0].length, names[i + 1]?.index ?? region.length);
      const reference = slice.match(/(?:value|connectionString):\s*([A-Za-z_]\w*)\.(?:name\b|properties\.[\w.]+)/);
      let value = slice.match(/(?:value|connectionString):\s*'([^']*)'/)?.[1]
        ?? (reference ? idBySymbol.get(reference[1]!) : undefined);
      if (value === undefined) return;
      // 'https://${ratingEngine.properties.configuration.ingress.fqdn}' points at another resource here.
      value = value.replace(/\$\{(\w+)[^}]*\}/g, (whole, symbol: string) => idBySymbol.get(symbol) ?? whole);
      if (value.includes('${')) return;
      out.push([normalizeEnvKey(m[1]!), value]);
    });
  }
  return out;
}

interface Declaration { type: string; block: string; id: string; kind: NodeKind }

export const scanBicep: Scanner = (ctx) => {
  const result = emptyResult();
  for (const f of ctx.files.filter((f) => f.endsWith('.bicep'))) {
    const text = readText(join(ctx.root, f)) ?? '';
    const decls = [...text.matchAll(/^\s*resource\s+(\w+)\s+'([^'@]+)@[^']*'\s*(?:existing\s*)?=\s*/gm)];
    const idBySymbol = new Map<string, string>();
    const compute: Declaration[] = [];

    decls.forEach((d, i) => {
      const [symbol, type] = [d[1]!, d[2]!];
      const hint = TYPES.find(([re]) => re.test(type))?.[1];
      if (!hint) return;
      const block = text.slice(d.index! + d[0].length, decls[i + 1]?.index ?? text.length);
      const nameLiteral = block.match(/^\s*name:\s*'([^']+)'/m)?.[1];
      if (!nameLiteral) {
        if (!/existing\s*=/.test(d[0])) result.warnings!.push(`${f}: ${type} has a non-literal name; add an alias or manual node if it matters`);
        return;
      }
      const id = bicepName(nameLiteral);
      if (!id) return;
      idBySymbol.set(symbol, id);
      if (/existing\s*=/.test(d[0])) return;

      let { kind, tech, hosting } = hint;
      if (/^Microsoft\.Web\/sites$/i.test(type) && /^\s*kind:\s*'[^']*functionapp/im.test(block)) {
        kind = 'function';
        hosting = 'Azure Functions';
      }
      result.nodes.push({ id, kind, ...(tech ? { tech: [tech] } : {}), ...(hosting ? { hosting } : {}), sources: ['bicep'] });
      if (COMPUTE_KINDS.has(kind)) compute.push({ type, block, id, kind });
    });

    // Second pass: app settings name the stores, topics, and services each app talks to.
    for (const app of compute) {
      const entries = settingsOf(app.block, idBySymbol);
      if (!entries.length) continue;
      const found = interpretSettings(entries, {
        serviceId: app.id,
        source: 'bicep',
        isWorker: app.kind === 'function' || /worker|processor|consumer|job/.test(app.id),
      });
      result.nodes.push(...found.nodes);
      result.edges.push(...found.edges);
    }
  }
  return result;
};
