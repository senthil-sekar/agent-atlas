import { join } from 'node:path';
import { type NodeKind, emptyResult, normalizeId } from '../model.js';
import { readText } from '../util.js';
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

export const scanBicep: Scanner = (ctx) => {
  const result = emptyResult();
  for (const f of ctx.files.filter((f) => f.endsWith('.bicep'))) {
    const text = readText(join(ctx.root, f)) ?? '';
    const decls = [...text.matchAll(/^\s*resource\s+\w+\s+'([^'@]+)@[^']*'\s*(?:existing\s*)?=\s*/gm)];
    decls.forEach((d, i) => {
      if (/existing\s*=/.test(d[0])) return;
      const type = d[1]!;
      const hint = TYPES.find(([re]) => re.test(type))?.[1];
      if (!hint) return;
      const block = text.slice(d.index! + d[0].length, decls[i + 1]?.index ?? text.length);
      const nameLiteral = block.match(/^\s*name:\s*'([^']+)'/m)?.[1];
      if (!nameLiteral) {
        result.warnings!.push(`${f}: ${type} has a non-literal name; add an alias or manual node if it matters`);
        return;
      }
      const id = bicepName(nameLiteral);
      if (!id) return;
      let { kind, tech, hosting } = hint;
      if (/^Microsoft\.Web\/sites$/i.test(type) && /^\s*kind:\s*'[^']*functionapp/im.test(block)) {
        kind = 'function';
        hosting = 'Azure Functions';
      }
      result.nodes.push({ id, kind, ...(tech ? { tech: [tech] } : {}), ...(hosting ? { hosting } : {}), sources: ['bicep'] });
    });
  }
  return result;
};
