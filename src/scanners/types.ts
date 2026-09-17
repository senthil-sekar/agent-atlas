import type { AtlasConfig } from '../config.js';
import type { AtlasNode, ScanResult } from '../model.js';

export interface ScanContext {
  /** Absolute path of the directory being scanned. */
  root: string;
  /** All files under root (posix paths relative to root), excludes applied. */
  files: string[];
  config: AtlasConfig;
  /** Compute nodes found by earlier scanners, for scanners that attach to them. */
  codeNodes: AtlasNode[];
}

export type Scanner = (ctx: ScanContext) => ScanResult;

/** The code node that owns a file: the deepest project directory containing it. */
export function ownerOf(ctx: ScanContext, dir: string): AtlasNode | undefined {
  return ctx.codeNodes
    .filter((n) => n.repoPath !== undefined && (dir === n.repoPath || dir.startsWith(`${n.repoPath}/`) || n.repoPath === '.'))
    .sort((a, b) => b.repoPath!.length - a.repoPath!.length)[0];
}

/** Workers default to consuming rather than publishing when a queue is named. */
export const isWorker = (node?: AtlasNode) =>
  !!node && ((node.tags ?? []).includes('worker') || /worker|processor|consumer|job/.test(node.id));
