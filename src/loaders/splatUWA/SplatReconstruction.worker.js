import createSplatUWAReconstructionWasm from './splat_uwa_reconstruction_wasm.js';

const RECONSTRUCTION_MODULE_BODY_START_ABS_MS = absoluteNowMs();
const RECONSTRUCTION_CLOCK_METHOD = absoluteClockMethod();

const PROTOCOL_VERSION = 2;
const BUILD_VERSION = 20260909;
const RECONSTRUCTION_WASM_URL = new URL('./splat_uwa_reconstruction_wasm.wasm', import.meta.url).href;

let wasmModule = null;
let wasmModulePromise = null;
let kernel = null;
let workerId = -1;
let activeModelId = 0;
let activeRequestId = 0;
let canceledModelId = 0;
let wasmModuleSource = 'worker-self-load';
let wasmModuleFallbackReason = null;

function absoluteNowMs() {
    // Worker performance.timeOrigin is not consistently aligned with the
    // coordinator realm on mobile browsers (some builds report a different
    // navigation origin). Date.now() is the shared wall clock across realms,
    // so use it for all cross-thread trace endpoints.
    return Date.now();
}

function absoluteClockMethod() {
    return 'Date.now';
}

function roundTimingMs(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.round(Math.max(0, value) * 100) / 100;
}

function getResourceTiming(resourceUrl) {
    try {
        if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') return null;
        const entries = performance.getEntriesByName(resourceUrl, 'resource');
        const entry = entries.length > 0 ? entries[entries.length - 1] : null;
        if (!entry || entry.entryType !== 'resource') return null;
        const timeOriginMs = Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null;
        const absolute = (value) => Number.isFinite(timeOriginMs) && Number.isFinite(value) ?
            timeOriginMs + value : null;
        return {
            url: entry.name || resourceUrl,
            initiatorType: entry.initiatorType || '',
            nextHopProtocol: entry.nextHopProtocol || '',
            timeOriginMs,
            startTimeAbsMs: absolute(entry.startTime),
            fetchStartAbsMs: absolute(entry.fetchStart),
            responseStartAbsMs: absolute(entry.responseStart),
            responseEndAbsMs: absolute(entry.responseEnd),
            durationMs: Number.isFinite(entry.duration) ? entry.duration : null,
            transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
            encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
            decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null
        };
    } catch (_) {
        return null;
    }
}

function assertProtocol(message) {
    if (message.protocolVersion !== PROTOCOL_VERSION || message.buildVersion !== BUILD_VERSION) {
        throw new Error(`Shard protocol/build mismatch: ${message.protocolVersion}/${message.buildVersion}`);
    }
}

function moduleFactoryOptions() {
    return {
        locateFile: (path) => path.endsWith('.wasm') ? RECONSTRUCTION_WASM_URL : path,
        print: (text) => console.log(`[SplatUWA shard ${workerId}]`, text),
        printErr: (text) => console.error(`[SplatUWA shard ${workerId}]`, text)
    };
}

function instantiatePrecompiledModule(precompiledModule) {
    return (imports, receiveInstance) => {
        const instance = new WebAssembly.Instance(precompiledModule, imports);
        receiveInstance(instance);
        return instance.exports;
    };
}

async function initializeWasmModule(precompiledModule) {
    const canUsePrecompiledModule = precompiledModule instanceof WebAssembly.Module;
    if (canUsePrecompiledModule) {
        try {
            wasmModule = await createSplatUWAReconstructionWasm({
                ...moduleFactoryOptions(),
                instantiateWasm: instantiatePrecompiledModule(precompiledModule)
            });
            wasmModuleSource = 'shared-compiled-module';
        } catch (error) {
            wasmModuleFallbackReason = error?.message || String(error);
            wasmModule = await createSplatUWAReconstructionWasm(moduleFactoryOptions());
            wasmModuleSource = 'worker-self-load-instantiation-fallback';
        }
    } else {
        wasmModule = await createSplatUWAReconstructionWasm(moduleFactoryOptions());
        wasmModuleSource = 'worker-self-load';
    }
    kernel = new wasmModule.SplatUWAReconstructionWasm();
    return wasmModule;
}

function getWasmModule(precompiledModule = null) {
    if (wasmModule) return Promise.resolve(wasmModule);
    if (wasmModulePromise) return wasmModulePromise;

    let trackedPromise;
    trackedPromise = initializeWasmModule(precompiledModule).finally(() => {
        if (wasmModulePromise === trackedPromise) wasmModulePromise = null;
    });
    wasmModulePromise = trackedPromise;
    return trackedPromise;
}

function buildError(error, stage, message) {
    return {
        name: error?.name,
        message: error?.message || String(error),
        stack: error?.stack,
        stage,
        workerId,
        modelId: message?.modelId,
        requestId: message?.requestId,
        shardId: message?.shardId,
        startBlock: message?.startBlock,
        blockCount: message?.blockCount,
        startPoint: message?.startPoint,
        pointCount: message?.pointCount
    };
}

async function initializeModel(message) {
    assertProtocol(message);
    const Module = await getWasmModule();
    if (!(message.metadata instanceof ArrayBuffer) || message.metadata.byteLength === 0) {
        throw new Error('Shard model initialization requires standalone metadata bytes.');
    }

    kernel.dispose();
    const metadata = new Uint8Array(message.metadata);
    const metadataPtr = Module._malloc(metadata.byteLength);
    if (!metadataPtr) throw new Error(`Failed to allocate ${metadata.byteLength} metadata bytes.`);
    try {
        Module.HEAPU8.set(metadata, metadataPtr);
        if (!kernel.initialize(metadataPtr, metadata.byteLength)) {
            throw new Error(kernel.getLastError() || 'Reconstruction metadata initialization failed.');
        }
    } finally {
        Module._free(metadataPtr);
    }

    activeModelId = message.modelId;
    activeRequestId = message.requestId;
    canceledModelId = 0;
    self.postMessage({
        type: 'modelReady',
        protocolVersion: PROTOCOL_VERSION,
        buildVersion: BUILD_VERSION,
        workerId,
        modelId: activeModelId,
        requestId: activeRequestId
    });
}

async function reconstructShard(message, handlerReceiveAbsMs) {
    assertProtocol(message);
    if (message.modelId !== activeModelId || message.requestId !== activeRequestId ||
        message.modelId === canceledModelId) {
        return;
    }
    if (!(message.packet instanceof ArrayBuffer) || message.packet.byteLength === 0) {
        throw new Error('Shard reconstruction requires a standalone packet buffer.');
    }

    const workerReceiveAbsMs = Number.isFinite(handlerReceiveAbsMs) ? handlerReceiveAbsMs : absoluteNowMs();
    const traceEnabled = message.reconstructionTraceLevel === 'js';
    const Module = await getWasmModule();
    const packet = new Uint8Array(message.packet);
    const wasmInputCopyBeginAbsMs = traceEnabled ? absoluteNowMs() : undefined;
    const packetPtr = Module._malloc(packet.byteLength);
    if (!packetPtr) throw new Error(`Failed to allocate ${packet.byteLength} shard packet bytes.`);

    let result;
    const wasmCopyStartedAt = performance.now();
    let kernelCallBeginAbsMs;
    let kernelCallEndAbsMs;
    try {
        Module.HEAPU8.set(packet, packetPtr);
        if (traceEnabled) kernelCallBeginAbsMs = absoluteNowMs();
        result = kernel.reconstruct(packetPtr, packet.byteLength);
        if (traceEnabled) kernelCallEndAbsMs = absoluteNowMs();
    } finally {
        Module._free(packetPtr);
    }
    const wasmCopyAndKernelMs = performance.now() - wasmCopyStartedAt;

    if (!result.success) {
        throw new Error(kernel.getLastError() || 'Reconstruction kernel rejected the shard.');
    }
    if (result.startBlock !== message.startBlock || result.blockCount !== message.blockCount ||
        result.startPoint !== message.startPoint || result.pointCount !== message.pointCount) {
        kernel.releaseResult();
        throw new Error('Reconstruction kernel returned a mismatched shard range.');
    }

    const copyStartedAt = performance.now();
    const resultCopyBeginAbsMs = traceEnabled ? absoluteNowMs() : undefined;
    const positions = new Float32Array(Module.HEAPF32.buffer, result.positionsPtr, result.pointCount * 3).slice();
    const scales = new Float32Array(Module.HEAPF32.buffer, result.scalesPtr, result.pointCount * 3).slice();
    const rotations = new Float32Array(Module.HEAPF32.buffer, result.rotationsPtr, result.pointCount * 4).slice();
    const colors = new Uint8Array(Module.HEAPU8.buffer, result.colorsPtr, result.pointCount * 4).slice();
    const validity = new Uint8Array(Module.HEAPU8.buffer, result.validityPtr, result.pointCount).slice();
    const featuresRest = result.featuresRestCount > 0 ?
        new Float32Array(Module.HEAPF32.buffer, result.featuresRestPtr, result.featuresRestCount).slice() : null;
    const resultCopyMs = performance.now() - copyStartedAt;
    const resultCopyEndAbsMs = traceEnabled ? absoluteNowMs() : undefined;
    kernel.releaseResult();

    if (message.modelId !== activeModelId || message.modelId === canceledModelId) return;

    const transferList = [
        positions.buffer,
        scales.buffer,
        rotations.buffer,
        colors.buffer,
        validity.buffer
    ];
    if (featuresRest) transferList.push(featuresRest.buffer);

    const trace = traceEnabled ? {
        ...(message.trace || {}),
        workerId,
        modelId: message.modelId,
        requestId: message.requestId,
        shardId: message.shardId,
        startBlock: message.startBlock,
        blockCount: message.blockCount,
        startPoint: message.startPoint,
        pointCount: message.pointCount,
        workerReceiveAbsMs,
        wasmInputCopyBeginAbsMs,
        kernelCallBeginAbsMs,
        kernelCallEndAbsMs,
        resultCopyBeginAbsMs,
        resultCopyEndAbsMs
    } : undefined;

    const response = {
        type: 'shardResult',
        protocolVersion: PROTOCOL_VERSION,
        buildVersion: BUILD_VERSION,
        workerId,
        modelId: message.modelId,
        requestId: message.requestId,
        shardId: message.shardId,
        startBlock: result.startBlock,
        blockCount: result.blockCount,
        startPoint: result.startPoint,
        pointCount: result.pointCount,
        positions,
        scales,
        rotations,
        colors,
        validity,
        featuresRest,
        ...(trace ? { trace } : {}),
        timings: {
            queueWaitMs: Number.isFinite(message.dispatchAbsMs) && Number.isFinite(workerReceiveAbsMs) ?
                Math.max(0, workerReceiveAbsMs - message.dispatchAbsMs) : 0,
            wasmCopyAndKernelMs,
            resultCopyMs,
            packetParseMs: result.packetParseMs,
            predictionMs: result.predictionMs,
            dequantizeMs: result.dequantizeMs,
            transformMs: result.transformMs,
            nonlinearMs: result.nonlinearMs,
            outputCopyMs: result.outputCopyMs,
            kernelTotalMs: result.totalMs
        }
    };
    if (trace) trace.resultPostBeginAbsMs = absoluteNowMs();
    response.resultPostedAbsMs = absoluteNowMs();
    self.postMessage(response, transferList);
}

self.onmessage = async (event) => {
    const handlerReceiveAbsMs = absoluteNowMs();
    const message = event.data || {};
    let stage = message.type || 'unknown';
    let initWarmupTrace = null;
    try {
        if (message.type === 'init') {
            assertProtocol(message);
            workerId = message.workerId;
            initWarmupTrace = {
                clockMethod: RECONSTRUCTION_CLOCK_METHOD,
                moduleBodyStartAbsMs: RECONSTRUCTION_MODULE_BODY_START_ABS_MS,
                moduleBodyMeaning: 'first module-body point after static imports; excludes static import internals',
                initHandlerReceiveAbsMs: handlerReceiveAbsMs,
                wasmInitBeginAbsMs: absoluteNowMs(),
                wasmInitEndAbsMs: undefined,
                readyPostBeginAbsMs: undefined
            };
            const startedAt = performance.now();
            await getWasmModule(message.reconstructionWasmModule);
            initWarmupTrace.wasmInitEndAbsMs = absoluteNowMs();
            const moduleInitMs = performance.now() - startedAt;
            const response = {
                type: 'ready',
                protocolVersion: PROTOCOL_VERSION,
                buildVersion: BUILD_VERSION,
                workerId,
                moduleInitMs: roundTimingMs(moduleInitMs),
                moduleSource: wasmModuleSource,
                moduleFallbackReason: message.moduleCloneFallbackReason || wasmModuleFallbackReason,
                resourceTiming: getResourceTiming(RECONSTRUCTION_WASM_URL),
                startupAttemptId: message.startupAttemptId,
                warmupTrace: initWarmupTrace
            };
            initWarmupTrace.readyPostBeginAbsMs = absoluteNowMs();
            self.postMessage(response);
        } else if (message.type === 'beginModel') {
            stage = 'initializeModel';
            await initializeModel(message);
        } else if (message.type === 'reconstructShard') {
            stage = 'reconstructShard';
            await reconstructShard(message, handlerReceiveAbsMs);
        } else if (message.type === 'cancelModel') {
            assertProtocol(message);
            canceledModelId = message.modelId;
            if (activeModelId === message.modelId) {
                activeModelId = 0;
                activeRequestId = 0;
                kernel?.dispose();
            }
        } else if (message.type === 'dispose') {
            kernel?.dispose();
            kernel?.delete();
            kernel = null;
            wasmModule = null;
            wasmModulePromise = null;
            activeModelId = 0;
            activeRequestId = 0;
            self.close();
        } else {
            throw new Error(`Unknown reconstruction worker message type: ${message.type}`);
        }
    } catch (error) {
        const details = buildError(error, stage, message);
        self.postMessage({
            type: 'workerError',
            protocolVersion: PROTOCOL_VERSION,
            buildVersion: BUILD_VERSION,
            workerId,
            modelId: message.modelId,
            requestId: message.requestId,
            shardId: message.shardId,
            error: details.message,
            details,
            ...(initWarmupTrace ? { warmupTrace: initWarmupTrace } : {})
        });
    }
};
