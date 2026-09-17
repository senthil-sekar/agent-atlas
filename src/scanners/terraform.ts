import { join } from 'node:path';
import { COMPUTE_KINDS, type NodeKind, emptyResult, normalizeId } from '../model.js';
import { readText } from '../util.js';
import { interpretSettings, normalizeEnvKey } from './settings.js';
import type { Scanner } from './types.js';

interface TypeHint {
  kind: NodeKind;
  tech?: string;
  hosting?: string;
  /** The argument that names the resource, when it isn't `name` (e.g. S3 buckets use `bucket`). */
  nameKey?: string;
  /** Read `tech` from another attribute's value instead of a fixed string (e.g. RDS's `engine`). */
  techFromAttr?: { attr: string; map: Record<string, string> };
}

/**
 * Terraform resource type -> what it tells us. Covers the common azurerm and aws resource types;
 * other providers (google, kubernetes as a provider, etc.) aren't recognized yet.
 */
const TYPES: Record<string, TypeHint> = {
  // Azure
  azurerm_container_app: { kind: 'service', hosting: 'Azure Container Apps' },
  azurerm_linux_web_app: { kind: 'service', hosting: 'Azure App Service' },
  azurerm_windows_web_app: { kind: 'service', hosting: 'Azure App Service' },
  azurerm_linux_function_app: { kind: 'function', hosting: 'Azure Functions' },
  azurerm_windows_function_app: { kind: 'function', hosting: 'Azure Functions' },
  azurerm_api_management: { kind: 'gateway', tech: 'Azure API Management' },
  azurerm_application_gateway: { kind: 'gateway', tech: 'Azure Application Gateway' },
  azurerm_cdn_frontdoor_profile: { kind: 'gateway', tech: 'Azure Front Door' },
  azurerm_mssql_database: { kind: 'database', tech: 'Azure SQL Database' },
  azurerm_postgresql_flexible_server_database: { kind: 'database', tech: 'Azure Database for PostgreSQL' },
  azurerm_mysql_flexible_server_database: { kind: 'database', tech: 'Azure Database for MySQL' },
  azurerm_cosmosdb_sql_database: { kind: 'database', tech: 'Azure Cosmos DB' },
  azurerm_redis_cache: { kind: 'cache', tech: 'Azure Cache for Redis' },
  azurerm_servicebus_topic: { kind: 'topic', tech: 'Azure Service Bus' },
  azurerm_servicebus_queue: { kind: 'queue', tech: 'Azure Service Bus' },
  azurerm_eventhub: { kind: 'stream', tech: 'Azure Event Hubs' },
  azurerm_storage_account: { kind: 'storage', tech: 'Azure Storage' },
  azurerm_search_service: { kind: 'search', tech: 'Azure AI Search' },
  // AWS
  aws_lambda_function: { kind: 'function', hosting: 'AWS Lambda', nameKey: 'function_name' },
  aws_ecs_service: { kind: 'service', hosting: 'Amazon ECS' },
  aws_apprunner_service: { kind: 'service', hosting: 'AWS App Runner', nameKey: 'service_name' },
  aws_api_gateway_rest_api: { kind: 'gateway', tech: 'Amazon API Gateway' },
  aws_apigatewayv2_api: { kind: 'gateway', tech: 'Amazon API Gateway' },
  aws_db_instance: {
    kind: 'database', nameKey: 'identifier',
    techFromAttr: { attr: 'engine', map: {
      postgres: 'Amazon RDS for PostgreSQL', mysql: 'Amazon RDS for MySQL',
      'sqlserver-se': 'Amazon RDS for SQL Server', 'sqlserver-ee': 'Amazon RDS for SQL Server',
      'sqlserver-web': 'Amazon RDS for SQL Server', 'sqlserver-ex': 'Amazon RDS for SQL Server',
    } },
  },
  aws_rds_cluster: { kind: 'database', nameKey: 'cluster_identifier', tech: 'Amazon Aurora' },
  aws_dynamodb_table: { kind: 'database', tech: 'Amazon DynamoDB' },
  aws_elasticache_cluster: { kind: 'cache', tech: 'Amazon ElastiCache', nameKey: 'cluster_id' },
  aws_elasticache_replication_group: { kind: 'cache', tech: 'Amazon ElastiCache', nameKey: 'replication_group_id' },
  aws_sqs_queue: { kind: 'queue', tech: 'Amazon SQS' },
  aws_sns_topic: { kind: 'topic', tech: 'Amazon SNS' },
  aws_s3_bucket: { kind: 'storage', tech: 'Amazon S3', nameKey: 'bucket' },
  aws_opensearch_domain: { kind: 'search', tech: 'Amazon OpenSearch', nameKey: 'domain_name' },
  aws_elasticsearch_domain: { kind: 'search', tech: 'Amazon OpenSearch', nameKey: 'domain_name' },
};

/** Turn a Terraform string literal into an id; `${var.prefix}-quote-api` resolves the same as Bicep's `${...}`. */
export function terraformName(literal: string): string {
  return normalizeId(literal.replace(/\$\{[^}]*\}/g, '-'));
}

/** Find the index just past the closing brace matching the one already consumed at `start`. */
function blockEnd(text: string, start: number): number {
  let depth = 1, i = start;
  for (; i < text.length && depth > 0; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
  }
  return i - 1;
}

/**
 * `environment { variables = { KEY = "value" } }` / `app_settings = { KEY = "value" }` (map literals),
 * and Container Apps' per-variable `env { name = "K" value = "V" }` blocks.
 */
function envEntries(block: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of block.matchAll(/\b(?:variables|app_settings)\s*=\s*\{/g)) {
    const body = block.slice(m.index! + m[0].length, blockEnd(block, m.index! + m[0].length));
    for (const kv of body.matchAll(/([\w.-]+)\s*=\s*"([^"]*)"/g)) out.push([kv[1]!, kv[2]!]);
  }
  for (const m of block.matchAll(/\benv\s*\{/g)) {
    const body = block.slice(m.index! + m[0].length, blockEnd(block, m.index! + m[0].length));
    const name = body.match(/\bname\s*=\s*"([^"]*)"/)?.[1];
    const value = body.match(/\bvalue\s*=\s*"([^"]*)"/)?.[1];
    if (name && value !== undefined) out.push([name, value]);
  }
  return out;
}

export const scanTerraform: Scanner = (ctx) => {
  const result = emptyResult();
  for (const f of ctx.files.filter((f) => f.endsWith('.tf'))) {
    const text = readText(join(ctx.root, f)) ?? '';
    for (const m of text.matchAll(/\bresource\s+"(\w+)"\s+"(\w+)"\s*\{/g)) {
      const type = m[1]!;
      const hint = TYPES[type];
      if (!hint) continue;
      const start = m.index! + m[0].length;
      const end = blockEnd(text, start);
      const block = text.slice(start, end);
      const nameKey = hint.nameKey ?? 'name';
      const nameLiteral = block.match(new RegExp(`\\b${nameKey}\\s*=\\s*"([^"]*)"`))?.[1];
      if (!nameLiteral) {
        result.warnings!.push(`${f}: ${type} "${m[2]}" has no literal ${nameKey}; add an alias or manual node if it matters`);
        continue;
      }
      const id = terraformName(nameLiteral);
      if (!id) continue;

      let tech = hint.tech;
      if (hint.techFromAttr) {
        const attrValue = block.match(new RegExp(`\\b${hint.techFromAttr.attr}\\s*=\\s*"([^"]*)"`))?.[1];
        tech = attrValue ? (hint.techFromAttr.map[attrValue] ?? attrValue) : undefined;
      }
      result.nodes.push({
        id, kind: hint.kind,
        ...(tech ? { tech: [tech] } : {}),
        ...(hint.hosting ? { hosting: hint.hosting } : {}),
        sources: ['terraform'],
      });

      if (COMPUTE_KINDS.has(hint.kind)) {
        const entries = envEntries(block).map(([k, v]) => [normalizeEnvKey(k), v] as [string, string]);
        if (entries.length) {
          const found = interpretSettings(entries, { serviceId: id, source: 'terraform', isWorker: /worker|processor|consumer|job/.test(id) });
          result.nodes.push(...found.nodes);
          result.edges.push(...found.edges);
        }
      }
    }
  }
  return result;
};
