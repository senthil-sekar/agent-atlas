#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildAtlas } from './build.js';
import { CONFIG_FILE, ConfigError, initConfig, loadConfig } from './config.js';
import { describeDoctor, diagnose } from './doctor.js';
import { describeDrift, diffAtlas, hasDrift } from './drift.js';
import { AtlasGraph } from './graph.js';
import { readAtlas, serializeAtlas, writeOutputs } from './io.js';
import { runStdioServer } from './mcp.js';
import { pack } from './pack.js';
import { flowDiagram, topologyDiagram } from './render/mermaid.js';
import { describeFlow, describeImpact, describeNode, describePath, hopList, summary, type SummaryLevel } from './render/text.js';
import { VERSION } from './version.js';

const HELP = `agentatlas ${VERSION}: map how your services connect, for humans and AI agents.

Usage: agentatlas <command> [options]

Commands
  init                     Create agentatlas.yaml in the target directory
  scan                     Scan code, config, IaC, and traces; write .agentatlas/atlas.yaml and SYSTEM.md
  check                    Fail (exit 1) if the committed atlas no longer matches the code
  doctor                   Report what scanners could not resolve, with paste-ready fixes
  summary                  Print a system summary        [--level brief|standard|full] [--max-tokens N]
  show <id>                Show one service, store, topic, or external system
  pack <id>                The smallest map an agent needs before changing <id> [--depth N] [--max-tokens N]
  deps <id>                What <id> depends on          [--depth N]
  callers <id>             What depends on <id>          [--depth N]
  impact <id>              Blast radius of changing <id> [--depth N]
  path <from> <to>         How a request or message travels from <from> to <to>
  flow [id]                List flows, or show one       [--diagram]
  diagram                  Print a Mermaid diagram       [--focus id] [--depth N] [--out file]
  mcp                      Start the MCP server on stdio

Options
  --dir <path>             Project directory (default: current directory)
  --dry-run                scan: print the atlas instead of writing files
  --force                  init: overwrite an existing agentatlas.yaml
  -h, --help               Show help
  -v, --version            Show version
`;

function main(argv: string[]): number | Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: '.' },
      depth: { type: 'string' },
      level: { type: 'string', default: 'standard' },
      'max-tokens': { type: 'string' },
      focus: { type: 'string' },
      out: { type: 'string' },
      diagram: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const [command, ...args] = positionals;
  const dir = resolve(values.dir!);
  const depth = values.depth ? Number(values.depth) : undefined;

  if (values.version) { console.log(VERSION); return 0; }
  if (values.help || !command) { console.log(HELP); return command || values.help ? 0 : 1; }

  const loadGraph = (): AtlasGraph => {
    const committed = readAtlas(dir);
    if (committed) return new AtlasGraph(committed);
    console.error('(no .agentatlas/atlas.yaml yet; scanning in memory)');
    return new AtlasGraph(buildAtlas(dir).atlas);
  };
  const need = (g: AtlasGraph, query: string | undefined, what = 'id') => {
    if (!query) throw new UsageError(`Missing <${what}>.`);
    const { node, candidates } = g.resolve(query);
    if (!node) {
      throw new UsageError(candidates.length
        ? `"${query}" is ambiguous: ${candidates.map((c) => c.id).join(', ')}`
        : `No node matches "${query}".`);
    }
    return node;
  };

  switch (command) {
    case 'init': {
      const path = initConfig(dir, values.force);
      console.log(`Created ${relative(process.cwd(), path) || CONFIG_FILE}. Next: agentatlas scan`);
      return 0;
    }
    case 'scan': {
      const config = loadConfig(dir);
      const { atlas, warnings, stats } = buildAtlas(dir, config);
      if (values['dry-run']) {
        process.stdout.write(serializeAtlas(atlas));
      } else {
        const written = writeOutputs(dir, atlas);
        const found = Object.entries(stats).filter(([, s]) => s.nodes + s.edges + s.flows > 0)
          .map(([k, s]) => `${k} (${s.nodes} nodes, ${s.edges} edges${s.flows ? `, ${s.flows} flows` : ''})`);
        console.log(`Mapped ${atlas.system.name}: ${atlas.nodes.length} nodes, ${atlas.edges.length} edges, ${atlas.flows.length} flows.`);
        console.log(`Sources: ${found.join('; ') || 'none'}`);
        written.forEach((w) => console.log(`Wrote ${relative(process.cwd(), w)}`));
      }
      warnings.forEach((w) => console.error(`warning: ${w}`));
      return 0;
    }
    case 'check': {
      const committed = readAtlas(dir);
      if (!committed) { console.error('No .agentatlas/atlas.yaml to check. Run `agentatlas scan` first.'); return 1; }
      const drift = diffAtlas(committed, buildAtlas(dir).atlas);
      console.log(describeDrift(drift));
      return hasDrift(drift) ? 1 : 0;
    }
    case 'doctor': {
      console.log(describeDoctor(diagnose(loadGraph().atlas)));
      return 0;
    }
    case 'pack': {
      const g = loadGraph();
      const n = need(g, args[0]);
      console.log(pack(g, n.id, { depth, maxTokens: values['max-tokens'] ? Number(values['max-tokens']) : undefined }));
      return 0;
    }
    case 'summary': {
      const level = values.level as SummaryLevel;
      if (!['brief', 'standard', 'full'].includes(level)) throw new UsageError('--level must be brief, standard, or full');
      console.log(summary(loadGraph(), level, values['max-tokens'] ? Number(values['max-tokens']) : undefined));
      return 0;
    }
    case 'show': {
      const g = loadGraph();
      console.log(describeNode(g, need(g, args[0])));
      return 0;
    }
    case 'deps':
    case 'callers': {
      const g = loadGraph();
      const n = need(g, args[0]);
      const hops = command === 'deps' ? g.dependencies(n.id, depth ?? 1) : g.callers(n.id, depth ?? 1);
      console.log(`${command === 'deps' ? `${n.id} depends on` : `Used by (${n.id})`}:\n${hopList(hops)}`);
      return 0;
    }
    case 'impact': {
      const g = loadGraph();
      const n = need(g, args[0]);
      console.log(describeImpact(g, n, g.impact(n.id, depth ?? 5)));
      return 0;
    }
    case 'path': {
      const g = loadGraph();
      const a = need(g, args[0], 'from'), b = need(g, args[1], 'to');
      const p = g.path(a.id, b.id);
      console.log(p ? describePath(p) : `No dependency path from ${a.id} to ${b.id}.`);
      return p ? 0 : 1;
    }
    case 'flow': {
      const g = loadGraph();
      if (!args[0]) {
        console.log(g.atlas.flows.map((f) => `${f.id}  ${f.name}`).join('\n') || 'No flows recorded.');
        return 0;
      }
      const f = g.findFlow(args[0]);
      if (!f) throw new UsageError(`No flow matches "${args[0]}".`);
      console.log(values.diagram ? flowDiagram(f, g.atlas) : describeFlow(f));
      return 0;
    }
    case 'diagram': {
      const g = loadGraph();
      const focus = values.focus ? need(g, values.focus).id : undefined;
      const mermaid = topologyDiagram(g, { focus, depth });
      if (values.out) {
        writeFileSync(values.out, values.out.endsWith('.md') ? `\`\`\`mermaid\n${mermaid}\n\`\`\`\n` : `${mermaid}\n`);
        console.log(`Wrote ${values.out}`);
      } else console.log(mermaid);
      return 0;
    }
    case 'mcp':
      return runStdioServer(dir).then(() => -1);
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

class UsageError extends Error {}

Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then((code) => { if (code >= 0) process.exitCode = code; })
  .catch((err: unknown) => {
    if (err instanceof UsageError || err instanceof ConfigError) console.error(err.message);
    else if (err instanceof Error && 'code' in err && String((err as any).code).startsWith('ERR_PARSE_ARGS')) console.error(`${err.message}\nRun agentatlas --help for usage.`);
    else console.error(err);
    process.exitCode = 1;
  });
