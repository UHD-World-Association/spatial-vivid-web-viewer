import * as THREE from 'three';
import { Constants } from '../Constants.js';

export function getCompressedTextureSampleAddress(
    offsetX, offsetY, coefficientIndex, regionWidth, regionHeight, textureWidth
) {
    const linearX = offsetX + coefficientIndex * regionWidth;
    return {
        x: linearX % textureWidth,
        y: offsetY + Math.floor(linearX / textureWidth) * regionHeight,
        layer: 0
    };
}

export class SplatMaterial {

    // Add the useASTC parameter.
    static buildVertexShaderBase(dynamicMode = false, enableOptionalEffects = false,
        maxSphericalHarmonicsDegree = 0, useASTC = false, customVars = '') {
        let vertexShaderSource = `
        precision highp float;
        precision highp int;
        precision highp usampler2D; // Required by the ASTC path.
        precision highp sampler2DArray; // Required by the ASTC path.

        #include <common>

        attribute uint splatIndex;
        uniform highp usampler2D centersColorsTexture;

        uniform highp usampler2D sceneIndexesTexture;
        uniform vec2 sceneIndexesTextureSize;
        uniform int sceneCount;
    `;

    // Define the ASTC and SH uniform branches.
    if (useASTC) {
        vertexShaderSource += `
            // ASTC Uniforms
            uniform highp usampler2D astcUVTexture;
            uniform highp sampler2DArray astcTextures;
            uniform int astcSingleWidth;
            uniform int astcSingleHeight;
            uniform int astcTextureWidth;
        uniform vec3 astcQuantMin;
        uniform vec3 astcQuantRange;
        uniform vec3 astcQuantMins[15];
        uniform vec3 astcQuantRanges[15];
            uniform vec2 astcUVTextureSize;
        `;
    } else {
        // Existing SH uniforms remain unchanged.
        vertexShaderSource += `
            uniform highp sampler2D sphericalHarmonicsTexture;
            uniform highp sampler2D sphericalHarmonicsTextureR;
            uniform highp sampler2D sphericalHarmonicsTextureG;
            uniform highp sampler2D sphericalHarmonicsTextureB;
        `;
    }

    if (enableOptionalEffects) {
        vertexShaderSource += `
            uniform float sceneOpacity[${Constants.MaxScenes}];
            uniform int sceneVisibility[${Constants.MaxScenes}];
        `;
    }

    if (dynamicMode) {
        vertexShaderSource += `
            uniform highp mat4 transforms[${Constants.MaxScenes}];
        `;
    }

    vertexShaderSource += `
        ${customVars}
        uniform vec2 focal;
        uniform float orthoZoom;
        uniform int orthographicMode;
        uniform int pointCloudModeEnabled;
        uniform float inverseFocalAdjustment;
        uniform vec2 viewport;
        uniform vec2 basisViewport;
        uniform vec2 centersColorsTextureSize;
        uniform int sphericalHarmonicsDegree;
        uniform vec2 sphericalHarmonicsTextureSize;
        uniform int sphericalHarmonics8BitMode;
        uniform int sphericalHarmonicsMultiTextureMode;
        uniform float visibleRegionRadius;
        uniform float visibleRegionFadeStartRadius;
        uniform float firstRenderTime;
        uniform float currentTime;
        uniform int fadeInComplete;
        uniform vec3 sceneCenter;
        uniform float splatScale;
        uniform float sphericalHarmonics8BitCompressionRangeMin[${Constants.MaxScenes}];
        uniform float sphericalHarmonics8BitCompressionRangeMax[${Constants.MaxScenes}];

        flat varying vec4 vColor;
        varying vec2 vPosition;

        mat3 quaternionToRotationMatrix(float x, float y, float z, float w) {
            float s = 1.0 / sqrt(w * w + x * x + y * y + z * z);
        
            return mat3(
                1. - 2. * (y * y + z * z),
                2. * (x * y + w * z),
                2. * (x * z - w * y),
                2. * (x * y - w * z),
                1. - 2. * (x * x + z * z),
                2. * (y * z + w * x),
                2. * (x * z + w * y),
                2. * (y * z - w * x),
                1. - 2. * (x * x + y * y)
            );
        }

        const float sqrt8 = sqrt(8.0);
        const float minAlpha = 1.0 / 255.0;

        const vec4 encodeNorm4 = vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0);
        const uvec4 mask4 = uvec4(uint(0x000000FF), uint(0x0000FF00), uint(0x00FF0000), uint(0xFF000000));
        const uvec4 shift4 = uvec4(0, 8, 16, 24);
        vec4 uintToRGBAVec (uint u) {
           uvec4 urgba = mask4 & u;
           urgba = urgba >> shift4;
           vec4 rgba = vec4(urgba) * encodeNorm4;
           return rgba;
        }

        vec2 getDataUV(in int stride, in int offset, in vec2 dimensions) {
            vec2 samplerUV = vec2(0.0, 0.0);
            float d = float(splatIndex * uint(stride) + uint(offset)) / dimensions.x;
            samplerUV.y = float(floor(d)) / dimensions.y;
            samplerUV.x = fract(d);
            return samplerUV;
        }

        vec2 getDataUVF(in uint sIndex, in float stride, in uint offset, in vec2 dimensions) {
            vec2 samplerUV = vec2(0.0, 0.0);
            float d = float(uint(float(sIndex) * stride) + offset) / dimensions.x;
            samplerUV.y = float(floor(d)) / dimensions.y;
            samplerUV.x = fract(d);
            return samplerUV;
        }

        const float SH_C1 = 0.4886025119029199f;
        const float[5] SH_C2 = float[](1.0925484, -1.0925484, 0.3153916, -1.0925484, 0.5462742);
        const float[7] SH_C3 = float[](-0.5900435899266435, 2.890611442640554,
                                        -0.4570457994644658, 0.3731763325901154,
                                        -0.4570457994644658, 1.445305721320277,
                                        -0.5900435899266435);
        `;

    // Insert the ASTC sampling function.
    if (useASTC) {
        vertexShaderSource += `
        vec3 GetAstcSHCoef(uvec2 shOffset, int shidx) {
            uint totalX = shOffset.x + uint(shidx) * uint(astcSingleWidth);
            uint newx = totalX % uint(astcTextureWidth);
            uint regionRow = totalX / uint(astcTextureWidth);
            uint newy = shOffset.y + regionRow * uint(astcSingleHeight);
            vec4 rawVal = texelFetch(astcTextures, ivec3(newx, newy, 0), 0);
            int rangeIndex = clamp(shidx, 0, 14);
            return rawVal.rgb * astcQuantRanges[rangeIndex] + astcQuantMins[rangeIndex];
        }
        `;
    }

    vertexShaderSource += `
        void main () {

            uint oddOffset = splatIndex & uint(0x00000001);
            uint doubleOddOffset = oddOffset * uint(2);
            bool isEven = oddOffset == uint(0);
            uint nearestEvenIndex = splatIndex - oddOffset;
            float fOddOffset = float(oddOffset);

            uvec4 sampledCenterColor = texture(centersColorsTexture, getDataUV(1, 0, centersColorsTextureSize));
            vec3 splatCenter = uintBitsToFloat(uvec3(sampledCenterColor.gba));

            uint sceneIndex = uint(0);
            if (sceneCount > 1) {
                sceneIndex = texture(sceneIndexesTexture, getDataUV(1, 0, sceneIndexesTextureSize)).r;
            }
            `;

        if (enableOptionalEffects) {
            vertexShaderSource += `
                float splatOpacityFromScene = sceneOpacity[sceneIndex];
                int sceneVisible = sceneVisibility[sceneIndex];
                if (splatOpacityFromScene <= 0.01 || sceneVisible == 0) {
                    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                    return;
                }
            `;
        }

        if (dynamicMode) {
            vertexShaderSource += `
                mat4 transform = transforms[sceneIndex];
                mat4 transformModelViewMatrix = viewMatrix * transform;
            `;
        } else {
            vertexShaderSource += `mat4 transformModelViewMatrix = modelViewMatrix;`;
        }

        vertexShaderSource += `
            float sh8BitCompressionRangeMinForScene = sphericalHarmonics8BitCompressionRangeMin[sceneIndex];
            float sh8BitCompressionRangeMaxForScene = sphericalHarmonics8BitCompressionRangeMax[sceneIndex];
            float sh8BitCompressionRangeForScene = sh8BitCompressionRangeMaxForScene - sh8BitCompressionRangeMinForScene;
            float sh8BitCompressionHalfRangeForScene = sh8BitCompressionRangeForScene / 2.0;
            vec3 vec8BitSHShift = vec3(sh8BitCompressionRangeMinForScene);

            vec4 viewCenter = transformModelViewMatrix * vec4(splatCenter, 1.0);

            vec4 clipCenter = projectionMatrix * viewCenter;

            float clip = 1.2 * clipCenter.w;
            if (clipCenter.z < -clip || clipCenter.x < -clip || clipCenter.x > clip || clipCenter.y < -clip || clipCenter.y > clip) {
                gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
                return;
            }

            // Preserve the original ndcCenter calculation.
            vec3 ndcCenter = clipCenter.xyz / clipCenter.w;

            vPosition = position.xy;
            vColor = uintToRGBAVec(sampledCenterColor.r);
            //vColor = vec4(0.5, 0.5, 0.5, uintToRGBAVec(sampledCenterColor.r).a);
        `;

        if (maxSphericalHarmonicsDegree >= 1) {

            vertexShaderSource += `   
            if (true) {
            `;

            if (dynamicMode) {
                vertexShaderSource += `
                    vec3 worldViewDir = normalize(splatCenter - vec3(inverse(transform) * vec4(cameraPosition, 1.0)));
                `;
            } else {
                vertexShaderSource += `
                    vec3 worldViewDir = normalize(splatCenter - cameraPosition);
                `;
            }

            vertexShaderSource += `
                vec3 sh1;
                vec3 sh2;
                vec3 sh3;
            `;

            if (maxSphericalHarmonicsDegree >= 2) {
                vertexShaderSource += `
                    vec3 sh4;
                    vec3 sh5;
                    vec3 sh6;
                    vec3 sh7;
                    vec3 sh8;
                `;
            }

            if (maxSphericalHarmonicsDegree >= 3) {
                vertexShaderSource += `
                    vec3 sh9;
                    vec3 sh10;
                    vec3 sh11;
                    vec3 sh12;
                    vec3 sh13;
                    vec3 sh14;
                    vec3 sh15;
                `;
            }

            if (useASTC) {
                vertexShaderSource += `
                    // ASTC mode.
                    ivec2 texSize = ivec2(astcUVTextureSize);
                    ivec2 fetchCoord = ivec2(int(splatIndex) % texSize.x, int(splatIndex) / texSize.x);
                    uvec4 shUVData = texelFetch(astcUVTexture, fetchCoord, 0);
                    uvec2 shOffset = shUVData.rg;

                    sh1 = GetAstcSHCoef(shOffset, 0);
                    sh2 = GetAstcSHCoef(shOffset, 1);
                    sh3 = GetAstcSHCoef(shOffset, 2);
                `;

                if (maxSphericalHarmonicsDegree >= 2) {
                    vertexShaderSource += `
                        if (true) {
                            sh4 = GetAstcSHCoef(shOffset, 3);
                            sh5 = GetAstcSHCoef(shOffset, 4);
                            sh6 = GetAstcSHCoef(shOffset, 5);
                            sh7 = GetAstcSHCoef(shOffset, 6);
                            sh8 = GetAstcSHCoef(shOffset, 7);
                        }
                    `;
                }
                if (maxSphericalHarmonicsDegree >= 3) {
                    vertexShaderSource += `
                        if (true) {
                            sh9 = GetAstcSHCoef(shOffset, 8);
                            sh10 = GetAstcSHCoef(shOffset, 9);
                            sh11 = GetAstcSHCoef(shOffset, 10);
                            sh12 = GetAstcSHCoef(shOffset, 11);
                            sh13 = GetAstcSHCoef(shOffset, 12);
                            sh14 = GetAstcSHCoef(shOffset, 13);
                            sh15 = GetAstcSHCoef(shOffset, 14);
                        }
                    `;
                }
            } else {
                // --- Original SH sampling path, preserved unchanged. ---
                if (maxSphericalHarmonicsDegree === 1) {
                    vertexShaderSource += `
                        if (sphericalHarmonicsMultiTextureMode == 0) {
                            vec2 shUV = getDataUVF(nearestEvenIndex, 2.5, doubleOddOffset, sphericalHarmonicsTextureSize);
                            vec4 sampledSH0123 = texture(sphericalHarmonicsTexture, shUV);
                            shUV = getDataUVF(nearestEvenIndex, 2.5, doubleOddOffset + uint(1), sphericalHarmonicsTextureSize);
                            vec4 sampledSH4567 = texture(sphericalHarmonicsTexture, shUV);
                            shUV = getDataUVF(nearestEvenIndex, 2.5, doubleOddOffset + uint(2), sphericalHarmonicsTextureSize);
                            vec4 sampledSH891011 = texture(sphericalHarmonicsTexture, shUV);
                            sh1 = vec3(sampledSH0123.rgb) * (1.0 - fOddOffset) + vec3(sampledSH0123.ba, sampledSH4567.r) * fOddOffset;
                            sh2 = vec3(sampledSH0123.a, sampledSH4567.rg) * (1.0 - fOddOffset) + vec3(sampledSH4567.gba) * fOddOffset;
                            sh3 = vec3(sampledSH4567.ba, sampledSH891011.r) * (1.0 - fOddOffset) + vec3(sampledSH891011.rgb) * fOddOffset;
                        } else {
                            vec2 sampledSH01R = texture(sphericalHarmonicsTextureR, getDataUV(2, 0, sphericalHarmonicsTextureSize)).rg;
                            vec2 sampledSH23R = texture(sphericalHarmonicsTextureR, getDataUV(2, 1, sphericalHarmonicsTextureSize)).rg;
                            vec2 sampledSH01G = texture(sphericalHarmonicsTextureG, getDataUV(2, 0, sphericalHarmonicsTextureSize)).rg;
                            vec2 sampledSH23G = texture(sphericalHarmonicsTextureG, getDataUV(2, 1, sphericalHarmonicsTextureSize)).rg;
                            vec2 sampledSH01B = texture(sphericalHarmonicsTextureB, getDataUV(2, 0, sphericalHarmonicsTextureSize)).rg;
                            vec2 sampledSH23B = texture(sphericalHarmonicsTextureB, getDataUV(2, 1, sphericalHarmonicsTextureSize)).rg;
                            sh1 = vec3(sampledSH01R.rg, sampledSH23R.r);
                            sh2 = vec3(sampledSH01G.rg, sampledSH23G.r);
                            sh3 = vec3(sampledSH01B.rg, sampledSH23B.r);
                        }
                    `;
                } else if (maxSphericalHarmonicsDegree >= 2) {
                    vertexShaderSource += `
                        vec4 sampledSH0123;
                        vec4 sampledSH4567;
                        vec4 sampledSH891011;

                        vec4 sampledSH0123R;
                        vec4 sampledSH0123G;
                        vec4 sampledSH0123B;

                        if (sphericalHarmonicsMultiTextureMode == 0) {
                            sampledSH0123 = texture(sphericalHarmonicsTexture, getDataUV(6, 0, sphericalHarmonicsTextureSize));
                            sampledSH4567 = texture(sphericalHarmonicsTexture, getDataUV(6, 1, sphericalHarmonicsTextureSize));
                            sampledSH891011 = texture(sphericalHarmonicsTexture, getDataUV(6, 2, sphericalHarmonicsTextureSize));
                            sh1 = sampledSH0123.rgb;
                            sh2 = vec3(sampledSH0123.a, sampledSH4567.rg);
                            sh3 = vec3(sampledSH4567.ba, sampledSH891011.r);
                        } else {
                            sampledSH0123R = texture(sphericalHarmonicsTextureR, getDataUV(2, 0, sphericalHarmonicsTextureSize));
                            sampledSH0123G = texture(sphericalHarmonicsTextureG, getDataUV(2, 0, sphericalHarmonicsTextureSize));
                            sampledSH0123B = texture(sphericalHarmonicsTextureB, getDataUV(2, 0, sphericalHarmonicsTextureSize));
                            sh1 = vec3(sampledSH0123R.rgb);
                            sh2 = vec3(sampledSH0123G.rgb);
                            sh3 = vec3(sampledSH0123B.rgb);
                        }
                    `;
                    if (maxSphericalHarmonicsDegree >= 3) {
                        vertexShaderSource += `
                        if (true && sphericalHarmonicsMultiTextureMode == 0) {
                            vec4 shTex0 = texture(sphericalHarmonicsTexture, getDataUV(12, 0, sphericalHarmonicsTextureSize));
                            vec4 shTex1 = texture(sphericalHarmonicsTexture, getDataUV(12, 1, sphericalHarmonicsTextureSize));
                            vec4 shTex2 = texture(sphericalHarmonicsTexture, getDataUV(12, 2, sphericalHarmonicsTextureSize));
                            vec4 shTex3 = texture(sphericalHarmonicsTexture, getDataUV(12, 3, sphericalHarmonicsTextureSize));
                            vec4 shTex4 = texture(sphericalHarmonicsTexture, getDataUV(12, 4, sphericalHarmonicsTextureSize));
                            vec4 shTex5 = texture(sphericalHarmonicsTexture, getDataUV(12, 5, sphericalHarmonicsTextureSize));
                            vec4 shTex6 = texture(sphericalHarmonicsTexture, getDataUV(12, 6, sphericalHarmonicsTextureSize));
                            vec4 shTex7 = texture(sphericalHarmonicsTexture, getDataUV(12, 7, sphericalHarmonicsTextureSize));
                            vec4 shTex8 = texture(sphericalHarmonicsTexture, getDataUV(12, 8, sphericalHarmonicsTextureSize));
                            vec4 shTex9 = texture(sphericalHarmonicsTexture, getDataUV(12, 9, sphericalHarmonicsTextureSize));
                            vec4 shTex10 = texture(sphericalHarmonicsTexture, getDataUV(12, 10, sphericalHarmonicsTextureSize));
                            vec4 shTex11 = texture(sphericalHarmonicsTexture, getDataUV(12, 11, sphericalHarmonicsTextureSize));
                            sh1 = shTex0.rgb;
                            sh2 = vec3(shTex0.a, shTex1.rg);
                            sh3 = vec3(shTex1.ba, shTex2.r);
                            sh4 = shTex2.gba;
                            sh5 = shTex3.rgb;
                            sh6 = vec3(shTex3.a, shTex4.rg);
                            sh7 = vec3(shTex4.ba, shTex5.r);
                            sh8 = shTex5.gba;
                            sh9 = shTex6.rgb;
                            sh10 = vec3(shTex6.a, shTex7.rg);
                            sh11 = vec3(shTex7.ba, shTex8.r);
                            sh12 = shTex8.gba;
                            sh13 = shTex9.rgb;
                            sh14 = vec3(shTex9.a, shTex10.rg);
                            sh15 = vec3(shTex10.ba, shTex11.r);
                        }
                        if (true && sphericalHarmonicsMultiTextureMode != 0) {
                            vec4 sh0R = texture(sphericalHarmonicsTextureR, getDataUV(4, 0, sphericalHarmonicsTextureSize));
                            vec4 sh0G = texture(sphericalHarmonicsTextureG, getDataUV(4, 0, sphericalHarmonicsTextureSize));
                            vec4 sh0B = texture(sphericalHarmonicsTextureB, getDataUV(4, 0, sphericalHarmonicsTextureSize));
                            vec4 sh1R = texture(sphericalHarmonicsTextureR, getDataUV(4, 1, sphericalHarmonicsTextureSize));
                            vec4 sh1G = texture(sphericalHarmonicsTextureG, getDataUV(4, 1, sphericalHarmonicsTextureSize));
                            vec4 sh1B = texture(sphericalHarmonicsTextureB, getDataUV(4, 1, sphericalHarmonicsTextureSize));
                            vec4 sh2R = texture(sphericalHarmonicsTextureR, getDataUV(4, 2, sphericalHarmonicsTextureSize));
                            vec4 sh2G = texture(sphericalHarmonicsTextureG, getDataUV(4, 2, sphericalHarmonicsTextureSize));
                            vec4 sh2B = texture(sphericalHarmonicsTextureB, getDataUV(4, 2, sphericalHarmonicsTextureSize));
                            vec4 sh3R = texture(sphericalHarmonicsTextureR, getDataUV(4, 3, sphericalHarmonicsTextureSize));
                            vec4 sh3G = texture(sphericalHarmonicsTextureG, getDataUV(4, 3, sphericalHarmonicsTextureSize));
                            vec4 sh3B = texture(sphericalHarmonicsTextureB, getDataUV(4, 3, sphericalHarmonicsTextureSize));
                            sh1 = vec3(sh0R.r, sh0G.r, sh0B.r);
                            sh2 = vec3(sh0R.g, sh0G.g, sh0B.g);
                            sh3 = vec3(sh0R.b, sh0G.b, sh0B.b);
                            sh4 = vec3(sh0R.a, sh0G.a, sh0B.a);
                            sh5 = vec3(sh1R.r, sh1G.r, sh1B.r);
                            sh6 = vec3(sh1R.g, sh1G.g, sh1B.g);
                            sh7 = vec3(sh1R.b, sh1G.b, sh1B.b);
                            sh8 = vec3(sh1R.a, sh1G.a, sh1B.a);
                            sh9 = vec3(sh2R.r, sh2G.r, sh2B.r);
                            sh10 = vec3(sh2R.g, sh2G.g, sh2B.g);
                            sh11 = vec3(sh2R.b, sh2G.b, sh2B.b);
                            sh12 = vec3(sh2R.a, sh2G.a, sh2B.a);
                            sh13 = vec3(sh3R.r, sh3G.r, sh3B.r);
                            sh14 = vec3(sh3R.g, sh3G.g, sh3B.g);
                            sh15 = vec3(sh3R.b, sh3G.b, sh3B.b);
                        }
                    `;
                    }
                }
            }

            vertexShaderSource += `
                    if (!${useASTC} && sphericalHarmonics8BitMode == 1) {
                        sh1 = sh1 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        sh2 = sh2 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        sh3 = sh3 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        ${maxSphericalHarmonicsDegree >= 3 ? `
                        sh9 = sh9 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        sh10 = sh10 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        sh11 = sh11 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        sh12 = sh12 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        sh13 = sh13 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        sh14 = sh14 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        sh15 = sh15 * sh8BitCompressionRangeForScene + vec8BitSHShift;` : ''}
                    }
                    float x = worldViewDir.x;
                    float y = worldViewDir.y;
                    float z = worldViewDir.z;
                    vColor.rgb += SH_C1 * (-sh1 * y + sh2 * z - sh3 * x);
            `;

            if (maxSphericalHarmonicsDegree >= 2) {

                vertexShaderSource += `
                    if (true) {
                        float xx = x * x;
                        float yy = y * y;
                        float zz = z * z;
                        float xy = x * y;
                        float yz = y * z;
                        float xz = x * z;
                `;

                if (!useASTC) {
                    vertexShaderSource += `
                            if (sphericalHarmonicsMultiTextureMode == 0) {
                                vec4 sampledSH12131415 = texture(sphericalHarmonicsTexture, getDataUV(6, 3, sphericalHarmonicsTextureSize));
                                vec4 sampledSH16171819 = texture(sphericalHarmonicsTexture, getDataUV(6, 4, sphericalHarmonicsTextureSize));
                                vec4 sampledSH20212223 = texture(sphericalHarmonicsTexture, getDataUV(6, 5, sphericalHarmonicsTextureSize));
                                sh4 = sampledSH891011.gba;
                                sh5 = sampledSH12131415.rgb;
                                sh6 = vec3(sampledSH12131415.a, sampledSH16171819.rg);
                                sh7 = vec3(sampledSH16171819.ba, sampledSH20212223.r);
                                sh8 = sampledSH20212223.gba;
                            } else {
                                vec4 sampledSH4567R = texture(sphericalHarmonicsTextureR, getDataUV(2, 1, sphericalHarmonicsTextureSize));
                                vec4 sampledSH4567G = texture(sphericalHarmonicsTextureG, getDataUV(2, 1, sphericalHarmonicsTextureSize));
                                vec4 sampledSH4567B = texture(sphericalHarmonicsTextureB, getDataUV(2, 1, sphericalHarmonicsTextureSize));
                                sh4 = vec3(sampledSH0123R.a, sampledSH4567R.rg);
                                sh5 = vec3(sampledSH4567R.ba, sampledSH0123G.a);
                                sh6 = vec3(sampledSH4567G.rgb);
                                sh7 = vec3(sampledSH4567G.a, sampledSH0123B.a, sampledSH4567B.r);
                                sh8 = vec3(sampledSH4567B.gba);
                            }
                    `;
                }

                vertexShaderSource += `
                        if (!${useASTC} && sphericalHarmonics8BitMode == 1) {
                            sh4 = sh4 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                            sh5 = sh5 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                            sh6 = sh6 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                            sh7 = sh7 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                            sh8 = sh8 * sh8BitCompressionRangeForScene + vec8BitSHShift;
                        }

                        vColor.rgb +=
                            (SH_C2[0] * xy) * sh4 +
                            (SH_C2[1] * yz) * sh5 +
                            (SH_C2[2] * (2.0 * zz - xx - yy)) * sh6 +
                            (SH_C2[3] * xz) * sh7 +
                            (SH_C2[4] * (xx - yy)) * sh8;
                    }
                `;
            }

            if (maxSphericalHarmonicsDegree >= 3) {
                vertexShaderSource += `
                    if (true) {
                        float x2 = x * x;
                        float y2 = y * y;
                        float z2 = z * z;
                        vColor.rgb +=
                            (SH_C3[0] * y * (3.0 * x2 - y2)) * sh9 +
                            (SH_C3[1] * x * y * z) * sh10 +
                            (SH_C3[2] * y * (4.0 * z2 - x2 - y2)) * sh11 +
                            (SH_C3[3] * z * (2.0 * z2 - 3.0 * x2 - 3.0 * y2)) * sh12 +
                            (SH_C3[4] * x * (4.0 * z2 - x2 - y2)) * sh13 +
                            (SH_C3[5] * z * (x2 - y2)) * sh14 +
                            (SH_C3[6] * x * (x2 - 3.0 * y2)) * sh15;
                    }
                `;
            }

            vertexShaderSource += `
                vColor.rgb = clamp(vColor.rgb, vec3(0.), vec3(1.));

            }

            `;
        }

        return vertexShaderSource;
    }

    static getVertexShaderFadeIn() {
        return `
            if (fadeInComplete == 0) {
                float opacityAdjust = 1.0;
                float centerDist = length(splatCenter - sceneCenter);
                float renderTime = max(currentTime - firstRenderTime, 0.0);

                float fadeDistance = 0.75;
                float distanceLoadFadeInFactor = step(visibleRegionFadeStartRadius, centerDist);
                distanceLoadFadeInFactor = (1.0 - distanceLoadFadeInFactor) +
                                        (1.0 - clamp((centerDist - visibleRegionFadeStartRadius) / fadeDistance, 0.0, 1.0)) *
                                        distanceLoadFadeInFactor;
                opacityAdjust *= distanceLoadFadeInFactor;
                vColor.a *= opacityAdjust;
            }
        `;
    }

    // Add the useASTC parameter to getUniforms.
    static getUniforms(dynamicMode = false, enableOptionalEffects = false, maxSphericalHarmonicsDegree = 0,
                       splatScale = 1.0, pointCloudModeEnabled = false, useASTC = false) {

        const uniforms = {
            'sceneCenter': {
                'type': 'v3',
                'value': new THREE.Vector3()
            },
            'fadeInComplete': {
                'type': 'i',
                'value': 0
            },
            'orthographicMode': {
                'type': 'i',
                'value': 0
            },
            'visibleRegionFadeStartRadius': {
                'type': 'f',
                'value': 0.0
            },
            'visibleRegionRadius': {
                'type': 'f',
                'value': 0.0
            },
            'currentTime': {
                'type': 'f',
                'value': 0.0
            },
            'firstRenderTime': {
                'type': 'f',
                'value': 0.0
            },
            'centersColorsTexture': {
                'type': 't',
                'value': null
            },
            'sphericalHarmonicsTexture': {
                'type': 't',
                'value': null
            },
            'sphericalHarmonicsTextureR': {
                'type': 't',
                'value': null
            },
            'sphericalHarmonicsTextureG': {
                'type': 't',
                'value': null
            },
            'sphericalHarmonicsTextureB': {
                'type': 't',
                'value': null
            },
            'sphericalHarmonics8BitCompressionRangeMin': {
                'type': 'f',
                'value': []
            },
            'sphericalHarmonics8BitCompressionRangeMax': {
                'type': 'f',
                'value': []
            },
            'focal': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'orthoZoom': {
                'type': 'f',
                'value': 1.0
            },
            'inverseFocalAdjustment': {
                'type': 'f',
                'value': 1.0
            },
            'viewport': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'basisViewport': {
                'type': 'v2',
                'value': new THREE.Vector2()
            },
            'debugColor': {
                'type': 'v3',
                'value': new THREE.Color()
            },
            'centersColorsTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            },
            'sphericalHarmonicsDegree': {
                'type': 'i',
                'value': maxSphericalHarmonicsDegree
            },
            'sphericalHarmonicsTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            },
            'sphericalHarmonics8BitMode': {
                'type': 'i',
                'value': 0
            },
            'sphericalHarmonicsMultiTextureMode': {
                'type': 'i',
                'value': 0
            },
            'splatScale': {
                'type': 'f',
                'value': splatScale
            },
            'pointCloudModeEnabled': {
                'type': 'i',
                'value': pointCloudModeEnabled ? 1 : 0
            },
            'sceneIndexesTexture': {
                'type': 't',
                'value': null
            },
            'sceneIndexesTextureSize': {
                'type': 'v2',
                'value': new THREE.Vector2(1024, 1024)
            },
            'sceneCount': {
                'type': 'i',
                'value': 1
            }
        };

        // Inject the ASTC uniforms.
        if (useASTC) {
            Object.assign(uniforms, {
                'astcUVTexture': { 'type': 't', 'value': null },
                'astcTextures': { 'type': 't', 'value': null }, // Texture2DArray
                'astcSingleWidth': { 'type': 'i', 'value': 0 },
                'astcSingleHeight': { 'type': 'i', 'value': 0 },
                'astcTextureWidth': { 'type': 'i', 'value': 0 },
            'astcQuantMin': { 'type': 'v3', 'value': new THREE.Vector3() },
            'astcQuantRange': { 'type': 'v3', 'value': new THREE.Vector3() },
            'astcQuantMins': { 'type': 'v3v', 'value': Array.from({ length: 15 }, () => new THREE.Vector3()) },
            'astcQuantRanges': { 'type': 'v3v', 'value': Array.from({ length: 15 }, () => new THREE.Vector3()) },
                'astcUVTextureSize': { 'type': 'v2', 'value': new THREE.Vector2(1024, 1024) }
            });
        }

        for (let i = 0; i < Constants.MaxScenes; i++) {
            uniforms.sphericalHarmonics8BitCompressionRangeMin.value.push(-Constants.SphericalHarmonics8BitCompressionRange / 2.0);
            uniforms.sphericalHarmonics8BitCompressionRangeMax.value.push(Constants.SphericalHarmonics8BitCompressionRange / 2.0);
        }

        if (enableOptionalEffects) {
            const sceneOpacity = [];
            for (let i = 0; i < Constants.MaxScenes; i++) {
                sceneOpacity.push(1.0);
            }
            uniforms['sceneOpacity'] ={
                'type': 'f',
                'value': sceneOpacity
            };

            const sceneVisibility = [];
            for (let i = 0; i < Constants.MaxScenes; i++) {
                sceneVisibility.push(1);
            }
            uniforms['sceneVisibility'] ={
                'type': 'i',
                'value': sceneVisibility
            };
        }

        if (dynamicMode) {
            const transformMatrices = [];
            for (let i = 0; i < Constants.MaxScenes; i++) {
                transformMatrices.push(new THREE.Matrix4());
            }
            uniforms['transforms'] = {
                'type': 'mat4',
                'value': transformMatrices
            };
        }

        return uniforms;
    }

}
