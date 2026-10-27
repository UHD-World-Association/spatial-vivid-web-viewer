import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildShQuantizationUniforms, readShQuantizationRanges, resolveRenderShDegree
} from '../SphericalHarmonicsQuantization.js';

test('each SH RGB channel uses its own range, including across coefficients', () => {
    const mins = Float32Array.from({ length: 45 }, (_, i) => -0.85 + i * 0.01);
    const maxs = Float32Array.from({ length: 45 }, (_, i) => 0.81 + i * 0.02);
    const uniforms = buildShQuantizationUniforms(mins, maxs, 3);
    for (let i = 0; i < 45; i++) {
        const encodedZero = -mins[i] / (maxs[i] - mins[i] + 1e-6);
        assert.ok(Math.abs(encodedZero * uniforms.range[i] + uniforms.min[i]) < 1e-7);
    }
    const encodedZero = -mins[11] / (maxs[11] - mins[11] + 1e-6);
    assert.ok(Math.abs(encodedZero * uniforms.range[0] + uniforms.min[0]) > 0.05);
});

test('explicit global quantization metadata can be broadcast', () => {
    const result = buildShQuantizationUniforms(new Float32Array([-1]), new Float32Array([1]), 2);
    assert.equal(result.min[23], -1);
    assert.ok(Math.abs(result.range[23] - 2.000001) < 1e-6);
    assert.equal(result.range[24], 0);
});

test('invalid or missing bounds never silently reuse the legacy scalar', () => {
    assert.throws(() => buildShQuantizationUniforms(undefined, undefined, 2), /rebuild/);
    assert.throws(() => buildShQuantizationUniforms(new Float32Array(9), new Float32Array(9), 2), /invalid/);
    assert.throws(() => buildShQuantizationUniforms(new Float32Array([NaN]), new Float32Array([1]), 1), /Invalid/);
    assert.throws(() => buildShQuantizationUniforms(new Float32Array([1]), new Float32Array([-1]), 1), /Invalid/);
});

test('WASM bounds are copied and validated before the coordinator releases memory', () => {
    const module = { HEAPF32: new Float32Array(128) };
    module.HEAPF32.fill(-1, 1, 46);
    module.HEAPF32.fill(1, 46, 91);
    const prepared = { shnMinsPtr: 4, shnMinsCount: 45, shnMaxsPtr: 184, shnMaxsCount: 45, shDegree: 3 };
    const result = readShQuantizationRanges(module, prepared);
    module.HEAPF32.fill(0);
    assert.equal(result.shnMins[44], -1);
    assert.equal(result.shnMaxs[44], 1);
    assert.throws(() => readShQuantizationRanges(module, { shnMin: -1, shnMax: 1 }), /rebuild/);
    assert.throws(() => readShQuantizationRanges(module, { ...prepared, shnMaxsPtr: 500 }), /rebuild/);
});

test('SH=0 is preserved and higher requested degrees include degree three', () => {
    assert.equal(resolveRenderShDegree(3, 0), 0);
    assert.equal(resolveRenderShDegree(0, 2), 0);
    assert.equal(resolveRenderShDegree(3, 1), 1);
    assert.equal(resolveRenderShDegree(3, 3), 3);
    assert.equal(resolveRenderShDegree(1, undefined), 1);
    const uniforms = buildShQuantizationUniforms(new Float32Array([-1]), new Float32Array([1]), 0);
    assert.ok(uniforms.range.every(value => value === 0));
});
