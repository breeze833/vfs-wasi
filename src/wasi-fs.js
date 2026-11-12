// WASI Preview 1 Filesystem Provider (wasi-fs)
// Implements pure, zero-dependency wasi_snapshot_preview1 filesystem syscall imports
// backed by OverlayVFS.

import {
  EROFS,
  ENOENT,
  EISDIR,
  ENOTDIR,
  EEXIST,
  EINVAL,
  EBADF,
  EPERM,
  normalizePath,
} from './vfs.js';

// WASI Preview 1 Constants
export const ESUCCESS = 0;
export const ENOSYS = 52;
export const ENOTEMPTY = 66;

export const FILETYPE_UNKNOWN = 0;
export const FILETYPE_BLOCK_DEVICE = 1;
export const FILETYPE_CHARACTER_DEVICE = 2;
export const FILETYPE_DIRECTORY = 3;
export const FILETYPE_REGULAR_FILE = 4;
export const FILETYPE_SOCKET_DGRAM = 5;
export const FILETYPE_SOCKET_STREAM = 6;
export const FILETYPE_SYMBOLIC_LINK = 7;

export const PREOPENTYPE_DIR = 0;

export const O_CREAT = 1;
export const O_DIRECTORY = 2;
export const O_EXCL = 4;
export const O_TRUNC = 8;

export const FDFLAG_APPEND = 1;
export const FDFLAG_DSYNC = 2;
export const FDFLAG_NONBLOCK = 4;
export const FDFLAG_RSYNC = 8;
export const FDFLAG_SYNC = 16;

export const WHENCE_SET = 0;
export const WHENCE_CUR = 1;
export const WHENCE_END = 2;

export const RIGHTS_ALL = 0x1fffffffffffffffn;
export const RIGHTS_READ = 0x0000000000000002n;
export const RIGHTS_WRITE = 0x0000000000000040n;

/**
 * Creates a standalone WASI Preview 1 filesystem import object backed by OverlayVFS.
 * @param {OverlayVFS} vfs
 * @param {object} [options]
 * @param {Function|WebAssembly.Memory} [options.memory] Function returning WebAssembly.Memory, or Memory instance
 * @param {Record<string, number>|Array<{fd: number, path: string}>} [options.preopens]
 * @param {Function} [options.stdin] Custom stdin reader callback
 * @param {Function} [options.stdout] Custom stdout writer callback
 * @param {Function} [options.stderr] Custom stderr writer callback
 * @returns {Record<string, Function>}
 */
export function createWasiFsImports(vfs, options = {}) {
  let memoryRef = options.memory || null;

  function getBuffer() {
    if (typeof memoryRef === 'function') {
      const mem = memoryRef();
      return mem ? mem.buffer : null;
    }
    if (memoryRef && memoryRef.buffer) {
      return memoryRef.buffer;
    }
    return null;
  }

  function getDataView() {
    const buf = getBuffer();
    if (!buf) throw new Error('WasiFs: WebAssembly memory buffer is not accessible');
    return new DataView(buf);
  }

  function getUint8() {
    const buf = getBuffer();
    if (!buf) throw new Error('WasiFs: WebAssembly memory buffer is not accessible');
    return new Uint8Array(buf);
  }

  function readStr(ptr, len) {
    if (len === 0) return '';
    const u8 = getUint8();
    const slice = u8.subarray(ptr, ptr + len);
    // If SAB, copy slice to unshared buffer for safe TextDecoder
    if (typeof SharedArrayBuffer !== 'undefined' && u8.buffer instanceof SharedArrayBuffer) {
      const unshared = new Uint8Array(len);
      unshared.set(slice);
      return new TextDecoder().decode(unshared);
    }
    return new TextDecoder().decode(slice);
  }

  function writeStr(ptr, maxLen, str) {
    const u8 = getUint8();
    const encoded = new TextEncoder().encode(str);
    const toWrite = Math.min(encoded.length, maxLen);
    u8.set(encoded.subarray(0, toWrite), ptr);
    return toWrite;
  }

  // Preopen setup
  const preopens = [];
  if (options.preopens) {
    if (Array.isArray(options.preopens)) {
      for (const p of options.preopens) {
        preopens.push({ fd: p.fd, path: normalizePath(p.path) });
      }
    } else {
      for (const [p, fd] of Object.entries(options.preopens)) {
        preopens.push({ fd: Number(fd), path: normalizePath(p) });
      }
    }
  } else {
    // Default preopens matching standard WASI configurations
    preopens.push({ fd: 3, path: '/workspace' });
    preopens.push({ fd: 4, path: '/' });
  }

  let nextFd = 10;
  for (const p of preopens) {
    if (p.fd >= nextFd) nextFd = p.fd + 1;
  }

  const openFiles = new Map();

  function getPreopen(fd) {
    return preopens.find(p => p.fd === fd) || null;
  }

  function resolvePath(dirfd, relativePath) {
    const normRel = relativePath || '';
    if (normRel.startsWith('/')) {
      return normalizePath(normRel);
    }
    const pre = getPreopen(dirfd);
    if (pre) {
      return normalizePath(normRel, pre.path);
    }
    const file = openFiles.get(dirfd);
    if (file && file.isDir) {
      return normalizePath(normRel, file.path);
    }
    return normalizePath(normRel, '/workspace');
  }

  return {
    // Allows late-binding of WebAssembly memory instance
    setMemory(mem) {
      memoryRef = mem;
    },

    fd_prestat_get(fd, prestat_out) {
      const pre = getPreopen(fd);
      if (!pre) return EBADF;
      const view = getDataView();
      // __wasi_prestat_t: pr_type (uint8, 0 = PREOPENTYPE_DIR), pr_name_len (uint32 at offset 4)
      view.setUint8(prestat_out, PREOPENTYPE_DIR);
      view.setUint32(prestat_out + 4, new TextEncoder().encode(pre.path).length, true);
      return ESUCCESS;
    },

    fd_prestat_dir_name(fd, path_ptr, path_len) {
      const pre = getPreopen(fd);
      if (!pre) return EBADF;
      writeStr(path_ptr, path_len, pre.path);
      return ESUCCESS;
    },

    fd_fdstat_get(fd, stat_out) {
      const view = getDataView();
      // Check stdin/stdout/stderr
      if (fd === 0 || fd === 1 || fd === 2) {
        view.setUint8(stat_out, FILETYPE_CHARACTER_DEVICE);
        view.setUint16(stat_out + 2, 0, true);
        view.setBigUint64(stat_out + 8, RIGHTS_ALL, true);
        view.setBigUint64(stat_out + 16, RIGHTS_ALL, true);
        return ESUCCESS;
      }

      // Check preopens
      const pre = getPreopen(fd);
      if (pre) {
        view.setUint8(stat_out, FILETYPE_DIRECTORY);
        view.setUint16(stat_out + 2, 0, true);
        view.setBigUint64(stat_out + 8, RIGHTS_ALL, true);
        view.setBigUint64(stat_out + 16, RIGHTS_ALL, true);
        return ESUCCESS;
      }

      // Check opened files
      const file = openFiles.get(fd);
      if (!file) return EBADF;

      view.setUint8(stat_out, file.isDir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
      view.setUint16(stat_out + 2, file.fdflags || 0, true);
      view.setBigUint64(stat_out + 8, file.rightsBase || RIGHTS_ALL, true);
      view.setBigUint64(stat_out + 16, file.rightsInheriting || RIGHTS_ALL, true);
      return ESUCCESS;
    },

    fd_filestat_get(fd, stat_out) {
      let targetPath = null;
      let isDir = false;

      const pre = getPreopen(fd);
      if (pre) {
        targetPath = pre.path;
        isDir = true;
      } else {
        const file = openFiles.get(fd);
        if (file) {
          targetPath = file.path;
          isDir = file.isDir;
        }
      }

      if (!targetPath) return EBADF;

      const st = vfs.stat(targetPath);
      if (!st) return ENOENT;

      const view = getDataView();
      const mtimeNs = BigInt(st.mtime || Date.now()) * 1000000n;

      view.setBigUint64(stat_out + 0, 1n, true); // dev
      view.setBigUint64(stat_out + 8, 1n, true); // ino
      view.setUint8(stat_out + 16, isDir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
      view.setBigUint64(stat_out + 24, 1n, true); // nlink
      view.setBigUint64(stat_out + 32, BigInt(st.size || 0), true); // size
      view.setBigUint64(stat_out + 40, mtimeNs, true); // atim
      view.setBigUint64(stat_out + 48, mtimeNs, true); // mtim
      view.setBigUint64(stat_out + 56, mtimeNs, true); // ctim
      return ESUCCESS;
    },

    fd_filestat_set_size(fd, size) {
      const file = openFiles.get(fd);
      if (!file || file.isDir) return EBADF;

      if (vfs._isReadOnly(file.path)) {
        return EROFS;
      }

      const targetSize = Number(size);
      let content = new Uint8Array(0);
      try {
        content = vfs.readFile(file.path);
      } catch (_) {}

      const newContent = new Uint8Array(targetSize);
      newContent.set(content.subarray(0, Math.min(content.length, targetSize)));
      vfs.writeFile(file.path, newContent);
      return ESUCCESS;
    },

    fd_read(fd, iovs_ptr, iovs_len, nread_out) {
      const view = getDataView();
      const u8 = getUint8();

      // Handle stdin
      if (fd === 0) {
        if (typeof options.stdin === 'function') {
          let totalRead = 0;
          for (let i = 0; i < iovs_len; i++) {
            const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
            const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);
            const readChunk = options.stdin(bufLen);
            if (!readChunk || readChunk.length === 0) break;
            u8.set(readChunk.subarray(0, bufLen), bufPtr);
            totalRead += Math.min(readChunk.length, bufLen);
          }
          view.setUint32(nread_out, totalRead, true);
          return ESUCCESS;
        }
        view.setUint32(nread_out, 0, true);
        return ESUCCESS;
      }

      const file = openFiles.get(fd);
      if (!file) return EBADF;
      if (file.isDir) return EISDIR;

      let fileData;
      try {
        fileData = vfs.readFile(file.path);
      } catch (err) {
        return err.errno || ENOENT;
      }

      let totalRead = 0;
      for (let i = 0; i < iovs_len; i++) {
        const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
        const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);

        if (file.offset >= fileData.length) break;

        const available = fileData.length - file.offset;
        const toCopy = Math.min(available, bufLen);

        u8.set(fileData.subarray(file.offset, file.offset + toCopy), bufPtr);
        file.offset += toCopy;
        totalRead += toCopy;
      }

      view.setUint32(nread_out, totalRead, true);
      return ESUCCESS;
    },

    fd_write(fd, iovs_ptr, iovs_len, nwritten_out) {
      const view = getDataView();
      const u8 = getUint8();

      // Handle stdout / stderr
      if (fd === 1 || fd === 2) {
        let totalWritten = 0;
        const chunks = [];
        for (let i = 0; i < iovs_len; i++) {
          const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
          const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);
          if (bufLen > 0) {
            chunks.push(u8.subarray(bufPtr, bufPtr + bufLen));
            totalWritten += bufLen;
          }
        }
        const handler = fd === 1 ? options.stdout : options.stderr;
        if (typeof handler === 'function') {
          for (const chunk of chunks) handler(chunk);
        }
        view.setUint32(nwritten_out, totalWritten, true);
        return ESUCCESS;
      }

      const file = openFiles.get(fd);
      if (!file) return EBADF;
      if (file.isDir) return EISDIR;

      if (vfs._isReadOnly(file.path)) {
        return EROFS;
      }

      let existing = new Uint8Array(0);
      try {
        existing = vfs.readFile(file.path);
      } catch (_) {}

      if ((file.fdflags & FDFLAG_APPEND) !== 0) {
        file.offset = existing.length;
      }

      // Calculate total incoming write size
      let incomingBytes = 0;
      for (let i = 0; i < iovs_len; i++) {
        incomingBytes += view.getUint32(iovs_ptr + i * 8 + 4, true);
      }

      const neededSize = Math.max(existing.length, file.offset + incomingBytes);
      let newBuffer = existing;
      if (neededSize > existing.length) {
        newBuffer = new Uint8Array(neededSize);
        newBuffer.set(existing);
      } else {
        newBuffer = new Uint8Array(existing);
      }

      let totalWritten = 0;
      for (let i = 0; i < iovs_len; i++) {
        const bufPtr = view.getUint32(iovs_ptr + i * 8, true);
        const bufLen = view.getUint32(iovs_ptr + i * 8 + 4, true);
        if (bufLen > 0) {
          newBuffer.set(u8.subarray(bufPtr, bufPtr + bufLen), file.offset);
          file.offset += bufLen;
          totalWritten += bufLen;
        }
      }

      vfs.writeFile(file.path, newBuffer);
      view.setUint32(nwritten_out, totalWritten, true);
      return ESUCCESS;
    },

    fd_seek(fd, offset, whence, newoffset_out) {
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      if (file.isDir) return EISDIR;

      let fileLen = 0;
      try {
        const st = vfs.stat(file.path);
        if (st) fileLen = st.size;
      } catch (_) {}

      const off = typeof offset === 'bigint' ? Number(offset) : Number(offset);
      let newOff = file.offset;

      if (whence === WHENCE_SET) {
        newOff = off;
      } else if (whence === WHENCE_CUR) {
        newOff = file.offset + off;
      } else if (whence === WHENCE_END) {
        newOff = fileLen + off;
      } else {
        return EINVAL;
      }

      if (newOff < 0) return EINVAL;

      file.offset = newOff;
      const view = getDataView();
      view.setBigUint64(newoffset_out, BigInt(newOff), true);
      return ESUCCESS;
    },

    fd_tell(fd, offset_out) {
      const file = openFiles.get(fd);
      if (!file) return EBADF;
      const view = getDataView();
      view.setBigUint64(offset_out, BigInt(file.offset), true);
      return ESUCCESS;
    },

    fd_close(fd) {
      if (openFiles.has(fd)) {
        openFiles.delete(fd);
        return ESUCCESS;
      }
      return ESUCCESS;
    },

    fd_readdir(fd, buf_ptr, buf_len, cookie, bufused_out) {
      let targetPath = null;
      const pre = getPreopen(fd);
      if (pre) {
        targetPath = pre.path;
      } else {
        const file = openFiles.get(fd);
        if (file && file.isDir) targetPath = file.path;
      }

      if (!targetPath) return EBADF;

      let entries;
      try {
        entries = vfs.readDir(targetPath);
      } catch (err) {
        return err.errno || ENOENT;
      }

      const view = getDataView();
      const u8 = getUint8();
      const encoder = new TextEncoder();

      const startIdx = Number(cookie);
      let bufOffset = 0;

      for (let i = startIdx; i < entries.length; i++) {
        const entry = entries[i];
        const nameBytes = encoder.encode(entry.name);
        const direntSize = 24 + nameBytes.length;

        if (bufOffset + 24 > buf_len) {
          break;
        }

        const nextCookie = BigInt(i + 1);
        const curPtr = buf_ptr + bufOffset;

        // __wasi_dirent_t:
        // d_next (uint64 at 0)
        // d_ino (uint64 at 8)
        // d_namlen (uint32 at 16)
        // d_type (uint8 at 20)
        view.setBigUint64(curPtr + 0, nextCookie, true);
        view.setBigUint64(curPtr + 8, BigInt(i + 1), true);
        view.setUint32(curPtr + 16, nameBytes.length, true);
        view.setUint8(curPtr + 20, entry.isDir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);

        bufOffset += 24;

        const nameSpace = Math.min(nameBytes.length, buf_len - bufOffset);
        if (nameSpace > 0) {
          u8.set(nameBytes.subarray(0, nameSpace), buf_ptr + bufOffset);
          bufOffset += nameSpace;
        }

        if (bufOffset >= buf_len) {
          break;
        }
      }

      view.setUint32(bufused_out, bufOffset, true);
      return ESUCCESS;
    },

    path_open(dirfd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, fd_out) {
      const relPath = readStr(path_ptr, path_len);
      const fullPath = resolvePath(dirfd, relPath);

      const isDirReq = (oflags & O_DIRECTORY) !== 0;
      const isCreat = (oflags & O_CREAT) !== 0;
      const isExcl = (oflags & O_EXCL) !== 0;
      const isTrunc = (oflags & O_TRUNC) !== 0;
      const isAppend = (fdflags & FDFLAG_APPEND) !== 0;

      const exists = vfs.exists(fullPath);

      if (isCreat && exists && isExcl) {
        return EEXIST;
      }

      if (!exists) {
        if (!isCreat) {
          return ENOENT;
        }
        if (vfs._isReadOnly(fullPath)) {
          return EROFS;
        }
        try {
          vfs.writeFile(fullPath, new Uint8Array(0));
        } catch (err) {
          return err.errno || EPERM;
        }
      }

      const isDir = vfs.isDir(fullPath);
      if (isDirReq && !isDir) {
        return ENOTDIR;
      }

      if (isTrunc && !isDir) {
        if (vfs._isReadOnly(fullPath)) {
          return EROFS;
        }
        try {
          vfs.writeFile(fullPath, new Uint8Array(0));
        } catch (err) {
          return err.errno || EPERM;
        }
      }

      const newFd = nextFd++;
      openFiles.set(newFd, {
        path: fullPath,
        isDir,
        offset: 0,
        fdflags,
        rightsBase: fs_rights_base,
        rightsInheriting: fs_rights_inheriting,
      });

      const view = getDataView();
      view.setUint32(fd_out, newFd, true);
      return ESUCCESS;
    },

    path_filestat_get(dirfd, flags, path_ptr, path_len, stat_out) {
      const relPath = readStr(path_ptr, path_len);
      const fullPath = resolvePath(dirfd, relPath);

      const st = vfs.stat(fullPath);
      if (!st) return ENOENT;

      const view = getDataView();
      const mtimeNs = BigInt(st.mtime || Date.now()) * 1000000n;

      view.setBigUint64(stat_out + 0, 1n, true); // dev
      view.setBigUint64(stat_out + 8, 1n, true); // ino
      view.setUint8(stat_out + 16, st.isDir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE);
      view.setBigUint64(stat_out + 24, 1n, true); // nlink
      view.setBigUint64(stat_out + 32, BigInt(st.size || 0), true); // size
      view.setBigUint64(stat_out + 40, mtimeNs, true); // atim
      view.setBigUint64(stat_out + 48, mtimeNs, true); // mtim
      view.setBigUint64(stat_out + 56, mtimeNs, true); // ctim
      return ESUCCESS;
    },

    path_filestat_set_times(dirfd, flags, path_ptr, path_len, atim, mtim, fst_flags) {
      const relPath = readStr(path_ptr, path_len);
      const fullPath = resolvePath(dirfd, relPath);

      if (!vfs.exists(fullPath)) return ENOENT;
      if (vfs._isReadOnly(fullPath)) return EROFS;

      let mtimeNs = BigInt(Date.now()) * 1000000n;
      if ((fst_flags & 4) !== 0) {
        mtimeNs = mtim;
      }

      try {
        vfs.setTimes(fullPath, atim, mtimeNs);
        return ESUCCESS;
      } catch (err) {
        return err.errno || EPERM;
      }
    },

    path_create_directory(dirfd, path_ptr, path_len) {
      const relPath = readStr(path_ptr, path_len);
      const fullPath = resolvePath(dirfd, relPath);

      if (vfs.exists(fullPath)) return EEXIST;
      if (vfs._isReadOnly(fullPath)) return EROFS;

      try {
        vfs.mkdir(fullPath, { recursive: false });
        return ESUCCESS;
      } catch (err) {
        return err.errno || EPERM;
      }
    },

    path_unlink_file(dirfd, path_ptr, path_len) {
      const relPath = readStr(path_ptr, path_len);
      const fullPath = resolvePath(dirfd, relPath);

      if (!vfs.exists(fullPath)) return ENOENT;
      if (vfs.isDir(fullPath)) return EISDIR;
      if (vfs._isReadOnly(fullPath)) return EROFS;

      try {
        vfs.removeFile(fullPath);
        return ESUCCESS;
      } catch (err) {
        return err.errno || EPERM;
      }
    },

    path_remove_directory(dirfd, path_ptr, path_len) {
      const relPath = readStr(path_ptr, path_len);
      const fullPath = resolvePath(dirfd, relPath);

      if (!vfs.exists(fullPath)) return ENOENT;
      if (!vfs.isDir(fullPath)) return ENOTDIR;
      if (vfs._isReadOnly(fullPath)) return EROFS;

      try {
        vfs.removeDir(fullPath, false);
        return ESUCCESS;
      } catch (err) {
        return err.errno || EPERM;
      }
    },

    path_rename(old_dirfd, old_path_ptr, old_path_len, new_dirfd, new_path_ptr, new_path_len) {
      const oldRel = readStr(old_path_ptr, old_path_len);
      const newRel = readStr(new_path_ptr, new_path_len);
      const oldFull = resolvePath(old_dirfd, oldRel);
      const newFull = resolvePath(new_dirfd, newRel);

      if (!vfs.exists(oldFull)) return ENOENT;
      if (vfs._isReadOnly(oldFull) || vfs._isReadOnly(newFull)) return EROFS;

      try {
        vfs.rename(oldFull, newFull);
        return ESUCCESS;
      } catch (err) {
        return err.errno || EPERM;
      }
    },
  };
}
