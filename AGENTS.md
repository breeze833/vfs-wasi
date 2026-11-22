# AGENTS.md: Developer and AI Agent Guidelines for `vfs-wasi`

This document provides architectural context, design invariants, coding conventions, and maintenance procedures for AI agents and human contributors working on `vfs-wasi`.

---

## 1. Project Mission & Architecture

`vfs-wasi` is a zero-dependency, high-performance **Two-Tier Virtual File System (`OverlayVFS`)**, **SharedSysroot (`SSYS`)**, and **Worker Delta Synchronization (`DeltaTracker`)** library for WebAssembly runtimes.

Designed specifically for multi-worker browser IDEs (such as [`wasm-c-ide`](https://github.com/breeze833/wasm-c-ide)), WebAssembly workers, Node.js sandboxes, and command-line execution, `vfs-wasi` solves the memory and boot-time bottlenecks of running POSIX toolchains in WebAssembly through:
1. **Contiguous Binary Sysroot (`SSYS` format)**: Packs large, read-only system trees (C/C++ headers, static `.a` archives, language standard libraries) into a memory-mapped `SharedArrayBuffer` (or standard `ArrayBuffer`).
2. **Zero-Copy Multi-Worker Sharing**: Multiple Web Workers (`compiler`, `shell`, `runtime`) read directly from a single shared buffer via 32-bit FNV-1a hash index lookups with 0ms initialization time and zero JS heap duplication.
3. **Two-Tier Overlay Filesystem**: Unifies an immutable bottom tier (`SharedSysroot` for `/usr`, `/lib`, `/include`, `/bin`) with an isolated, mutable top tier (in-memory Map for `/workspace`, `/tmp`), complete with directory unioning (`readDir`), path normalization, `mtime` preservation, and POSIX `EROFS` enforcement.
4. **`wasi-host` Delegation (`v0.2.0`)**: Cleanly delegates all `wasi_snapshot_preview1` / `wasi_unstable` syscalls to [`wasi-host`](https://github.com/breeze833/wasi-host), exposing the exact duck-typed VFS surface consumed by `VfsAdapter` without bundling duplicate WASI syscall tables.

---

## 2. Core Design Invariants

When modifying or extending the codebase, strictly adhere to these fundamental invariants:

1. **Strict Specification Alignment**:
   - `SPEC.md` is the architectural ground truth. Autonomous agents must strictly adhere to the architecture, binary layout, and WASI host specifications defined in `SPEC.md`. Do not deviate, substitute architectures, or introduce heavyweight dependencies.
2. **Zero External Runtime Dependencies**:
   - The core VFS engine (`src/index.js`, `src/ssys.js`, `src/shared-sysroot.js`, `src/vfs.js`, `src/sync.js`) must remain 100% zero-dependency modern JavaScript.
3. **Dual Buffer Compatibility (SharedArrayBuffer & ArrayBuffer)**:
   - `SharedSysroot` must seamlessly function over `SharedArrayBuffer` (in COOP/COEP cross-origin isolated environments) as well as regular `ArrayBuffer` (in single-thread or non-isolated environments).
4. **Browser Encoding Standard Compliance**:
   - W3C `TextDecoder.decode()` throws `TypeError` when passed a direct view over a `SharedArrayBuffer`. All string table index parsing and text reading must safely isolate slices into unshared buffers before decoding.
5. **Strict POSIX Permission & Overlay Isolation**:
   - System paths (`/usr`, `/lib`, `/include`, `/bin`, `/dev`) are read-only bottom-tier mounts. Write, create, truncate, unlink, or rename operations against bottom-tier paths must strictly throw POSIX `EROFS` (errno 65) and report `true` via `_isReadOnly(path)`.
6. **Clean Boundary with `wasi-host`**:
   - `vfs-wasi` focuses strictly on **storage, `SSYS` sysroot packing/reading, two-tier overlay resolution, and worker delta sync**. All `wasi_snapshot_preview1` syscalls (`fd_*`, `path_*`, process lifecycle, clocks, entropy, stdio) live in [`wasi-host`](https://github.com/breeze833/wasi-host), which adapts `OverlayVFS` via `VfsAdapter`.

---

## 3. Developer Collaboration & Revision Workflow

All agent-assisted development in this repository must strictly adhere to the developer's 4-phase revision workflow:

```
┌──────────────────────────────────────────────────────────────┐
│  Phase 1: Specification Revision & Developer Confirmation     │
│  - Propose/update SPEC.md changes first                      │
│  - Await explicit developer review & approval                │
└──────────────────────────────┬───────────────────────────────┘
                               │ Approved
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 2: Specification-Compliant Implementation             │
│  - Strictly implement according to the confirmed SPEC.md     │
│  - Verify automated tests (npm test) with zero failures      │
└──────────────────────────────┬───────────────────────────────┘
                               │ Verified
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 3: Developer Manual Verification                      │
│  - Prompt developer to perform interactive verification      │
│  - Developer tests VFS & CLI tools via bin/ and node tests   │
└──────────────────────────────┬───────────────────────────────┘
                               │ Developer Confirmed
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 4: Explicitly Instructed Document Alignment & Commit  │
│  - Await developer's explicit instruction                    │
│  - Align secondary docs (README.md, package.json, etc.)      │
│  - Stage and commit changes to git repository                │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Directory Structure & Key Files

```
vfs-wasi/
├── SPEC.md                    # Technical specification & architectural ground truth
├── AGENTS.md                  # Developer & AI agent operating protocols (this file)
├── README.md                  # User-facing documentation, architecture, and quick start
├── LICENSE                    # MIT license
├── package.json               # Package metadata, exports, and npm test scripts
├── Makefile                   # Convenience Makefile (test, build, pack, clean)
├── bin/
│   ├── vfs-pack.js            # CLI tool to compile directories or tarballs into .ssys images
│   └── vfs-inspect.js         # CLI tool to inspect and verify .ssys binary headers & index
├── src/
│   ├── index.js               # Main package entry point and unified exports
│   ├── ssys.js                # SSYS constants, header offsets, and FNV-1a path hasher
│   ├── shared-sysroot.js      # SharedSysrootBuilder and zero-copy SharedSysrootReader
│   ├── vfs.js                 # Two-Tier Overlay VFS engine (mutable Map + immutable sysroot)
│   └── sync.js                # Worker differential synchronization & delta serialization
├── .github/
│   └── workflows/
│       └── release.yml        # Automated CI testing, packaging, and v* GitHub Releases
└── test/
    ├── ssys.test.js           # Binary format packing, hash collisions, and SAB reading
    ├── vfs.test.js            # Overlay unioning, mtime, ENOTEMPTY, EROFS, and wasi-host contract tests
    └── sync.test.js           # Differential worker delta export and apply tests
```

---

## 5. Development & Testing Commands

```bash
# Run automated test suite
npm test
# (or: node test/ssys.test.js && node test/vfs.test.js && node test/sync.test.js)

# Pack a directory into a binary .ssys image
node bin/vfs-pack.js <directory-or-tar> -o sysroot.ssys

# Inspect a .ssys binary image
node bin/vfs-inspect.js sysroot.ssys

# Package release archive
make dist

# Clean temporary files
make clean
```

---

## 6. Verification Checklist Before Committing Changes

Before completing tasks or submitting PRs, verify:

- [ ] Specification updated in `SPEC.md` and confirmed by the developer prior to code changes.
- [ ] Implementation strictly conforms to the confirmed `SPEC.md`.
- [ ] Automated tests (`npm test`) pass with zero errors in standard Node.js.
- [ ] Memory alignment and W3C `TextDecoder` safe slicing verified for `SharedArrayBuffer`.
- [ ] `EROFS` (errno 65) strictly enforced for modifications against bottom-tier system mounts.
- [ ] Developer has conducted verification via tests or embedding in `wasm-c-ide`.
- [ ] Secondary documentation (`README.md`, `package.json`, etc.) aligned upon explicit developer instruction.
- [ ] Git commit performed only when explicitly instructed by the developer.
