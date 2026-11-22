// vfs-wasi: Two-Tier Virtual File System, SharedSysroot, and Delta Sync
// Main Unified Package Exports

export {
  SSYS_MAGIC,
  SSYS_VERSION,
  HEADER_SIZE,
  ENTRY_SIZE,
  align4,
  align8,
  fnv1a,
} from './ssys.js';

export {
  buildSharedSysroot,
  SharedSysrootReader,
} from './shared-sysroot.js';

export {
  OverlayVFS,
  normalizePath,
  EROFS,
  ENOENT,
  EISDIR,
  ENOTDIR,
  EEXIST,
  EINVAL,
  EBADF,
  EPERM,
  ENOTEMPTY,
} from './vfs.js';

export {
  DeltaTracker,
  applyDelta,
  exportDelta,
  DELTA_VERSION,
} from './sync.js';
