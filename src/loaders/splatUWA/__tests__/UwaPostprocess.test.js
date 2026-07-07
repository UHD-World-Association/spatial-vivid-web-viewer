import test from 'node:test';
import assert from 'node:assert/strict';
import { processDecodedModel } from '../postprocess/UwaPostprocess.js';

test('UWA postprocess compacts alpha and keeps ASTC UV alignment', () => {
    const result = processDecodedModel({
        numPoints: 3,
        positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
        scales: new Float32Array([1, 1, 1, 2, 2, 2, 3, 3, 3]),
        // UWA quaternion order is w,x,y,z.
        rotations: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
        colors: new Uint8Array([10, 20, 30, 0, 40, 50, 60, 2, 70, 80, 90, 1]),
        compressedTextureData: {
            format: 'astc', raw: new Uint8Array([1, 2, 3, 4]),
            uvs: new Uint32Array([11, 12, 21, 22, 31, 32]), metas: new Uint32Array([4, 1, 1, 1, 3, 16]),
            width: 1, height: 1, layers: 1, blockWidth: 4, blockHeight: 4,
            singleWidth: 1, singleHeight: 1, shnMin: 0, shnMax: 1
        },
        shDegree: 1
    }, { minimumAlpha: 1, textureStrategy: 'astc' });

    assert.equal(result.numPoints, 2);
    assert.deepEqual(Array.from(result.positions), [4, 5, 6, 7, 8, 9]);
    assert.deepEqual(Array.from(result.compressedTextureData.uvs), [21, 22, 31, 32]);
    assert.equal(result.colors.length, result.numPoints * 4);
    assert.equal(result.covariances, null);
    assert.equal(result.sceneIndexes.length, result.numPoints);
});

test('UWA postprocess adopts worker-compacted arrays without another attribute copy', () => {
    const positions = new Float32Array([4, 5, 6, 7, 8, 9]);
    const scales = new Float32Array([2, 2, 2, 3, 3, 3]);
    const rotations = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0]);
    const colors = new Uint8Array([40, 50, 60, 2, 70, 80, 90, 1]);
    const uvs = new Uint32Array([21, 22, 31, 32]);
    const gpuScaleRotations = new Float32Array(16);
    gpuScaleRotations.set([2, 2, 2, 0, 0, 0, 3, 3, 3, 0, 0, 0]);
    const gpuCenterColors = new Uint32Array([
        0x023c3228, 0x40800000, 0x40a00000, 0x40c00000,
        0x015a5046, 0x40e00000, 0x41000000, 0x41100000,
        0, 0, 0, 0
    ]);
    const gpuCompressedTextureUV = new Uint32Array([21, 22, 0, 0, 31, 32, 0, 0, 0, 0, 0, 0]);
    const result = processDecodedModel({
        numPoints: 2,
        sourcePointCount: 3,
        validPointCount: 2,
        postprocessCompacted: true,
        postprocessMinimumAlpha: 1,
        positions,
        scales,
        rotations,
        colors,
        gpuScaleRotations,
        gpuCenterColors,
        gpuCompressedTextureUV,
        compressedTextureData: {
            format: 'astc', raw: new Uint8Array([1, 2, 3, 4]), uvs,
            metas: new Uint32Array([4, 1, 1, 1, 3, 16])
        },
        shDegree: 1
    }, { minimumAlpha: 1, textureStrategy: 'astc' });

    assert.equal(result.numPoints, 2);
    assert.equal(result.positions, positions);
    assert.equal(result.scales, scales);
    assert.equal(result.rotations, rotations);
    assert.equal(result.colors, colors);
    assert.equal(result.compressedTextureData.uvs, uvs);
    assert.equal(result.gpuScaleRotations, gpuScaleRotations);
    assert.equal(result.gpuCenterColors, gpuCenterColors);
    assert.equal(result.gpuCompressedTextureUV, gpuCompressedTextureUV);
    assert.equal(result.uwaPostprocessTimings.attributeCopyMs, 0);
    assert.equal(result.uwaPostprocessTimings.alphaScanMs >= 0, true);
    assert.equal(result.uwaPostprocessTimings.compactionDroppedCount, 1);
    assert.equal(result.covariances, null);
});

test('worker-compacted CPU fallback still computes covariance and keeps SH arrays', () => {
    const featuresRest = new Float32Array(45).fill(.25);
    const result = processDecodedModel({
        numPoints: 1,
        sourcePointCount: 1,
        validPointCount: 1,
        postprocessCompacted: true,
        postprocessMinimumAlpha: 1,
        positions: new Float32Array([1, 2, 3]),
        scales: new Float32Array([2, 3, 4]),
        rotations: new Float32Array([1, 0, 0, 0]),
        colors: new Uint8Array([10, 20, 30, 255]),
        featuresRest,
        shDegree: 1
    }, { minimumAlpha: 1, textureStrategy: 'cpu' });

    assert.equal(result.featuresRest, featuresRest);
    assert.deepEqual(Array.from(result.covariances), [4, 0, 0, 9, 0, 16]);
    assert.equal(result.uwaPostprocessTimings.attributeCopyMs, 0);
    assert.equal(result.uwaPostprocessTimings.covarianceComputeMs >= 0, true);
});
