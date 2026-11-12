# SPEC.md: Architectural Specification for `vfs-wasi`

---

## 1. Architectural Ground Truth & Mission Statement

`vfs-wasi` provides a zero-dependency, high-performance **Two-Tier Virtual File System (VFS)** and **WASI Preview 1 (`wasi_snapshot_preview1`)** filesystem host provider for WebAssembly runtimes.

Designed specifically for multi-worker browser IDEs (such as [`wasm-c-ide`](https://github.com/breeze833/wasm-c-ide)), WebAssembly workers, Node.js sandboxes, and POSIX toolchains (Clang/LLVM, BusyBox ash, GNU Make, SQLite, Python, Ruby), `vfs-wasi` solves the memory duplication, slow startup, and permission isolation bottlenecks inherent to running complex filesystem-dependent workloads in WebAssembly.

---

## 2. Motivation & Architectural Problem Statement

In conventional WebAssembly/WASI browser environments, running complete developer toolchains (compiler, shell, runtime, build systems) involves mounting large system directories (headers, runtime archives, command binaries) containing thousands of files (~100 MB+ decompressed).

When multi-worker concurrency is introduced (such as a Tri-Worker model: `compiler.worker`, `shell.worker`, `runtime.worker`):
1. **Redundant Heap Duplication**: Unpacking ~4,000+ files into independent JavaScript object trees per worker consumes ~100 MB of JS heap *per worker* (~300+ MB combined), causing massive heap pressure and aggressive browser garbage collection.
2. **Boot Latency & Tar Extraction**: Every worker must fetch, decompress, and parse large tarballs on startup, leading to noticeable UI freezes and startup delays.
3. **Missing Overlay & System Protection**: Standard in-memory filesystems treat all paths equally. If student code, user scripts, or shell utilities modify system paths (`/usr`, `/lib`, `/include`), the underlying runtime image becomes corrupted in memory.
4. **Lack of Standardized WASI Preview 1 Filesystem Provider**: Existing solutions either tightly couple filesystem syscalls to process lifecycle and non-standard runtimes, or rely on Node.js OS filesystem preopens that cannot run in browser workers.

`vfs-wasi` resolves these issues through a memory-mapped, contiguous binary sysroot format (`SSYS`) shared across workers via `SharedArrayBuffer`, combined with an isolated, mutable top-tier overlay and a zero-dependency WASI Preview 1 filesystem host layer.

---

## 3. Target Platform & Environment Profile

- **Target Architecture**: WebAssembly 32-bit WASI Preview 1 (`wasm32-wasip1` / `wasm32-unknown-wasi`).
- **Host Runtime Environments**:
  - Modern web browsers (main thread and Web Workers with or without `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`).
  - Node.js (>= 18) with standard ES modules.
  - Headless sandboxes and edge runtimes.
- **Zero Runtime Dependencies**: The core VFS engine, binary parser, overlay router, and WASI Preview 1 filesystem imports are implemented in 100% pure vanilla JavaScript / TypedArrays with zero external npm dependencies.
- **Buffer Support**: Dual support for `SharedArrayBuffer` (zero-copy multi-worker concurrency) and standard `ArrayBuffer` (single-threaded or non-isolated fallback).
- **Encoding Compliance**: Strict compliance with W3C Encoding Standard (`TextDecoder` prohibition on SharedArrayBuffer views).

---

## 4. Repository Topology & Source File Organization

```
vfs-wasi/
├── SPEC.md                    # Technical specification & architectural ground truth (this file)
├── AGENTS.md                  # Developer & AI agent operating protocols
├── README.md                  # User-facing documentation, architecture, and quick start
├── LICENSE                    # MIT License
├── package.json               # Package metadata, exports, and test scripts
├── Makefile                   # Build, test, packaging, and clean targets
├── bin/
│   ├── vfs-pack.js            # CLI tool: compiles directories or tar archives into .ssys images
│   └── vfs-inspect.js         # CLI tool: inspects and validates .ssys binary headers & index entries
├── src/
│   ├── index.js               # Unified entry point exposing public VFS API & WASI host factory
│   ├── ssys.js                # SSYS binary format constants, header definitions, and FNV-1a hasher
│   ├── shared-sysroot.js      # SharedSysrootBuilder and zero-copy SharedSysrootReader
│   ├── vfs.js                 # Two-Tier Overlay VFS engine (mutable Map + immutable sysroot)
│   ├── wasi-fs.js             # Pure WASI Preview 1 filesystem syscall table generator
│   └── sync.js                # Differential worker synchronization & delta serialization
├── examples/
│   ├── basic-node.js          # Running a WASI binary with OverlayVFS in Node.js
│   └── multi-worker-browser/  # HTML/Worker demo sharing a single SharedSysroot buffer
└── test/
    ├── ssys.test.js           # Binary format packing, hash lookups, and SAB compatibility
    ├── vfs.test.js            # Overlay unioning, mtime, permissions, and EROFS tests
    ├── wasi-fs.test.js        # Standard WASI Preview 1 filesystem syscall conformance
    └── sync.test.js           # Differential worker delta export and apply tests
```

---

## 5. Binary Sysroot Format Specification (`SSYS` Version 1)

The `SharedSysroot` is a contiguous, memory-mapped byte buffer stored in a `SharedArrayBuffer` (or `ArrayBuffer`).

### 5.1 File Layout

```
+-----------------------------------------------------------------------+
| Header (64 bytes, 8-byte aligned)                                     |
| Magic (0x53535953) | Version | Count | StrTableOff | StrTableSize ... |
+-----------------------------------------------------------------------+
| Index Table (Count * 32 bytes)                                        |
| [Hash, StrOff, StrLen, DataOff, DataLen, Mode, Mtime, IsDir] x N      |
+-----------------------------------------------------------------------+
| String Table (8-byte aligned, raw UTF-8 path bytes)                   |
| "/usr\0/usr/include\0/usr/include/stdio.h\0..."                       |
+-----------------------------------------------------------------------+
| Data Segment (4-byte aligned, contiguous file payloads)               |
| [Raw file bytes for libc.a, stdio.h, libraylib.a, etc.]               |
+-----------------------------------------------------------------------+
```

### 5.2 Header Layout (64 Bytes, Little-Endian)

| Offset | Type | Field | Description |
|---|---|---|---|
| `0x00` | `uint32` | `magic` | Magic signature `0x53535953` (`SSYS` in ASCII) |
| `0x04` | `uint32` | `version` | Format version (currently `1`) |
| `0x08` | `uint32` | `count` | Total number of directory and file entries |
| `0x0C` | `uint32` | `stringTableOffset` | Byte offset from buffer start to string table |
| `0x10` | `uint32` | `stringTableSize` | Total byte length of string table |
| `0x14` | `uint32` | `dataSegmentOffset` | Byte offset from buffer start to data segment |
| `0x18` | `uint32` | `dataSegmentSize` | Total byte length of data segment |
| `0x1C` | `uint32` | `totalBufferSize` | Total allocated byte size of the entire buffer |
| `0x20` | `uint8[32]` | `reserved` | Reserved for future extensions (zero-padded) |

### 5.3 Index Entry Layout (32 Bytes, Little-Endian)

Each file and directory in the sysroot occupies an invariant 32-byte record:

| Offset | Type | Field | Description |
|---|---|---|---|
| `0x00` | `uint32` | `hash` | 32-bit FNV-1a hash of the normalized path |
| `0x04` | `uint32` | `strOffset` | Byte offset of path within string table |
| `0x08` | `uint32` | `strLen` | Byte length of path UTF-8 string |
| `0x0C` | `uint32` | `dataOffset` | Byte offset of file payload within data segment |
| `0x10` | `uint32` | `dataLen` | Byte length of file payload (0 for directories) |
| `0x14` | `uint32` | `mode` | POSIX file mode (e.g. `0o040555` for dirs, `0o100444` for files) |
| `0x18` | `uint32` | `mtimeSec` | Modification timestamp in seconds |
| `0x1C` | `uint32` | `isDir` | Directory flag (`1` for directory, `0` for file) |

### 5.4 32-Bit FNV-1a Path Hashing

Paths are normalized (leading slash, no trailing slash except root, collapse redundant slashes and `.`/`..`) and hashed using standard 32-bit FNV-1a:

```javascript
export function fnv1a(str) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
```

### 5.5 Zero-Copy Safe UTF-8 Decoding

Under W3C standards, passing a view over `SharedArrayBuffer` to `TextDecoder.decode()` throws a `TypeError`:
> *TypeError: Failed to execute 'decode' on 'TextDecoder': The provided ArrayBufferView value must not be shared.*

`vfs-wasi` strictly adheres to this standard:
1. **String Table Index Parsing**: When initializing `SharedSysrootReader`, the entire string table is copied into an unshared `Uint8Array` once, from which path slices are decoded.
2. **Text File Reads**: In `readFile(path, asText = true)`, if the underlying buffer is shared, an unshared slice is created before decoding. Binary reads (`readFile(path, false)`) return direct zero-copy subarray views without allocation.

---

## 6. Two-Tier Overlay Virtual File System (`OverlayVFS`)

The virtual filesystem exposes a single, unified POSIX path namespace through two distinct tiers:

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

### 6.1 Path Normalization Rules
All filesystem methods accept absolute or relative paths and resolve them according to standard POSIX conventions:
- Empty paths or paths without root resolve relative to the current working directory (default: `/workspace`).
- Redundant slashes (`//`, `///`) are collapsed into single slashes `/`.
- Dot segments (`.`) are removed; parent segments (`..`) traverse upwards without escaping the virtual root `/`.
- Trailing slashes are stripped (except for root `/`).

### 6.2 Lookup Order & Directory Unioning
- **File Lookups (`readFile`, `exists`, `stat`, `isDir`)**: Lookups check the top-tier mutable map first. If a local entry exists, it takes precedence (allowing file shadowing or updates). If absent, lookups query the bottom-tier `SharedSysroot`.
- **Directory Listing (`readDir`, `fd_readdir`)**: Directory enumeration unions children from both tiers:
  1. Entries in the mutable top tier are collected.
  2. Entries in the immutable bottom tier under the target directory are merged.
  3. Duplicate entry names are deduplicated.
  4. Results are sorted alphabetically with directories preceding files.

### 6.3 POSIX Permission & Safety Model (`EROFS`)
System directories (`/usr`, `/lib`, `/include`, `/bin`, or any custom paths designated as system mounts) are permanently write-protected:
- `path_open` with write flags (`WASI_O_CREAT`, `WASI_O_TRUNC`, `WASI_FDFLAG_APPEND`, or write capability) returns standard WASI `EROFS` (65).
- `path_unlink_file`, `path_remove_directory`, and `path_create_directory` return `EROFS` (65).
- `path_rename` returns `EROFS` if either the source or destination path resides within a system mount.
- JS API `writeFile` and `mkdir` throw `EROFS: read-only file system` unless invoked with internal option `isSystem = true`.

---

## 7. WASI Preview 1 Filesystem Provider (`wasi-fs`)

`vfs-wasi` provides a factory `createWasiFsImports(vfs, options)` generating a complete, standalone import object matching `wasi_snapshot_preview1` filesystem specifications.

### 7.1 Preopens & File Descriptor Table
- `fd 0`: `stdin` (delegated to host stream handler)
- `fd 1`: `stdout` (delegated to host stream handler)
- `fd 2`: `stderr` (delegated to host stream handler)
- `fd 3`: Preopen directory for `/workspace` (or custom user working directory)
- `fd 4`: Preopen directory for root `/`
- Dynamic descriptors (`fd >= 5`): Allocated for opened files and directories.

### 7.2 Implemented WASI Preview 1 Syscalls

| Syscall | Signature | Semantics |
|---|---|---|
| `fd_prestat_get` | `(fd, prestat_out)` | Returns `__WASI_PREOPENTYPE_DIR` and path length for preopened descriptors. |
| `fd_prestat_dir_name` | `(fd, path_ptr, path_len)` | Writes the preopen path name into WebAssembly memory. |
| `fd_fdstat_get` | `(fd, stat_out)` | Returns file type (`FILETYPE_DIRECTORY` / `FILETYPE_REGULAR_FILE`) and full capability rights (`0x1fffffffffffffffn`). |
| `fd_filestat_get` | `(fd, stat_out)` | Populates size, device, inode, filetype, nlink, atim, mtim, ctim from VFS metadata. |
| `fd_filestat_set_size` | `(fd, size)` | Truncates or extends an open mutable file to specified byte size. |
| `fd_read` | `(fd, iovs_ptr, iovs_len, nread_out)` | Reads bytes from current file offset into scatter-gather buffers; advances offset. |
| `fd_write` | `(fd, iovs_ptr, iovs_len, nwritten_out)` | Writes bytes from gather buffers into mutable VFS file; auto-seeks to EOF if opened with append flag. |
| `fd_seek` | `(fd, offset, whence, newoffset_out)` | Adjusts file offset (`SEEK_SET = 0`, `SEEK_CUR = 1`, `SEEK_END = 2`). |
| `fd_tell` | `(fd, offset_out)` | Returns the current file read/write offset. |
| `fd_close` | `(fd)` | Releases descriptor from the open file table. |
| `fd_readdir` | `(fd, buf_ptr, buf_len, cookie, bufused_out)` | Packs 24-byte `__wasi_dirent_t` headers followed by file name strings for directory entries, supporting chunked cookie-based pagination. |
| `path_open` | `(dirfd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, fd_out)` | Resolves path against `dirfd`, validates `EROFS`, creates or truncates file if requested, allocates new descriptor. |
| `path_filestat_get` | `(dirfd, flags, path_ptr, path_len, stat_out)` | Returns file attributes for path relative to `dirfd`. |
| `path_filestat_set_times` | `(dirfd, flags, path_ptr, path_len, atim, mtim, fst_flags)` | Updates file modification timestamp (`mtime`), enabling tools like `touch` and `make`. |
| `path_create_directory` | `(dirfd, path_ptr, path_len)` | Creates a new directory in top-tier mutable storage. |
| `path_unlink_file` | `(dirfd, path_ptr, path_len)` | Unlinks a regular file from mutable storage; returns `EROFS` for system files. |
| `path_remove_directory`| `(dirfd, path_ptr, path_len)` | Removes an empty directory from mutable storage. |
| `path_rename` | `(old_dirfd, old_path_ptr, old_path_len, new_dirfd, new_path_ptr, new_path_len)` | Atomically renames or moves a file or directory within mutable storage. |

### 7.3 Standard WASI Error Codes

```javascript
export const ESUCCESS = 0;
export const EBADF    = 8;
export const EEXIST   = 20;
export const EINVAL   = 28;
export const EISDIR   = 31;
export const ENOENT   = 44;
export const ENOTDIR  = 54;
export const EPERM    = 63;
export const EROFS    = 65;
export const ENOSYS   = 52;
```

---

## 8. Worker Differential Synchronization Protocol (`sync`)

In multi-worker architectures, when one worker (e.g. `compiler.worker`) generates a binary (`build/main.o` or `a.out`), or a shell script runs `mkdir`/`touch`, mutations must propagate to the master thread and other workers without re-broadcasting entire filesystem states.

### 8.1 Delta Serialization Format
`vfs-wasi` includes a built-in diff engine:
```typescript
interface VfsDelta {
  version: number;
  timestamp: number;
  created: Array<{ path: string; isDir: boolean; content?: Uint8Array; mode?: number; mtime?: number }>;
  updated: Array<{ path: string; content: Uint8Array; mtime: number }>;
  deleted: Array<{ path: string }>;
}
```

### 8.2 Synchronization Lifecycle
1. **Change Tracking**: Mutable operations (`writeFile`, `mkdir`, `removeFile`, `rename`) record local mutation events.
2. **Delta Export (`vfs.exportDelta()`)**: Produces a compact delta payload containing only modified files and deletion tombstones.
3. **Delta Ingestion (`vfs.applyDelta(delta)`)**: Merges external worker changes into local memory and emits change notifications.

---

## 9. Tooling & CLI Utilities

`vfs-wasi` includes command-line tools for packaging and inspecting sysroot images:

### 9.1 `bin/vfs-pack.js`
Compiles a directory or tar archive (`.tar` or `.tar.gz`) into an optimized `.ssys` binary image:
```bash
node bin/vfs-pack.js <input-dir-or-tar> -o sysroot.ssys [--array-buffer]
```
- Traverses directory recursively or unpacks tarball streams.
- Computes FNV-1a hashes and 4-byte/8-byte alignments.
- Emits verification stats (file count, string table size, data segment size, total compression ratio).

### 9.2 `bin/vfs-inspect.js`
Inspects, verifies, and dumps `.ssys` images:
```bash
node bin/vfs-inspect.js sysroot.ssys [--tree] [--list] [--path /usr/include/stdio.h]
```
- Validates `SSYS` magic signature and header offsets.
- Detects any FNV-1a hash collisions across indexed paths.
- Dumps directory trees, file sizes, permissions, and timestamps.

---

## 10. Automated Test & Verification Protocol

The automated test suite (`npm test`) verifies correctness across four dimensions:
1. **`test/ssys.test.js`**: Validates `SSYS` binary header packing, 32-byte index layout, FNV-1a hashing, zero-copy reading, TextDecoder safety, and fallback to `ArrayBuffer`.
2. **`test/vfs.test.js`**: Validates two-tier overlay lookups, directory unioning, mutable writes, file removals, `mtime` persistence, and strict `EROFS` enforcement.
3. **`test/wasi-fs.test.js`**: Validates WASI Preview 1 syscall compliance (`path_open`, `fd_read`, `fd_write`, `fd_seek`, `fd_readdir`, `path_unlink_file`, `path_rename`) with standard memory buffers.
4. **`test/sync.test.js`**: Validates differential delta export, serialization, and multi-instance synchronization.
