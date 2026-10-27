// EGSC stores coefficient-major RGB, matching the compressed texture regions.
export const SH_QUANTIZATION_COMPONENTS = 45;
export const SH_QUANTIZATION_EPSILON = 1e-6;

export function resolveRenderShDegree(sourceDegree, requestedDegree) {
    const requested = Number.isInteger(requestedDegree) ? requestedDegree : sourceDegree;
    return Math.max(0, Math.min(3, sourceDegree, requested));
}

export function buildShQuantizationUniforms(mins, maxs, shDegree) {
    const required = ((shDegree + 1) ** 2 - 1) * 3;
    if (!Number.isInteger(shDegree) || shDegree < 0 || shDegree > 3 ||
        !(mins instanceof Float32Array) || !(maxs instanceof Float32Array) ||
        mins.length !== maxs.length ||
        !(mins.length === 1 || [9, 24, 45].includes(mins.length) && mins.length >= required)) {
        throw new Error('Missing or invalid per-channel SH quantization ranges; rebuild the coordinator WASM.');
    }
    const min = new Float32Array(SH_QUANTIZATION_COMPONENTS);
    const range = new Float32Array(SH_QUANTIZATION_COMPONENTS);
    for (let i = 0; i < mins.length; i++) {
        if (!Number.isFinite(mins[i]) || !Number.isFinite(maxs[i]) || maxs[i] < mins[i]) {
            throw new Error(`Invalid SH quantization range at component ${i}.`);
        }
    }
    for (let i = 0; i < required; i++) {
        const source = mins.length === 1 ? 0 : i;
        min[i] = mins[source];
        // Match Quantizer::dequantizeMinMax, including its epsilon.
        range[i] = maxs[source] - mins[source] + SH_QUANTIZATION_EPSILON;
    }
    return { min, range };
}

export function readShQuantizationRanges(module, prepared) {
    const read = (ptr, count) => {
        if (!Number.isInteger(ptr) || ptr <= 0 || ptr % 4 !== 0 ||
            !Number.isInteger(count) || count <= 0 || count > SH_QUANTIZATION_COMPONENTS ||
            ptr + count * 4 > module.HEAPF32.byteLength) {
            throw new Error('Coordinator has no valid per-channel SH ranges; rebuild the coordinator WASM.');
        }
        // Copy before coordinator.release() or any heap growth.
        return module.HEAPF32.slice(ptr / 4, ptr / 4 + count);
    };
    const shnMins = read(prepared.shnMinsPtr, prepared.shnMinsCount);
    const shnMaxs = read(prepared.shnMaxsPtr, prepared.shnMaxsCount);
    buildShQuantizationUniforms(shnMins, shnMaxs, prepared.shDegree);
    return { shnMins, shnMaxs };
}
