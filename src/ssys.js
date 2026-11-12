// SSYS (SharedSysroot) Binary Format Specification Constants & Utilities
//
// File Layout:
// +-----------------------------------------------------------------------+
// | Header (64 bytes, 8-byte aligned)                                     |
// | Magic (0x53535953) | Version | Count | StrTableOff | StrTableSize ... |
// +-----------------------------------------------------------------------+
// | Index Table (Count * 32 bytes)                                        |
// | [Hash, StrOff, StrLen, DataOff, DataLen, Mode, Mtime, IsDir] x N      |
// +-----------------------------------------------------------------------+
// | String Table (8-byte aligned, raw UTF-8 path bytes)                   |
// | "/usr\0/usr/include\0/usr/include/stdio.h\0..."                       |
// +-----------------------------------------------------------------------+
// | Data Segment (4-byte aligned, contiguous file payloads)               |
// | [Raw file bytes for libc.a, stdio.h, etc.]                            |
// +-----------------------------------------------------------------------+

export const SSYS_MAGIC = 0x53535953; // 'SSYS' in little-endian ASCII
export const SSYS_VERSION = 1;

export const HEADER_SIZE = 64; // 64 bytes header
export const ENTRY_SIZE = 32;  // 32 bytes per index entry

// Header offsets (uint32)
export const HDR_MAGIC = 0x00;
export const HDR_VERSION = 0x04;
export const HDR_COUNT = 0x08;
export const HDR_STR_TABLE_OFFSET = 0x0C;
export const HDR_STR_TABLE_SIZE = 0x10;
export const HDR_DATA_SEG_OFFSET = 0x14;
export const HDR_DATA_SEG_SIZE = 0x18;
export const HDR_TOTAL_BUFFER_SIZE = 0x1C;

// Entry offsets (uint32)
export const ENTRY_HASH = 0x00;
export const ENTRY_STR_OFFSET = 0x04;
export const ENTRY_STR_LEN = 0x08;
export const ENTRY_DATA_OFFSET = 0x0C;
export const ENTRY_DATA_LEN = 0x10;
export const ENTRY_MODE = 0x14;
export const ENTRY_MTIME_SEC = 0x18;
export const ENTRY_IS_DIR = 0x1C;

/**
 * Align byte offset up to 4 bytes.
 * @param {number} offset
 * @returns {number}
 */
export function align4(offset) {
  return (offset + 3) & ~3;
}

/**
 * Align byte offset up to 8 bytes.
 * @param {number} offset
 * @returns {number}
 */
export function align8(offset) {
  return (offset + 7) & ~7;
}

/**
 * Compute 32-bit FNV-1a hash of a UTF-8 path string.
 * @param {string} str
 * @returns {number} 32-bit unsigned integer hash
 */
export function fnv1a(str) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
