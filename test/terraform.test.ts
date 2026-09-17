import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { project } from './helpers.js';

describe('terraform', () => {
  it('reads azurerm resources, env vars, and connection strings into edges', () => {
    const root = project({
      'infra/main.tf': `
resource "azurerm_container_app" "quote_api" {
  name = "\${var.prefix}-quote-api"
  template {
    container {
      name  = "api"
      env {
        name  = "DATABASE_URL"
        value = "postgres://quote-db:5432/quotes"
      }
      env {
        name  = "RATING_ENGINE_URL"
        value = "http://rating-engine:8080"
      }
    }
  }
}

resource "azurerm_redis_cache" "cache" {
  name = "\${var.prefix}-redis"
}

resource "azurerm_servicebus_queue" "policy_issued" {
  name = "policy-issued"
}
`,
    });
    const { atlas } = buildAtlas(root);
    const ids = atlas.nodes.map((n) => `${n.id}:${n.kind}`);
    expect(ids).toContain('quote-api:service');
    expect(ids).toContain('redis:cache');
    expect(ids).toContain('policy-issued:queue');
    const quoteApi = atlas.nodes.find((n) => n.id === 'quote-api')!;
    expect(quoteApi.hosting).toBe('Azure Container Apps');
    const edges = atlas.edges.map((e) => `${e.from}-${e.kind}-${e.to}`);
    expect(edges).toEqual(expect.arrayContaining(['quote-api-stores-quote-db', 'quote-api-calls-rating-engine']));
  });

  it('reads aws resources, deriving tech from an attribute for aws_db_instance', () => {
    const root = project({
      'main.tf': `
resource "aws_lambda_function" "notifier" {
  function_name = "notifier"
}
resource "aws_db_instance" "policy" {
  identifier = "policy-db"
  engine     = "postgres"
}
resource "aws_sqs_queue" "claims" {
  name = "claims-queue"
}
`,
    });
    const { atlas } = buildAtlas(root);
    const byId = new Map(atlas.nodes.map((n) => [n.id, n]));
    expect(byId.get('notifier')!.kind).toBe('function');
    expect(byId.get('notifier')!.hosting).toBe('AWS Lambda');
    expect(byId.get('policy-db')!.tech).toEqual(['Amazon RDS for PostgreSQL']);
    expect(byId.get('claims-queue')!.kind).toBe('queue');
  });

  it('warns instead of guessing when the name is not a literal', () => {
    const root = project({
      'main.tf': `
resource "azurerm_storage_account" "sa" {
  name = local.storage_name
}
`,
    });
    const { warnings } = buildAtlas(root);
    expect(warnings[0]).toMatch(/no literal name/);
  });

  it('ignores resource types it does not recognize', () => {
    const root = project({
      'main.tf': `
resource "azurerm_resource_group" "rg" {
  name = "my-rg"
}
`,
    });
    const { atlas } = buildAtlas(root);
    expect(atlas.nodes).toEqual([]);
  });
});
