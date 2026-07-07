import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { SplatMesh } from '../SplatMesh.js';
import { SplatRenderMode } from '../../SplatRenderMode.js';

test('SplatMesh retains only exact precompiled material variants', () => {
    let compileCount = 0;
    const renderer = {
        getContext: () => ({}),
        compile: () => {
            compileCount++;
        }
    };
    const camera = new THREE.PerspectiveCamera();
    const mesh = new SplatMesh(SplatRenderMode.ThreeD);
    mesh.renderer = renderer;

    const options = {
        camera,
        useCompressedTexture: true,
        covariancesFromScaleRotation: true,
        minSphericalHarmonicsDegree: 2
    };
    assert.equal(mesh.precompileMaterial(options), true);
    const firstMaterial = mesh.precompiledMaterial;
    let firstMaterialDisposeCount = 0;
    const originalDispose = firstMaterial.dispose.bind(firstMaterial);
    firstMaterial.dispose = () => {
        firstMaterialDisposeCount++;
        originalDispose();
    };

    assert.equal(mesh.precompileMaterial(options), true);
    assert.equal(mesh.precompiledMaterial, firstMaterial);
    assert.equal(compileCount, 1);

    assert.equal(mesh.precompileMaterial({ ...options, minSphericalHarmonicsDegree: 1 }), true);
    assert.equal(firstMaterialDisposeCount, 1);
    assert.notEqual(mesh.precompiledMaterial, firstMaterial);

    mesh.dispose();
    assert.equal(mesh.precompiledMaterial, null);
});
