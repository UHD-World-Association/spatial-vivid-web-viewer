import assert from 'node:assert/strict';
import test from 'node:test';

import { SplatMesh } from '../SplatMesh.js';

const makeBuffer = (maxSplatCount) => ({
    getMaxSplatCount: () => maxSplatCount
});

test('uses identity scene and local indexes for a single scene, then restores explicit mappings', () => {
    const firstBuffer = makeBuffer(2);
    const secondBuffer = makeBuffer(3);
    const mesh = new SplatMesh();
    mesh.scenes = [SplatMesh.createScene(firstBuffer)];

    const implicitMaps = SplatMesh.buildSplatIndexMaps([firstBuffer]);
    mesh.globalSplatIndexToLocalSplatIndexMap = implicitMaps.localSplatIndexMap;
    mesh.globalSplatIndexToSceneIndexMap = implicitMaps.sceneIndexMap;
    mesh.implicitSingleSceneIndexMap = implicitMaps.implicitSingleSceneIndexMap;

    assert.equal(mesh.implicitSingleSceneIndexMap, true);
    assert.deepEqual(Array.from(mesh.getSceneIndexes(0, 2)), [0, 0, 0]);
    assert.equal(mesh.getSceneIndexForSplat(123), 0);
    assert.equal(mesh.getSplatLocalIndex(123), 123);
    assert.equal(mesh.getSplatBufferForSplat(123), firstBuffer);
    assert.equal(mesh.getSceneTransformForSplat(123), mesh.scenes[0].transform);

    const explicitMaps = SplatMesh.buildSplatIndexMaps([firstBuffer, secondBuffer]);
    mesh.scenes = [SplatMesh.createScene(firstBuffer), SplatMesh.createScene(secondBuffer)];
    mesh.globalSplatIndexToLocalSplatIndexMap = explicitMaps.localSplatIndexMap;
    mesh.globalSplatIndexToSceneIndexMap = explicitMaps.sceneIndexMap;
    mesh.implicitSingleSceneIndexMap = explicitMaps.implicitSingleSceneIndexMap;

    assert.equal(mesh.implicitSingleSceneIndexMap, false);
    assert.deepEqual(Array.from(mesh.getSceneIndexes(0, 4)), [0, 0, 1, 1, 1]);
    assert.equal(mesh.getSceneIndexForSplat(2), 1);
    assert.equal(mesh.getSplatLocalIndex(2), 0);
    assert.equal(mesh.getSplatBufferForSplat(4), secondBuffer);
    assert.equal(mesh.getSceneTransformForSplat(4), mesh.scenes[1].transform);

    mesh.dispose();
    assert.equal(mesh.implicitSingleSceneIndexMap, false);
});

test('sizes generated data textures from capacity with compact power-of-two rows', () => {
    const libraryCount = 1_035_024;
    const oneTexelPerSplat = SplatMesh.computeDataTextureSize(1, 1, libraryCount);
    assert.deepEqual([oneTexelPerSplat.x, oneTexelPerSplat.y], [4096, 256]);

    const oneAndHalfTexelsPerSplat = SplatMesh.computeDataTextureSize(1, 1.5, libraryCount);
    assert.deepEqual([oneAndHalfTexelsPerSplat.x, oneAndHalfTexelsPerSplat.y], [4096, 512]);
    assert.equal(SplatMesh.computeDataTextureSize(1, 1, libraryCount, true).x, 1024);

    const empty = SplatMesh.computeDataTextureSize(4, 1, 0);
    assert.deepEqual([empty.x, empty.y], [4096, 1]);
    const small = SplatMesh.computeDataTextureSize(4, 1, 1);
    assert.deepEqual([small.x, small.y], [4096, 1]);
    assert.ok(oneAndHalfTexelsPerSplat.y > 0 &&
              (oneAndHalfTexelsPerSplat.y & (oneAndHalfTexelsPerSplat.y - 1)) === 0);
    assert.ok(oneAndHalfTexelsPerSplat.x * oneAndHalfTexelsPerSplat.y >= libraryCount * 1.5);

    // Oversized single-texture probes still support the existing covariance
    // fallback and CPU SH split decisions; the compact final layouts fit.
    const oversizedProbe = SplatMesh.computeDataTextureSize(4, 6, 12_000_000, false, true);
    assert.ok(oversizedProbe.y > 4096);
    assert.throws(() => SplatMesh.computeDataTextureSize(4, 6, 12_000_000), /MAX_TEXTURE_TEXELS/);
    const compactSplitTexture = SplatMesh.computeDataTextureSize(6, 6, 12_000_000);
    assert.ok(compactSplitTexture.y <= 4096);
});

test('marks CPU sort data preparation as deferred without touching the distance path', () => {
    const mesh = new SplatMesh();
    mesh.enableDistancesComputationOnGPU = false;
    mesh.getSplatCount = () => 4;
    mesh.refreshDataTexturesFromSplatBuffers = () => {};
    mesh.getDataForDistancesComputation = () => {
        throw new Error('deferred path must not prepare sort data during the build');
    };
    const processingProfile = { deferSortDataPrep: true };

    const result = mesh.refreshGPUDataFromSplatBuffers(false, processingProfile);

    assert.deepEqual(result, {
        from: 0,
        to: 3,
        count: 4,
        centers: null,
        sceneIndexes: null,
        deferredSortDataPrep: true
    });
    assert.equal(processingProfile.meshSortDataPrepMs, undefined);
});
