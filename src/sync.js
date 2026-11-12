// Differential Worker Synchronization & Delta Serialization (sync)
// Enables low-overhead, event-driven state propagation across Web Workers
// without full VFS re-broadcasting.

import { normalizePath } from './vfs.js';

export const DELTA_VERSION = 1;

/**
 * Tracks incremental mutations on an OverlayVFS instance.
 */
export class DeltaTracker {
  /**
   * @param {OverlayVFS} vfs
   * @param {object} [options]
   * @param {string} [options.basePath='/workspace']
   */
  constructor(vfs, options = {}) {
    this.vfs = vfs;
    this.basePath = normalizePath(options.basePath || '/workspace');
    this.created = new Map();
    this.updated = new Map();
    this.deleted = new Set();
    this.lastFlushed = Date.now();

    this._unsubscribe = vfs.subscribe((event) => this._onEvent(event));
  }

  _onEvent(event) {
    if (!event || !event.path) return;
    const path = normalizePath(event.path);
    if (!path.startsWith(this.basePath)) return;

    if (event.type === 'write' || event.type === 'mkdir') {
      this.deleted.delete(path);
      const isDir = event.type === 'mkdir' || event.isDir;
      let content = null;
      let mode = 0o100644;
      let mtime = event.mtime || Date.now();

      if (!isDir) {
        try {
          content = this.vfs.readFile(path);
          const st = this.vfs.stat(path);
          if (st) {
            mode = st.mode;
            mtime = st.mtime;
          }
        } catch (_) {}
      }

      this.updated.set(path, {
        path,
        isDir,
        content,
        mode,
        mtime,
      });
    } else if (event.type === 'remove') {
      this.created.delete(path);
      this.updated.delete(path);
      this.deleted.add(path);
    } else if (event.type === 'rename') {
      if (event.oldPath) {
        this.deleted.add(normalizePath(event.oldPath));
      }
      this._onEvent({ type: 'write', path: event.path });
    }
  }

  /**
   * Flushes and returns the pending mutations since last flush.
   * @returns {object|null}
   */
  flush() {
    if (this.updated.size === 0 && this.deleted.size === 0) {
      return null;
    }

    const delta = {
      version: DELTA_VERSION,
      timestamp: Date.now(),
      basePath: this.basePath,
      entries: Array.from(this.updated.values()),
      deleted: Array.from(this.deleted),
    };

    this.updated.clear();
    this.deleted.clear();
    this.lastFlushed = delta.timestamp;

    return delta;
  }

  destroy() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this.updated.clear();
    this.deleted.clear();
  }
}

/**
 * Applies a differential delta payload to an OverlayVFS instance.
 * @param {OverlayVFS} vfs
 * @param {object} delta
 */
export function applyDelta(vfs, delta) {
  if (!delta || delta.version !== DELTA_VERSION) {
    throw new Error(`applyDelta: Unsupported delta version: ${delta && delta.version}`);
  }

  // Handle deletions first
  if (Array.isArray(delta.deleted)) {
    for (const delPath of delta.deleted) {
      const norm = normalizePath(delPath);
      try {
        if (vfs.exists(norm)) {
          vfs.remove(norm, true, false);
        }
      } catch (_) {}
    }
  }

  // Handle created / updated entries
  if (Array.isArray(delta.entries)) {
    for (const entry of delta.entries) {
      const norm = normalizePath(entry.path);
      if (entry.isDir) {
        vfs.mkdir(norm, { recursive: true, mode: entry.mode });
      } else if (entry.content) {
        vfs.writeFile(norm, entry.content, {
          mtime: entry.mtime,
          mode: entry.mode,
        });
      }
    }
  }
}

/**
 * Exports all mutable files modified since a timestamp as a delta.
 * @param {OverlayVFS} vfs
 * @param {number} [sinceTimestamp=0]
 * @param {string} [basePath='/workspace']
 * @returns {object}
 */
export function exportDelta(vfs, sinceTimestamp = 0, basePath = '/workspace') {
  const normBase = normalizePath(basePath);
  const allFiles = vfs.getAllFiles(normBase);

  const entries = [];
  for (const f of allFiles) {
    if (f.mtime >= sinceTimestamp) {
      entries.push({
        path: f.path,
        isDir: f.isDir,
        content: f.isDir ? null : f.content,
        mtime: f.mtime,
        mode: f.mode,
      });
    }
  }

  return {
    version: DELTA_VERSION,
    timestamp: Date.now(),
    basePath: normBase,
    entries,
    deleted: [],
  };
}
