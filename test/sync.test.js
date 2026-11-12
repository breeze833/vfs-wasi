// Automated Unit Tests: Worker Differential Synchronization (sync)

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OverlayVFS,
  DeltaTracker,
  applyDelta,
  exportDelta,
  DELTA_VERSION,
} from '../src/index.js';

test('Sync: DeltaTracker & applyDelta Synchronization across VFS instances', () => {
  const vfs1 = new OverlayVFS();
  const vfs2 = new OverlayVFS();

  const tracker = new DeltaTracker(vfs1);

  // Perform actions on vfs1
  vfs1.writeFile('/workspace/index.js', 'console.log("sync test");');
  vfs1.mkdir('/workspace/build');
  vfs1.writeFile('/workspace/build/bundle.js', '// bundle content');

  const delta1 = tracker.flush();
  assert.ok(delta1);
  assert.equal(delta1.version, DELTA_VERSION);
  assert.equal(delta1.entries.length, 3); // index.js, /workspace/build, /workspace/build/bundle.js

  // Apply delta1 to vfs2
  applyDelta(vfs2, delta1);

  // Verify vfs2 state matches vfs1
  assert.equal(vfs2.exists('/workspace/index.js'), true);
  assert.equal(vfs2.readFile('/workspace/index.js', true), 'console.log("sync test");');
  assert.equal(vfs2.isDir('/workspace/build'), true);
  assert.equal(vfs2.readFile('/workspace/build/bundle.js', true), '// bundle content');

  // Test deletion tracking
  vfs1.removeFile('/workspace/index.js');
  const delta2 = tracker.flush();
  assert.ok(delta2);
  assert.ok(delta2.deleted.includes('/workspace/index.js'));

  // Apply deletion to vfs2
  applyDelta(vfs2, delta2);
  assert.equal(vfs2.exists('/workspace/index.js'), false);

  tracker.destroy();
});

test('Sync: exportDelta timestamp filtering', () => {
  const vfs = new OverlayVFS();

  const t1 = 1000;
  const t2 = 2000;

  vfs.writeFile('/workspace/old.c', 'void old_fn() {}', { mtime: t1 });
  vfs.writeFile('/workspace/new.c', 'void new_fn() {}', { mtime: t2 });

  // Export only modifications since t2
  const delta = exportDelta(vfs, t2);
  assert.ok(delta);
  const paths = delta.entries.map(e => e.path);

  assert.ok(paths.includes('/workspace/new.c'));
  assert.equal(paths.includes('/workspace/old.c'), false);
});
