import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createSortResultBufferPool,
    initializeIdentityCandidate,
    isSortGenerationCurrent,
    reconstructTreeCandidate
} from '../SortWorkerProtocol.js';

test('initializes a persistent identity candidate', () => {
    const candidate = new Uint32Array(6);
    assert.equal(initializeIdentityCandidate(candidate), candidate);
    assert.deepEqual([...candidate], [0, 1, 2, 3, 4, 5]);
});

test('reconstructs ordered tree nodes with the existing reverse-window semantics', () => {
    const packedIndexes = new Uint32Array([
        10, 11,
        20, 21, 22,
        30
    ]);
    const offsets = new Uint32Array([0, 2, 5]);
    const counts = new Uint32Array([2, 3, 1]);
    const candidate = new Uint32Array(6);

    reconstructTreeCandidate(candidate, packedIndexes, offsets, counts, new Uint32Array([1, 0, 2]), 6);

    // The nearest node (1) is written last, exactly like Viewer used to fill from the end.
    assert.deepEqual([...candidate], [30, 10, 11, 20, 21, 22]);
});

test('supports empty and partial tree selections', () => {
    const packedIndexes = new Uint32Array([4, 5, 8, 9, 10]);
    const offsets = new Uint32Array([0, 2]);
    const counts = new Uint32Array([2, 3]);
    assert.deepEqual(
        [...reconstructTreeCandidate(new Uint32Array(0), packedIndexes, offsets, counts, new Uint32Array(0), 0)],
        []
    );

    const partial = new Uint32Array(3);
    reconstructTreeCandidate(partial, packedIndexes, offsets, counts, new Uint32Array([1]), 3);
    assert.deepEqual([...partial], [8, 9, 10]);
});

test('rejects incomplete or unknown tree selections', () => {
    const packedIndexes = new Uint32Array([1, 2, 3]);
    const offsets = new Uint32Array([0, 2]);
    const counts = new Uint32Array([2, 1]);
    assert.throws(
        () => reconstructTreeCandidate(new Uint32Array(3), packedIndexes, offsets, counts, new Uint32Array([0]), 3),
        /do not match/
    );
    assert.throws(
        () => reconstructTreeCandidate(new Uint32Array(1), packedIndexes, offsets, counts, new Uint32Array([2]), 1),
        /Unknown/
    );
});

test('recycles result buffers and counts temporary pool misses', () => {
    const pool = createSortResultBufferPool(16, 1);
    const first = pool.take();
    const temporary = pool.take();
    assert.equal(first.byteLength, 16);
    assert.equal(temporary.byteLength, 16);
    assert.equal(pool.poolMissCount, 1);
    assert.equal(pool.recycle(first), true);
    assert.equal(pool.take(), first);
    assert.equal(pool.recycle(new ArrayBuffer(4)), false);
});

test('rejects stale worker and tree generations', () => {
    assert.equal(isSortGenerationCurrent({ generation: 4, treeGeneration: 7 }, 4, 7), true);
    assert.equal(isSortGenerationCurrent({ generation: 3, treeGeneration: 7 }, 4, 7), false);
    assert.equal(isSortGenerationCurrent({ generation: 4, treeGeneration: 6 }, 4, 7), false);
});
