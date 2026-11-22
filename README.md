# vfs-wasi

A zero-dependency, high-performance **Two-Tier Virtual File System (`OverlayVFS`)**, contiguous **Shared Binary Sysroot (`SharedSysroot` / `SSYS`)**, and **Worker Delta Synchronization (`DeltaTracker`)** library for WebAssembly runtimes.

Designed specifically for multi-worker browser IDEs (such as [wasm-c-ide](https://github.com/breeze833/wasm-c-ide)), WebAssembly workers, Node.js sandboxes, and POSIX toolchains (Clang/LLVM, BusyBox ash, GNU Make, SQLite, Python, Ruby)—pairing directly with [`wasi-host`](https://github.com/breeze833/wasi-host) for `wasi_snapshot_preview1` syscall execution.

---

## The Problem: The Worker Memory Wall in WebAssembly

In modern browser WebAssembly environments, running complete developer toolchains (compilers, POSIX shells, runtimes, build systems) requires mounting large system trees (C/C++ libc headers, runtime static libraries, Python standard libraries) containing thousands of files (~100 MB+ decompressed).

When multi-worker concurrency is introduced (such as a Tri-Worker model with compiler, shell, and runtime workers):
* **Redundant Heap Duplication**: Unpacking ~4,000+ files into independent JavaScript object trees per worker consumes ~100 MB of JS heap *per worker* (~300+ MB combined), causing massive heap pressure and aggressive browser garbage collection.
* **Boot Latency**: Every worker must fetch, decompress, and parse large tarballs independently, freezing workers during startup.
* **Lack of Overlay Protection**: In conventional in-memory filesystems, user code or shell scripts can accidentally modify system headers (`/usr/include/stdio.h`), corrupting the in-memory runtime.

---

## The Solution: Two-Tier Overlay + Contiguous Binary Sysroot (`SSYS`)

`vfs-wasi` solves this problem by decoupling the virtual filesystem into two distinct tiers:

```
+-----------------------------------------------------------------+
|                       VFS / WASI Path                           |
+-----------------------------------------------------------------+
                                |
               +----------------+----------------+
               |                                 |
        Top Tier (Mutable)               Bottom Tier (Immutable)
        e.g. /workspace, /tmp            e.g. /usr, /include, /lib, /bin
               |                                 |
               v                                 v
      +-----------------+              +-------------------+
      | Local JS Nodes  |              | SharedSysroot     |
      | (Read-Write)    |              | (Read-Only)       |
      | - Map storage   |              | - Zero-copy SAB   |
      | - In-memory tree|              | - Fast hash index |
      +-----------------+              +-------------------+
```

1. **Zero-Copy SharedSysroot (`SSYS`)**: Compiles system directories into a single contiguous, memory-mapped byte buffer stored in a `SharedArrayBuffer` (or standard `ArrayBuffer`).
2. **Instant Multi-Worker Startup**: Multiple Web Workers query the exact same buffer simultaneously using 32-bit FNV-1a hash index lookups with **0ms startup time and zero memory duplication**.
3. **Seamless Directory Unioning**: `readDir` automatically unions children from both tiers, deduplicating matching names.
4. **Strict POSIX Permission Enforcement (`EROFS`)**: Guards system mounts at the VFS layer (`EROFS`, errno 65) and exposes `_isReadOnly(path)` for WASI hosts.
5. **Clean `wasi-host` Integration**: Composes directly with [`wasi-host`](https://github.com/breeze833/wasi-host) (`new WasiHost({ vfs })`), keeping VFS storage and binary sysroot tooling 100% dependency-free.

---

## Features

- **Pure Zero-Dependency Architecture**: 100% vanilla JavaScript / TypedArrays; zero external runtime dependencies.
- **Dual Buffer Support**: Operates over `SharedArrayBuffer` (in COOP/COEP isolated environments) or regular `ArrayBuffer` (in single-thread or non-isolated environments).
- **W3C TextDecoder Compliant**: Fully compliant with the W3C Encoding Standard prohibition on shared buffer views.
- **Two-Tier Overlay & `wasi-host` Compatibility**:
  - Top-tier mutable storage (`writeFile`, `mkdir`, `removeFile`, `removeDir`, `rename`, `setTimes`) with `mtime` persistence and POSIX error semantics (`EROFS`, `ENOENT`, `EISDIR`, `ENOTDIR`, `EEXIST`, `ENOTEMPTY`).
  - Bottom-tier immutable `SharedSysroot` (`SSYS`) lookup and sorted directory unioning (`readDir`).
- **Differential Worker Synchronization**: Built-in delta tracking (`exportDelta`, `applyDelta`) for fast state propagation across worker boundaries.
- **CLI Utilities Included**:
  - `vfs-pack`: Pack directories or tarballs into `.ssys` images.
  - `vfs-inspect`: Validate and inspect `.ssys` images.

---

## Quick Start

### 1. In Node.js / Single-Threaded Environments

```javascript
import { OverlayVFS, buildSharedSysroot } from 'vfs-wasi';

// 1. Pack system files into a contiguous binary sysroot
const sysrootBuffer = buildSharedSysroot([
  { path: '/usr/include/stdio.h', content: '#pragma once\nint printf(const char*, ...);' },
  { path: '/usr/lib/libc.a', content: new Uint8Array([0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]) }
]);

// 2. Initialize Two-Tier Overlay VFS
const vfs = new OverlayVFS({
  sharedSysroot: sysrootBuffer,
  workingDir: '/workspace'
});

// 3. User operations happen in top-tier mutable storage
vfs.writeFile('/workspace/main.c', '#include <stdio.h>\nint main() { printf("Hello\\n"); return 0; }');

// Lookups union both tiers seamlessly:
console.log(vfs.exists('/workspace/main.c'));      // true (mutable)
console.log(vfs.exists('/usr/include/stdio.h'));   // true (shared sysroot)

// System mounts are strictly protected:
try {
  vfs.writeFile('/usr/include/stdio.h', 'corrupt');
} catch (err) {
  console.log(err.message); // EROFS: read-only file system
}
```

### 2. Multi-Worker Browser Architecture (Zero-Copy Sysroot Sharing)

```javascript
// In main.js:
import { buildSharedSysroot } from 'vfs-wasi';

// Fetch or build the SharedSysroot inside a SharedArrayBuffer once:
const response = await fetch('/sysroot.ssys');
const sharedBuffer = await response.arrayBuffer(); // or SharedArrayBuffer

// Broadcast to workers with 0ms initialization and zero heap duplication:
compilerWorker.postMessage({ type: 'init', sysroot: sharedBuffer });
shellWorker.postMessage({ type: 'init', sysroot: sharedBuffer });
runtimeWorker.postMessage({ type: 'init', sysroot: sharedBuffer });

// In worker.js (e.g. compiler.worker.js or runtime.worker.js):
import { OverlayVFS } from 'vfs-wasi';
import { WasiHost } from 'wasi-host';

self.onmessage = async (e) => {
  if (e.data.type === 'init') {
    const vfs = new OverlayVFS({ sharedSysroot: e.data.sysroot });

    let memory = null;
    const host = new WasiHost({
      vfs,
      cwd: '/workspace',
      preopens: [
        { fd: 3, path: '/workspace', name: '.' },
        { fd: 4, path: '/', name: '/' },
      ],
      getMemory: () => memory,
    });

    const { instance } = await WebAssembly.instantiate(wasmModule, host.createImportObject());
    memory = instance.exports.memory;
    instance.exports._start();
  }
};
```

---

## CLI Utilities

`vfs-wasi` bundles command-line utilities for creating and inspecting `.ssys` images:

```bash
# Pack a directory or tar archive into an optimized .ssys binary image:
npx vfs-pack ./sysroot -o sysroot.ssys

# Inspect and verify a .ssys binary file (structure, hash collisions, entry count):
npx vfs-inspect sysroot.ssys

# Dump file tree from a .ssys image:
npx vfs-inspect sysroot.ssys --tree
```

---

## Running Tests

```bash
npm test
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
