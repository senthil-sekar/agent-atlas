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
