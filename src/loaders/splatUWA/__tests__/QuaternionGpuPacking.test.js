import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

globalThis.self = { __UWA_SPLAT_DECODER_BOOTSTRAP__: true };
const { buildGpuScaleRotations, buildPreviewData } = await import('../SplatDecoder.worker.js');

function covariance(wxyz, scale) {
    const q = new THREE.Quaternion(wxyz[1], wxyz[2], wxyz[3], wxyz[0]).normalize();
    const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
    const linear = rotation.multiply(new THREE.Matrix3().set(scale[0], 0, 0, 0, scale[1], 0, 0, 0, scale[2]));
    return linear.clone().multiply(linear.clone().transpose()).elements;
}

function unpackGpuQuaternion(packed, offset) {
    const xyz = [...packed.subarray(offset + 3, offset + 6)];
    return [Math.sqrt(Math.max(0, 1 - xyz.reduce((sum, value) => sum + value * value, 0))), ...xyz];
}

test('full and preview GPU packing preserve PLY covariance for positive and negative W', () => {
    const model = {
        pointCount: 4, postprocessCompaction: true, previewEnabled: true, previewSent: false,
        minimumAlpha: 1, shDegree: 3,
        positions: new Float32Array(12), scales: new Float32Array([0.001, 0.03, 1, 0.001, 0.03, 1, 1, 2, 3, 1, 2, 3]),
        rotations: new Float32Array([-0.8, 0.3, -0.4, 0.5, 0.8, -0.3, 0.4, -0.5, -2, 1, 2, 3, 0, 0, 0, 0]),
        colors: new Uint8Array(16).fill(255), validity: new Uint8Array(4).fill(1), featuresRest: null,
        compressedTextureData: { format: 'astc', raw: new Uint8Array(16), metas: new Uint32Array(6), uvs: new Uint32Array(8) }
    };
    const original = model.rotations.slice();
    buildGpuScaleRotations(model);
    const preview = buildPreviewData(model);
    assert.deepEqual(preview.gpuScaleRotations, model.gpuScaleRotations);
    assert.deepEqual(model.rotations, original);
    for (let i = 0; i < model.pointCount; i++) {
        const scale = model.scales.subarray(i * 3, i * 3 + 3);
        const expected = covariance(model.rotations.subarray(i * 4, i * 4 + 4), scale);
        const actual = covariance(unpackGpuQuaternion(model.gpuScaleRotations, i * 6), scale);
        for (let j = 0; j < 9; j++) assert.ok(Math.abs(expected[j] - actual[j]) < 2e-6);
    }
    // Equivalent q and -q must produce the same packed rotation.
    assert.deepEqual(model.gpuScaleRotations.slice(3, 6), model.gpuScaleRotations.slice(9, 12));
    // Demonstrate that the previous sign-dropping path fails on the same anisotropic splat.
    const q = [...original.subarray(0, 4)];
    const length = Math.hypot(...q);
    const wrong = [Math.abs(q[0]) / length, ...q.slice(1).map(v => v / length)];
    const scale = model.scales.subarray(0, 3);
    const expected = covariance(q, scale), broken = covariance(wrong, scale);
    assert.ok(Math.max(...expected.map((value, i) => Math.abs(value - broken[i]))) > 0.3);
});
