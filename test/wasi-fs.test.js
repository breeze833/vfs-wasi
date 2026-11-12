// Automated Unit Tests: WASI Preview 1 Filesystem Provider (wasi-fs)

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OverlayVFS,
  buildSharedSysroot,
  createWasiFsImports,
  ESUCCESS,
  EBADF,
  ENOENT,
  EROFS,
  O_CREAT,
  O_TRUNC,
  WHENCE_SET,
  FILETYPE_REGULAR_FILE,
  FILETYPE_DIRECTORY,
  RIGHTS_ALL,
} from '../src/index.js';

test('WASI-FS: Preopens & fd_prestat_get / fd_prestat_dir_name', () => {
  const vfs = new OverlayVFS();
  const wasmMemory = new WebAssembly.Memory({ initial: 2 });

  const imports = createWasiFsImports(vfs, { memory: wasmMemory });
  const view = new DataView(wasmMemory.buffer);

  // Test fd 3 (/workspace)
  const prestatPtr = 1000;
  const res3 = imports.fd_prestat_get(3, prestatPtr);
  assert.equal(res3, ESUCCESS);

  const type = view.getUint8(prestatPtr);
  const nameLen = view.getUint32(prestatPtr + 4, true);
  assert.equal(type, 0); // PREOPENTYPE_DIR
  assert.equal(nameLen, '/workspace'.length);

  const namePtr = 1100;
  const resName = imports.fd_prestat_dir_name(3, namePtr, nameLen);
  assert.equal(resName, ESUCCESS);

  const decodedName = new TextDecoder().decode(new Uint8Array(wasmMemory.buffer, namePtr, nameLen));
  assert.equal(decodedName, '/workspace');

  // Test non-preopen descriptor
  assert.equal(imports.fd_prestat_get(99, prestatPtr), EBADF);
});

test('WASI-FS: path_open, fd_write, fd_seek, fd_read, and fd_close lifecycle', () => {
  const vfs = new OverlayVFS();
  const wasmMemory = new WebAssembly.Memory({ initial: 2 });
  const imports = createWasiFsImports(vfs, { memory: wasmMemory });
  const view = new DataView(wasmMemory.buffer);
  const u8 = new Uint8Array(wasmMemory.buffer);

  // 1. Write file name into memory: "hello.txt"
  const fileName = 'hello.txt';
  const namePtr = 2000;
  u8.set(new TextEncoder().encode(fileName), namePtr);

  // 2. path_open(dirfd=3, path="hello.txt", oflags=O_CREAT)
  const fdOutPtr = 2050;
  const openRes = imports.path_open(
    3,              // dirfd (/workspace)
    0,              // dirflags
    namePtr,        // path_ptr
    fileName.length,// path_len
    O_CREAT,        // oflags
    RIGHTS_ALL,     // fs_rights_base
    RIGHTS_ALL,     // fs_rights_inheriting
    0,              // fdflags
    fdOutPtr        // fd_out
  );
  assert.equal(openRes, ESUCCESS);

  const fd = view.getUint32(fdOutPtr, true);
  assert.ok(fd >= 10);

  // 3. fd_write payload: "Hello WASI Virtual File System!"
  const payload = 'Hello WASI Virtual File System!';
  const payloadBytes = new TextEncoder().encode(payload);
  const payloadPtr = 3000;
  u8.set(payloadBytes, payloadPtr);

  // Prepare iovec: { bufPtr: payloadPtr, bufLen: payloadBytes.length }
  const iovsPtr = 4000;
  view.setUint32(iovsPtr, payloadPtr, true);
  view.setUint32(iovsPtr + 4, payloadBytes.length, true);

  const nwrittenPtr = 4050;
  const writeRes = imports.fd_write(fd, iovsPtr, 1, nwrittenPtr);
  assert.equal(writeRes, ESUCCESS);
  assert.equal(view.getUint32(nwrittenPtr, true), payloadBytes.length);

  // Verify VFS has the written file
  assert.equal(vfs.readFile('/workspace/hello.txt', true), payload);

  // 4. fd_seek back to beginning (offset 0, WHENCE_SET)
  const newOffsetPtr = 4100;
  const seekRes = imports.fd_seek(fd, 0n, WHENCE_SET, newOffsetPtr);
  assert.equal(seekRes, ESUCCESS);
  assert.equal(view.getBigUint64(newOffsetPtr, true), 0n);

  // 5. fd_read back from file into a different buffer
  const readBufPtr = 5000;
  const readIovsPtr = 6000;
  view.setUint32(readIovsPtr, readBufPtr, true);
  view.setUint32(readIovsPtr + 4, 100, true);

  const nreadPtr = 6050;
  const readRes = imports.fd_read(fd, readIovsPtr, 1, nreadPtr);
  assert.equal(readRes, ESUCCESS);
  assert.equal(view.getUint32(nreadPtr, true), payloadBytes.length);

  const readBackStr = new TextDecoder().decode(u8.subarray(readBufPtr, readBufPtr + payloadBytes.length));
  assert.equal(readBackStr, payload);

  // 6. fd_close
  assert.equal(imports.fd_close(fd), ESUCCESS);
});

test('WASI-FS: Read-Only System Mount EROFS Protection via path_open & path_unlink', () => {
  const sysrootBuf = buildSharedSysroot([
    { path: '/usr/include/stdio.h', content: '/* sysroot stdio */' },
  ], { useArrayBuffer: true });

  const vfs = new OverlayVFS({ sharedSysroot: sysrootBuf });
  const wasmMemory = new WebAssembly.Memory({ initial: 2 });
  const imports = createWasiFsImports(vfs, { memory: wasmMemory });
  const view = new DataView(wasmMemory.buffer);
  const u8 = new Uint8Array(wasmMemory.buffer);

  // Try creating a file inside /usr/include via root preopen (fd 4)
  const badPath = 'usr/include/malicious.h';
  const badPathPtr = 2000;
  u8.set(new TextEncoder().encode(badPath), badPathPtr);

  const fdOutPtr = 2050;
  const openRes = imports.path_open(
    4,              // dirfd (/)
    0,
    badPathPtr,
    badPath.length,
    O_CREAT | O_TRUNC,
    RIGHTS_ALL,
    RIGHTS_ALL,
    0,
    fdOutPtr
  );

  assert.equal(openRes, EROFS);

  // Try unlinking an existing sysroot file: /usr/include/stdio.h
  const stdioRel = 'usr/include/stdio.h';
  u8.set(new TextEncoder().encode(stdioRel), badPathPtr);

  const unlinkRes = imports.path_unlink_file(4, badPathPtr, stdioRel.length);
  assert.equal(unlinkRes, EROFS);
});

test('WASI-FS: Directory Enumeration with fd_readdir', () => {
  const vfs = new OverlayVFS();
  vfs.writeFile('/workspace/file1.txt', '1');
  vfs.writeFile('/workspace/file2.txt', '2');
  vfs.mkdir('/workspace/subdir');

  const wasmMemory = new WebAssembly.Memory({ initial: 2 });
  const imports = createWasiFsImports(vfs, { memory: wasmMemory });
  const view = new DataView(wasmMemory.buffer);

  const bufPtr = 10000;
  const bufLen = 1024;
  const bufUsedPtr = 11000;

  // readdir on preopen fd 3 (/workspace)
  const readdirRes = imports.fd_readdir(3, bufPtr, bufLen, 0n, bufUsedPtr);
  assert.equal(readdirRes, ESUCCESS);

  const bytesUsed = view.getUint32(bufUsedPtr, true);
  assert.ok(bytesUsed > 0);
});
