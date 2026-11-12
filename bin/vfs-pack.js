#!/usr/bin/env node
// CLI Tool: vfs-pack
// Packs a directory or files into an optimized .ssys binary image

import fs from 'node:fs';
import path from 'node:path';
import { buildSharedSysroot } from '../src/shared-sysroot.js';

function printUsage() {
  console.log(`
Usage:
  vfs-pack <input-dir> -o <output.ssys> [options]

Options:
  -o, --output <file>    Destination output file (default: sysroot.ssys)
  --array-buffer         Use standard ArrayBuffer instead of SharedArrayBuffer
  -h, --help             Display this help message
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  let inputPath = null;
  let outputPath = 'sysroot.ssys';
  let useArrayBuffer = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' || arg === '--output') {
      outputPath = args[++i];
    } else if (arg === '--array-buffer') {
      useArrayBuffer = true;
    } else if (!arg.startsWith('-')) {
      inputPath = arg;
    }
  }

  if (!inputPath) {
    console.error('Error: Missing input directory');
    printUsage();
    process.exit(1);
  }

  const resolvedInput = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInput)) {
    console.error(`Error: Path not found: ${resolvedInput}`);
    process.exit(1);
  }

  const entries = [];

  function collectEntries(dir, vfsPrefix) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      const vfsPath = `${vfsPrefix}/${item.name}`;
      const st = fs.statSync(full);

      if (item.isDirectory()) {
        entries.push({
          path: vfsPath,
          isDir: true,
          mtime: Math.floor(st.mtimeMs),
          mode: st.mode,
        });
        collectEntries(full, vfsPath);
      } else if (item.isFile()) {
        const content = fs.readFileSync(full);
        entries.push({
          path: vfsPath,
          isDir: false,
          content: new Uint8Array(content),
          mtime: Math.floor(st.mtimeMs),
          mode: st.mode,
        });
      }
    }
  }

  console.log(`Scanning input directory: ${resolvedInput}...`);
  const rootStat = fs.statSync(resolvedInput);
  if (rootStat.isDirectory()) {
    collectEntries(resolvedInput, '');
  } else {
    const content = fs.readFileSync(resolvedInput);
    entries.push({
      path: '/' + path.basename(resolvedInput),
      isDir: false,
      content: new Uint8Array(content),
      mtime: Math.floor(rootStat.mtimeMs),
      mode: rootStat.mode,
    });
  }

  console.log(`Collected ${entries.length} entries. Building .ssys binary image...`);
  const buffer = buildSharedSysroot(entries, { useArrayBuffer });

  const resolvedOutput = path.resolve(outputPath);
  const nodeBuf = Buffer.from(buffer);
  fs.writeFileSync(resolvedOutput, nodeBuf);

  console.log(`Successfully generated: ${resolvedOutput}`);
  console.log(`  Total size: ${(nodeBuf.length / 1024).toFixed(2)} KB (${nodeBuf.length} bytes)`);
  console.log(`  Total files & directories: ${entries.length}`);
}

main().catch((err) => {
  console.error('vfs-pack error:', err);
  process.exit(1);
});
