// Automated Unit Tests: Two-Tier OverlayVFS

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OverlayVFS,
  normalizePath,
  buildSharedSysroot,
  EROFS,
} from '../src/index.js';

test('OverlayVFS: Path Normalization', () => {
  assert.equal(normalizePath(''), '/workspace');
  assert.equal(normalizePath('foo.c'), '/workspace/foo.c');
  assert.equal(normalizePath('/foo/bar/../baz'), '/foo/baz');
  assert.equal(normalizePath('///usr//include///stdio.h'), '/usr/include/stdio.h');
  assert.equal(normalizePath('/workspace/../../..'), '/');
});

test('OverlayVFS: Basic Mutable Operations in /workspace', () => {
  const vfs = new OverlayVFS();

  // Write and Read file
  vfs.writeFile('/workspace/hello.txt', 'Hello WASI!');
  assert.equal(vfs.exists('/workspace/hello.txt'), true);
  assert.equal(vfs.isDir('/workspace/hello.txt'), false);
  assert.equal(vfs.readFile('/workspace/hello.txt', true), 'Hello WASI!');

  // Stat file
  const st = vfs.stat('/workspace/hello.txt');
  assert.equal(st.name, 'hello.txt');
  assert.equal(st.isDir, false);
  assert.equal(st.size, 11);

  // Subdirectory creation
  vfs.mkdir('/workspace/src/utils', { recursive: true });
  assert.equal(vfs.isDir('/workspace/src'), true);
  assert.equal(vfs.isDir('/workspace/src/utils'), true);

  // Rename file
  vfs.rename('/workspace/hello.txt', '/workspace/src/greeting.txt');
  assert.equal(vfs.exists('/workspace/hello.txt'), false);
  assert.equal(vfs.exists('/workspace/src/greeting.txt'), true);
  assert.equal(vfs.readFile('/workspace/src/greeting.txt', true), 'Hello WASI!');

  // Remove file
  vfs.removeFile('/workspace/src/greeting.txt');
  assert.equal(vfs.exists('/workspace/src/greeting.txt'), false);
});

test('OverlayVFS: Read-Only System Mount Protection (EROFS)', () => {
  const vfs = new OverlayVFS();

  // Writing to system directories must throw EROFS
  assert.throws(() => {
    vfs.writeFile('/usr/bin/touch', 'malicious');
  }, (err) => {
    return err.errno === EROFS && err.code === 'EROFS';
  });

  assert.throws(() => {
    vfs.mkdir('/usr/local/bin');
  }, (err) => {
    return err.errno === EROFS && err.code === 'EROFS';
  });

  assert.throws(() => {
    vfs.remove('/lib');
  }, (err) => {
    return err.errno === EROFS && err.code === 'EROFS';
  });
});

test('OverlayVFS: Two-Tier Overlay & Directory Unioning', () => {
  // Build sysroot with system files
  const sysrootBuf = buildSharedSysroot([
    { path: '/usr/include/math.h', content: '#pragma once\ndouble sqrt(double);' },
    { path: '/usr/include/string.h', content: '#pragma once\nint strlen(const char*);' },
  ], { useArrayBuffer: true });

  const vfs = new OverlayVFS({ sharedSysroot: sysrootBuf });

  // System headers must be accessible
  assert.equal(vfs.exists('/usr/include/math.h'), true);
  assert.ok(vfs.readFile('/usr/include/math.h', true).includes('double sqrt'));

  // User adds custom header in user directory:
  vfs.writeFile('/workspace/custom.h', '/* custom user header */');

  // Verify readdir in /usr/include shows sysroot entries
  const usrIncludeList = vfs.readDir('/usr/include');
  const names = usrIncludeList.map(item => item.name);
  assert.ok(names.includes('math.h'));
  assert.ok(names.includes('string.h'));

  // Test directory unioning in root '/'
  const rootList = vfs.readDir('/');
  const rootNames = rootList.map(item => item.name);
  assert.ok(rootNames.includes('workspace')); // from mutable tier
  assert.ok(rootNames.includes('usr'));       // from sysroot tier
});

test('OverlayVFS: Timestamp Management (setTimes)', () => {
  const vfs = new OverlayVFS();
  vfs.writeFile('/workspace/test.c', 'int main() {}');

  const customTime = 1600000000000;
  vfs.setTimes('/workspace/test.c', customTime, customTime);

  const st = vfs.stat('/workspace/test.c');
  assert.equal(st.mtime, customTime);
});
