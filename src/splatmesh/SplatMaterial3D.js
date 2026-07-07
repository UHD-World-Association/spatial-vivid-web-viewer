import * as THREE from 'three';
import { SplatMaterial } from './SplatMaterial.js';

export class SplatMaterial3D {

    /**
     * Build the Three.js material that is used to render the splats.
     * @param {number} dynamicMode If true, it means the scene geometry represented by this splat mesh is not stationary or
     *                             that the splat count might change
     * @param {boolean} enableOptionalEffects When true, allows for usage of extra properties and attributes in the shader for effects
     *                                        such as opacity adjustment. Default is false for performance reasons.
     * @param {boolean} antialiased If true, calculate compensation factor to deal with gaussians being rendered at a significantly
     *                              different resolution than that of their training
     * @param {number} maxScreenSpaceSplatSize The maximum clip space splat size
     * @param {number} splatScale Value by which all splats are scaled in screen-space (default is 1.0)
     * @param {number} pointCloudModeEnabled Render all splats as screen-space circles
     * @param {number} maxSphericalHarmonicsDegree Degree of spherical harmonics to utilize in rendering splats
     * @param {number} minimumGaussianContribution Minimum fragment alpha contribution to retain; zero uses legacy support
     * @return {THREE.ShaderMaterial}
     */
    static build(dynamicMode = false, enableOptionalEffects = false, antialiased = false, maxScreenSpaceSplatSize = 2048,
                 splatScale = 1.0, pointCloudModeEnabled = false, maxSphericalHarmonicsDegree = 0, kernel2DSize = 0.3,
                 useASTC = false, covariancesFromScaleRotation = false, minimumGaussianContribution = 1 / 1024) {

        const requestedMinimumContribution = Number(minimumGaussianContribution);
        const clampedMinimumContribution = !Number.isFinite(requestedMinimumContribution) ?
            (1 / 1024) : Math.min(Math.max(requestedMinimumContribution, 0), 1);
        const directCovarianceVariant = !!covariancesFromScaleRotation;
        const supportVarying = !directCovarianceVariant;

        const customVertexVars = `
            uniform vec2 covariancesTextureSize;
            uniform highp sampler2D covariancesTexture;
            uniform highp usampler2D covariancesTextureHalfFloat;
            uniform int covariancesAreHalfFloat;
            uniform vec2 scaleRotationsTextureSize;
            uniform highp sampler2D scaleRotationsTexture;
            uniform int covariancesFromScaleRotation;
            ${supportVarying ? 'flat varying float vGaussianSupportSquared;' : ''}

            void fromCovarianceHalfFloatV4(uvec4 val, out vec4 first, out vec4 second) {
                vec2 r = unpackHalf2x16(val.r);
                vec2 g = unpackHalf2x16(val.g);
                vec2 b = unpackHalf2x16(val.b);

                first = vec4(r.x, r.y, g.x, g.y);
                second = vec4(b.x, b.y, 0.0, 0.0);
            }
        `;

        let vertexShaderSource = SplatMaterial.buildVertexShaderBase(dynamicMode, enableOptionalEffects,
                                                                     maxSphericalHarmonicsDegree, useASTC, customVertexVars);
        vertexShaderSource += SplatMaterial3D.buildVertexShaderProjection(antialiased, enableOptionalEffects,
                                                                          maxScreenSpaceSplatSize, kernel2DSize,
                                                                          clampedMinimumContribution,
                                                                          covariancesFromScaleRotation);
        const fragmentShaderSource = SplatMaterial3D.buildFragmentShader(clampedMinimumContribution,
                                                                          covariancesFromScaleRotation);

        const uniforms = SplatMaterial.getUniforms(dynamicMode, enableOptionalEffects,
                                                   maxSphericalHarmonicsDegree, splatScale, pointCloudModeEnabled, useASTC);

        uniforms['covariancesTextureSize'] = {
            'type': 'v2',
            'value': new THREE.Vector2(1024, 1024)
        };
        uniforms['covariancesTexture'] = {
            'type': 't',
            'value': null
        };
        uniforms['covariancesTextureHalfFloat'] = {
            'type': 't',
            'value': null
        };
        uniforms['covariancesAreHalfFloat'] = {
            'type': 'i',
            'value': 0
        };
        uniforms['scaleRotationsTextureSize'] = {
            'type': 'v2',
            'value': new THREE.Vector2(1024, 1024)
        };
        uniforms['scaleRotationsTexture'] = {
            'type': 't',
            'value': null
        };
        uniforms['covariancesFromScaleRotation'] = {
            'type': 'i',
            'value': covariancesFromScaleRotation ? 1 : 0
        };

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertexShaderSource,
            fragmentShader: fragmentShaderSource,
            transparent: true,
            alphaTest: 1.0,
            blending: THREE.NormalBlending,
            depthTest: true,
            depthWrite: false,
            side: THREE.DoubleSide
        });

        return material;
    }

    static buildVertexShaderProjection(antialiased, enableOptionalEffects, maxScreenSpaceSplatSize, kernel2DSize,
                                       minimumGaussianContribution = 0, covariancesFromScaleRotation = false) {
        const directCovarianceVariant = !!covariancesFromScaleRotation;
        const contributionAwareSupport = !directCovarianceVariant && minimumGaussianContribution > 0;
        const supportVarying = !directCovarianceVariant;
        const minimumContributionLiteral = contributionAwareSupport ? minimumGaussianContribution.toPrecision(10) : null;
        let vertexShaderSource = `

            vec4 sampledCovarianceA;
            vec4 sampledCovarianceB;
            vec3 cov3D_M11_M12_M13;
            vec3 cov3D_M22_M23_M33;
            ${directCovarianceVariant ? `
                vec4 scaleRotationA = texture(scaleRotationsTexture, getDataUVF(nearestEvenIndex, 1.5,
                                                                                  oddOffset, scaleRotationsTextureSize));
                vec4 scaleRotationB = texture(scaleRotationsTexture, getDataUVF(nearestEvenIndex, 1.5,
                                                                                  oddOffset + uint(1), scaleRotationsTextureSize));
                vec3 scale = vec3(scaleRotationA.rgb) * (1.0 - fOddOffset) +
                             vec3(scaleRotationA.ba, scaleRotationB.r) * fOddOffset;
                vec3 rotation = vec3(scaleRotationA.a, scaleRotationB.rg) * (1.0 - fOddOffset) +
                                vec3(scaleRotationB.gba) * fOddOffset;
                float missingW = sqrt(max(0.0, 1.0 - dot(rotation, rotation)));
                mat3 rotationMatrix = quaternionToRotationMatrix(rotation.x, rotation.y, rotation.z, missingW);
                mat3 scaleMatrix = mat3(scale.x, 0.0, 0.0,
                                        0.0, scale.y, 0.0,
                                        0.0, 0.0, scale.z);
                mat3 linear = rotationMatrix * scaleMatrix;
                mat3 covariance = linear * transpose(linear);
                cov3D_M11_M12_M13 = vec3(covariance[0][0], covariance[0][1], covariance[0][2]);
                cov3D_M22_M23_M33 = vec3(covariance[1][1], covariance[1][2], covariance[2][2]);
            ` : `
            if (covariancesAreHalfFloat == 0) {
                sampledCovarianceA = texture(covariancesTexture, getDataUVF(nearestEvenIndex, 1.5, oddOffset,
                                                                            covariancesTextureSize));
                sampledCovarianceB = texture(covariancesTexture, getDataUVF(nearestEvenIndex, 1.5, oddOffset + uint(1),
                                                                            covariancesTextureSize));

                cov3D_M11_M12_M13 = vec3(sampledCovarianceA.rgb) * (1.0 - fOddOffset) +
                                    vec3(sampledCovarianceA.ba, sampledCovarianceB.r) * fOddOffset;
                cov3D_M22_M23_M33 = vec3(sampledCovarianceA.a, sampledCovarianceB.rg) * (1.0 - fOddOffset) +
                                    vec3(sampledCovarianceB.gba) * fOddOffset;
            } else {
                uvec4 sampledCovarianceU = texture(covariancesTextureHalfFloat, getDataUV(1, 0, covariancesTextureSize));
                fromCovarianceHalfFloatV4(sampledCovarianceU, sampledCovarianceA, sampledCovarianceB);
                cov3D_M11_M12_M13 = sampledCovarianceA.rgb;
                cov3D_M22_M23_M33 = vec3(sampledCovarianceA.a, sampledCovarianceB.rg);
            }
            `}
        
            // Construct the 3D covariance matrix
            mat3 Vrk = mat3(
                cov3D_M11_M12_M13.x, cov3D_M11_M12_M13.y, cov3D_M11_M12_M13.z,
                cov3D_M11_M12_M13.y, cov3D_M22_M23_M33.x, cov3D_M22_M23_M33.y,
                cov3D_M11_M12_M13.z, cov3D_M22_M23_M33.y, cov3D_M22_M23_M33.z
            );

            mat3 J;
            if (orthographicMode == 1) {
                // Since the projection is linear, we don't need an approximation
                J = transpose(mat3(orthoZoom, 0.0, 0.0,
                                0.0, orthoZoom, 0.0,
                                0.0, 0.0, 0.0));
            } else {
                // Construct the Jacobian of the affine approximation of the projection matrix. It will be used to transform the
                // 3D covariance matrix instead of using the actual projection matrix because that transformation would
                // require a non-linear component (perspective division) which would yield a non-gaussian result.
                float s = 1.0 / (viewCenter.z * viewCenter.z);
                J = mat3(
                    focal.x / viewCenter.z, 0., -(focal.x * viewCenter.x) * s,
                    0., focal.y / viewCenter.z, -(focal.y * viewCenter.y) * s,
                    0., 0., 0.
                );
            }

            // Concatenate the projection approximation with the model-view transformation
            mat3 W = transpose(mat3(transformModelViewMatrix));
            mat3 T = W * J;

            // Transform the 3D covariance matrix (Vrk) to compute the 2D covariance matrix
            mat3 cov2Dm = transpose(T) * Vrk * T;
            `;

        if (antialiased) {
            vertexShaderSource += `
                float detOrig = cov2Dm[0][0] * cov2Dm[1][1] - cov2Dm[0][1] * cov2Dm[0][1];
                cov2Dm[0][0] += ${kernel2DSize};
                cov2Dm[1][1] += ${kernel2DSize};
                float detBlur = cov2Dm[0][0] * cov2Dm[1][1] - cov2Dm[0][1] * cov2Dm[0][1];
                vColor.a *= sqrt(max(detOrig / detBlur, 0.0));
                if (vColor.a < minAlpha) return;
            `;
        } else {
            vertexShaderSource += `
                cov2Dm[0][0] += ${kernel2DSize};
                cov2Dm[1][1] += ${kernel2DSize};
            `;
        }

        if (contributionAwareSupport) {
            vertexShaderSource += `
                // Keep the support stable while scene opacity and progressive fade-in change.
                float baseAlpha = vColor.a;
                const float minimumGaussianContribution = ${minimumContributionLiteral};
                if (!(baseAlpha > minimumGaussianContribution)) {
                    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                    return;
                }
                float gaussianSupportSquared = clamp(2.0 * log(baseAlpha / minimumGaussianContribution), 0.0, 8.0);
                if (!(gaussianSupportSquared > 0.0)) {
                    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                    return;
                }
                float gaussianSupport = sqrt(gaussianSupportSquared);
                vGaussianSupportSquared = gaussianSupportSquared;
            `;
        } else if (supportVarying) {
            vertexShaderSource += `
                vGaussianSupportSquared = 8.0;
            `;
        }

        vertexShaderSource += `

            // We are interested in the upper-left 2x2 portion of the projected 3D covariance matrix because
            // we only care about the X and Y values. We want the X-diagonal, cov2Dm[0][0],
            // the Y-diagonal, cov2Dm[1][1], and the correlation between the two cov2Dm[0][1]. We don't
            // need cov2Dm[1][0] because it is a symetric matrix.
            vec3 cov2Dv = vec3(cov2Dm[0][0], cov2Dm[0][1], cov2Dm[1][1]);

            // We now need to solve for the eigen-values and eigen vectors of the 2D covariance matrix
            // so that we can determine the 2D basis for the splat. This is done using the method described
            // here: https://people.math.harvard.edu/~knill/teaching/math21b2004/exhibits/2dmatrices/index.html
            // After calculating the eigen-values and eigen-vectors, we calculate the basis for rendering the splat
            // by normalizing the eigen-vectors and then multiplying them by (sqrt(8) * sqrt(eigen-value)), which is
            // equal to scaling them by sqrt(8) standard deviations.
            //
            // This is a different approach than in the original work at INRIA. In that work they compute the
            // max extents of the projected splat in screen space to form a screen-space aligned bounding rectangle
            // which forms the geometry that is actually rasterized. The dimensions of that bounding box are 3.0
            // times the square root of the maximum eigen-value, or 3 standard deviations. They then use the inverse
            // 2D covariance matrix (called 'conic') in the CUDA rendering thread to determine fragment opacity by
            // calculating the full gaussian: exp(-0.5 * (X - mean) * conic * (X - mean)) * splat opacity
            float a = cov2Dv.x;
            float d = cov2Dv.z;
            float b = cov2Dv.y;
            float D = a * d - b * b;
            float trace = a + d;
            float traceOver2 = 0.5 * trace;
            float term2 = sqrt(max(0.1f, traceOver2 * traceOver2 - D));
            float eigenValue1 = traceOver2 + term2;
            float eigenValue2 = traceOver2 - term2;

            if (pointCloudModeEnabled == 1) {
                eigenValue1 = eigenValue2 = 0.2;
            }

            if (eigenValue2 <= 0.0) return;

            vec2 eigenVector1 = normalize(vec2(b, eigenValue1 - a));
            // since the eigen vectors are orthogonal, we derive the second one from the first
            vec2 eigenVector2 = vec2(eigenVector1.y, -eigenVector1.x);

            // Bound the quad by the retained Gaussian support, capped at the legacy sqrt(8) support.
            vec2 basisVector1 = eigenVector1 * splatScale *
                                min(${contributionAwareSupport ? 'gaussianSupport' : 'sqrt8'} * sqrt(eigenValue1),
                                    ${parseInt(maxScreenSpaceSplatSize)}.0);
            vec2 basisVector2 = eigenVector2 * splatScale *
                                min(${contributionAwareSupport ? 'gaussianSupport' : 'sqrt8'} * sqrt(eigenValue2),
                                    ${parseInt(maxScreenSpaceSplatSize)}.0);
            `;

        if (enableOptionalEffects) {
            vertexShaderSource += `
                vColor.a *= splatOpacityFromScene;
            `;
        }

        vertexShaderSource += `
            vec2 ndcOffset = vec2(vPosition.x * basisVector1 + vPosition.y * basisVector2) *
                             basisViewport * 2.0 * inverseFocalAdjustment;

            vec4 quadPos = vec4(ndcCenter.xy + ndcOffset, ndcCenter.z, 1.0);
            gl_Position = quadPos;

            // Scale the position data we send to the fragment shader
            vPosition *= ${contributionAwareSupport ? 'gaussianSupport' : 'sqrt8'};
        `;

        vertexShaderSource += SplatMaterial.getVertexShaderFadeIn();
        vertexShaderSource += `}`;

        return vertexShaderSource;
    }

    static buildFragmentShader(minimumGaussianContribution = 0, covariancesFromScaleRotation = false) {
        const directCovarianceVariant = !!covariancesFromScaleRotation;
        const contributionAwareSupport = !directCovarianceVariant && minimumGaussianContribution > 0;
        const supportVarying = !directCovarianceVariant;
        const minimumContributionLiteral = contributionAwareSupport ? minimumGaussianContribution.toPrecision(10) : null;
        let fragmentShaderSource = `
            precision highp float;
            #include <common>
 
            flat varying vec4 vColor;
            varying vec2 vPosition;
            ${supportVarying ? 'flat varying float vGaussianSupportSquared;' : ''}
        `;

        fragmentShaderSource += `
            void main () {
                // Compute the positional squared distance from the center of the splat to the current fragment.
                float A = dot(vPosition, vPosition);
                // The vertex shader scales vPosition by this splat's support radius. Reject corners of the
                // bounding quad that lie outside the corresponding elliptical support before evaluating the falloff.
                ${supportVarying ? 'if (A > vGaussianSupportSquared) discard;' : 'if (A > 8.0) discard;'}
                vec3 color = vColor.rgb;

                // Since the rendered splat is scaled by sqrt(8), the inverse covariance matrix that is part of
                // the gaussian formula becomes the identity matrix. We're then left with (X - mean) * (X - mean),
                // and since 'mean' is zero, we have X * X, which is the same as A:
                // exp(-0.5 * A) is exactly exp2((-0.5 / ln(2)) * A).
                float opacity = ${directCovarianceVariant ? 'exp(-0.5 * A)' : 'exp2(-0.7213475204444817 * A)'} * vColor.a;

                ${contributionAwareSupport ? `if (opacity < ${minimumContributionLiteral}) discard;` : ''}

                gl_FragColor = vec4(color.rgb, opacity);
            }
        `;

        return fragmentShaderSource;
    }

}
