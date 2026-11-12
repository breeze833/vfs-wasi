// Shared Read-Only Sysroot (SharedSysroot)
// Packs sysroot directories, standard C/C++ headers, libraries, and runtime files
// into a contiguous, memory-mapped SharedArrayBuffer or ArrayBuffer for zero-copy,
// zero-heap-duplication VFS reads across multiple WebAssembly workers.

import {
  SSYS_MAGIC,
  SSYS_VERSION,
  HEADER_SIZE,
  ENTRY_SIZE,
  align4,
  align8,
  fnv1a,
} from './ssys.js';

import { normalizePath } from './vfs.js';

/**
 * Builds a contiguous, memory-mapped SharedArrayBuffer or ArrayBuffer containing all sysroot files.
 * @param {Array<{path: string, content?: Uint8Array|ArrayBuffer|string, isDir?: boolean, mtime?: number, mode?: number}>|Record<string, Uint8Array|ArrayBuffer|string>|Map<string, any>} inputEntries
 * @param {object} [options]
 * @param {boolean} [options.useArrayBuffer=false] Force standard ArrayBuffer instead of SharedArrayBuffer
 * @returns {SharedArrayBuffer|ArrayBuffer}
 */
export function buildSharedSysroot(inputEntries, options = {}) {
  const fileMap = new Map();
  const dirSet = new Set(['/']);

  function addDir(dirPath) {
    const norm = normalizePath(dirPath);
    if (!norm || norm === '/') return;
    const parts = norm.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      dirSet.add(cur);
    }
  }

  // Normalize input entries
  if (Array.isArray(inputEntries)) {
    for (const item of inputEntries) {
      if (!item || !item.path) continue;
      const norm = normalizePath(item.path);
      if (item.isDir) {
        addDir(norm);
      } else {
        const lastSlash = norm.lastIndexOf('/');
        if (lastSlash > 0) {
          addDir(norm.substring(0, lastSlash));
        }
        let contentBytes;
        if (typeof item.content === 'string') {
          contentBytes = new TextEncoder().encode(item.content);
        } else if (item.content instanceof Uint8Array) {
          contentBytes = item.content;
        } else if (item.content instanceof ArrayBuffer) {
          contentBytes = new Uint8Array(item.content);
        } else {
          contentBytes = new Uint8Array(0);
        }
        fileMap.set(norm, {
          content: contentBytes,
          mtime: item.mtime || Date.now(),
          mode: item.mode || 0o100444, // S_IFREG | r--r--r--
        });
      }
    }
  } else if (inputEntries instanceof Map) {
    for (const [rawPath, rawContent] of inputEntries.entries()) {
      const norm = normalizePath(rawPath);
      const lastSlash = norm.lastIndexOf('/');
      if (lastSlash > 0) {
        addDir(norm.substring(0, lastSlash));
      }
      let contentBytes;
      if (typeof rawContent === 'string') {
        contentBytes = new TextEncoder().encode(rawContent);
      } else if (rawContent instanceof Uint8Array) {
        contentBytes = rawContent;
      } else if (rawContent instanceof ArrayBuffer) {
        contentBytes = new Uint8Array(rawContent);
      } else if (rawContent && rawContent.content) {
        contentBytes = typeof rawContent.content === 'string'
          ? new TextEncoder().encode(rawContent.content)
          : (rawContent.content instanceof Uint8Array ? rawContent.content : new Uint8Array(rawContent.content));
      } else {
        contentBytes = new Uint8Array(0);
      }
      fileMap.set(norm, {
        content: contentBytes,
        mtime: (rawContent && rawContent.mtime) || Date.now(),
        mode: (rawContent && rawContent.mode) || 0o100444,
      });
    }
  } else if (inputEntries && typeof inputEntries === 'object') {
    for (const [rawPath, rawVal] of Object.entries(inputEntries)) {
      const norm = normalizePath(rawPath);
      const lastSlash = norm.lastIndexOf('/');
      if (lastSlash > 0) {
        addDir(norm.substring(0, lastSlash));
      }
      let contentBytes;
      let mtime = Date.now();
      let mode = 0o100444;
      if (typeof rawVal === 'string') {
        contentBytes = new TextEncoder().encode(rawVal);
      } else if (rawVal instanceof Uint8Array) {
        contentBytes = rawVal;
      } else if (rawVal instanceof ArrayBuffer) {
        contentBytes = new Uint8Array(rawVal);
      } else if (rawVal && rawVal.content) {
        contentBytes = typeof rawVal.content === 'string'
          ? new TextEncoder().encode(rawVal.content)
          : (rawVal.content instanceof Uint8Array ? rawVal.content : new Uint8Array(rawVal.content));
        if (rawVal.mtime) mtime = rawVal.mtime;
        if (rawVal.mode) mode = rawVal.mode;
      } else {
        contentBytes = new Uint8Array(0);
      }
      fileMap.set(norm, { content: contentBytes, mtime, mode });
    }
  }

  // Collect all entries: directories first, sorted by path length and name
  const allEntries = [];
  const sortedDirs = Array.from(dirSet).sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  for (const d of sortedDirs) {
    allEntries.push({
      path: d,
      isDir: true,
      content: null,
      mode: 0o040555, // S_IFDIR | r-xr-xr-x
      mtime: Date.now(),
    });
  }

  const sortedFiles = Array.from(fileMap.keys()).sort();
  for (const f of sortedFiles) {
    const item = fileMap.get(f);
    allEntries.push({
      path: f,
      isDir: false,
      content: item.content,
      mode: item.mode,
      mtime: item.mtime,
    });
  }

  const count = allEntries.length;
  const indexTableSize = count * ENTRY_SIZE;

  // Build string table
  const encoder = new TextEncoder();
  const strOffsets = [];
  let currentStrOffset = 0;
  const strByteArrays = [];

  for (const entry of allEntries) {
    const bytes = encoder.encode(entry.path);
    strOffsets.push({ offset: currentStrOffset, length: bytes.length });
    strByteArrays.push(bytes);
    currentStrOffset += bytes.length;
  }

  const stringTableSize = currentStrOffset;
  const stringTableOffset = HEADER_SIZE + indexTableSize;
  const dataSegmentOffset = align8(stringTableOffset + stringTableSize);

  // Compute file data offsets
  let currentDataOffset = 0;
  const fileDataOffsets = [];
  for (const entry of allEntries) {
    if (entry.isDir || !entry.content) {
      fileDataOffsets.push({ offset: 0, length: 0 });
    } else {
      const aligned = align4(currentDataOffset);
      fileDataOffsets.push({ offset: aligned, length: entry.content.length });
      currentDataOffset = aligned + entry.content.length;
    }
  }

  const dataSegmentSize = currentDataOffset;
  const totalBufferSize = align8(dataSegmentOffset + dataSegmentSize);

  // Allocate buffer: use SharedArrayBuffer if available and not explicitly disabled
  const hasSAB = typeof SharedArrayBuffer !== 'undefined';
  const forceAB = options.useArrayBuffer === true;
  const buffer = (!forceAB && hasSAB)
    ? new SharedArrayBuffer(totalBufferSize)
    : new ArrayBuffer(totalBufferSize);

  const dataView = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // Write Header (64 bytes)
  dataView.setUint32(0x00, SSYS_MAGIC, true);
  dataView.setUint32(0x04, SSYS_VERSION, true);
  dataView.setUint32(0x08, count, true);
  dataView.setUint32(0x0C, stringTableOffset, true);
  dataView.setUint32(0x10, stringTableSize, true);
  dataView.setUint32(0x14, dataSegmentOffset, true);
  dataView.setUint32(0x18, dataSegmentSize, true);
  dataView.setUint32(0x1C, totalBufferSize, true);

  // Write Index Table
  for (let i = 0; i < count; i++) {
    const entry = allEntries[i];
    const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;
    const strMeta = strOffsets[i];
    const dataMeta = fileDataOffsets[i];
    const hash = fnv1a(entry.path);

    dataView.setUint32(entryOffset + 0x00, hash, true);
    dataView.setUint32(entryOffset + 0x04, strMeta.offset, true);
    dataView.setUint32(entryOffset + 0x08, strMeta.length, true);
    dataView.setUint32(entryOffset + 0x0C, dataMeta.offset, true);
    dataView.setUint32(entryOffset + 0x10, dataMeta.length, true);
    dataView.setUint32(entryOffset + 0x14, entry.mode, true);
    dataView.setUint32(entryOffset + 0x18, Math.floor(entry.mtime / 1000), true);
    dataView.setUint32(entryOffset + 0x1C, entry.isDir ? 1 : 0, true);
  }

  // Write String Table
  let strCursor = stringTableOffset;
  for (const bytes of strByteArrays) {
    u8.set(bytes, strCursor);
    strCursor += bytes.length;
  }

  // Write Data Segment
  for (let i = 0; i < count; i++) {
    const entry = allEntries[i];
    if (!entry.isDir && entry.content && entry.content.length > 0) {
      const dataMeta = fileDataOffsets[i];
      const destOffset = dataSegmentOffset + dataMeta.offset;
      u8.set(entry.content, destOffset);
    }
  }

  return buffer;
}

/**
 * Fast, zero-copy, read-only reader for SSYS binary images.
 */
export class SharedSysrootReader {
  /**
   * @param {SharedArrayBuffer|ArrayBuffer} buffer
   */
  constructor(buffer) {
    if (!buffer || (!(buffer instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer))) {
      throw new Error('SharedSysrootReader: expected ArrayBuffer or SharedArrayBuffer');
    }

    this.buffer = buffer;
    this.dataView = new DataView(buffer);
    this.u8 = new Uint8Array(buffer);

    const magic = this.dataView.getUint32(0x00, true);
    if (magic !== SSYS_MAGIC) {
      throw new Error(`SharedSysrootReader: Invalid magic 0x${magic.toString(16)} (expected 0x${SSYS_MAGIC.toString(16)})`);
    }

    this.version = this.dataView.getUint32(0x04, true);
    this.count = this.dataView.getUint32(0x08, true);
    this.stringTableOffset = this.dataView.getUint32(0x0C, true);
    this.stringTableSize = this.dataView.getUint32(0x10, true);
    this.dataSegmentOffset = this.dataView.getUint32(0x14, true);
    this.dataSegmentSize = this.dataView.getUint32(0x18, true);
    this.totalBufferSize = this.dataView.getUint32(0x1C, true);

    this.entries = new Map();
    this.dirChildren = new Map();

    this._parseIndex();
  }

  _parseIndex() {
    const decoder = new TextDecoder();

    // Copy string table bytes into an unshared buffer so TextDecoder can safely decode paths
    // (W3C Encoding Standard forbids decoding directly from SharedArrayBuffer views)
    const strTableBytes = new Uint8Array(this.stringTableSize);
    strTableBytes.set(this.u8.subarray(this.stringTableOffset, this.stringTableOffset + this.stringTableSize));

    for (let i = 0; i < this.count; i++) {
      const entryOffset = HEADER_SIZE + i * ENTRY_SIZE;
      const hash = this.dataView.getUint32(entryOffset + 0x00, true);
      const strOffset = this.dataView.getUint32(entryOffset + 0x04, true);
      const strLen = this.dataView.getUint32(entryOffset + 0x08, true);
      const dataOffset = this.dataView.getUint32(entryOffset + 0x0C, true);
      const dataLen = this.dataView.getUint32(entryOffset + 0x10, true);
      const mode = this.dataView.getUint32(entryOffset + 0x14, true);
      const mtimeSec = this.dataView.getUint32(entryOffset + 0x18, true);
      const isDir = this.dataView.getUint32(entryOffset + 0x1C, true) === 1;

      const pathBytes = strTableBytes.subarray(strOffset, strOffset + strLen);
      const path = decoder.decode(pathBytes);

      const entry = {
        path,
        hash,
        isDir,
        dataOffset,
        dataLength: dataLen,
        mode,
        mtime: mtimeSec * 1000,
      };

      this.entries.set(path, entry);

      // Track child entries for directory unioning
      if (path !== '/') {
        const lastSlash = path.lastIndexOf('/');
        const parentDir = lastSlash === 0 ? '/' : path.substring(0, lastSlash);
        const childName = path.substring(lastSlash + 1);

        let children = this.dirChildren.get(parentDir);
        if (!children) {
          children = new Set();
          this.dirChildren.set(parentDir, children);
        }
        children.add(childName);
      }
    }
  }

  exists(path) {
    const norm = normalizePath(path);
    return this.entries.has(norm);
  }

  isDir(path) {
    const norm = normalizePath(path);
    const entry = this.entries.get(norm);
    return entry ? entry.isDir : false;
  }

  stat(path) {
    const norm = normalizePath(path);
    const entry = this.entries.get(norm);
    if (!entry) return null;

    const lastSlash = norm.lastIndexOf('/');
    const name = lastSlash >= 0 ? norm.substring(lastSlash + 1) : norm;

    return {
      name,
      isDir: entry.isDir,
      size: entry.isDir ? 0 : entry.dataLength,
      mtime: entry.mtime,
      mode: entry.mode,
    };
  }

  readFile(path, asText = false) {
    const norm = normalizePath(path);
    const entry = this.entries.get(norm);
    if (!entry) {
      throw new Error(`No such file or directory: ${norm}`);
    }
    if (entry.isDir) {
      throw new Error(`Is a directory: ${norm}`);
    }

    const start = this.dataSegmentOffset + entry.dataOffset;
    const end = start + entry.dataLength;
    const rawSlice = this.u8.subarray(start, end);

    if (asText) {
      // If backed by SharedArrayBuffer, copy slice to unshared buffer for safe TextDecoder
      if (typeof SharedArrayBuffer !== 'undefined' && this.buffer instanceof SharedArrayBuffer) {
        const unshared = new Uint8Array(entry.dataLength);
        unshared.set(rawSlice);
        return new TextDecoder().decode(unshared);
      }
      return new TextDecoder().decode(rawSlice);
    }

    return rawSlice;
  }

  readDir(path) {
    const norm = normalizePath(path);
    const childrenNames = this.dirChildren.get(norm);
    if (!childrenNames) {
      if (this.exists(norm) && this.isDir(norm)) {
        return [];
      }
      return null;
    }

    const results = [];
    for (const name of childrenNames) {
      const childPath = norm === '/' ? `/${name}` : `${norm}/${name}`;
      const entry = this.entries.get(childPath);
      if (entry) {
        results.push({
          name,
          isDir: entry.isDir,
          size: entry.isDir ? 0 : entry.dataLength,
          mtime: entry.mtime,
          mode: entry.mode,
        });
      }
    }

    return results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  getAllPaths() {
    return Array.from(this.entries.keys());
  }

  getEntry(path) {
    const norm = normalizePath(path);
    return this.entries.get(norm) || null;
  }
}
