#!/usr/bin/env node
// CLI Tool: vfs-inspect
// Validates and inspects .ssys binary images

import fs from 'node:fs';
import path from 'node:path';
import { SharedSysrootReader } from '../src/shared-sysroot.js';

function printUsage() {
  console.log(`
Usage:
  vfs-inspect <file.ssys> [options]

Options:
  --list                 List all files and directories
  --tree                 Display hierarchical directory tree
  --path <path>          Show details or contents of a specific file
  -h, --help             Display this help message
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  let filePath = null;
  let showList = false;
  let showTree = false;
  let targetPath = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--list') {
      showList = true;
    } else if (arg === '--tree') {
      showTree = true;
    } else if (arg === '--path') {
      targetPath = args[++i];
    } else if (!arg.startsWith('-')) {
      filePath = arg;
    }
  }

  if (!filePath) {
    console.error('Error: Missing input .ssys file');
    printUsage();
    process.exit(1);
  }

  const resolvedFile = path.resolve(filePath);
  if (!fs.existsSync(resolvedFile)) {
    console.error(`Error: File not found: ${resolvedFile}`);
    process.exit(1);
  }

  const fileBytes = fs.readFileSync(resolvedFile);
  const ab = fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength);

  let reader;
  try {
    reader = new SharedSysrootReader(ab);
  } catch (err) {
    console.error(`Error validating .ssys file: ${err.message}`);
    process.exit(1);
  }

  console.log('=== SSYS Binary Header ===');
  console.log(`Version:             ${reader.version}`);
  console.log(`Total Entries:       ${reader.count}`);
  console.log(`String Table Offset: ${reader.stringTableOffset} (${reader.stringTableSize} bytes)`);
  console.log(`Data Segment Offset: ${reader.dataSegmentOffset} (${reader.dataSegmentSize} bytes)`);
  console.log(`Total Buffer Size:   ${reader.totalBufferSize} bytes`);

  // Detect hash collisions
  const hashMap = new Map();
  let collisionCount = 0;
  for (const [p, entry] of reader.entries.entries()) {
    if (hashMap.has(entry.hash)) {
      const prev = hashMap.get(entry.hash);
      console.warn(`[WARN] FNV-1a Hash Collision detected: 0x${entry.hash.toString(16)} for '${prev}' and '${p}'`);
      collisionCount++;
    } else {
      hashMap.set(entry.hash, p);
    }
  }

  if (collisionCount === 0) {
    console.log('Hash Integrity:      Zero FNV-1a collisions across all indexed entries (OK)');
  }

  if (targetPath) {
    console.log(`\n=== Entry Details: ${targetPath} ===`);
    const st = reader.stat(targetPath);
    if (!st) {
      console.log('Status: Path does not exist in sysroot.');
    } else {
      console.log(`Type:     ${st.isDir ? 'Directory' : 'Regular File'}`);
      console.log(`Size:     ${st.size} bytes`);
      console.log(`Mode:     0o${st.mode.toString(8)}`);
      console.log(`Mtime:    ${new Date(st.mtime).toISOString()}`);
      if (!st.isDir && st.size < 4096) {
        console.log('\n--- Content Preview ---');
        try {
          console.log(reader.readFile(targetPath, true));
        } catch (_) {
          console.log('(Binary content)');
        }
      }
    }
    return;
  }

  if (showList) {
    console.log('\n=== Indexed Entries ===');
    for (const [p, entry] of reader.entries.entries()) {
      const typeStr = entry.isDir ? 'DIR ' : 'FILE';
      const sizeStr = entry.isDir ? '' : ` (${entry.dataLength} bytes)`;
      console.log(`  [${typeStr}] ${p}${sizeStr}`);
    }
  }

  if (showTree) {
    console.log('\n=== Directory Tree ===');
    function printDir(dirPath, indent = '') {
      const children = reader.readDir(dirPath);
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const item = children[i];
        const isLast = i === children.length - 1;
        const branch = isLast ? '└── ' : '├── ';
        const childPath = dirPath === '/' ? `/${item.name}` : `${dirPath}/${item.name}`;
        console.log(`${indent}${branch}${item.name}${item.isDir ? '/' : ''}`);
        if (item.isDir) {
          printDir(childPath, indent + (isLast ? '    ' : '│   '));
        }
      }
    }
    console.log('/');
    printDir('/');
  }
}

main().catch((err) => {
  console.error('vfs-inspect error:', err);
  process.exit(1);
});
