import * as THREE from 'three';
import { copyCoefficientMajorRgbToChannelMajor } from '../SphericalHarmonicsLayout.js';

function asTypedArray(value, Type, name) {
    if (!(value instanceof Type)) throw new Error(`UWA postprocess requires ${name} as ${Type.name}.`);
    return value;
}

/** Build compact, render-ready arrays from one decoded UWA model. */
export function processDecodedModel(data, options = {}) {
    const startedAt = performance.now();
    const sourceCount = Number.isInteger(data?.sourcePointCount) ? data.sourcePointCount :
        (Number.isInteger(data?.numPoints) ? data.numPoints : 0);
    if (sourceCount < 0) throw new Error('UWA postprocess received an invalid point count.');
    const positions = asTypedArray(data.positions, Float32Array, 'positions');
    const scales = asTypedArray(data.scales, Float32Array, 'scales');
    const rotations = asTypedArray(data.rotations, Float32Array, 'rotations');
    const colors = asTypedArray(data.colors, Uint8Array, 'colors');
    const featuresRest = data.featuresRest || null;
    const workerCompacted = data?.postprocessCompacted === true;
    const workerPointCount = Number.isInteger(data?.numPoints) ? data.numPoints : 0;
    const inputCount = workerCompacted ? workerPointCount : sourceCount;
    if (workerCompacted && (data.validPointCount !== inputCount || sourceCount < inputCount)) {
        throw new Error('UWA worker compact metadata is inconsistent with numPoints.');
    }
    if (featuresRest && featuresRest.length !== inputCount * 45) throw new Error('UWA SH array does not match numPoints.');
    if (positions.length !== inputCount * 3 || scales.length !== inputCount * 3 ||
        rotations.length !== inputCount * 4 || colors.length !== inputCount * 4) {
        throw new Error('UWA postprocess input arrays do not match numPoints.');
    }
    const minimumAlpha = Number.isFinite(options.minimumAlpha) ? options.minimumAlpha : 1;
    if (workerCompacted && data.postprocessMinimumAlpha !== minimumAlpha) {
        throw new Error('UWA worker compact threshold does not match the loader minimumAlpha value.');
    }
    const compressed = data.compressedTextureData || null;
    const sourceUvs = compressed?.uvs || null;
    if (sourceUvs && sourceUvs.length !== inputCount * 2) {
        throw new Error('UWA compressed texture UV array does not match numPoints.');
    }
    const alphaFilterStartedAt = performance.now();
    const validCount = workerCompacted ? inputCount : (() => {
        let count = 0;
        for (let i = 0; i < sourceCount; i++) if (colors[i * 4 + 3] >= minimumAlpha) count++;
        return count;
    })();
    const alphaScanMs = performance.now() - alphaFilterStartedAt;

    const arrayAllocationStartedAt = performance.now();
    const outPositions = workerCompacted ? positions : new Float32Array(validCount * 3);
    const outScales = workerCompacted ? scales : new Float32Array(validCount * 3);
    const outRotations = workerCompacted ? rotations : new Float32Array(validCount * 4);
    const outColors = workerCompacted ? colors : new Uint8Array(validCount * 4);
    const textureStrategy = options.textureStrategy || 'cpu';
    const backendRequested = options.backend || 'cpu';
    const backend = backendRequested === 'cpu' ? 'cpu' : 'cpu';
    const backendFallbackReason = backendRequested === 'cpu' ? null : `Backend ${backendRequested} is unavailable; CPU fallback used.`;
    // Compressed SH textures keep scale and rotation as GPU inputs. CPU texture
    // rendering still materializes covariance values for the legacy path.
    const outCovariances = (textureStrategy === 'cpu' || options.computeCovariances === true) ?
        new Float32Array(validCount * 6) : null;
    const outFeaturesRest = featuresRest ? (workerCompacted ? featuresRest : new Float32Array(validCount * 45)) : null;
    const outUvs = sourceUvs ? (workerCompacted ? sourceUvs : new Uint32Array(validCount * 2)) : null;
    const sceneIndexes = new Uint32Array(validCount);
    const arrayAllocationMs = performance.now() - arrayAllocationStartedAt;
    const gpuScaleRotations = data.gpuScaleRotations || null;
    if (gpuScaleRotations && (!(gpuScaleRotations instanceof Float32Array) ||
        gpuScaleRotations.length < validCount * 6 ||
        (gpuScaleRotations.length !== validCount * 6 && gpuScaleRotations.length % 4 !== 0))) {
        throw new Error('UWA GPU scale/rotation array does not match numPoints.');
    }
    const gpuCenterColors = data.gpuCenterColors || null;
    if (gpuCenterColors && (!(gpuCenterColors instanceof Uint32Array) ||
        gpuCenterColors.length < validCount * 4 || gpuCenterColors.length % 4 !== 0)) {
        throw new Error('UWA GPU center/color array does not match numPoints.');
    }
    const gpuCompressedTextureUV = data.gpuCompressedTextureUV || null;
    if (gpuCompressedTextureUV && (!(gpuCompressedTextureUV instanceof Uint32Array) ||
        gpuCompressedTextureUV.length < validCount * 4 || gpuCompressedTextureUV.length % 4 !== 0)) {
        throw new Error('UWA GPU compressed-texture UV array does not match numPoints.');
    }
    const sortCenters = outPositions;
    const copyStartedAt = performance.now();
    if (!workerCompacted) {
        let destination = 0;
        for (let source = 0; source < sourceCount; source++) {
            if (colors[source * 4 + 3] < minimumAlpha) continue;
            const srcPos = source * 3;
            const srcRot = source * 4;
            const dstPos = destination * 3;
            const dstRot = destination * 4;
            outPositions.set(positions.subarray(srcPos, srcPos + 3), dstPos);
            outScales.set(scales.subarray(srcPos, srcPos + 3), dstPos);
            outRotations.set(rotations.subarray(srcRot, srcRot + 4), dstRot);
            outColors.set(colors.subarray(srcRot, srcRot + 4), dstRot);
            if (outFeaturesRest) {
                outFeaturesRest.set(featuresRest.subarray(source * 45, source * 45 + 45), destination * 45);
            }
            if (outUvs) outUvs.set(sourceUvs.subarray(source * 2, source * 2 + 2), destination * 2);
            destination++;
        }
    }
    const attributeCopyMs = workerCompacted ? 0 : performance.now() - copyStartedAt;

    const covarianceStartedAt = outCovariances ? performance.now() : 0;
    if (outCovariances) {
        const scale = new THREE.Vector3();
        const quaternion = new THREE.Quaternion();
        const rotationMatrix = new THREE.Matrix3();
        const covarianceMatrix = new THREE.Matrix3();
        const transformedCovariance = new THREE.Matrix3();
        const matrix = new THREE.Matrix4();
        const scaleMatrix = new THREE.Matrix3();
        for (let point = 0; point < validCount; point++) {
            const positionOffset = point * 3;
            const rotationOffset = point * 4;
            scale.fromArray(outScales, positionOffset);
            // UWA reconstruction stores quaternion components as w,x,y,z.
            quaternion.set(outRotations[rotationOffset + 1], outRotations[rotationOffset + 2],
                           outRotations[rotationOffset + 3], outRotations[rotationOffset]).normalize();
            rotationMatrix.setFromMatrix4(matrix.makeRotationFromQuaternion(quaternion));
            scaleMatrix.set(scale.x, 0, 0, 0, scale.y, 0, 0, 0, scale.z);
            covarianceMatrix.copy(rotationMatrix).multiply(scaleMatrix);
            transformedCovariance.copy(covarianceMatrix).transpose().premultiply(covarianceMatrix);
            const e = transformedCovariance.elements;
            const covarianceBase = point * 6;
            outCovariances[covarianceBase] = e[0];
            outCovariances[covarianceBase + 1] = e[3];
            outCovariances[covarianceBase + 2] = e[6];
            outCovariances[covarianceBase + 3] = e[4];
            outCovariances[covarianceBase + 4] = e[7];
            outCovariances[covarianceBase + 5] = e[8];
        }
    }
    const covarianceComputeMs = outCovariances ? performance.now() - covarianceStartedAt : 0;
    const sourceArrayBytes = positions.byteLength + scales.byteLength + rotations.byteLength + colors.byteLength +
        (featuresRest?.byteLength || 0) + (sourceUvs?.byteLength || 0);
    const outputArrayBytes = outPositions.byteLength + outScales.byteLength + outRotations.byteLength +
        outColors.byteLength + (outFeaturesRest?.byteLength || 0) + (outUvs?.byteLength || 0) +
        (outCovariances?.byteLength || 0) + (gpuScaleRotations?.byteLength || 0) +
        (gpuCenterColors?.byteLength || 0) + (gpuCompressedTextureUV?.byteLength || 0) + validCount * 4;

    const result = {
        isUwaPostprocessResult: true,
        numPoints: validCount,
        count: validCount,
        positions: outPositions,
        centers: outPositions,
        sortCenters,
        scales: outScales,
        rotations: outRotations,
        colors: outColors,
        gpuScaleRotations,
        gpuCenterColors,
        gpuCompressedTextureUV,
        featuresRest: outFeaturesRest,
        covariances: outCovariances,
        backend,
        backendRequested,
        backendFallbackReason,
        sceneIndexes,
        shDegree: data.shDegree,
        compressedTextureData: compressed ? { ...compressed, uvs: outUvs } : null,
        uwaPostprocessTimings: {
            sourceCount,
            validCount,
            alphaFilterMs: alphaScanMs,
            alphaScanMs,
            covarianceComputeMs,
            positionScaleRotationColorUvCopyMs: attributeCopyMs,
            attributeCopyMs,
            gpuInputPackMs: data.timings?.wall?.gpuInputPackMs || 0,
            workerGpuTexturePackMs: data.timings?.wall?.gpuTexturePackMs || 0,
            arrayAllocationMs,
            sourceArrayBytes,
            outputArrayBytes,
            compactionDroppedCount: sourceCount - validCount,
            arrayBuildMs: performance.now() - startedAt,
            totalMs: performance.now() - startedAt,
            workerCompacted
        }
    };
    return result;
}

/** Lightweight SplatBuffer-compatible view used by SplatMesh's existing scene API. */
export class UwaPostprocessSplatBuffer {
    static attachResult(result) {
        if (!result || !result.isUwaPostprocessResult) throw new Error('Invalid UWA postprocess result.');
        if (!(result instanceof UwaPostprocessSplatBuffer)) {
            Object.setPrototypeOf(result, UwaPostprocessSplatBuffer.prototype);
            UwaPostprocessSplatBuffer.prototype.initializeResult.call(result, result);
        }
        return result;
    }
    initializeResult(result) {
        this.uwaPostprocessResult = result;
        this.numPoints = result.numPoints;
        this.splatCount = result.numPoints;
        this.maxSplatCount = result.numPoints;
        this.compressionLevel = 0;
        this.sceneCenter = new THREE.Vector3();
        this.sections = [];
        this.globalSplatIndexToSectionMap = [];
        this.minSphericalHarmonicsCoeff = result.compressedTextureData?.shnMin ?? 0;
        this.maxSphericalHarmonicsCoeff = result.compressedTextureData?.shnMax ?? 1;
        this.compressedTextureData = result.compressedTextureData;
        this.astcData = this.compressedTextureData?.format === 'astc' ? this.compressedTextureData : undefined;
        this.hasCompressedTexture = !!this.compressedTextureData;
        this.hasAstc = !!this.astcData;
        this.directCompressedTextureData = this.compressedTextureData ? {
            positions: result.positions, scales: result.scales, rotations: result.rotations,
            colors: result.colors, uvs: result.compressedTextureData.uvs, covariances: result.covariances,
            gpuScaleRotations: result.gpuScaleRotations || null,
            gpuCenterColors: result.gpuCenterColors || null,
            gpuCompressedTextureUV: result.gpuCompressedTextureUV || null
        } : null;
        this.directUwaPostprocessResult = result;
    }
    constructor(result) {
        this.initializeResult(result);
    }
    getSplatCount() {
 return this.splatCount;
}
    getMaxSplatCount() {
 return this.maxSplatCount;
}
    getMinSphericalHarmonicsDegree() {
 return Number.isInteger(this.uwaPostprocessResult.shDegree) ? this.uwaPostprocessResult.shDegree : 0;
}
    getSplatCenter(index, outCenter, transform) {
        outCenter.fromArray(this.uwaPostprocessResult.positions, index * 3);
        if (transform) outCenter.applyMatrix4(transform);
    }
    getSplatScaleAndRotation(index, outScale, outRotation, transform) {
        outScale.fromArray(this.uwaPostprocessResult.scales, index * 3);
        const base = index * 4;
        outRotation.set(this.uwaPostprocessResult.rotations[base + 1], this.uwaPostprocessResult.rotations[base + 2],
                        this.uwaPostprocessResult.rotations[base + 3], this.uwaPostprocessResult.rotations[base]).normalize();
        if (transform) {
            const scaleMatrix = new THREE.Matrix4().makeScale(outScale.x, outScale.y, outScale.z);
            const rotationMatrix = new THREE.Matrix4().makeRotationFromQuaternion(outRotation);
            const combined = scaleMatrix.multiply(rotationMatrix).multiply(transform);
            combined.decompose(new THREE.Vector3(), outRotation, outScale);
        }
    }
    getSplatColor(index, outColor) {
 outColor.fromArray(this.uwaPostprocessResult.colors, index * 4);
}
    fillSplatCenterArray(out, transform, srcFrom = 0, srcTo = this.splatCount - 1, destFrom = srcFrom) {
        const center = new THREE.Vector3();
        for (let i = srcFrom; i <= srcTo; i++) {
            this.getSplatCenter(i, center, transform);
            out.set([center.x, center.y, center.z], (destFrom + i - srcFrom) * 3);
        }
    }
    fillSplatColorArray(out, _minimumAlpha, srcFrom = 0, srcTo = this.splatCount - 1, destFrom = srcFrom) {
        out.set(this.uwaPostprocessResult.colors.subarray(srcFrom * 4, (srcTo + 1) * 4), destFrom * 4);
    }
    fillSplatScaleRotationArray(outScales, outRotations, transform, srcFrom = 0, srcTo = this.splatCount - 1, destFrom = srcFrom) {
        const scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        for (let i = srcFrom; i <= srcTo; i++) {
            this.getSplatScaleAndRotation(i, scale, rotation, transform);
            const dst = (destFrom + i - srcFrom) * 3;
            outScales.set([scale.x, scale.y, scale.z], dst);
            const q = (destFrom + i - srcFrom) * 4;
            outRotations.set([rotation.x, rotation.y, rotation.z, rotation.w], q);
        }
    }
    fillSplatCovarianceArray(out, transform, srcFrom = 0, srcTo = this.splatCount - 1, destFrom = srcFrom) {
        if (!this.uwaPostprocessResult.covariances) return;
        if (!transform) {
            out.set(this.uwaPostprocessResult.covariances.subarray(srcFrom * 6, (srcTo + 1) * 6), destFrom * 6);
            return;
        }
        const a = transform.elements;
        for (let i = srcFrom; i <= srcTo; i++) {
            const s = i * 6;
            const c00 = this.uwaPostprocessResult.covariances[s];
            const c01 = this.uwaPostprocessResult.covariances[s + 1];
            const c02 = this.uwaPostprocessResult.covariances[s + 2];
            const c11 = this.uwaPostprocessResult.covariances[s + 3];
            const c12 = this.uwaPostprocessResult.covariances[s + 4];
            const c22 = this.uwaPostprocessResult.covariances[s + 5];
            const m00 = a[0];
            const m01 = a[4];
            const m02 = a[8];
            const m10 = a[1];
            const m11 = a[5];
            const m12 = a[9];
            const m20 = a[2];
            const m21 = a[6];
            const m22 = a[10];
            const t00 = c00 * m00 + c01 * m10 + c02 * m20;
            const t01 = c00 * m01 + c01 * m11 + c02 * m21;
            const t02 = c00 * m02 + c01 * m12 + c02 * m22;
            const t10 = c01 * m00 + c11 * m10 + c12 * m20;
            const t11 = c01 * m01 + c11 * m11 + c12 * m21;
            const t12 = c01 * m02 + c11 * m12 + c12 * m22;
            const t20 = c02 * m00 + c12 * m10 + c22 * m20;
            const t21 = c02 * m01 + c12 * m11 + c22 * m21;
            const t22 = c02 * m02 + c12 * m12 + c22 * m22;
            const d = (destFrom + i - srcFrom) * 6;
            out[d] = m00 * t00 + m10 * t10 + m20 * t20;
            out[d + 1] = m00 * t01 + m10 * t11 + m20 * t21;
            out[d + 2] = m00 * t02 + m10 * t12 + m20 * t22;
            out[d + 3] = m01 * t01 + m11 * t11 + m21 * t21;
            out[d + 4] = m01 * t02 + m11 * t12 + m21 * t22;
            out[d + 5] = m02 * t02 + m12 * t12 + m22 * t22;
        }
    }
    fillSphericalHarmonicsArray(out, degree, _transform, srcFrom = 0, srcTo = this.splatCount - 1, destFrom = srcFrom) {
        if (!this.uwaPostprocessResult.featuresRest || !out || degree <= 0) return;
        const count = degree === 1 ? 9 : (degree === 2 ? 24 : 45);
        const scratch = new Float32Array(14 + count);
        for (let i = srcFrom; i <= srcTo; i++) {
            const src = i * 45;
            const dst = (destFrom + i - srcFrom) * count;
            copyCoefficientMajorRgbToChannelMajor(this.uwaPostprocessResult.featuresRest, src, scratch, 14, count);
            out.set(scratch.subarray(14, 14 + count), dst);
        }
    }
}

export default processDecodedModel;
