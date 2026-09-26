const assert = require('assert');
const syncQueue = require('../src/lib/syncQueue');
const api = require('../src/lib/api');

async function itAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function runTests() {
  console.log('\n--- RUNNING PERFORMANCE & RECONNECTION RESILIENCE TEST SUITE ---\n');

  // Test 1: SyncQueue priority handling
  await itAsync('SyncQueue: executes high-priority jobs ahead of low-priority jobs', async () => {
    syncQueue.minDelayMs = 5;
    const executionOrder = [];

    // Pause queue by pretending to be rate limited for 50ms
    syncQueue.rateLimitedUntil = Date.now() + 60;

    // Enqueue a low priority task
    syncQueue.enqueue('test', 'low_1', async () => {
      executionOrder.push('low_1');
    }, 1, null, null, 'low');

    // Enqueue another low priority task
    syncQueue.enqueue('test', 'low_2', async () => {
      executionOrder.push('low_2');
    }, 1, null, null, 'low');

    // Enqueue a high priority task
    syncQueue.enqueue('test', 'high_1', async () => {
      executionOrder.push('high_1');
    }, 1, null, null, 'high');

    // Wait for queue to drain
    while (syncQueue.processing || syncQueue.queue.length > 0 || syncQueue.inFlightSet.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.strictEqual(executionOrder[0], 'high_1', 'High priority task must execute first');
    assert.deepStrictEqual(executionOrder, ['high_1', 'low_1', 'low_2']);
  });

  // Test 2: SyncQueue concurrency pool
  await itAsync('SyncQueue: allows up to maxConcurrency parallel workers', async () => {
    syncQueue.minDelayMs = 0;
    assert.strictEqual(syncQueue.maxConcurrency, 3);
    assert.strictEqual(syncQueue.processing, false);

    let activeRunning = 0;
    let maxSeenParallel = 0;

    const task = async () => {
      activeRunning++;
      maxSeenParallel = Math.max(maxSeenParallel, activeRunning);
      await new Promise((r) => setTimeout(r, 30));
      activeRunning--;
    };

    const p1 = syncQueue.enqueueAsync('test', 'c1', task);
    const p2 = syncQueue.enqueueAsync('test', 'c2', task);
    const p3 = syncQueue.enqueueAsync('test', 'c3', task);

    await Promise.all([p1, p2, p3]);

    assert.ok(maxSeenParallel >= 2, `Expected parallel execution >= 2, saw ${maxSeenParallel}`);
  });

  // Test 3: getAllOsRoles caching
  await itAsync('api: getAllOsRoles caches results in memory to avoid repeated DB round trips', async () => {
    const supabase = require('../src/lib/supabase');
    api.invalidateOsRolesCache();

    const mockRoles = [{ id: '1', key: 'campus_lead', name: 'Campus Lead' }];
    const origFrom = supabase.from;
    supabase.from = (table) => {
      if (table === 'roles') {
        return {
          select: () => Promise.resolve({ data: mockRoles, error: null }),
        };
      }
      return origFrom ? origFrom.call(supabase, table) : {};
    };

    try {
      const roles1 = await api.getAllOsRoles();
      const roles2 = await api.getAllOsRoles();
      assert.strictEqual(roles1, roles2, 'Second call should return cached array reference directly');
      assert.deepStrictEqual(roles1, mockRoles);

      api.invalidateOsRolesCache();
      const roles3 = await api.getAllOsRoles();
      assert.deepStrictEqual(roles3, mockRoles);
    } finally {
      supabase.from = origFrom;
    }
  });

  // Test 4: Roster debouncing in updateChapterCurrentRolesTopic
  await itAsync('api: updateChapterCurrentRolesTopic debounces background calls per chapter', async () => {
    let callCount = 0;
    const mockClient = {};
    const origGetChapter = api.getChapterByIdentifier;
    api.getChapterByIdentifier = async () => {
      callCount++;
      return null;
    };

    try {
      // Trigger 3 calls in rapid succession for same chapter
      api.updateChapterCurrentRolesTopic(mockClient, 'test-ch-debounce');
      api.updateChapterCurrentRolesTopic(mockClient, 'test-ch-debounce');
      const lastPromise = api.updateChapterCurrentRolesTopic(mockClient, 'test-ch-debounce');

      // Immediately callCount should still be 0 (debounced)
      assert.strictEqual(callCount, 0, 'Should not execute immediately when debounced');

      await lastPromise;
      // After debounce delay expires, should have executed only once
      assert.strictEqual(callCount, 1, 'Should have coalesced multiple rapid calls into a single execution');
    } finally {
      api.getChapterByIdentifier = origGetChapter;
    }
  });

  console.log('\n========================================');
  console.log('ALL PERFORMANCE & RECONNECTION TESTS PASSED! (4/4 tests)');
  console.log('========================================\n');
}

runTests().catch((err) => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
