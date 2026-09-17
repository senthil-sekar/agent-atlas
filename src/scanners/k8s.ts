import { join, posix } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';
import { type AtlasNode, type NodeKind, emptyResult, normalizeId } from '../model.js';
import { flatten, readText } from '../util.js';
import { OBSERVABILITY, imageHint } from './compose.js';
import { interpretSettings, normalizeEnvKey } from './settings.js';
import type { Scanner } from './types.js';

/** Workload kinds that run code. Batch kinds default to consuming rather than publishing. */
const WORKLOADS: Record<string, boolean> = {
  Deployment: false, StatefulSet: false, ReplicaSet: false, DaemonSet: true, Job: true, CronJob: true,
};

type Labels = Record<string, string>;

interface Workload {
  id: string;
  labels: Labels;
  worker: boolean;
  image: string;
  entries: Array<[string, string]>;
  configMaps: string[];
}

/**
 * Helm templates are not valid YAML. Resolve `.Values` lookups from values.yaml, drop control-flow
 * lines, and let anything still unresolved fall away; charts that stay unparseable are reported.
 */
export function renderTemplate(text: string, values: Record<string, unknown>, release: string): string {
  const lookup = new Map(flatten(values).map(([k, v]) => [k.replace(/:/g, '.'), v]));
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\{\{-?\s*(if|else|end|range|with|define|template|block)\b/.test(line))
    .map((line) => line.replace(/\{\{-?\s*(.*?)\s*-?\}\}/g, (whole, expr: string) => {
      const path = String(expr).replace(/\|.*$/, '').trim();
      if (/^\.(Chart|Release)\.Name$/.test(path)) return release;
      const value = path.startsWith('.Values.') ? lookup.get(path.slice('.Values.'.length)) : undefined;
      return value === undefined ? whole : String(value);
    }))
    .join('\n');
}

const podOf = (doc: any) => (doc.kind === 'CronJob' ? doc.spec?.jobTemplate?.spec?.template : doc.spec?.template);

const selects = (selector: Labels, labels: Labels) =>
  Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => String(labels[k]) === String(v));

export const scanK8s: Scanner = (ctx) => {
  const result = emptyResult();
  const workloads: Workload[] = [];
  const services: Array<{ id: string; selector: Labels; externalName?: string }> = [];
  const ingresses: Array<{ id: string; backends: string[] }> = [];
  const configMaps = new Map<string, Array<[string, string]>>();

  for (const f of ctx.files.filter((f) => /\.ya?ml$/i.test(f))) {
    let text = readText(join(ctx.root, f));
    if (!text || !/^\s*apiVersion:/m.test(text)) continue;
    if (text.includes('{{')) {
      const chartDir = posix.dirname(posix.dirname(f)); // templates/<file>.yaml
      let values: Record<string, unknown> = {};
      try { values = parse(readText(join(ctx.root, chartDir, 'values.yaml')) ?? '') ?? {}; } catch { /* no usable values */ }
      const chart = posix.basename(chartDir === '.' ? ctx.root : chartDir);
      text = renderTemplate(text, values, chart);
    }

    let docs: unknown[];
    try {
      docs = parseAllDocuments(text).map((d) => d.toJS({ maxAliasCount: -1 }));
    } catch {
      result.warnings!.push(`${f}: could not parse as Kubernetes YAML`);
      continue;
    }

    for (const raw of docs) {
      const doc = raw as any;
      const name = doc?.metadata?.name;
      if (!doc?.apiVersion || typeof doc.kind !== 'string' || typeof name !== 'string' || !name) continue;

      if (doc.kind === 'ConfigMap') {
        const data = doc.data && typeof doc.data === 'object' ? doc.data : {};
        configMaps.set(name, Object.entries(data).map(([k, v]) => [k, String(v ?? '')]));
      } else if (doc.kind === 'Service') {
        services.push({ id: normalizeId(name), selector: doc.spec?.selector ?? {}, externalName: doc.spec?.externalName });
      } else if (doc.kind === 'Ingress') {
        const backends: string[] = [];
        for (const rule of doc.spec?.rules ?? []) {
          for (const path of rule?.http?.paths ?? []) {
            const backend = path?.backend?.service?.name ?? path?.backend?.serviceName;
            if (backend) backends.push(normalizeId(String(backend)));
          }
        }
        const fallback = doc.spec?.defaultBackend?.service?.name;
        if (fallback) backends.push(normalizeId(String(fallback)));
        ingresses.push({ id: normalizeId(name), backends });
      } else if (Object.hasOwn(WORKLOADS, doc.kind)) {
        const pod = podOf(doc);
        const containers = pod?.spec?.containers ?? [];
        const entries: Array<[string, string]> = [];
        const refs: string[] = [];
        for (const container of containers) {
          for (const e of container?.env ?? []) {
            if (typeof e?.name === 'string' && typeof e?.value === 'string') entries.push([e.name, e.value]);
          }
          for (const from of container?.envFrom ?? []) {
            const ref = from?.configMapRef?.name;
            if (ref) refs.push(String(ref));
          }
        }
        workloads.push({
          id: normalizeId(name),
          labels: pod?.metadata?.labels ?? doc.spec?.selector?.matchLabels ?? {},
          worker: WORKLOADS[doc.kind]!,
          image: String(containers[0]?.image ?? ''),
          entries,
          configMaps: refs,
        });
      }
    }
  }

  for (const w of workloads) {
    if (OBSERVABILITY.test(w.image.toLowerCase())) continue;
    const infra = imageHint(w.image);
    const kind: NodeKind = infra?.[0] ?? 'service';
    const node: AtlasNode = { id: w.id, kind, sources: ['k8s'], hosting: 'Kubernetes' };
    if (infra) node.tech = [infra[1]];
    result.nodes.push(node);

    // The image often names the code project that produces it.
    const image = w.image.split('@')[0]!.split(':')[0]!;
    const project = ctx.codeNodes.find((n) => n.id === normalizeId(posix.basename(image)));
    if (project && project.id !== w.id) result.aliases!.push([project.id, w.id]);

    if (infra) continue; // an infrastructure container's own config describes itself, not its dependencies
    const entries = [...w.configMaps.flatMap((name) => configMaps.get(name) ?? []), ...w.entries];
    const found = interpretSettings(entries.map(([k, v]) => [normalizeEnvKey(k), v]), {
      serviceId: w.id, source: 'k8s', isWorker: w.worker || /worker|processor|consumer|job/.test(w.id),
    });
    result.nodes.push(...found.nodes);
    result.edges.push(...found.edges);
  }

  // A Service is a name for the workload behind it, not a separate node.
  for (const svc of services) {
    if (svc.externalName) {
      result.nodes.push({ id: svc.id, kind: 'external', description: `Kubernetes ExternalName for ${svc.externalName}`, sources: ['k8s'] });
      continue;
    }
    const behind = workloads.find((w) => selects(svc.selector, w.labels));
    if (behind && behind.id !== svc.id) result.aliases!.push([behind.id, svc.id]);
  }

  for (const ingress of ingresses) {
    if (!ingress.backends.length) continue;
    result.nodes.push({ id: ingress.id, kind: 'gateway', tech: ['Kubernetes Ingress'], sources: ['k8s'] });
    for (const backend of ingress.backends) {
      result.edges.push({ from: ingress.id, to: backend, kind: 'calls', protocol: 'https', sources: ['k8s'] });
    }
  }

  return result;
};
