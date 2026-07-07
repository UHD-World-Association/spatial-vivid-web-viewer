import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.self = { __UWA_SPLAT_DECODER_BOOTSTRAP__: true };
const { buildPreviewData, compactModel, transferPreviewResult, transferDecodeResult } =
    await import('../SplatDecoder.worker.js');

function model(count = 6) {
    return {
        pointCount: count, minimumAlpha: 2, postprocessCompaction: true,
        previewEnabled: true, previewSent: false, shDegree: 2,
        positions: Float32Array.from({length: count * 3}, (_, i) => i),
        scales: Float32Array.from({length: count * 3}, (_, i) => i + 100),
        rotations: Float32Array.from({length: count * 4}, (_, i) => i / 100),
        colors: new Uint8Array(count * 4).fill(255),
        featuresRest: Float32Array.from({length: count * 45}, (_, i) => i / 1000),
        validity: new Uint8Array(count).fill(1),
        compressedTextureData: {
            format: 'astc', raw: new Uint8Array([1, 2, 3, 4]), metas: new Uint32Array([4, 4, 1]),
            uvs: Uint32Array.from({length: count * 2}, (_, i) => i + 1000)
        },
        timings: {pruneMs: 0}
    };
}

test('preview uses completed, valid, alpha-visible points in global source order', () => {
    const source = model();
    source.validity.set([0, 1, 0, 1, 1, 1]); // Out-of-order shards; unreceived points stay zero.
    source.colors[4 * 4 + 3] = 1;
    const preview = buildPreviewData(source);
    assert.deepEqual([...preview.previewSourcePointIndexes], [1, 3, 5]);
    assert.equal(preview.shDegree, 2);
    for (const [name, stride] of [['positions', 3], ['scales', 3], ['rotations', 4], ['colors', 4], ['featuresRest', 45]]) {
        for (const [destination, point] of [1, 3, 5].entries()) {
            assert.deepEqual(preview[name].subarray(destination * stride, (destination + 1) * stride),
                source[name].subarray(point * stride, (point + 1) * stride));
        }
    }
    assert.deepEqual([...preview.compressedTextureData.uvs], [1002, 1003, 1006, 1007, 1010, 1011]);
    assert.equal(preview.gpuScaleRotations[3], source.rotations[5]);
    // A real transferable preview must not detach any canonical final-model buffer.
    const transfer = [preview.positions, preview.scales, preview.rotations, preview.colors, preview.featuresRest,
        preview.gpuScaleRotations, preview.previewSourcePointIndexes, preview.compressedTextureData.raw,
        preview.compressedTextureData.uvs, preview.compressedTextureData.metas].map((array) => array.buffer);
    structuredClone(preview, {transfer});
    assert.equal(source.positions.length, 18);
    assert.deepEqual([...source.compressedTextureData.raw], [1, 2, 3, 4]);
    source.validity.fill(1);
    compactModel(source);
    assert.equal(source.pointCount, 5);
    assert.equal(source.featuresRest.length, 225);
});

test('preview is opt-in, once only, and waits past empty or invisible shards', () => {
    const source = model();
    source.previewEnabled = false;
    assert.equal(buildPreviewData(source), null);
    source.previewEnabled = true;
    source.validity.fill(0);
    assert.equal(buildPreviewData(source), null);
    source.validity[5] = 1;
    source.colors[23] = 1;
    source.postprocessCompaction = false; // Legacy full path still needs correctly pruned preview.
    assert.equal(buildPreviewData(source), null);
    source.colors[23] = 255;
    assert.equal(buildPreviewData(source).numPoints, 1);
    source.previewSent = true;
    assert.equal(buildPreviewData(source), null);
});

test('CPU preview retains SH and respects the 65536-point memory bound', () => {
    const source = model(66000);
    source.compressedTextureData = null;
    const preview = buildPreviewData(source);
    assert.equal(preview.numPoints, 65536);
    assert.equal(preview.featuresRest.length, 65536 * 45);
    assert.equal(preview.compressedTextureData, null);
    assert.equal(preview.gpuScaleRotations, null);
});

for (const format of ['astc', 'bc3', 'bc7']) {
    for (const rangeCount of [0, 45]) {
        test(`${format} preview transfer preserves ${rangeCount} SH ranges for final transfer`, () => {
            const source = model();
            source.compressedTextureData.format = format;
            source.compressedTextureData.shnMins = Float32Array.from({length: rangeCount}, (_, i) => -i - 1);
            source.compressedTextureData.shnMaxs = Float32Array.from({length: rangeCount}, (_, i) => i + 1);
            const expectedMins = source.compressedTextureData.shnMins.slice();
            const expectedMaxs = source.compressedTextureData.shnMaxs.slice();
            const preview = buildPreviewData(source);
            const received = [];
            const previousPostMessage = self.postMessage;
            // Exercise the production transfer lists, including actual sender-side detachment.
            self.postMessage = (message, transfer) => {
                received.push(structuredClone(message, {transfer}));
            };
            try {
                transferPreviewResult(source, preview);
                assert.equal(received[0].type, 'decodePreview');
                assert.deepEqual(received[0].data.compressedTextureData.shnMins, expectedMins);
                assert.deepEqual(received[0].data.compressedTextureData.shnMaxs, expectedMaxs);
                // A zero-length buffer may also be detached: test cloning, not only byteLength.
                assert.doesNotThrow(() => transferDecodeResult(123, source));
                assert.equal(received[1].type, 'decodeResult');
                assert.deepEqual(received[1].data.compressedTextureData.shnMins, expectedMins);
                assert.deepEqual(received[1].data.compressedTextureData.shnMaxs, expectedMaxs);
                assert.equal(received[1].data.positions.length, 18);
            } finally {
                self.postMessage = previousPostMessage;
            }
        });
    }
}
