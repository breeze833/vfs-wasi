// vfs-wasi: Two-Tier Virtual File System & WASI Preview 1 Filesystem Provider
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
} from './vfs.js';

export {
  createWasiFsImports,
  ESUCCESS,
  ENOSYS,
  ENOTEMPTY,
  FILETYPE_UNKNOWN,
  FILETYPE_BLOCK_DEVICE,
  FILETYPE_CHARACTER_DEVICE,
  FILETYPE_DIRECTORY,
  FILETYPE_REGULAR_FILE,
  FILETYPE_SOCKET_DGRAM,
  FILETYPE_SOCKET_STREAM,
  FILETYPE_SYMBOLIC_LINK,
  PREOPENTYPE_DIR,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_TRUNC,
  FDFLAG_APPEND,
  FDFLAG_DSYNC,
  FDFLAG_NONBLOCK,
  FDFLAG_RSYNC,
  FDFLAG_SYNC,
  WHENCE_SET,
  WHENCE_CUR,
  WHENCE_END,
  RIGHTS_ALL,
  RIGHTS_READ,
  RIGHTS_WRITE,
} from './wasi-fs.js';

export {
  DeltaTracker,
  applyDelta,
  exportDelta,
  DELTA_VERSION,
} from './sync.js';
