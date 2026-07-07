import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.self = { __UWA_SPLAT_DECODER_BOOTSTRAP__: true };
const {
    composeVideoDecoderPath, compactModel, buildGpuScaleRotations, buildGpuTextureInputs
} = await import('../SplatDecoder.worker.js');

test('labels no-video and raw-only staged prepares', () => {
    assert.equal(composeVideoDecoderPath(0, 0), 'none');
    assert.equal(composeVideoDecoderPath(2, 0), 'raw');
});

test('combines raw adoption with encoded video decoder paths', () => {
    assert.equal(composeVideoDecoderPath(1, 2, 'webcodecs'), 'raw+webcodecs');
    assert.equal(composeVideoDecoderPath(1, 2, 'ffmpeg'), 'raw+ffmpeg');
    assert.equal(composeVideoDecoderPath(1, 2, 'mixed'), 'raw+mixed');
    assert.equal(composeVideoDecoderPath(0, 2, 'mixed'), 'mixed');
});

test('worker compaction keeps every attribute and compressed UV in one stable point order', () => {
    const model = {
        pointCount: 4,
        postprocessCompaction: true,
        minimumAlpha: 1,
        validity: new Uint8Array([1, 1, 1, 1]),
        positions: new Float32Array([0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32]),
        scales: new Float32Array([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]),
        rotations: new Float32Array([1, 0, 0, 0, 1, .1, .2, .3, 1, .4, .5, .6, 1, .7, .8, .9]),
        colors: new Uint8Array([1, 2, 3, 0, 4, 5, 6, 2, 7, 8, 9, 1, 10, 11, 12, 0]),
        featuresRest: null,
        compressedTextureData: { uvs: new Uint32Array([0, 1, 10, 11, 20, 21, 30, 31]) },
        timings: { pruneMs: 0 }
    };

    compactModel(model);
    buildGpuScaleRotations(model);
    buildGpuTextureInputs(model);

    assert.equal(model.sourcePointCount, 4);
    assert.equal(model.pointCount, 2);
    assert.equal(model.postprocessCompacted, true);
    assert.deepEqual(Array.from(model.positions), [10, 11, 12, 20, 21, 22]);
    assert.deepEqual(Array.from(model.colors), [4, 5, 6, 2, 7, 8, 9, 1]);
    assert.deepEqual(Array.from(model.compressedTextureData.uvs), [10, 11, 20, 21]);
    assert.deepEqual(model.gpuScaleRotations, new Float32Array([
        2, 2, 2, .1, .2, .3,
        3, 3, 3, .4, .5, .6
    ]));
    assert.equal(model.gpuScaleRotations.length, 2 * 6);
    assert.deepEqual(Array.from(model.gpuCenterColors), [
        0x02060504, 0x41200000, 0x41300000, 0x41400000,
        0x01090807, 0x41a00000, 0x41a80000, 0x41b00000
    ]);
    assert.deepEqual(Array.from(model.gpuCompressedTextureUV), [10, 11, 0, 0, 20, 21, 0, 0]);
});

test('worker texture inputs use texture-sized padding only when capacity overhead is bounded', () => {
    const count = 4096;
    const positions = new Float32Array(count * 3);
    positions.set([10, 11, 12]);
    const colors = new Uint8Array(count * 4);
    colors.set([4, 5, 6, 255]);
    const uvs = new Uint32Array(count * 2);
    uvs.set([10, 11]);
    const model = {
        pointCount: count,
        postprocessCompaction: true,
        positions,
        scales: new Float32Array(count * 3),
        rotations: new Float32Array(count * 4),
        colors,
        compressedTextureData: { uvs }
    };

    buildGpuTextureInputs(model);

    assert.equal(model.gpuCenterColors.length, 4096 * 4);
    assert.equal(model.gpuCompressedTextureUV.length, 4096 * 4);
    assert.deepEqual(Array.from(model.gpuCenterColors.subarray(0, 4)),
        [0xff060504, 0x41200000, 0x41300000, 0x41400000]);
    assert.deepEqual(Array.from(model.gpuCompressedTextureUV.subarray(0, 4)), [10, 11, 0, 0]);
    assert.equal(model.gpuCenterColors.at(-1), 0);
    assert.equal(model.gpuCompressedTextureUV.at(-1), 0);

    const compactCount = 5000;
    const compactModelInput = {
        pointCount: compactCount,
        postprocessCompaction: true,
        positions: new Float32Array(compactCount * 3),
        scales: new Float32Array(compactCount * 3),
        rotations: new Float32Array(compactCount * 4),
        colors: new Uint8Array(compactCount * 4),
        compressedTextureData: { uvs: new Uint32Array(compactCount * 2) }
    };
    buildGpuTextureInputs(compactModelInput);
    assert.equal(compactModelInput.gpuCenterColors.length, compactCount * 4);
    assert.equal(compactModelInput.gpuCompressedTextureUV.length, compactCount * 4);
});

test('worker scale/rotation input uses bounded texture padding and keeps WXYZ-derived layout', () => {
    const count = 4096;
    const scales = new Float32Array(count * 3);
    const rotations = new Float32Array(count * 4);
    scales.set([2, 3, 4]);
    rotations.set([1, .1, .2, .3]);
    const model = {
        pointCount: count,
        postprocessCompaction: true,
        scales,
        rotations,
        compressedTextureData: {}
    };

    buildGpuScaleRotations(model);

    assert.equal(model.gpuScaleRotations.length, 8192 * 4);
    assert.deepEqual(Array.from(model.gpuScaleRotations.subarray(0, 6)),
        Array.from(new Float32Array([2, 3, 4, .1, .2, .3])));
    assert.equal(model.gpuScaleRotations.at(-1), 0);
});
