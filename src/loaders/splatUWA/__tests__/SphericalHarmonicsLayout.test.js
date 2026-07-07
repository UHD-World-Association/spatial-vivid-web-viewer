import assert from 'node:assert/strict';
import test from 'node:test';

import { copyCoefficientMajorRgbToChannelMajor } from '../SphericalHarmonicsLayout.js';

test('reorders coefficient-major RGB triplets into SplatBuffer channel bands', () => {
    const source = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const destination = new Float32Array(9);
    copyCoefficientMajorRgbToChannelMajor(source, 0, destination, 0, 3);
    assert.deepEqual(Array.from(destination), [0, 3, 6, 1, 4, 7, 2, 5, 8]);
});
