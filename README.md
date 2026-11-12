# vfs-wasi

A zero-dependency, high-performance **Two-Tier Virtual File System (VFS)** and **WASI Preview 1 (`wasi_snapshot_preview1`)** filesystem host provider for WebAssembly runtimes.

Designed specifically for multi-worker browser IDEs (such as [wasm-c-ide](https://github.com/breeze833/wasm-c-ide)), WebAssembly workers, Node.js sandboxes, and POSIX developer toolchains (Clang/LLVM, BusyBox ash, GNU Make, SQLite, Python, Ruby).

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
3. **Seamless Directory Unioning**: `readDir` and `fd_readdir` automatically union children from both tiers, deduplicating matching names.
4. **Strict POSIX Permission Enforcement (`EROFS`)**: Intercepts modifications to system mounts at the host level, returning standard WASI `EROFS` (errno 65).
5. **Zero-Dependency WASI Preview 1 Filesystem Provider**: Exposes standard `wasi_snapshot_preview1` filesystem imports ready to be wired directly into any WASI WebAssembly instance.

---

## Features

- **Pure Zero-Dependency Architecture**: 100% vanilla JavaScript / TypedArrays; zero external runtime dependencies.
- **Dual Buffer Support**: Operates over `SharedArrayBuffer` (in COOP/COEP isolated environments) or regular `ArrayBuffer` (in single-thread or non-isolated environments).
- **W3C TextDecoder Compliant**: Fully compliant with the W3C Encoding Standard prohibition on shared buffer views.
- **Complete WASI Preview 1 Syscall Coverage**:
  - `path_open`, `fd_read`, `fd_write`, `fd_seek`, `fd_tell`, `fd_close`
  - `fd_filestat_get`, `fd_filestat_set_size`, `fd_fdstat_get`
  - `fd_readdir` (with 24-byte `__wasi_dirent_t` headers and cookie-based pagination)
  - `path_unlink_file`, `path_remove_directory`, `path_create_directory`, `path_rename`
  - `path_filestat_get`, `path_filestat_set_times` (preserves `mtime` for tools like `touch` and `make`)
- **Differential Worker Synchronization**: Built-in delta tracking (`exportDelta`, `applyDelta`) for fast state propagation across worker boundaries.
- **CLI Utilities Included**:
  - `vfs-pack`: Pack directories or tarballs into `.ssys` images.
  - `vfs-inspect`: Validate and inspect `.ssys` images.

---

## Quick Start

### 1. In Node.js / Single-Threaded Environments

```javascript
import { OverlayVFS, buildSharedSysroot, createWasiFsImports } from 'vfs-wasi';

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

// In worker.js (e.g. compiler.worker.js or shell.worker.js):
import { OverlayVFS, createWasiFsImports } from 'vfs-wasi';

self.onmessage = async (e) => {
  if (e.data.type === 'init') {
    const vfs = new OverlayVFS({ sharedSysroot: e.data.sysroot });
    
    // Bind directly to WebAssembly WASI instance:
    const fsImports = createWasiFsImports(vfs, {
      preopens: { '/workspace': 3, '/': 4 }
    });

    const wasiImports = {
      wasi_snapshot_preview1: {
        ...hostProcessImports, // clocks, random, exit
        ...fsImports           // all filesystem operations
      }
    };

    const { instance } = await WebAssembly.instantiate(wasmModule, wasiImports);
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
