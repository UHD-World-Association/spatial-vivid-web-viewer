import assert from 'node:assert/strict';
import test from 'node:test';

import { SplatGeometry } from '../SplatGeometry.js';
import { SplatMaterial2D } from '../SplatMaterial2D.js';
import { SplatMaterial3D } from '../SplatMaterial3D.js';

const build3DMaterial = (minimumGaussianContribution, enableOptionalEffects = false, useASTC = false) =>
    SplatMaterial3D.build(false, enableOptionalEffects, false, 2048, 1.0, false, 2, 0.3,
                          useASTC, false, minimumGaussianContribution);

test('uses matching flat per-instance color varyings in 3D and 2D shaders', () => {
    const material3D = build3DMaterial(1 / 1024);
    const material2D = SplatMaterial2D.build(false, false, 1.0, false, 2);

    for (const material of [material3D, material2D]) {
        assert.match(material.vertexShader, /flat varying vec4 vColor;/);
        assert.match(material.fragmentShader, /flat varying vec4 vColor;/);
        assert.doesNotMatch(material.vertexShader, /\bvUv\b/);
        assert.doesNotMatch(material.fragmentShader, /\bvUv\b/);
    }

    assert.match(material2D.vertexShader, /varying mat3 vT;/);
    assert.doesNotMatch(material3D.fragmentShader, /uniform vec3 debugColor;/);
});

test('passes contribution-aware and legacy support limits to the 3D fragment shader', () => {
    const contributionMaterial = build3DMaterial(1 / 1024);
    const legacyMaterial = build3DMaterial(0);
    const astcMaterial = build3DMaterial(1 / 1024, false, true);

    assert.match(contributionMaterial.vertexShader, /flat varying float vGaussianSupportSquared;/);
    assert.match(contributionMaterial.fragmentShader, /flat varying float vGaussianSupportSquared;/);
    assert.match(contributionMaterial.vertexShader,
                 /vGaussianSupportSquared = gaussianSupportSquared;/);
    assert.match(contributionMaterial.vertexShader,
                 /gaussianSupportSquared = clamp\(2\.0 \* log\(baseAlpha \/ minimumGaussianContribution\), 0\.0, 8\.0\);/);

    assert.match(legacyMaterial.vertexShader, /vGaussianSupportSquared = 8\.0;/);
    assert.match(legacyMaterial.vertexShader, /vPosition \*= sqrt8;/);
    assert.doesNotMatch(legacyMaterial.vertexShader, /float baseAlpha = vColor\.a;/);
    assert.equal(astcMaterial.fragmentShader, contributionMaterial.fragmentShader);
    assert.match(astcMaterial.vertexShader, /flat varying float vGaussianSupportSquared;/);
});

test('rejects unsupported 3D fragments before the equivalent exp2 falloff', () => {
    const fragmentShader = build3DMaterial(1 / 1024).fragmentShader;
    const supportDiscardIndex = fragmentShader.indexOf('if (A > vGaussianSupportSquared) discard;');
    const exp2Index = fragmentShader.indexOf('exp2(-0.7213475204444817 * A)');
    const opacityDiscardIndex = fragmentShader.indexOf('if (opacity < 0.0009765625000) discard;');

    assert.ok(supportDiscardIndex >= 0);
    assert.ok(exp2Index > supportDiscardIndex);
    assert.ok(opacityDiscardIndex > exp2Index);
    assert.doesNotMatch(fragmentShader, /float opacity = exp\(/);
});

test('keeps optional opacity changes after base support calculation', () => {
    const vertexShader = build3DMaterial(1 / 1024, true).vertexShader;

    assert.ok(vertexShader.indexOf('float baseAlpha = vColor.a;') <
              vertexShader.indexOf('vColor.a *= splatOpacityFromScene;'));
    assert.ok(vertexShader.indexOf('vGaussianSupportSquared = gaussianSupportSquared;') <
              vertexShader.indexOf('vColor.a *= opacityAdjust;'));
});

test('retains the instanced quad and material transparency contract', () => {
    const geometry = SplatGeometry.build(1);
    const material = build3DMaterial(1 / 1024);

    assert.equal(geometry.getAttribute('position').count, 4);
    assert.deepEqual(Array.from(geometry.index.array), [0, 1, 2, 0, 2, 3]);
    assert.equal(material.transparent, true);
    assert.equal(material.depthTest, true);
    assert.equal(material.depthWrite, false);
    assert.doesNotMatch(material.vertexShader, /devicePixelRatio|pixelRatio/);
    assert.doesNotMatch(material.fragmentShader, /devicePixelRatio|pixelRatio/);
});
