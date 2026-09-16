import { join, posix } from 'node:path';
import { type AtlasEdge, type AtlasNode, type NodeKind, emptyResult, normalizeId } from '../model.js';
import { flatten, parseLooseJson, readText, uniq } from '../util.js';
import { interpretSettings } from './settings.js';
import type { Scanner } from './types.js';

interface PackageHint { tech: string; kind?: NodeKind; messaging?: boolean; role?: 'gateway' }

/** Package id prefix → what it tells us. Longest prefix wins. */
const PACKAGE_HINTS: Array<[string, PackageHint]> = [
  ['Microsoft.EntityFrameworkCore.SqlServer', { tech: 'SQL Server', kind: 'database' }],
  ['Microsoft.Data.SqlClient', { tech: 'SQL Server', kind: 'database' }],
  ['Npgsql', { tech: 'PostgreSQL', kind: 'database' }],
  ['Microsoft.Azure.Cosmos', { tech: 'Azure Cosmos DB', kind: 'database' }],
  ['Microsoft.EntityFrameworkCore.Cosmos', { tech: 'Azure Cosmos DB', kind: 'database' }],
  ['MongoDB.Driver', { tech: 'MongoDB', kind: 'database' }],
  ['Pomelo.EntityFrameworkCore.MySql', { tech: 'MySQL', kind: 'database' }],
  ['StackExchange.Redis', { tech: 'Redis', kind: 'cache' }],
  ['Microsoft.Extensions.Caching.StackExchangeRedis', { tech: 'Redis', kind: 'cache' }],
  ['Azure.Messaging.ServiceBus', { tech: 'Azure Service Bus', messaging: true }],
  ['MassTransit.Azure.ServiceBus', { tech: 'Azure Service Bus', messaging: true }],
  ['Azure.Messaging.EventHubs', { tech: 'Azure Event Hubs', messaging: true }],
  ['Confluent.Kafka', { tech: 'Kafka', messaging: true }],
  ['RabbitMQ.Client', { tech: 'RabbitMQ', messaging: true }],
  ['MassTransit.RabbitMQ', { tech: 'RabbitMQ', messaging: true }],
  ['AWSSDK.SQS', { tech: 'Amazon SQS', messaging: true }],
  ['Azure.Storage.Blobs', { tech: 'Azure Blob Storage', kind: 'storage' }],
  ['Azure.Search.Documents', { tech: 'Azure AI Search', kind: 'search' }],
  ['Elastic.Clients.Elasticsearch', { tech: 'Elasticsearch', kind: 'search' }],
  ['Yarp.ReverseProxy', { tech: 'YARP', role: 'gateway' }],
  ['Ocelot', { tech: 'Ocelot', role: 'gateway' }],
  ['Grpc.AspNetCore', { tech: 'gRPC' }],
  ['MassTransit', { tech: 'MassTransit' }],
  ['MediatR', { tech: 'MediatR' }],
  ['Dapr', { tech: 'Dapr' }],
  ['OpenTelemetry', { tech: 'OpenTelemetry' }],
  ['Microsoft.ApplicationInsights', { tech: 'Application Insights' }],
  ['Polly', { tech: 'Polly' }],
  ['System.ServiceModel', { tech: 'WCF client' }],
  ['Refit', { tech: 'Refit' }],
];

function hintFor(pkg: string): PackageHint | undefined {
  let best: [string, PackageHint] | undefined;
  for (const entry of PACKAGE_HINTS) {
    if ((pkg === entry[0] || pkg.startsWith(`${entry[0]}.`)) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best?.[1];
}

interface Project {
  path: string;
  dir: string;
  name: string;
  sdk: string;
  props: Record<string, string>;
  packages: string[];
  references: string[];
}

function parseProject(root: string, rel: string): Project | undefined {
  const text = readText(join(root, rel));
  if (!text) return undefined;
  const props: Record<string, string> = {};
  for (const m of text.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) props[m[1]!] = m[2]!.trim();
  const attr = (tag: string) => [...text.matchAll(new RegExp(`<${tag}\\s+[^>]*Include="([^"]+)"`, 'g'))].map((m) => m[1]!);
  const dir = posix.dirname(rel);
  return {
    path: rel,
    dir,
    name: props.AssemblyName || posix.basename(rel).replace(/\.(cs|fs|vb)proj$/, ''),
    sdk: text.match(/<Project\s+[^>]*Sdk="([^"]+)"/)?.[1] ?? '',
    props,
    packages: attr('PackageReference'),
    references: attr('ProjectReference').map((r) => posix.normalize(posix.join(dir, r.replace(/\\/g, '/')))),
  };
}

function isTest(p: Project) {
  return p.props.IsTestProject === 'true' || p.packages.some((x) => /^(Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest)/.test(x));
}

function roleOf(p: Project): { kind: NodeKind; worker: boolean } | undefined {
  const pk = p.packages;
  if (/Functions/.test(p.sdk) || pk.some((x) => x.startsWith('Microsoft.Azure.Functions.Worker'))) return { kind: 'function', worker: true };
  if (/Worker/.test(p.sdk)) return { kind: 'service', worker: true };
  if (/Web/.test(p.sdk)) {
    if (/BlazorWebAssembly/.test(p.sdk)) return { kind: 'frontend', worker: false };
    const gateway = pk.some((x) => hintFor(x)?.role === 'gateway');
    return { kind: gateway ? 'gateway' : 'service', worker: false };
  }
  if (p.props.OutputType?.toLowerCase() === 'exe' && pk.some((x) => x.startsWith('Microsoft.Extensions.Hosting'))) {
    return { kind: 'service', worker: true };
  }
  return undefined;
}

export const scanDotnet: Scanner = (ctx) => {
  const result = emptyResult();
  const projects = new Map<string, Project>();
  for (const f of ctx.files.filter((f) => /\.(cs|fs|vb)proj$/.test(f))) {
    const p = parseProject(ctx.root, f);
    if (p) projects.set(f, p);
  }

  // Packages reachable through project references (libraries contribute to the deployable that uses them).
  const closure = (p: Project, seen = new Set<string>()): string[] => {
    if (seen.has(p.path)) return [];
    seen.add(p.path);
    return uniq([...p.packages, ...p.references.flatMap((r) => (projects.get(r) ? closure(projects.get(r)!, seen) : []))]);
  };

  for (const p of projects.values()) {
    if (isTest(p)) continue;
    const role = roleOf(p);
    if (!role) continue;
    const id = normalizeId(p.props.AgentAtlasId || p.name);
    const packages = closure(p);
    const hints = packages.map(hintFor).filter((h): h is PackageHint => !!h);
    const framework = p.props.TargetFramework || p.props.TargetFrameworks?.split(';')[0];
    const tech = uniq([
      framework ? `.NET (${framework})` : '.NET',
      role.kind === 'function' ? 'Azure Functions' : role.worker ? 'Worker Service' : 'ASP.NET Core',
      ...hints.map((h) => h.tech),
    ]);
    const node: AtlasNode = {
      id,
      kind: role.kind,
      name: p.name,
      tech,
      repoPath: p.dir,
      ...(p.props.Description ? { description: p.props.Description } : {}),
      ...(role.worker ? { tags: ['worker'] } : {}),
      sources: ['dotnet'],
    };
    result.nodes.push(node);

    // Settings: appsettings*.json in the project folder.
    const settingsFiles = ctx.files.filter((f) => posix.dirname(f) === p.dir && /^appsettings(\.[\w-]+)?\.json$/i.test(posix.basename(f)));
    const entries = settingsFiles.flatMap((f) => {
      try { return flatten(parseLooseJson(readText(join(ctx.root, f)) ?? '{}')); }
      catch { result.warnings!.push(`${f}: could not parse JSON`); return []; }
    });
    const messagingTech = hints.find((h) => h.messaging)?.tech;
    const found = interpretSettings(entries, { serviceId: id, source: 'dotnet', isWorker: role.worker, messagingTech });
    result.nodes.push(...found.nodes);
    result.edges.push(...found.edges);

    // Stores implied by packages but not named by any connection string.
    const namedKinds = new Set<NodeKind>(found.nodes.map((n) => n.kind));
    for (const h of hints) {
      if (!h.kind || namedKinds.has(h.kind)) continue;
      const storeId = `${id}-${normalizeId(h.tech)}`;
      result.nodes.push({ id: storeId, kind: h.kind, tech: [h.tech], description: `Inferred from a ${h.tech} package in ${p.name}; add a connection string or a manual node to name it.`, sources: ['dotnet'] });
      result.edges.push({ from: id, to: storeId, kind: 'stores', sources: ['dotnet'] } satisfies AtlasEdge);
      namedKinds.add(h.kind);
    }
  }
  return result;
};
