import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getCompressedTextureSampleAddress,
    SplatMaterial
} from '../../../splatmesh/SplatMaterial.js';

test('addresses row-major SH regions in the bundled 1M texture layout', () => {
    const address = (coefficientIndex) => getCompressedTextureSampleAddress(
        0, 0, coefficientIndex, 1024, 1024, 4096
    );

    assert.deepEqual(address(0), { x: 0, y: 0, layer: 0 });
    assert.deepEqual(address(3), { x: 3072, y: 0, layer: 0 });
    assert.deepEqual(address(4), { x: 0, y: 1024, layer: 0 });
    assert.deepEqual(address(7), { x: 3072, y: 1024, layer: 0 });
});

test('generated compressed-texture shader advances rows instead of array layers', () => {
    const shader = SplatMaterial.buildVertexShaderBase(false, false, 2, true);

    assert.match(shader, /regionRow \* uint\(astcSingleHeight\)/);
    assert.match(shader, /ivec3\(newx, newy, 0\)/);
});

test('degree-3 shader evaluates all seven l=3 coefficients', () => {
    const astcShader = SplatMaterial.buildVertexShaderBase(false, false, 3, true);
    const textureShader = SplatMaterial.buildVertexShaderBase(false, false, 3, false);

    assert.match(astcShader, /GetAstcSHCoef\(shOffset, 14\)/);
    assert.match(textureShader, /getDataUV\(12, 11/);
    assert.match(textureShader, /SH_C3\[6\].*sh15/);
});
