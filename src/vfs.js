// Two-Tier Overlay Virtual File System (OverlayVFS)
// Combines an immutable bottom-tier (SharedSysroot) with a mutable top-tier (in-memory Map)
// Features directory unioning, POSIX path normalization, and strict EROFS permission enforcement.

import { SharedSysrootReader } from './shared-sysroot.js';

export const EROFS = 65;
export const ENOENT = 44;
export const EISDIR = 31;
export const ENOTDIR = 54;
export const EEXIST = 20;
export const EINVAL = 28;
export const EBADF = 8;
export const EPERM = 63;

/**
 * Normalizes a virtual path string.
 * Resolves redundant slashes, '.' and '..'.
 * @param {string} path
 * @param {string} [cwd='/workspace']
 * @returns {string}
 */
export function normalizePath(path, cwd = '/workspace') {
  if (!path) return cwd || '/';
  let target = path;
  if (!target.startsWith('/')) {
    const base = cwd && cwd.startsWith('/') ? cwd : '/workspace';
    target = base === '/' ? `/${path}` : `${base}/${path}`;
  }

  const parts = target.split('/').filter(p => p && p !== '.');
  const resolved = [];

  for (const part of parts) {
    if (part === '..') {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  const result = '/' + resolved.join('/');
  return result === '' ? '/' : result;
}

export class OverlayVFS {
  /**
   * @param {object} [options]
   * @param {SharedArrayBuffer|ArrayBuffer|SharedSysrootReader} [options.sharedSysroot=null]
   * @param {string} [options.workingDir='/workspace']
   * @param {string[]} [options.systemPaths] Read-only path prefixes
   */
  constructor(options = {}) {
    this.root = {
      name: '',
      isDir: true,
      children: new Map(),
      mtime: Date.now(),
      mode: 0o040755,
    };
    this.listeners = new Set();
    this.workingDir = normalizePath(options.workingDir || '/workspace');
    this.systemPaths = (options.systemPaths || ['/usr', '/include', '/lib', '/bin', '/dev']).map(p => normalizePath(p));

    this.sharedSysroot = null;
    if (options.sharedSysroot) {
      this.setSharedSysroot(options.sharedSysroot);
    }

    // Initialize root directories in mutable storage
    this.mkdir('/workspace', { recursive: true, allowReadOnly: true });
    this.mkdir('/tmp', { recursive: true, allowReadOnly: true });
  }

  /**
   * Sets or mounts a SharedSysroot buffer or reader.
   * @param {SharedArrayBuffer|ArrayBuffer|SharedSysrootReader} bufferOrReader
   */
  setSharedSysroot(bufferOrReader) {
    if (!bufferOrReader) {
      this.sharedSysroot = null;
      return;
    }
    if (bufferOrReader instanceof SharedSysrootReader) {
      this.sharedSysroot = bufferOrReader;
    } else {
      this.sharedSysroot = new SharedSysrootReader(bufferOrReader);
    }
    this._notify({ type: 'sysroot_mounted' });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notify(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('OverlayVFS listener error:', err);
      }
    }
  }

  _isReadOnly(path) {
    const norm = normalizePath(path, this.workingDir);
    for (const sysPath of this.systemPaths) {
      if (norm === sysPath || norm.startsWith(sysPath + '/')) {
        return true;
      }
    }
    return false;
  }

  _resolve(path, createIntermediate = false) {
    const norm = normalizePath(path, this.workingDir);
    if (norm === '/') return this.root;

    const parts = norm.split('/').filter(Boolean);
    let current = this.root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let next = current.children.get(part);

      if (!next) {
        if (createIntermediate) {
          next = {
            name: part,
            isDir: true,
            children: new Map(),
            mtime: Date.now(),
            mode: 0o040755,
          };
          current.children.set(part, next);
        } else {
          return null;
        }
      }

      current = next;
    }

    return current;
  }

  mkdir(path, options = {}) {
    const recursive = typeof options === 'boolean' ? options : (options.recursive !== false);
    const allowReadOnly = (typeof options === 'object' && options.allowReadOnly) || false;
    const mode = (typeof options === 'object' && options.mode) || 0o040755;

    const norm = normalizePath(path, this.workingDir);
    if (norm === '/') return;

    if (!allowReadOnly && this._isReadOnly(norm)) {
      const err = new Error(`EROFS: Read-only file system, cannot create directory ${norm}`);
      err.code = 'EROFS';
      err.errno = EROFS;
      throw err;
    }

    const parts = norm.split('/').filter(Boolean);
    let current = this.root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      let next = current.children.get(part);

      if (!next) {
        if (!recursive && i < parts.length - 1) {
          const err = new Error(`ENOENT: No such file or directory, mkdir '${norm}'`);
          err.code = 'ENOENT';
          err.errno = ENOENT;
          throw err;
        }
        next = {
          name: part,
          isDir: true,
          children: new Map(),
          mtime: Date.now(),
          mode,
        };
        current.children.set(part, next);
      } else if (!next.isDir) {
        const err = new Error(`ENOTDIR: Not a directory, mkdir '${norm}'`);
        err.code = 'ENOTDIR';
        err.errno = ENOTDIR;
        throw err;
      }

      current = next;
    }

    this._notify({ type: 'mkdir', path: norm });
  }

  writeFile(path, content, options = {}) {
    let mtime = Date.now();
    let allowReadOnly = false;
    let mode = 0o100644;

    if (typeof options === 'number') {
      mtime = options;
    } else if (typeof options === 'object') {
      if (options.mtime !== undefined) mtime = options.mtime;
      if (options.allowReadOnly !== undefined) allowReadOnly = options.allowReadOnly;
      if (options.mode !== undefined) mode = options.mode;
    }

    const norm = normalizePath(path, this.workingDir);
    if (!allowReadOnly && this._isReadOnly(norm)) {
      const err = new Error(`EROFS: Read-only file system, cannot write to ${norm}`);
      err.code = 'EROFS';
      err.errno = EROFS;
      throw err;
    }

    const parts = norm.split('/').filter(Boolean);
    if (parts.length === 0) {
      throw new Error('EINVAL: Cannot write to root directory');
    }

    const fileName = parts.pop();
    const dirPath = '/' + parts.join('/');
    const dirNode = this._resolve(dirPath, true);

    if (!dirNode.isDir) {
      const err = new Error(`ENOTDIR: Not a directory, '${dirPath}'`);
      err.code = 'ENOTDIR';
      err.errno = ENOTDIR;
      throw err;
    }

    let buffer;
    if (typeof content === 'string') {
      buffer = new TextEncoder().encode(content);
    } else if (content instanceof Uint8Array) {
      buffer = content;
    } else if (content instanceof ArrayBuffer) {
      buffer = new Uint8Array(content);
    } else {
      buffer = new Uint8Array(0);
    }

    const existing = dirNode.children.get(fileName);
    if (existing && existing.isDir) {
      const err = new Error(`EISDIR: Is a directory, open '${norm}'`);
      err.code = 'EISDIR';
      err.errno = EISDIR;
      throw err;
    }

    const node = {
      name: fileName,
      isDir: false,
      content: buffer,
      mtime,
      mode,
    };

    dirNode.children.set(fileName, node);
    this._notify({ type: 'write', path: norm, size: buffer.length, mtime });
  }

  readFile(path, asText = false) {
    const norm = normalizePath(path, this.workingDir);

    // 1. Check mutable top tier
    const node = this._resolve(norm);
    if (node) {
      if (node.isDir) {
        const err = new Error(`EISDIR: Is a directory, read '${norm}'`);
        err.code = 'EISDIR';
        err.errno = EISDIR;
        throw err;
      }
      if (asText) {
        return new TextDecoder().decode(node.content);
      }
      return node.content;
    }

    // 2. Check immutable bottom tier (SharedSysroot)
    if (this.sharedSysroot && this.sharedSysroot.exists(norm)) {
      if (this.sharedSysroot.isDir(norm)) {
        const err = new Error(`EISDIR: Is a directory, read '${norm}'`);
        err.code = 'EISDIR';
        err.errno = EISDIR;
        throw err;
      }
      return this.sharedSysroot.readFile(norm, asText);
    }

    const err = new Error(`ENOENT: No such file or directory, open '${norm}'`);
    err.code = 'ENOENT';
    err.errno = ENOENT;
    throw err;
  }

  exists(path) {
    const norm = normalizePath(path, this.workingDir);
    if (this._resolve(norm)) return true;
    if (this.sharedSysroot && this.sharedSysroot.exists(norm)) return true;
    return false;
  }

  isDir(path) {
    const norm = normalizePath(path, this.workingDir);
    const node = this._resolve(norm);
    if (node) return node.isDir;
    if (this.sharedSysroot && this.sharedSysroot.exists(norm)) {
      return this.sharedSysroot.isDir(norm);
    }
    return false;
  }

  stat(path) {
    const norm = normalizePath(path, this.workingDir);

    // 1. Check mutable top tier
    const node = this._resolve(norm);
    if (node) {
      return {
        name: node.name || (norm === '/' ? '/' : norm.split('/').pop()),
        isDir: node.isDir,
        size: node.isDir ? 0 : node.content.length,
        mtime: node.mtime,
        mode: node.mode,
      };
    }

    // 2. Check immutable bottom tier
    if (this.sharedSysroot) {
      const st = this.sharedSysroot.stat(norm);
      if (st) return st;
    }

    return null;
  }

  readDir(path) {
    const norm = normalizePath(path, this.workingDir);
    const resultMap = new Map();

    // 1. Check mutable top tier
    const node = this._resolve(norm);
    let hasNode = false;
    if (node) {
      if (!node.isDir) {
        const err = new Error(`ENOTDIR: Not a directory, scandir '${norm}'`);
        err.code = 'ENOTDIR';
        err.errno = ENOTDIR;
        throw err;
      }
      hasNode = true;
      for (const [name, child] of node.children.entries()) {
        resultMap.set(name, {
          name,
          isDir: child.isDir,
          size: child.isDir ? 0 : child.content.length,
          mtime: child.mtime,
          mode: child.mode,
        });
      }
    }

    // 2. Check and union with bottom tier (SharedSysroot)
    if (this.sharedSysroot) {
      const sysEntries = this.sharedSysroot.readDir(norm);
      if (sysEntries) {
        hasNode = true;
        for (const entry of sysEntries) {
          if (!resultMap.has(entry.name)) {
            resultMap.set(entry.name, entry);
          }
        }
      }
    }

    if (!hasNode) {
      const err = new Error(`ENOENT: No such file or directory, scandir '${norm}'`);
      err.code = 'ENOENT';
      err.errno = ENOENT;
      throw err;
    }

    return Array.from(resultMap.values()).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  remove(path, recursive = false, allowReadOnly = false) {
    const norm = normalizePath(path, this.workingDir);
    if (norm === '/' || norm === '/workspace') {
      throw new Error(`EINVAL: Cannot remove root or workspace: ${norm}`);
    }
    if (!allowReadOnly && this._isReadOnly(norm)) {
      const err = new Error(`EROFS: Read-only file system, cannot remove ${norm}`);
      err.code = 'EROFS';
      err.errno = EROFS;
      throw err;
    }

    const parts = norm.split('/').filter(Boolean);
    const name = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parentNode = this._resolve(parentPath);

    if (!parentNode || !parentNode.isDir) {
      const err = new Error(`ENOENT: No such file or directory, unlink '${norm}'`);
      err.code = 'ENOENT';
      err.errno = ENOENT;
      throw err;
    }

    const targetNode = parentNode.children.get(name);
    if (!targetNode) {
      const err = new Error(`ENOENT: No such file or directory, unlink '${norm}'`);
      err.code = 'ENOENT';
      err.errno = ENOENT;
      throw err;
    }

    if (targetNode.isDir && targetNode.children.size > 0 && !recursive) {
      const err = new Error(`ENOTEMPTY: Directory not empty, rmdir '${norm}'`);
      err.code = 'ENOTEMPTY';
      err.errno = 66;
      throw err;
    }

    parentNode.children.delete(name);
    this._notify({ type: 'remove', path: norm, isDir: targetNode.isDir });
  }

  removeFile(path, allowReadOnly = false) {
    return this.remove(path, false, allowReadOnly);
  }

  removeDir(path, recursive = false, allowReadOnly = false) {
    return this.remove(path, recursive, allowReadOnly);
  }

  rename(oldPath, newPath) {
    const oldNorm = normalizePath(oldPath, this.workingDir);
    const newNorm = normalizePath(newPath, this.workingDir);

    if (this._isReadOnly(oldNorm) || this._isReadOnly(newNorm)) {
      const err = new Error('EROFS: Read-only file system, cannot rename read-only paths');
      err.code = 'EROFS';
      err.errno = EROFS;
      throw err;
    }

    if (oldNorm === newNorm) return;

    const sourceNode = this._resolve(oldNorm);
    if (!sourceNode) {
      const err = new Error(`ENOENT: No such file or directory, rename '${oldNorm}' -> '${newNorm}'`);
      err.code = 'ENOENT';
      err.errno = ENOENT;
      throw err;
    }

    let targetNorm = newNorm;
    const destNode = this._resolve(newNorm);
    if (destNode && destNode.isDir) {
      const oldName = oldNorm.split('/').filter(Boolean).pop();
      targetNorm = newNorm === '/' ? `/${oldName}` : `${newNorm}/${oldName}`;
      if (this._isReadOnly(targetNorm)) {
        const err = new Error(`EROFS: Read-only file system, cannot rename into ${targetNorm}`);
        err.code = 'EROFS';
        err.errno = EROFS;
        throw err;
      }
      if (oldNorm === targetNorm) return;
    }

    if (sourceNode.isDir && (targetNorm + '/').startsWith(oldNorm + '/')) {
      const err = new Error(`EINVAL: Cannot move directory into itself: ${targetNorm}`);
      err.code = 'EINVAL';
      err.errno = EINVAL;
      throw err;
    }

    const oldParts = oldNorm.split('/').filter(Boolean);
    const oldName = oldParts.pop();
    const oldParent = this._resolve('/' + oldParts.join('/'));

    const newParts = targetNorm.split('/').filter(Boolean);
    const newName = newParts.pop();
    const newParent = this._resolve('/' + newParts.join('/'), true);

    if (!newParent || !newParent.isDir) {
      const err = new Error(`ENOTDIR: Destination directory not found: /${newParts.join('/')}`);
      err.code = 'ENOTDIR';
      err.errno = ENOTDIR;
      throw err;
    }

    const existingDest = newParent.children.get(newName);
    if (existingDest) {
      if (existingDest.isDir && !sourceNode.isDir) {
        const err = new Error(`EISDIR: Cannot overwrite directory with non-directory: ${targetNorm}`);
        err.code = 'EISDIR';
        err.errno = EISDIR;
        throw err;
      }
      if (!existingDest.isDir && sourceNode.isDir) {
        const err = new Error(`ENOTDIR: Cannot overwrite non-directory with directory: ${targetNorm}`);
        err.code = 'ENOTDIR';
        err.errno = ENOTDIR;
        throw err;
      }
      if (existingDest.isDir && sourceNode.isDir && existingDest.children.size > 0) {
        const err = new Error(`ENOTEMPTY: Directory not empty: ${targetNorm}`);
        err.code = 'ENOTEMPTY';
        err.errno = 66;
        throw err;
      }
    }

    oldParent.children.delete(oldName);
    sourceNode.name = newName;
    newParent.children.set(newName, sourceNode);

    this._notify({ type: 'rename', oldPath: oldNorm, path: targetNorm });
  }

  setTimes(path, atim, mtim) {
    const norm = normalizePath(path, this.workingDir);
    const node = this._resolve(norm);
    if (!node) {
      const err = new Error(`ENOENT: No such file or directory, utimes '${norm}'`);
      err.code = 'ENOENT';
      err.errno = ENOENT;
      throw err;
    }
    if (this._isReadOnly(norm)) {
      const err = new Error(`EROFS: Read-only file system, utimes '${norm}'`);
      err.code = 'EROFS';
      err.errno = EROFS;
      throw err;
    }

    let mtimeMs = typeof mtim === 'bigint' ? Number(mtim / 1000000n) : Number(mtim);
    if (!mtimeMs || isNaN(mtimeMs)) mtimeMs = Date.now();
    node.mtime = mtimeMs;
    this._notify({ type: 'write', path: norm, isDir: node.isDir, mtime: node.mtime });
  }

  getAllFiles(basePath = '/workspace') {
    const norm = normalizePath(basePath, this.workingDir);
    const results = [];

    const traverse = (currentPath, node) => {
      const fullPath = currentPath === '/' ? `/${node.name}` : `${currentPath}/${node.name}`;
      if (!node.isDir) {
        results.push({
          path: fullPath,
          isDir: false,
          content: node.content,
          mtime: node.mtime,
          mode: node.mode,
        });
      } else {
        if (fullPath !== '/' && fullPath !== norm) {
          results.push({
            path: fullPath,
            isDir: true,
            mtime: node.mtime,
            mode: node.mode,
          });
        }
        for (const child of node.children.values()) {
          traverse(fullPath === '/' ? '' : fullPath, child);
        }
      }
    };

    const baseNode = this._resolve(norm);
    if (baseNode) {
      for (const child of baseNode.children.values()) {
        traverse(norm, child);
      }
    }

    return results;
  }
}
