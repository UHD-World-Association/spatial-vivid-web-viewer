import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildDiagnosticAnalysis,
    createDiagnosticPhasePlan,
    createEvenlySampledIndexes,
    summarizeSamples
} from '../RenderPerformanceDiagnostics.js';

test('summarizes finite samples with interpolated percentiles', () => {
    assert.deepEqual(summarizeSamples([4, 1, NaN, 3, 2]), {
        count: 4,
        min: 1,
        max: 4,
        mean: 2.5,
        p50: 2.5,
        p95: 3.85
    });
    assert.deepEqual(summarizeSamples([]), {
        count: 0, min: null, max: null, mean: null, p50: null, p95: null
    });
});

test('uses measured GPU evidence and marks incomplete query sets as medium confidence', () => {
    const phase = (id, gpuP50, gpuCount = 24, rafP50 = 16.7) => ({
        id,
        expectedSampleCount: 24,
        gpuMs: {p50: gpuP50, count: gpuCount},
        rafIntervalMs: {p50: rafP50}
    });
    const analysis = buildDiagnosticAnalysis([
        phase('B1', 10),
        phase('V', 6, 20),
        phase('B2', 10),
        phase('B3', 10)
    ], true);
    assert.equal(analysis.comparisons[0].metric, 'gpuMs.p50');
    assert.equal(analysis.inferences[0].confidence, 'medium');
    assert.equal(analysis.inferences[0].evidence.effectPercent, 40);
    assert.match(analysis.inferences[0].finding, /material sensitivity/);
});

test('subsamples the sorted prefix at even positions while preserving order', () => {
    const source = Uint32Array.from([91, 17, 70, 3, 44, 29, 8, 61]);
    assert.deepEqual(Array.from(createEvenlySampledIndexes(source, 4)), [91, 70, 44, 8]);
    assert.deepEqual(Array.from(createEvenlySampledIndexes(source, 2)), [91, 44]);
});

test('plans DPR and SH phases only when applicable', () => {
    assert.deepEqual(createDiagnosticPhasePlan(2, 2).map((phase) => phase.id),
                     ['B0', 'DPR1', 'B1', 'V', 'V0', 'B2', 'N', 'I50', 'I25', 'B3']);
    assert.deepEqual(createDiagnosticPhasePlan(1, 0).map((phase) => phase.id),
                     ['B0', 'B1', 'V', 'B2', 'N', 'I50', 'I25', 'B3']);
});
