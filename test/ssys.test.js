// Automated Unit Tests: SSYS Binary Format & SharedSysrootReader

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SSYS_MAGIC,
  SSYS_VERSION,
  HEADER_SIZE,
  ENTRY_SIZE,
  fnv1a,
  buildSharedSysroot,
  SharedSysrootReader,
} from '../src/index.js';

test('SSYS: Constants and FNV-1a Hash', () => {
  assert.equal(SSYS_MAGIC, 0x53535953);
  assert.equal(SSYS_VERSION, 1);
  assert.equal(HEADER_SIZE, 64);
  assert.equal(ENTRY_SIZE, 32);

  // Check deterministic hash
  const hash1 = fnv1a('/usr/include/stdio.h');
  const hash2 = fnv1a('/usr/include/stdio.h');
  assert.equal(hash1, hash2);
  assert.equal(typeof hash1, 'number');
  assert.ok(hash1 > 0);
});

test('SSYS: buildSharedSysroot & SharedSysrootReader with ArrayBuffer', () => {
  const files = [
    { path: '/usr/include/stdio.h', content: '#pragma once\nint printf(const char* fmt, ...);' },
    { path: '/usr/include/stdlib.h', content: '#pragma once\nvoid* malloc(unsigned long size);' },
    { path: '/lib/libc.a', content: new Uint8Array([0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e, 0x0a]) },
  ];

  const buffer = buildSharedSysroot(files, { useArrayBuffer: true });
  assert.ok(buffer instanceof ArrayBuffer);

  const reader = new SharedSysrootReader(buffer);
  assert.equal(reader.version, SSYS_VERSION);
  assert.ok(reader.count >= 3); // files + auto-created parent dirs

  // Verify paths exist
  assert.ok(reader.exists('/usr/include/stdio.h'));
  assert.ok(reader.exists('/usr/include/stdlib.h'));
  assert.ok(reader.exists('/lib/libc.a'));
  assert.ok(reader.exists('/usr/include'));
  assert.ok(reader.exists('/usr'));
  assert.ok(reader.exists('/'));

  // Verify isDir
  assert.ok(reader.isDir('/usr/include'));
  assert.ok(reader.isDir('/usr'));
  assert.equal(reader.isDir('/usr/include/stdio.h'), false);

  // Verify file content (binary vs text)
  const textContent = reader.readFile('/usr/include/stdio.h', true);
  assert.ok(textContent.includes('int printf'));

  const binContent = reader.readFile('/lib/libc.a', false);
  assert.ok(binContent instanceof Uint8Array);
  assert.equal(binContent[0], 0x21);
  assert.equal(binContent[1], 0x3c);

  // Verify stat
  const st = reader.stat('/usr/include/stdio.h');
  assert.equal(st.name, 'stdio.h');
  assert.equal(st.isDir, false);
  assert.equal(st.size, textContent.length);

  // Verify readdir
  const children = reader.readDir('/usr/include');
  assert.ok(children.length >= 2);
  const names = children.map(c => c.name);
  assert.ok(names.includes('stdio.h'));
  assert.ok(names.includes('stdlib.h'));
});

test('SSYS: SharedArrayBuffer compatibility & W3C TextDecoder safe slicing', () => {
  if (typeof SharedArrayBuffer === 'undefined') {
    // Environment does not support SharedArrayBuffer, skip
    return;
  }

  const files = [
    { path: '/include/test.h', content: '/* shared buffer test header */' },
  ];

  const sab = buildSharedSysroot(files, { useArrayBuffer: false });
  assert.ok(sab instanceof SharedArrayBuffer);

  const reader = new SharedSysrootReader(sab);
  assert.ok(reader.exists('/include/test.h'));

  // Reading as text must not throw TypeError on SharedArrayBuffer
  const text = reader.readFile('/include/test.h', true);
  assert.equal(text, '/* shared buffer test header */');
});

test('SSYS: Invalid Magic Detection', () => {
  const badBuffer = new ArrayBuffer(128);
  const dv = new DataView(badBuffer);
  dv.setUint32(0, 0x12345678, true);

  assert.throws(() => {
    new SharedSysrootReader(badBuffer);
  }, /Invalid magic/);
});
