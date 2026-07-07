import createSplatUWAWasm from './splat_uwa_wasm.js';
import {
    classifyWebCodecsFastPath,
    createWebCodecsCapabilityKey,
    decodeVideoStreamWithWebCodecs,
    isWebCodecsNegativeCapabilityError,
    videoBufferByteLength
} from './WebCodecsVideoDecoder.js';
import {
    getWebCodecsCapabilityCanary,
    WEB_CODECS_CANARY_DESCRIPTOR
} from './WebCodecsCapabilityCanary.js';
import {
    normalizeTextureStrategyChain,
    normalizeTextureStrategy,
    TextureBuildCapabilities,
    TextureStrategy,
    textureStrategyToNativeMode
} from './TextureStrategy.js';

const DECODER_MODULE_BODY_START_ABS_MS = absoluteNowMs();
const DECODER_CLOCK_METHOD = absoluteClockMethod();

const PROTOCOL_VERSION = 2;
const BUILD_VERSION = 20260909;
const WEB_CODECS_PREFLIGHT_TIMEOUT_MS = 5000;
const WEB_CODECS_PHASE_TIMEOUT_MS = 20000;
const WEB_CODECS_FAST_PATH_SCOPE = 'hevc-main-8bit-420';
const SHARD_WORKER_COUNT = 2;
let configuredShardWorkerCount = SHARD_WORKER_COUNT;
const GPU_BLOCKS_PER_SHARD = 64;
const CPU_BLOCKS_PER_SHARD = 16;
const MAX_ADAPTIVE_SHARD_MULTIPLIER = 4;
const MODEL_TIMEOUT_MS = 60000;
const SHARD_TIMEOUT_MS = 20000;
const CONTROL_TIMEOUT_MS = 15000;
const MAX_RECONSTRUCTION_TRACE_TASKS = 512;
const MAX_PREVIEW_POINTS = 65536;
const MAX_PENDING_PACKETS = 2;
const MAX_PENDING_PACKET_BYTES = 32 * 1024 * 1024;
const COORDINATOR_WASM_URL = new URL('./splat_uwa_wasm.wasm', import.meta.url).href;
const PTHREAD_COORDINATOR_JS_URL = new URL('./splat_uwa_wasm_pthread.js', import.meta.url);
const PTHREAD_COORDINATOR_WASM_URL = new URL('./splat_uwa_wasm_pthread.wasm', import.meta.url).href;
const RECONSTRUCTION_WASM_URL = new URL('./splat_uwa_reconstruction_wasm.wasm', import.meta.url).href;

let coordinatorModule = null;
let coordinatorModulePromise = null;
let coordinator = null;
let reconstructionModulePreparation = null;
let reconstructionModulePreparationPromise = null;
let shardPool = [];
let decoderSessionPrewarmPromise = null;
let decoderSessionGeneration = 0;
let decoderSessionActive = true;
let activeWarmupProgress = null;
let activePreparation = null;
let activeModel = null;
let nextModelId = 1;
let nextShardStartupAttemptId = 1;
let verboseLog = false;
let coordinatorWasmUrl = COORDINATOR_WASM_URL;
let coordinatorFlavor = 'single-thread';
let coordinatorTextureBuildCapabilities = { ...TextureBuildCapabilities };
let pthreadFallbackLogged = false;
let webCodecsSessionPolicy = null;
let webCodecsSessionPolicyPromise = null;
let webCodecsProbeAbortController = null;
let webCodecsProbeStatus = 'not-started';
let webCodecsProbeStartedAt = 0;
const webCodecsNegativeCapabilities = new Set();

// These views are local to the coordinator worker and are used only for the
// exact IEEE-754 bit representation consumed by the center/color shader
// texture. The worker cannot import Util.js because it is also deployed as a
// standalone worker module.
const gpuPackFloatView = new Float32Array(1);
const gpuPackUintView = new Uint32Array(gpuPackFloatView.buffer);

function uintEncodedFloatForGpuPack(value) {
    gpuPackFloatView[0] = value;
    return gpuPackUintView[0];
}

function rgbaArrayToUintForGpuPack(array, offset) {
    return (array[offset] |
        (array[offset + 1] << 8) |
        (array[offset + 2] << 16) |
        (array[offset + 3] << 24)) >>> 0;
}

function gpuTexturePackedArrayLength(pointCount) {
    if (!Number.isSafeInteger(pointCount) || pointCount < 0) return null;
    if (pointCount === 0) return 0;
    const width = 4096;
    let height = 1;
    while (width * height < pointCount) {
        height *= 2;
        if (!Number.isSafeInteger(height) || width * height > Number.MAX_SAFE_INTEGER / 4) return null;
    }
    const capacity = width * height;
    if (capacity / pointCount > 1.25) {
        const compactLength = pointCount * 4;
        return Number.isSafeInteger(compactLength) ? compactLength : null;
    }
    const arrayLength = capacity * 4;
    return Number.isSafeInteger(arrayLength) ? arrayLength : null;
}

function gpuScaleRotationPackedArrayLength(pointCount) {
    if (!Number.isSafeInteger(pointCount) || pointCount < 0) return null;
    if (pointCount === 0) return 0;
    const elementsPerSplat = 6;
    const elementsPerTexel = 4;
    const requiredElements = pointCount * elementsPerSplat;
    if (!Number.isSafeInteger(requiredElements)) return null;
    const requiredTexels = Math.ceil(requiredElements / elementsPerTexel);
    const width = 4096;
    let height = 1;
    while (width * height < requiredTexels) {
        height *= 2;
        if (!Number.isSafeInteger(height) || width * height > Number.MAX_SAFE_INTEGER / elementsPerTexel) {
            return null;
        }
    }
    const capacityElements = width * height * elementsPerTexel;
    const paddedBytes = capacityElements * Float32Array.BYTES_PER_ELEMENT;
    const paddedRatio = capacityElements / requiredElements;
    if (paddedRatio <= 1.5 && paddedBytes <= 64 * 1024 * 1024 && Number.isSafeInteger(capacityElements)) {
        return capacityElements;
    }
    return Number.isSafeInteger(requiredElements) ? requiredElements : null;
}

function absoluteNowMs() {
    try {
        const timeOrigin = performance.timeOrigin;
        const now = performance.now();
        const absolute = timeOrigin + now;
        if (Number.isFinite(timeOrigin) && Number.isFinite(now) && Number.isFinite(absolute)) return absolute;
    } catch (_) {}
    const fallback = Date.now();
    return fallback;
}

function absoluteClockMethod() {
    try {
        const timeOrigin = performance.timeOrigin;
        const now = performance.now();
        if (Number.isFinite(timeOrigin) && Number.isFinite(now) && Number.isFinite(timeOrigin + now)) {
            return 'performance.timeOrigin+performance.now';
        }
    } catch (_) {}
    return 'Date.now';
}

function roundTimingMs(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.round(Math.max(0, value) * 100) / 100;
}

function addTimelineEvent(timings, id, startAbsMs, endAbsMs, lane = 'decoder-coordinator') {
    if (!timings || !Number.isFinite(startAbsMs) || !Number.isFinite(endAbsMs) || endAbsMs < startAbsMs) return;
    if (!Array.isArray(timings.timelineEvents)) timings.timelineEvents = [];
    timings.timelineEvents.push({
        id: `coordinator.${id}`,
        lane,
        task: id,
        startAbsMs,
        endAbsMs,
        durationMs: endAbsMs - startAbsMs,
        source: 'SplatDecoder.worker.js',
        evidence: 'measured'
    });
}

function sessionDisposedError() {
    return new Error('SplatUWA decoder session was disposed.');
}

function isDecoderSessionActive(generation = decoderSessionGeneration) {
    return decoderSessionActive && generation === decoderSessionGeneration;
}

function assertDecoderSessionActive(generation = decoderSessionGeneration) {
    if (!isDecoderSessionActive(generation)) throw sessionDisposedError();
}

function normalizeResourceTiming(timing) {
    if (!timing || typeof timing !== 'object') return null;
    const finiteOrNull = (value) => Number.isFinite(value) ? value : null;
    return {
        url: typeof timing.url === 'string' ? timing.url : '',
        initiatorType: typeof timing.initiatorType === 'string' ? timing.initiatorType : '',
        nextHopProtocol: typeof timing.nextHopProtocol === 'string' ? timing.nextHopProtocol : '',
        timeOriginMs: finiteOrNull(timing.timeOriginMs),
        startTimeAbsMs: finiteOrNull(timing.startTimeAbsMs),
        fetchStartAbsMs: finiteOrNull(timing.fetchStartAbsMs),
        responseStartAbsMs: finiteOrNull(timing.responseStartAbsMs),
        responseEndAbsMs: finiteOrNull(timing.responseEndAbsMs),
        durationMs: finiteOrNull(timing.durationMs),
        transferSize: finiteOrNull(timing.transferSize),
        encodedBodySize: finiteOrNull(timing.encodedBodySize),
        decodedBodySize: finiteOrNull(timing.decodedBodySize)
    };
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
        return normalizeResourceTiming({
            url: entry.name || resourceUrl,
            initiatorType: entry.initiatorType,
            nextHopProtocol: entry.nextHopProtocol,
            timeOriginMs,
            startTimeAbsMs: absolute(entry.startTime),
            fetchStartAbsMs: absolute(entry.fetchStart),
            responseStartAbsMs: absolute(entry.responseStart),
            responseEndAbsMs: absolute(entry.responseEnd),
            durationMs: entry.duration,
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize
        });
    } catch (_) {
        return null;
    }
}

function assertProtocol(message) {
    if (message.protocolVersion !== PROTOCOL_VERSION || message.buildVersion !== BUILD_VERSION) {
        throw new Error(`Worker protocol/build mismatch: ${message.protocolVersion}/${message.buildVersion}`);
    }
}

function extractUwaCompressedPayload(arrayBuffer) {
    const dataView = new DataView(arrayBuffer);
    const GLB_MAGIC = 0x46546c67;
    const JSON_CHUNK = 0x4e4f534a;
    const BIN_CHUNK = 0x004e4942;
    if (dataView.byteLength < 20 || dataView.getUint32(0, true) !== GLB_MAGIC) {
        return { bytes: new Uint8Array(arrayBuffer), compressedPayload: false, reason: 'raw GSBS payload' };
    }
    if (dataView.getUint32(4, true) !== 2) throw new Error('Only GLB version 2 is supported.');

    let offset = 12;
    let json = null;
    let binOffset = 0;
    let binLength = 0;
    while (offset + 8 <= dataView.byteLength) {
        const chunkLength = dataView.getUint32(offset, true);
        const chunkType = dataView.getUint32(offset + 4, true);
        const chunkOffset = offset + 8;
        if (chunkOffset + chunkLength > dataView.byteLength) throw new Error('Invalid GLB chunk length.');
        if (chunkType === JSON_CHUNK) {
            json = JSON.parse(new TextDecoder().decode(
                new Uint8Array(arrayBuffer, chunkOffset, chunkLength)
            ).trim());
        } else if (chunkType === BIN_CHUNK) {
            binOffset = chunkOffset;
            binLength = chunkLength;
        }
        offset = chunkOffset + chunkLength;
    }
    if (!json || !binOffset || !binLength) throw new Error('GLB is missing its JSON or BIN chunk.');

    const extensionNames = new Set([
        'UWA_gaussian_splatting_compression_EGSC',
        'UWA_primitive_3DGS_compression'
    ]);
    let extension = null;
    const stack = [json];
    while (stack.length > 0 && !extension) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') continue;
        for (const [key, value] of Object.entries(current)) {
            if (extensionNames.has(key) && value && typeof value === 'object') {
                extension = value;
                break;
            }
            if (value && typeof value === 'object') stack.push(value);
        }
    }
    const bufferViewIndex = extension?.bufferView ?? extension?.buffer_view ?? extension?.buffer_view_index;
    const bufferView = Number.isInteger(bufferViewIndex) ? json.bufferViews?.[bufferViewIndex] : null;
    if (!bufferView || !Number.isInteger(bufferView.byteLength)) {
        throw new Error('GLB does not contain a supported UWA compression bufferView.');
    }
    const byteOffset = bufferView.byteOffset || 0;
    if (byteOffset < 0 || bufferView.byteLength <= 0 || byteOffset + bufferView.byteLength > binLength) {
        throw new Error('UWA compression bufferView is outside the GLB BIN chunk.');
    }
    return {
        bytes: new Uint8Array(arrayBuffer, binOffset + byteOffset, bufferView.byteLength),
        compressedPayload: true,
        reason: `bufferView=${bufferViewIndex}`
    };
}

async function initializeCoordinatorModule(generation) {
    const instantiate = async (factory, wasmUrl, flavor) => {
        const module = await factory({
            locateFile: (path) => path.endsWith('.wasm') ? wasmUrl : path,
            print: (text) => console.log('[SplatUWA coordinator]', text),
            printErr: (text) => console.error('[SplatUWA coordinator]', text)
        });
        return { module, wasmUrl, flavor };
    };
    const canUsePthreads = globalThis.crossOriginIsolated === true &&
        typeof globalThis.SharedArrayBuffer === 'function';
    let selected = null;
    if (canUsePthreads) {
        try {
            const pthreadModule = await import(PTHREAD_COORDINATOR_JS_URL.href);
            selected = await instantiate(
                pthreadModule.default, PTHREAD_COORDINATOR_WASM_URL, 'pthread'
            );
        } catch (error) {
            if (!pthreadFallbackLogged) {
                pthreadFallbackLogged = true;
                console.warn('[SplatUWA coordinator] pthread artifact unavailable; using single-thread fallback.', error);
            }
        }
    }
    if (!selected) {
        selected = await instantiate(
            createSplatUWAWasm, COORDINATOR_WASM_URL, 'single-thread'
        );
    }
    assertDecoderSessionActive(generation);
    const nextCoordinator = new selected.module.SplatUWACoordinatorWasm();
    const encoderMask = typeof nextCoordinator.getTextureEncoderMask === 'function' ?
        nextCoordinator.getTextureEncoderMask() : 0;
    if (!isDecoderSessionActive(generation)) {
        nextCoordinator.delete();
        throw sessionDisposedError();
    }
    coordinatorModule = selected.module;
    coordinator = nextCoordinator;
    coordinatorWasmUrl = selected.wasmUrl;
    coordinatorFlavor = selected.flavor;
    coordinatorTextureBuildCapabilities = {
        bc7: (encoderMask & 1) !== 0,
        bc3: (encoderMask & 2) !== 0
    };
    return coordinatorModule;
}

function getCoordinatorModule() {
    assertDecoderSessionActive();
    if (coordinatorModule) return Promise.resolve(coordinatorModule);
    if (coordinatorModulePromise) return coordinatorModulePromise;

    const generation = decoderSessionGeneration;
    let trackedPromise;
    trackedPromise = initializeCoordinatorModule(generation).finally(() => {
        if (coordinatorModulePromise === trackedPromise) coordinatorModulePromise = null;
    });
    coordinatorModulePromise = trackedPromise;
    return trackedPromise;
}

function postWarmupProgress(phase, message, details = {}) {
    const progress = activeWarmupProgress;
    if (!progress || !isDecoderSessionActive(progress.generation)) return;
    postProgress(progress.requestId, message, {
        progressKind: 'warmup',
        phase,
        elapsedMs: roundTimingMs(performance.now() - progress.startedAt),
        details
    });
}

async function compileReconstructionModule(generation) {
    const startedAt = performance.now();
    const compileBeginAbsMs = absoluteNowMs();
    let compiledModule = null;
    let source = 'array-buffer-compile';
    let fallbackReason = null;

    if (typeof WebAssembly.compileStreaming === 'function') {
        try {
            const response = await fetch(RECONSTRUCTION_WASM_URL, { credentials: 'same-origin' });
            if (!response.ok) {
                throw new Error(`Reconstruction WASM fetch failed: ${response.status} ${response.statusText}`);
            }
            compiledModule = await WebAssembly.compileStreaming(response);
            source = 'compile-streaming';
        } catch (error) {
            assertDecoderSessionActive(generation);
            fallbackReason = error?.message || String(error);
        }
    }

    if (!compiledModule) {
        try {
            const response = await fetch(RECONSTRUCTION_WASM_URL, { credentials: 'same-origin' });
            if (!response.ok) {
                throw new Error(`Reconstruction WASM fetch failed: ${response.status} ${response.statusText}`);
            }
            compiledModule = await WebAssembly.compile(await response.arrayBuffer());
            source = fallbackReason ? 'array-buffer-compile-fallback' : 'array-buffer-compile';
        } catch (error) {
            assertDecoderSessionActive(generation);
            const compileError = error?.message || String(error);
            fallbackReason = fallbackReason ? `${fallbackReason} <- ${compileError}` : compileError;
            source = 'worker-self-load-compile-fallback';
        }
    }

    assertDecoderSessionActive(generation);
    const compileEndAbsMs = absoluteNowMs();
    reconstructionModulePreparation = {
        module: compiledModule,
        source,
        compileMs: roundTimingMs(performance.now() - startedAt),
        compileBeginAbsMs,
        compileEndAbsMs,
        fallbackReason,
        resourceTiming: getResourceTiming(RECONSTRUCTION_WASM_URL)
    };
    return reconstructionModulePreparation;
}

function getReconstructionModulePreparation(generation = decoderSessionGeneration) {
    assertDecoderSessionActive(generation);
    if (reconstructionModulePreparation) return Promise.resolve(reconstructionModulePreparation);
    if (reconstructionModulePreparationPromise) return reconstructionModulePreparationPromise;

    let trackedPromise;
    trackedPromise = compileReconstructionModule(generation).finally(() => {
        if (reconstructionModulePreparationPromise === trackedPromise) {
            reconstructionModulePreparationPromise = null;
        }
    });
    reconstructionModulePreparationPromise = trackedPromise;
    trackedPromise.catch(() => {});
    return trackedPromise;
}

function postShardWorkerInit(record, preparation) {
    assertDecoderSessionActive(record.sessionGeneration);
    if (!record.alive || !record.worker) throw new Error(`Shard worker ${record.workerId} was terminated before init.`);

    const baseMessage = {
        type: 'init',
        protocolVersion: PROTOCOL_VERSION,
        buildVersion: BUILD_VERSION,
        workerId: record.workerId,
        startupAttemptId: record.startupAttemptId
    };
    record.initPostedAt = performance.now();
    record.readyTimeoutId = setTimeout(() => {
        if (record.readyReject) {
            handleShardWorkerCrash(record, new Error(`Shard worker ${record.workerId} startup timed out.`));
        }
    }, CONTROL_TIMEOUT_MS);

    if (preparation.module) {
        const attempt = {
            source: 'shared-compiled-module',
            postBeginAbsMs: absoluteNowMs(),
            success: false
        };
        record.initAttempts.push(attempt);
        try {
            record.worker.postMessage({
                ...baseMessage,
                reconstructionWasmModule: preparation.module
            });
            attempt.postReturnAbsMs = absoluteNowMs();
            attempt.success = true;
            record.initPostBeginAbsMs = attempt.postBeginAbsMs;
            record.initPostReturnAbsMs = attempt.postReturnAbsMs;
            record.moduleSource = 'shared-compiled-module';
            return;
        } catch (error) {
            attempt.errorAbsMs = absoluteNowMs();
            attempt.error = error?.message || String(error);
            if (error?.name !== 'DataCloneError' && !/clone/i.test(error?.message || '')) throw error;
            record.moduleSource = 'worker-self-load-clone-fallback';
            record.moduleFallbackReason = error?.message || String(error);
            postWarmupProgress(
                'reconstruction-module-fallback',
                `Failed to share the reconstruction module; shard ${record.workerId + 1} will load independently`,
                { workerId: record.workerId, reason: record.moduleFallbackReason }
            );
        }
    } else {
        record.moduleSource = 'worker-self-load-compile-fallback';
        record.moduleFallbackReason = preparation.fallbackReason;
    }

    const fallbackAttempt = {
        source: record.moduleSource,
        fallbackReason: record.moduleFallbackReason,
        postBeginAbsMs: absoluteNowMs(),
        success: false
    };
    record.initAttempts.push(fallbackAttempt);
    try {
        record.worker.postMessage({
            ...baseMessage,
            moduleCloneFallbackReason: record.moduleFallbackReason
        });
        fallbackAttempt.postReturnAbsMs = absoluteNowMs();
        fallbackAttempt.success = true;
        record.initPostBeginAbsMs = fallbackAttempt.postBeginAbsMs;
        record.initPostReturnAbsMs = fallbackAttempt.postReturnAbsMs;
    } catch (error) {
        fallbackAttempt.errorAbsMs = absoluteNowMs();
        fallbackAttempt.error = error?.message || String(error);
        throw error;
    }
}

function createShardWorker(workerId, poolIndex, generation = decoderSessionGeneration) {
    assertDecoderSessionActive(generation);
    const createdAt = performance.now();
    const createBeginAbsMs = absoluteNowMs();
    const worker = new Worker(new URL('./SplatReconstruction.worker.js', import.meta.url), { type: 'module' });
    const createEndAbsMs = absoluteNowMs();
    const record = {
        workerId,
        poolIndex,
        startupAttemptId: nextShardStartupAttemptId++,
        sessionGeneration: generation,
        worker,
        alive: true,
        busy: false,
        inflight: null,
        modelReady: null,
        readyResolve: null,
        readyReject: null,
        readyPromise: null,
        readyTimeoutId: null,
        ready: false,
        moduleSource: 'pending',
        moduleFallbackReason: null,
        initPromise: null,
        createdAt,
        initPostedAt: null,
        moduleInitMs: 0,
        startupMs: 0,
        roundTripMs: 0,
        resourceTiming: null,
        clockMethod: DECODER_CLOCK_METHOD,
        createBeginAbsMs,
        createEndAbsMs,
        initPostBeginAbsMs: undefined,
        initPostReturnAbsMs: undefined,
        readyReceiveAbsMs: undefined,
        idleSinceAbsMs: undefined,
        initAttempts: [],
        workerWarmupTrace: null
    };
    record.readyPromise = new Promise((resolve, reject) => {
        record.readyResolve = resolve;
        record.readyReject = reject;
    });

    worker.onmessage = (event) => {
        const handlerReceiveAbsMs = absoluteNowMs();
        handleShardWorkerMessage(record, event.data || {}, handlerReceiveAbsMs);
    };
    worker.onerror = (error) => handleShardWorkerCrash(record, error);
    worker.onmessageerror = (error) => handleShardWorkerCrash(record, error);
    record.initPromise = getReconstructionModulePreparation(generation)
        .then((preparation) => postShardWorkerInit(record, preparation))
        .catch((error) => handleShardWorkerCrash(record, error));
    record.initPromise.catch(() => {});
    return record;
}

function terminateShardRecord(record, error = null) {
    if (!record) return;
    record.alive = false;
    record.ready = false;
    if (record.readyTimeoutId) {
        clearTimeout(record.readyTimeoutId);
        record.readyTimeoutId = null;
    }
    if (record.inflight?.timeoutId) clearTimeout(record.inflight.timeoutId);
    const terminationError = error || new Error(`Shard worker ${record.workerId} was terminated.`);
    if (record.readyReject) {
        const reject = record.readyReject;
        record.readyResolve = null;
        record.readyReject = null;
        reject(terminationError);
    }
    if (record.modelReady) {
        clearTimeout(record.modelReady.timeoutId);
        const reject = record.modelReady.reject;
        record.modelReady = null;
        reject(terminationError);
    }
    if (record.worker) {
        record.worker.onmessage = null;
        record.worker.onerror = null;
        record.worker.onmessageerror = null;
        record.worker.terminate();
        record.worker = null;
    }
}

function shardWorkerDiagnostics(record) {
    return {
        workerId: record.workerId,
        poolIndex: record.poolIndex,
        ready: record.ready,
        moduleSource: record.moduleSource,
        moduleFallbackReason: record.moduleFallbackReason,
        moduleInitMs: roundTimingMs(record.moduleInitMs),
        startupMs: roundTimingMs(record.startupMs),
        roundTripMs: roundTimingMs(record.roundTripMs),
        resourceTiming: normalizeResourceTiming(record.resourceTiming),
        warmupTrace: {
            schema: 'uwa.warmup.trace.v1',
            workerId: record.workerId,
            poolIndex: record.poolIndex,
            startupAttemptId: record.startupAttemptId,
            status: record.ready ? 'ready' : 'pending',
            moduleSource: record.moduleSource,
            moduleFallbackReason: record.moduleFallbackReason,
            parent: {
                clockMethod: record.clockMethod,
                createBeginAbsMs: record.createBeginAbsMs,
                createEndAbsMs: record.createEndAbsMs,
                initAttempts: record.initAttempts,
                initPostBeginAbsMs: record.initPostBeginAbsMs,
                initPostReturnAbsMs: record.initPostReturnAbsMs,
                readyReceiveAbsMs: record.readyReceiveAbsMs
            },
            worker: record.workerWarmupTrace
        }
    };
}

async function ensureShardWorkerReady(poolIndex, generation = decoderSessionGeneration) {
    assertDecoderSessionActive(generation);
    let record = shardPool[poolIndex];
    if (!record?.alive || record.sessionGeneration !== generation) {
        if (record) terminateShardRecord(record);
        record = createShardWorker(poolIndex, poolIndex, generation);
        shardPool[poolIndex] = record;
    }
    try {
        await record.readyPromise;
        assertDecoderSessionActive(generation);
        if (shardPool[poolIndex] !== record || !record.alive || !record.ready) {
            throw new Error(`Shard worker ${poolIndex} became unavailable during startup.`);
        }
        return record;
    } catch (error) {
        if (shardPool[poolIndex] === record) {
            terminateShardRecord(record, error);
            shardPool[poolIndex] = null;
        }
        throw error;
    }
}

async function ensureTargetShardPool(generation = decoderSessionGeneration, requestedCount = configuredShardWorkerCount) {
    const workerCount = Math.max(1, Math.min(8, Number.isInteger(requestedCount) ? requestedCount : SHARD_WORKER_COUNT));
    configuredShardWorkerCount = workerCount;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        assertDecoderSessionActive(generation);
        try {
            const records = await Promise.all(
                Array.from({ length: workerCount },
                    (_, poolIndex) => ensureShardWorkerReady(poolIndex, generation))
            );
            return records;
        } catch (error) {
            lastError = error;
            if (!isDecoderSessionActive(generation)) throw error;
        }
    }
    throw new Error(`Failed to initialize the ${workerCount}-worker shard pool after retry: ` +
        `${lastError?.message || String(lastError)}`);
}

function webCodecsCapabilitySnapshot() {
    if (webCodecsSessionPolicy) return { ...webCodecsSessionPolicy };
    return {
        status: webCodecsProbeStatus,
        supported: null,
        scope: WEB_CODECS_FAST_PATH_SCOPE,
        format: null,
        probeMs: webCodecsProbeStatus === 'pending' ?
            roundTimingMs(performance.now() - webCodecsProbeStartedAt) : 0
    };
}

function probeWebCodecsSessionPolicy() {
    assertDecoderSessionActive();
    if (webCodecsSessionPolicy) return Promise.resolve(webCodecsSessionPolicy);
    if (webCodecsSessionPolicyPromise) return webCodecsSessionPolicyPromise;

    const generation = decoderSessionGeneration;
    const startedAt = performance.now();
    const abortController = new AbortController();
    webCodecsProbeAbortController = abortController;
    webCodecsProbeStartedAt = startedAt;
    webCodecsProbeStatus = 'pending';
    const probePromise = (async () => {
        let policy;
        try {
            const result = await decodeVideoStreamWithWebCodecs(
                WEB_CODECS_CANARY_DESCRIPTOR,
                getWebCodecsCapabilityCanary(),
                {
                    signal: abortController.signal,
                    timeoutMs: WEB_CODECS_PREFLIGHT_TIMEOUT_MS
                }
            );
            if (result.layout.format !== 'I420' && result.layout.format !== 'NV12') {
                throw new Error(`Canary returned unsupported VideoFrame format ${result.layout.format || 'unknown'}.`);
            }
            policy = {
                status: 'complete',
                supported: true,
                scope: WEB_CODECS_FAST_PATH_SCOPE,
                format: result.layout.format,
                acceleration: result.config.hardwareAcceleration,
                probeMs: roundTimingMs(performance.now() - startedAt)
            };
        } catch (error) {
            assertDecoderSessionActive(generation);
            policy = {
                status: 'complete',
                supported: false,
                scope: WEB_CODECS_FAST_PATH_SCOPE,
                format: null,
                reason: normalizeFallbackReason(error),
                probeMs: roundTimingMs(performance.now() - startedAt)
            };
        }
        assertDecoderSessionActive(generation);
        webCodecsSessionPolicy = policy;
        webCodecsProbeStatus = 'complete';
        return policy;
    })();

    let trackedPromise;
    trackedPromise = probePromise.finally(() => {
        if (webCodecsSessionPolicyPromise === trackedPromise) {
            webCodecsSessionPolicyPromise = null;
            webCodecsProbeAbortController = null;
        }
    });
    webCodecsSessionPolicyPromise = trackedPromise;
    trackedPromise.catch(() => {});
    return trackedPromise;
}

function warmupEntryState(ready, inflight) {
    if (ready) return 'ready';
    if (inflight) return 'inflight';
    return 'cold';
}

function startWarmupBranch(decoderTrace, name, entryState, factory) {
    const branch = {
        entryState,
        beginAbsMs: absoluteNowMs(),
        endAbsMs: undefined
    };
    decoderTrace.branches[name] = branch;
    let promise;
    try {
        promise = factory();
    } catch (error) {
        branch.endAbsMs = absoluteNowMs();
        branch.error = error?.message || String(error);
        return Promise.reject(error);
    }
    return Promise.resolve(promise).then((result) => {
        branch.endAbsMs = absoluteNowMs();
        return result;
    }, (error) => {
        branch.endAbsMs = absoluteNowMs();
        branch.error = error?.message || String(error);
        throw error;
    });
}

function createDecoderWarmupTrace(handlerReceiveAbsMs, requestId = 0, bootstrapTrace = null) {
    return {
        schema: 'uwa.warmup.trace.v1',
        attempt: {
            requestId,
            lifecycleGeneration: decoderSessionGeneration,
            status: 'in-progress'
        },
        decoder: {
            clockMethod: DECODER_CLOCK_METHOD,
            moduleBodyStartAbsMs: DECODER_MODULE_BODY_START_ABS_MS,
            moduleBodyMeaning: 'first module-body point after static imports; excludes static import internals',
            handlerReceiveAbsMs,
            fullReadyBeginAbsMs: undefined,
            fullReadyEndAbsMs: undefined,
            resultPostBeginAbsMs: undefined,
            branches: {},
            reconstructionCompile: null
        },
        bootstrap: bootstrapTrace && typeof bootstrapTrace === 'object' ? bootstrapTrace : null,
        shardWorkers: []
    };
}

function prewarmDecoderSession(requestId = 0, requestWarmupTrace = null,
    requestedWorkerCount = configuredShardWorkerCount) {
    assertDecoderSessionActive();
    if (decoderSessionPrewarmPromise) return decoderSessionPrewarmPromise;

    const generation = decoderSessionGeneration;
    const targetWorkerCount = Math.max(1, Math.min(8,
        Number.isInteger(requestedWorkerCount) ? requestedWorkerCount : SHARD_WORKER_COUNT));
    const startedAt = performance.now();
    const warmupTrace = requestWarmupTrace || createDecoderWarmupTrace(undefined, requestId);
    const decoderTrace = warmupTrace.decoder;
    decoderTrace.fullReadyBeginAbsMs = absoluteNowMs();
    activeWarmupProgress = requestId > 0 ? { requestId, generation, startedAt } : null;

    const coordinatorStartedAt = startedAt;
    const coordinatorEntryState = warmupEntryState(!!coordinatorModule, !!coordinatorModulePromise);
    const coordinatorInitPromise = startWarmupBranch(
        decoderTrace, 'coordinator', coordinatorEntryState, () => getCoordinatorModule()
    ).then(() => ({
        durationMs: performance.now() - coordinatorStartedAt,
        resourceTiming: getResourceTiming(coordinatorWasmUrl),
        flavor: coordinatorFlavor
    })).then((result) => {
        postWarmupProgress(
            'coordinator-ready',
            `Coordinator ready (${result.flavor})`,
            { flavor: result.flavor, durationMs: roundTimingMs(result.durationMs) }
        );
        return result;
    });

    const reconstructionEntryState = warmupEntryState(
        !!reconstructionModulePreparation, !!reconstructionModulePreparationPromise
    );
    const reconstructionPreparationPromise = startWarmupBranch(
        decoderTrace, 'reconstruction', reconstructionEntryState,
        () => getReconstructionModulePreparation(generation)
    ).then((result) => {
        const shared = !!result.module;
        postWarmupProgress(
            'reconstruction-module-ready',
            shared ? 'Reconstruction module compiled once and ready to share with shard workers' :
                'Reconstruction module precompilation unavailable; each shard worker will load independently',
            {
                source: result.source,
                shared,
                compileMs: result.compileMs,
                fallbackReason: result.fallbackReason
            }
        );
        return result;
    });

    const shardStartedAt = performance.now();
    const shardPoolReady = shardPool.length >= targetWorkerCount &&
        shardPool.slice(0, targetWorkerCount).every((record) => record?.alive && record.ready);
    const shardPoolInflight = shardPool.some((record) => record?.alive && !record.ready);
    const shardInitPromise = startWarmupBranch(
        decoderTrace, 'shardPool', warmupEntryState(shardPoolReady, shardPoolInflight),
        () => ensureTargetShardPool(generation, targetWorkerCount)
    ).then((records) => {
        return {
            durationMs: performance.now() - shardStartedAt,
            records
        };
    });

    const webCodecsEntryState = warmupEntryState(
        !!webCodecsSessionPolicy, !!webCodecsSessionPolicyPromise || webCodecsProbeStatus === 'in-progress'
    );
    const webCodecsPolicyPromise = startWarmupBranch(
        decoderTrace, 'webCodecs', webCodecsEntryState, () => probeWebCodecsSessionPolicy()
    ).then((policy) => {
        postWarmupProgress(
            'hevc-complete',
            policy.supported ?
                `HEVC probe complete (WebCodecs ${policy.format})` :
                'HEVC probe complete (using FFmpeg fallback)',
            {
                supported: policy.supported,
                format: policy.format,
                reason: policy.reason,
                probeMs: policy.probeMs
            }
        );
        return policy;
    });

    const initializationPromise = (async () => {
        const [coordinatorResult, reconstructionResult, shardResult, webCodecsCapability] = await Promise.all([
            coordinatorInitPromise,
            reconstructionPreparationPromise,
            shardInitPromise,
            webCodecsPolicyPromise
        ]);
        decoderTrace.fullReadyEndAbsMs = absoluteNowMs();
        assertDecoderSessionActive(generation);
        const fullReadyMs = performance.now() - startedAt;
        const serialEquivalentMs = coordinatorResult.durationMs + shardResult.durationMs +
            webCodecsCapability.probeMs;
        decoderTrace.reconstructionCompile = {
            beginAbsMs: reconstructionResult.compileBeginAbsMs,
            endAbsMs: reconstructionResult.compileEndAbsMs,
            source: reconstructionResult.source,
            execution: reconstructionEntryState === 'cold' ? 'started-by-attempt' :
                (reconstructionEntryState === 'inflight' ? 'shared-inflight' : 'historical-cache')
        };
        const shardDiagnostics = shardResult.records.map(shardWorkerDiagnostics);
        warmupTrace.shardWorkers = shardDiagnostics.map((record) => record.warmupTrace);
        const bootstrapResources = Array.isArray(warmupTrace.bootstrap?.javaScriptResourceTiming) ?
            warmupTrace.bootstrap.javaScriptResourceTiming : [];
        warmupTrace.resources = [
            ...bootstrapResources.map((timing, index) => ({
                name: `Decoder JS ${index + 1}`,
                owner: 'decoder-bootstrap-module-graph',
                kind: 'javascript',
                source: 'bootstrap-resource-timing',
                timing: normalizeResourceTiming({ ...timing, durationMs: timing.duration })
            })),
            {
                name: 'Coordinator selected WASM',
                owner: `coordinator-${coordinatorResult.flavor}`,
                kind: 'wasm',
                source: coordinatorResult.flavor,
                timing: coordinatorResult.resourceTiming
            },
            {
                name: 'Reconstruction WASM compile',
                owner: 'decoder-reconstruction-compile',
                kind: 'wasm',
                source: reconstructionResult.source,
                timing: reconstructionResult.resourceTiming
            },
            ...shardDiagnostics.map((record) => ({
                name: `Shard ${record.workerId} reconstruction resource`,
                owner: `shard-${record.workerId}`,
                kind: 'worker-or-wasm',
                source: record.moduleSource,
                entryUrl: new URL('./SplatReconstruction.worker.js', import.meta.url).href,
                timing: record.resourceTiming
            }))
        ];
        warmupTrace.attempt.status = 'success';
        const diagnostics = {
            coordinatorModuleMs: roundTimingMs(coordinatorResult.durationMs),
            coordinatorFlavor: coordinatorResult.flavor,
            reconstructionModuleMs: reconstructionResult.compileMs,
            reconstructionModuleSource: reconstructionResult.source,
            reconstructionModuleFallbackReason: reconstructionResult.fallbackReason,
            reconstructionModuleShared: !!reconstructionResult.module,
            shardWarmupMs: roundTimingMs(shardResult.durationMs),
            shardWorkerCount: shardResult.records.length,
            targetShardWorkerCount: targetWorkerCount,
            fullReadyMs: roundTimingMs(fullReadyMs),
            parallelInitMs: roundTimingMs(fullReadyMs),
            totalMs: roundTimingMs(fullReadyMs),
            serialEquivalentMs: roundTimingMs(serialEquivalentMs),
            estimatedOverlapMs: roundTimingMs(Math.max(0, serialEquivalentMs - fullReadyMs)),
            textureBuildCapabilities: coordinatorTextureBuildCapabilities,
            webCodecsCapability,
            webCodecsProbeStatus: webCodecsCapability.status,
            webCodecsProbeMs: webCodecsCapability.probeMs,
            coordinatorResourceTiming: coordinatorResult.resourceTiming,
            reconstructionResourceTiming: reconstructionResult.resourceTiming,
            shardWorkers: shardDiagnostics,
            warmupTrace
        };
        postWarmupProgress(
            'full-ready',
            `Workers fully ready ${targetWorkerCount}/${targetWorkerCount}`,
            { shardWorkerCount: targetWorkerCount, fullReadyMs: diagnostics.fullReadyMs }
        );
        if (activeWarmupProgress?.generation === generation) activeWarmupProgress = null;
        return diagnostics;
    })();

    let trackedPromise;
    trackedPromise = initializationPromise.catch((error) => {
        if (!Number.isFinite(decoderTrace.fullReadyEndAbsMs)) {
            decoderTrace.failureAbsMs = absoluteNowMs();
            decoderTrace.failure = error?.message || String(error);
        }
        warmupTrace.attempt.status = 'error';
        warmupTrace.attempt.failureStage = 'prewarmDecoderSession';
        if (decoderSessionPrewarmPromise === trackedPromise) decoderSessionPrewarmPromise = null;
        if (activeWarmupProgress?.generation === generation) activeWarmupProgress = null;
        throw error;
    });
    decoderSessionPrewarmPromise = trackedPromise;
    return trackedPromise;
}

function beginModelOnWorker(record, model) {
    if (!record.alive || !record.ready ||
        !isDecoderSessionActive(record.sessionGeneration)) {
        return Promise.reject(new Error(`Shard worker ${record.workerId} is unavailable.`));
    }
    return new Promise((resolve, reject) => {
        const metadata = model.metadata.slice(0);
        const timeoutId = setTimeout(() => {
            if (record.modelReady?.modelId !== model.modelId) return;
            handleShardWorkerCrash(
                record,
                new Error(`Shard worker ${record.workerId} model initialization timed out.`)
            );
        }, CONTROL_TIMEOUT_MS);
        record.modelReady = { modelId: model.modelId, requestId: model.requestId, resolve, reject, timeoutId };
        try {
            record.worker.postMessage({
                type: 'beginModel',
                protocolVersion: PROTOCOL_VERSION,
                buildVersion: BUILD_VERSION,
                workerId: record.workerId,
                modelId: model.modelId,
                requestId: model.requestId,
                traceOriginAbsMs: model.traceOriginAbsMs,
                reconstructionTraceLevel: model.reconstructionTraceLevel,
                metadata
            }, [metadata]);
        } catch (error) {
            handleShardWorkerCrash(record, error);
        }
    });
}

function postProgress(requestId, message, extra = {}) {
    self.postMessage({
        type: 'progress',
        protocolVersion: PROTOCOL_VERSION,
        buildVersion: BUILD_VERSION,
        requestId,
        message,
        ...extra
    });
}

function assertPreparationActive(preparation) {
    if (activePreparation !== preparation || preparation.abortController.signal.aborted) {
        const reason = preparation.abortController.signal.reason;
        throw reason instanceof Error ? reason : new Error('SplatUWA decode preparation was canceled.');
    }
}

function readPendingVideo(Module, pendingIndex) {
    const descriptor = coordinator.getPendingVideo(pendingIndex);
    if (!descriptor.success) {
        throw new Error(coordinator.getLastError() || `Failed to read pending video ${pendingIndex}.`);
    }
    if (!Number.isInteger(descriptor.frameWidth) || descriptor.frameWidth <= 0 ||
        !Number.isInteger(descriptor.frameHeight) || descriptor.frameHeight <= 0 ||
        !Number.isInteger(descriptor.frameCount) || descriptor.frameCount <= 0 ||
        descriptor.encodedSize <= 0 || descriptor.encodedPtr <= 0) {
        throw new Error(`Pending video ${pendingIndex} has an invalid bridge descriptor.`);
    }
    return {
        streamIndex: descriptor.streamIndex,
        codecId: descriptor.codecId,
        frameWidth: descriptor.frameWidth,
        frameHeight: descriptor.frameHeight,
        frameCount: descriptor.frameCount,
        encoded: Module.HEAPU8.slice(descriptor.encodedPtr, descriptor.encodedPtr + descriptor.encodedSize)
    };
}

function injectDecodedVideo(Module, descriptor, result) {
    const decoded = result?.decoded;
    const pixelFormat = result?.pixelFormat;
    const expectedSize = videoBufferByteLength(
        pixelFormat, descriptor.frameWidth, descriptor.frameHeight, descriptor.frameCount
    );
    if (!(decoded instanceof Uint8Array) || decoded.byteLength !== expectedSize ||
        result.layout?.width !== descriptor.frameWidth || result.layout?.height !== descriptor.frameHeight ||
        result.layout?.frameCount !== descriptor.frameCount) {
        throw new Error(`WebCodecs returned an invalid byte layout for video substream ${descriptor.streamIndex}.`);
    }
    const startedAt = performance.now();
    const decodedPtr = Module._malloc(decoded.byteLength);
    if (!decodedPtr) throw new Error(`Failed to allocate ${decoded.byteLength} decoded video bytes.`);
    try {
        Module.HEAPU8.set(decoded, decodedPtr);
        if (!coordinator.injectDecodedVideo(
            descriptor.streamIndex, decodedPtr, decoded.byteLength, pixelFormat
        )) {
            throw new Error(coordinator.getLastError() ||
                `Failed to inject video substream ${descriptor.streamIndex}.`);
        }
    } finally {
        Module._free(decodedPtr);
    }
    return performance.now() - startedAt;
}

function normalizeFallbackReason(error) {
    const reasons = [];
    const visited = new Set();
    let current = error;
    while (current && !visited.has(current) && reasons.length < 3) {
        visited.add(current);
        const name = typeof current.name === 'string' && current.name ? current.name : '';
        const message = typeof current.message === 'string' && current.message ? current.message : String(current);
        const reason = name && name !== 'Error' ? `${name}: ${message}` : message;
        if (reason && reasons[reasons.length - 1] !== reason) reasons.push(reason);
        current = current.cause;
    }
    const normalized = reasons.join(' <- ') || 'Unknown WebCodecs failure';
    return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

export function composeVideoDecoderPath(rawVideoStreamCount, pendingVideoCount, encodedPath = 'none') {
    const rawCount = Number.isInteger(rawVideoStreamCount) && rawVideoStreamCount > 0 ?
        rawVideoStreamCount : 0;
    const pendingCount = Number.isInteger(pendingVideoCount) && pendingVideoCount > 0 ?
        pendingVideoCount : 0;
    if (rawCount === 0) return pendingCount === 0 ? 'none' : encodedPath;
    if (pendingCount === 0) return 'raw';
    return `raw+${encodedPath}`;
}

async function preparePendingVideos(Module, staged, preparation) {
    const pendingVideoCount = staged.pendingVideoCount;
    const rawVideoStreamCount = staged.rawVideoStreamCount || 0;
    const timings = {
        videoDecoderPath: composeVideoDecoderPath(
            rawVideoStreamCount, pendingVideoCount, pendingVideoCount > 0 ? 'ffmpeg' : 'none'
        ),
        pendingVideoCount,
        rawVideoStreamCount,
        rawVideoInputBytes: staged.rawVideoInputBytes || 0,
        rawVideoAdoptMs: staged.rawVideoAdoptMs || 0,
        webCodecsEligibleStreamCount: 0,
        webCodecsStreamCount: 0,
        webCodecsPolicySkipCount: 0,
        webCodecsIneligibleStreamCount: 0,
        webCodecsNegativeCacheHitCount: 0,
        ffmpegFallbackStreamCount: 0,
        webCodecsMs: 0,
        webCodecsCopyMs: 0,
        webCodecsRangeNormalizedCount: 0,
        webCodecsDetectedFullRangeCount: 0,
        jsToWasmInjectMs: 0,
        webCodecsLayouts: [],
        streams: [],
        ffmpegFallbackWallMs: 0,
        webCodecsSessionPolicy: webCodecsCapabilitySnapshot()
    };
    if (pendingVideoCount === 0) return timings;

    assertPreparationActive(preparation);
    const sessionPolicy = await probeWebCodecsSessionPolicy();
    assertPreparationActive(preparation);
    timings.webCodecsSessionPolicy = sessionPolicy;
    const webCodecsEnabled = sessionPolicy.supported === true;
    const webCodecsDeadline = performance.now() + WEB_CODECS_PHASE_TIMEOUT_MS;
    const preparationSignal = preparation.abortController.signal;
    const phaseAbortController = webCodecsEnabled ? new AbortController() : null;
    const abortPhaseFromPreparation = () => phaseAbortController?.abort(preparationSignal.reason);
    if (preparationSignal.aborted) abortPhaseFromPreparation();
    if (phaseAbortController) {
        preparationSignal.addEventListener('abort', abortPhaseFromPreparation, { once: true });
    }
    const phaseTimeoutId = phaseAbortController ? setTimeout(() => {
        phaseAbortController.abort(new Error(
            `WebCodecs phase timed out after ${WEB_CODECS_PHASE_TIMEOUT_MS} ms.`
        ));
    }, WEB_CODECS_PHASE_TIMEOUT_MS) : null;
    const phaseAbortPromise = phaseAbortController ? new Promise((_, reject) => {
        if (phaseAbortController.signal.aborted) {
            reject(phaseAbortController.signal.reason);
            return;
        }
        phaseAbortController.signal.addEventListener('abort', () => {
            reject(phaseAbortController.signal.reason);
        }, { once: true });
    }) : null;
    phaseAbortPromise?.catch(() => {});
    const fallbackReasons = [];
    const webCodecsFailureReasons = [];
    const streamDetails = new Map();
    try {
        for (let pendingIndex = 0; pendingIndex < pendingVideoCount; pendingIndex++) {
            let streamIndex = pendingIndex;
            let capabilityKey = '';
            let attemptedWebCodecs = false;
            let attemptStartedAt = 0;
            let streamTiming = null;
            try {
                assertPreparationActive(preparation);
                const descriptor = readPendingVideo(Module, pendingIndex);
                streamIndex = descriptor.streamIndex;
                streamTiming = {
                    streamIndex,
                    role: 'video',
                    decoderPath: 'ffmpeg',
                    actualPath: 'ffmpeg'
                };
                streamDetails.set(streamIndex, streamTiming);
                const eligibility = classifyWebCodecsFastPath(descriptor, descriptor.encoded);
                if (!eligibility.eligible) {
                    timings.webCodecsIneligibleStreamCount++;
                    fallbackReasons.push(`stream ${streamIndex}: direct FFmpeg route: ${eligibility.reason}`);
                    continue;
                }
                timings.webCodecsEligibleStreamCount++;
                if (!webCodecsEnabled) {
                    timings.webCodecsPolicySkipCount++;
                    fallbackReasons.push(
                        `stream ${streamIndex}: session policy selected FFmpeg: ` +
                        `${sessionPolicy.reason || 'WebCodecs preflight was not available'}`
                    );
                    continue;
                }
                if (phaseAbortController.signal.aborted) throw phaseAbortController.signal.reason;
                capabilityKey = createWebCodecsCapabilityKey(
                    descriptor, descriptor.encoded, eligibility.sps
                );
                if (webCodecsNegativeCapabilities.has(capabilityKey)) {
                    timings.webCodecsNegativeCacheHitCount++;
                    fallbackReasons.push(`stream ${streamIndex}: cached incompatible WebCodecs output layout`);
                    continue;
                }
                const remainingTimeoutMs = Math.max(1, Math.ceil(webCodecsDeadline - performance.now()));
                attemptedWebCodecs = true;
                attemptStartedAt = performance.now();
                const decodePromise = decodeVideoStreamWithWebCodecs(descriptor, descriptor.encoded, {
                    signal: phaseAbortController.signal,
                    timeoutMs: remainingTimeoutMs,
                    accelerationPreference: sessionPolicy.acceleration
                });
                decodePromise.catch(() => {});
                const result = await Promise.race([decodePromise, phaseAbortPromise]);
                assertPreparationActive(preparation);
                if (phaseAbortController.signal.aborted) throw phaseAbortController.signal.reason;
                const injectToWasmMs = injectDecodedVideo(Module, descriptor, result);
                timings.jsToWasmInjectMs += injectToWasmMs;
                timings.webCodecsCopyMs += result.timing?.copyMs || 0;
                if (result.rangeNormalized) timings.webCodecsRangeNormalizedCount++;
                if (result.detectedFullRange) timings.webCodecsDetectedFullRangeCount++;
                Object.assign(streamTiming, {
                    decoderPath: 'webcodecs',
                    actualPath: 'webcodecs',
                    decodeAndFlushMs: result.timing?.decodeAndFlushMs,
                    totalMs: result.timing?.totalMs,
                    copyMs: result.timing?.copyMs,
                    injectToWasmMs,
                    rangeNormalized: !!result.rangeNormalized,
                    detectedFullRange: !!result.detectedFullRange,
                    minLuma: result.minLuma ?? null,
                    maxLuma: result.maxLuma ?? null,
                    zeroLuma: result.zeroLuma ?? null,
                    colorSpace: result.colorSpace || null
                });
                timings.webCodecsLayouts.push({
                    streamIndex,
                    format: result.layout.format,
                    frameByteLength: result.layout.frameByteLength,
                    planeLayouts: result.layout.observedPlaneLayouts
                });
                timings.webCodecsStreamCount++;
            } catch (error) {
                assertPreparationActive(preparation);
                if (capabilityKey && isWebCodecsNegativeCapabilityError(error)) {
                    webCodecsNegativeCapabilities.add(capabilityKey);
                }
                const reason = `stream ${streamIndex}: ${normalizeFallbackReason(error)}`;
                fallbackReasons.push(reason);
                if (attemptedWebCodecs) webCodecsFailureReasons.push(reason);
                if (phaseAbortController?.signal.aborted || performance.now() >= webCodecsDeadline) break;
            } finally {
                if (attemptStartedAt > 0) {
                    const attemptWallMs = performance.now() - attemptStartedAt;
                    timings.webCodecsMs += attemptWallMs;
                    if (streamTiming) streamTiming.attemptWallMs = attemptWallMs;
                }
            }
        }
    } finally {
        if (phaseTimeoutId) clearTimeout(phaseTimeoutId);
        if (phaseAbortController) {
            preparationSignal.removeEventListener('abort', abortPhaseFromPreparation);
        }
    }
    if (fallbackReasons.length === 0) {
        timings.streams = [...streamDetails.values()];
        timings.videoDecoderPath = composeVideoDecoderPath(
            rawVideoStreamCount, pendingVideoCount, 'webcodecs'
        );
        return timings;
    }

    timings.fallbackReason = normalizeFallbackReason(fallbackReasons.join('; '));
    if (webCodecsFailureReasons.length > 0) {
        console.warn(`[SplatUWA coordinator] WebCodecs failed for ${webCodecsFailureReasons.length} stream(s); ` +
            'continuing with FFmpeg fallback.');
    } else if (verboseLog) {
        console.info(`[SplatUWA coordinator] Routed ${fallbackReasons.length} video stream(s) directly to FFmpeg.`);
    }

    const fallbackStartedAt = performance.now();
    if (!coordinator.decodePendingVideosWithFallback()) {
        throw new Error(coordinator.getLastError() || 'FFmpeg video fallback failed.');
    }
    timings.ffmpegFallbackWallMs = performance.now() - fallbackStartedAt;
    timings.ffmpegFallbackStreamCount = pendingVideoCount - timings.webCodecsStreamCount;
    timings.streams = [...streamDetails.values()];
    timings.videoDecoderPath = composeVideoDecoderPath(
        rawVideoStreamCount, pendingVideoCount,
        timings.webCodecsStreamCount > 0 ? 'mixed' : 'ffmpeg'
    );
    return timings;
}

function buildSubstreamTimings(prepared, videoTimings) {
    const roles = ['non-video', 'non-video', 'video', 'texture', 'non-video'];
    const videoByStream = new Map((videoTimings?.streams || []).map((stream) => [stream.streamIndex, stream]));
    return Object.fromEntries(roles.map((role, streamIndex) => {
        const wasmDecodeMs = prepared[`substream${streamIndex}Ms`];
        const entry = { streamIndex, role, wasmDecodeMs };
        if (streamIndex !== 2) {
            entry.primaryDecodeMs = wasmDecodeMs;
            return [String(streamIndex), entry];
        }

        const detail = videoByStream.get(streamIndex);
        const actualPath = detail?.actualPath || detail?.decoderPath || videoTimings?.videoDecoderPath || 'unknown';
        Object.assign(entry, detail || {}, {
            streamIndex,
            role,
            decoderPath: actualPath,
            actualPath
        });
        if (actualPath === 'webcodecs') {
            entry.primaryDecodeMs = Number.isFinite(detail?.decodeAndFlushMs) ?
                detail.decodeAndFlushMs : detail?.totalMs;
            entry.wasmDecodeMeaning = 'WebCodecs decode runs in JavaScript; wasmDecodeMs records only the C++ injection marker.';
        } else if (actualPath === 'ffmpeg') {
            entry.primaryDecodeMs = wasmDecodeMs;
            entry.ffmpegRawDecodeMs = wasmDecodeMs;
            entry.ffmpegOuterWallMs = videoTimings?.ffmpegFallbackWallMs;
        }
        return [String(streamIndex), entry];
    }));
}

function failModel(model, error) {
    if (!model || model.settled) return;
    model.settled = true;
    model.canceled = true;
    clearPacketQueue(model);
    if (model.deadlineId) clearTimeout(model.deadlineId);
    for (const record of shardPool) {
        if (!record) continue;
        if (record.inflight?.timeoutId) clearTimeout(record.inflight.timeoutId);
        record.inflight = null;
        record.busy = false;
        if (record.modelReady?.modelId === model.modelId) {
            clearTimeout(record.modelReady.timeoutId);
            const reject = record.modelReady.reject;
            record.modelReady = null;
            reject(error);
        }
        if (record.alive) {
            try {
                record.worker.postMessage({
                    type: 'cancelModel',
                    protocolVersion: PROTOCOL_VERSION,
                    buildVersion: BUILD_VERSION,
                    workerId: record.workerId,
                    modelId: model.modelId,
                    requestId: model.requestId
                });
            } catch (postError) {
                decoderSessionPrewarmPromise = null;
                terminateShardRecord(record, postError);
            }
        }
    }
    model.reject(error);
}

function packRange(model, range) {
    let packed;
    const exportStartedAt = performance.now();
    const packExportBeginAbsMs = absoluteNowMs();
    try {
        packed = coordinator.packShard(range.startBlock, range.blockCount);
        if (!packed.success) throw new Error(coordinator.getLastError() || 'Coordinator failed to pack a shard.');
        if (packed.startPoint !== range.startPoint || packed.pointCount !== range.pointCount) {
            throw new Error('Coordinator returned a mismatched packed shard range.');
        }
        const packet = coordinatorModule.HEAPU8.slice(packed.packetPtr, packed.packetPtr + packed.packetSize).buffer;
        model.timings.taskExportCopyMs += performance.now() - exportStartedAt;
        model.timings.packShardMs += packed.packMs;
        model.timings.unpackMs += packed.unpackMs || 0;
        const packExportEndAbsMs = absoluteNowMs();
        addTimelineEvent(model.timings, `dispatch.pack.${model.timings.dispatch.packedShardCount + 1}`,
            packExportBeginAbsMs, packExportEndAbsMs);
        model.timings.dispatch.packedShardCount++;
        model.maxPacketBytes = Math.max(model.maxPacketBytes, packet.byteLength);
        return {range, packet, packExportBeginAbsMs, packExportEndAbsMs, queuedAt: performance.now()};

    } finally {
        coordinator.releasePackedShard();
    }
}

function dispatchRange(record, model, range, preparedPacket = null) {
    if (model.canceled || model.settled || !record.alive) return;
    const traceEnabled = model.reconstructionTraceLevel === 'js';
    try {
        const entry = preparedPacket || packRange(model, range);
        const {packet, packExportBeginAbsMs, packExportEndAbsMs} = entry;
        model.timings.dispatch.queueWaitMs += Math.max(0, performance.now() - entry.queuedAt);

        const shardId = model.nextShardId++;
        const timeoutId = setTimeout(() => {
            if (record.inflight?.shardId !== shardId) return;
            recoverShardWorker(record, new Error(`Shard ${shardId} timed out.`)).catch((error) => {
                if (activeModel && !activeModel.settled) failModel(activeModel, error);
            });
        }, SHARD_TIMEOUT_MS);
        const trace = traceEnabled ? {
            workerId: record.workerId,
            modelId: model.modelId,
            requestId: model.requestId,
            shardId,
            startBlock: range.startBlock,
            blockCount: range.blockCount,
            startPoint: range.startPoint,
            pointCount: range.pointCount,
            retry: range.retries || 0,
            packExportBeginAbsMs,
            packExportEndAbsMs
        } : null;
        record.busy = true;
        if (Number.isFinite(record.idleSinceAbsMs)) {
            model.timings.dispatch.workerIdleMs += Math.max(0, absoluteNowMs() - record.idleSinceAbsMs);
            record.idleSinceAbsMs = undefined;
        }
        record.inflight = { ...range, shardId, timeoutId, trace };
        model.timings.dispatch.inflight = shardPool.reduce((count, item) => count + (item?.busy ? 1 : 0), 0);
        model.timings.dispatch.maxInflight = Math.max(model.timings.dispatch.maxInflight, model.timings.dispatch.inflight);
        const dispatchBeginAbsMs = absoluteNowMs();
        const dispatchAbsMs = dispatchBeginAbsMs;
        if (trace) trace.dispatchBeginAbsMs = dispatchBeginAbsMs;
        record.worker.postMessage({
            type: 'reconstructShard',
            protocolVersion: PROTOCOL_VERSION,
            buildVersion: BUILD_VERSION,
            workerId: record.workerId,
            modelId: model.modelId,
            requestId: model.requestId,
            shardId,
            startBlock: range.startBlock,
            blockCount: range.blockCount,
            startPoint: range.startPoint,
            pointCount: range.pointCount,
            dispatchedAt: performance.now(),
            dispatchAbsMs,
            traceOriginAbsMs: model.traceOriginAbsMs,
            reconstructionTraceLevel: model.reconstructionTraceLevel,
            ...(trace ? { trace } : {}),
            packet
        }, [packet]);
        const dispatchReturnAbsMs = absoluteNowMs();
        if (trace) trace.dispatchReturnAbsMs = dispatchReturnAbsMs;
        addTimelineEvent(model.timings, `dispatch.post.${shardId}`, dispatchBeginAbsMs, dispatchReturnAbsMs);
    } catch (error) {
        failModel(model, error);
    }
}

function clearPacketQueue(model) {
    model.packetQueue.length = 0;
    model.packetQueueBytes = 0;
    model.pumpChannel?.port1.close();
    model.pumpChannel?.port2.close();
    model.pumpChannel = null;
    model.pumpScheduled = false;
}

function readyConsumers(model) {
    return shardPool.filter((record) => record?.alive && record.ready && !record.busy &&
        record.currentModelId === model.modelId);
}

function dispatchQueuedPackets(model) {
    for (const record of readyConsumers(model)) {
        if (model.canceled || model.settled || !model.packetQueue.length) break;
        const entry = model.packetQueue.shift();
        model.packetQueueBytes -= entry.packet.byteLength;
        dispatchRange(record, model, entry.range, entry);
    }
}

export function canPackNextShard(model, pendingLimit) {
    return model.nextBlock < model.blockCount &&
        model.packetQueue.length < pendingLimit &&
        (!model.packetQueue.length ||
         model.packetQueueBytes + model.maxPacketBytes <= MAX_PENDING_PACKET_BYTES);
}

function schedulePump(model) {
    if (model.canceled || model.settled || model.pumpScheduled) return;
    if (!model.pumpChannel) {
        model.pumpChannel = new MessageChannel();
        model.pumpChannel.port1.onmessage = () => {
            model.pumpScheduled = false;
            if (activeModel === model && !model.settled && !model.canceled) pumpDispatch(model);
        };
    }
    model.pumpScheduled = true;
    model.pumpChannel.port2.postMessage(null);
}

// One synchronous pack per event-loop turn: workers consume ready packets
// first, and result messages can run between packs. Prefetch is bounded by
// count and bytes; a single oversize packet is allowed only in an empty queue.
function pumpDispatch(model) {
    if (!model || model.canceled || model.settled) return;
    dispatchQueuedPackets(model);
    if (model.completedBlocks === model.blockCount) {
        finishModel(model);
        return;
    }
    // Fill every currently available worker in this turn.  The previous
    // one-packet-per-turn policy could leave fast workers idle while the next
    // coordinator pack waited for another MessageChannel turn; on mobile
    // devices this made an 8-worker pool report only 2-3 max in-flight tasks.
    const workerSlots = Math.max(1, readyConsumers(model).length);
    const pendingLimit = Math.max(MAX_PENDING_PACKETS, model.workerCount || workerSlots);
    let packedThisTurn = 0;
    while (packedThisTurn < workerSlots && canPackNextShard(model, pendingLimit)) {
        const startBlock = model.nextBlock;
        const blockCount = Math.min(model.blocksPerShard, model.blockCount - startBlock);
        const startPoint = startBlock * model.pointsPerBlock;
        const pointCount = Math.min(model.pointCount - startPoint, blockCount * model.pointsPerBlock);
        model.nextBlock += blockCount;
        model.timings.dispatch.dispatchCount++;
        try {
            const entry = packRange(model, {startBlock, blockCount, startPoint, pointCount, retries: 0});
            model.packetQueue.push(entry);
            model.packetQueueBytes += entry.packet.byteLength;
            model.timings.dispatch.peakQueuedPackets = Math.max(model.timings.dispatch.peakQueuedPackets, model.packetQueue.length);
            model.timings.dispatch.peakQueuedBytes = Math.max(model.timings.dispatch.peakQueuedBytes, model.packetQueueBytes);
            packedThisTurn++;
            dispatchQueuedPackets(model);
        } catch (error) {
            failModel(model, error);
            return;
        }
    }
    if (canPackNextShard(model, pendingLimit)) {
        schedulePump(model);
    }
}

function accumulateShardTimings(target, source) {
    if (!source) return;
    for (const [name, value] of Object.entries(source)) {
        if (typeof value === 'number' && Number.isFinite(value)) target[name] = (target[name] || 0) + value;
    }
}

function traceDurationMs(start, end) {
    return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
}

function recordCompletedShardTrace(model, range, message, coordinatorReceiveAbsMs,
    mergeBeginAbsMs, mergeEndAbsMs) {
    const shardTrace = model.timings.shardTrace;
    if (!shardTrace) return;
    try {
        const workerTrace = message.trace || {};
        const coordinatorTrace = range.trace || {};
        const task = {
            workerId: message.workerId,
            modelId: model.modelId,
            requestId: model.requestId,
            shardId: message.shardId,
            startBlock: range.startBlock,
            blockCount: range.blockCount,
            startPoint: range.startPoint,
            pointCount: range.pointCount,
            retry: range.retries || 0,
            packExportBeginAbsMs: coordinatorTrace.packExportBeginAbsMs,
            packExportEndAbsMs: coordinatorTrace.packExportEndAbsMs,
            dispatchBeginAbsMs: coordinatorTrace.dispatchBeginAbsMs,
            dispatchReturnAbsMs: coordinatorTrace.dispatchReturnAbsMs,
            workerReceiveAbsMs: workerTrace.workerReceiveAbsMs,
            wasmInputCopyBeginAbsMs: workerTrace.wasmInputCopyBeginAbsMs,
            kernelCallBeginAbsMs: workerTrace.kernelCallBeginAbsMs,
            kernelCallEndAbsMs: workerTrace.kernelCallEndAbsMs,
            resultCopyBeginAbsMs: workerTrace.resultCopyBeginAbsMs,
            resultCopyEndAbsMs: workerTrace.resultCopyEndAbsMs,
            resultPostBeginAbsMs: workerTrace.resultPostBeginAbsMs,
            coordinatorReceiveAbsMs,
            mergeBeginAbsMs,
            mergeEndAbsMs
        };

        let summary = shardTrace.workerSummaries.find((item) => item.workerId === task.workerId);
        if (!summary) {
            summary = {
                workerId: task.workerId,
                taskCount: 0,
                blockCount: 0,
                pointCount: 0,
                firstWorkerReceiveAbsMs: undefined,
                lastWorkerPostAbsMs: undefined,
                activeTaskMs: 0,
                kernelBoundaryMs: 0,
                resultCopyMs: 0,
                spanMs: 0
            };
            shardTrace.workerSummaries.push(summary);
        }
        summary.taskCount++;
        summary.blockCount += task.blockCount;
        summary.pointCount += task.pointCount;
        if (Number.isFinite(task.workerReceiveAbsMs)) {
            summary.firstWorkerReceiveAbsMs = Number.isFinite(summary.firstWorkerReceiveAbsMs) ?
                Math.min(summary.firstWorkerReceiveAbsMs, task.workerReceiveAbsMs) : task.workerReceiveAbsMs;
        }
        if (Number.isFinite(task.resultPostBeginAbsMs)) {
            summary.lastWorkerPostAbsMs = Number.isFinite(summary.lastWorkerPostAbsMs) ?
                Math.max(summary.lastWorkerPostAbsMs, task.resultPostBeginAbsMs) : task.resultPostBeginAbsMs;
        }
        summary.activeTaskMs += traceDurationMs(task.workerReceiveAbsMs, task.resultPostBeginAbsMs);
        summary.kernelBoundaryMs += traceDurationMs(task.kernelCallBeginAbsMs, task.kernelCallEndAbsMs);
        summary.resultCopyMs += traceDurationMs(task.resultCopyBeginAbsMs, task.resultCopyEndAbsMs);
        summary.spanMs = traceDurationMs(summary.firstWorkerReceiveAbsMs, summary.lastWorkerPostAbsMs);

        if (shardTrace.tasks.length < MAX_RECONSTRUCTION_TRACE_TASKS) {
            shardTrace.tasks.push(task);
        } else {
            shardTrace.droppedTaskCount++;
            shardTrace.truncated = true;
        }
    } catch (_) {
        // Optional trace collection must never interrupt reconstruction.
    }
}

// Build a bounded, independent preview payload. All arrays are copied so the
// final model can continue to be filled and transferred later without being
// detached by the preview message.
export function buildPreviewData(model) {
    if (!model || !model.previewEnabled || model.previewSent) return null;
    const indexes = [];
    for (let point = 0; point < model.pointCount && indexes.length < MAX_PREVIEW_POINTS; point++) {
        if (!model.validity[point]) continue;
        if (model.colors[point * 4 + 3] < model.minimumAlpha) continue;
        indexes.push(point);
    }
    if (indexes.length === 0) return null;
    const count = indexes.length;
    const positions = new Float32Array(count * 3);
    const scales = new Float32Array(count * 3);
    const rotations = new Float32Array(count * 4);
    const colors = new Uint8Array(count * 4);
    const featuresRest = model.featuresRest ? new Float32Array(count * 45) : null;
    const compressedTextureData = model.compressedTextureData ? {
        ...model.compressedTextureData,
        raw: model.compressedTextureData.raw?.slice() || null,
        uvs: new Uint32Array(count * 2),
        metas: model.compressedTextureData.metas?.slice() || null,
        // These are transferred with the preview too, including empty arrays.
        // Sharing them here would detach the final model's SH ranges.
        shnMins: model.compressedTextureData.shnMins?.slice() || null,
        shnMaxs: model.compressedTextureData.shnMaxs?.slice() || null
    } : null;
    indexes.forEach((source, destination) => {
        positions.set(model.positions.subarray(source * 3, source * 3 + 3), destination * 3);
        scales.set(model.scales.subarray(source * 3, source * 3 + 3), destination * 3);
        rotations.set(model.rotations.subarray(source * 4, source * 4 + 4), destination * 4);
        colors.set(model.colors.subarray(source * 4, source * 4 + 4), destination * 4);
        if (featuresRest) featuresRest.set(model.featuresRest.subarray(source * 45, source * 45 + 45), destination * 45);
        if (compressedTextureData?.uvs) {
            compressedTextureData.uvs.set(model.compressedTextureData.uvs.subarray(source * 2, source * 2 + 2), destination * 2);
        }
    });
    const preview = {
        numPoints: count,
        sourcePointCount: model.pointCount,
        validPointCount: count,
        positions,
        scales,
        rotations,
        colors,
        featuresRest,
        compressedTextureData,
        postprocessCompacted: true,
        postprocessMinimumAlpha: model.minimumAlpha,
        gpuScaleRotations: null,
        gpuCenterColors: null,
        gpuCompressedTextureUV: null,
        shDegree: model.shDegree,
        preview: true,
        previewSourcePointIndexes: new Uint32Array(indexes)
    };
    if (model.compressedTextureData) {
        preview.gpuScaleRotations = new Float32Array(count * 6);
        for (let i = 0; i < count; i++) {
            const s = i * 3;
            const r = i * 4;
            const g = i * 6;
            preview.gpuScaleRotations[g] = scales[s];
            preview.gpuScaleRotations[g + 1] = scales[s + 1];
            preview.gpuScaleRotations[g + 2] = scales[s + 2];
            preview.gpuScaleRotations[g + 3] = rotations[r + 1];
            preview.gpuScaleRotations[g + 4] = rotations[r + 2];
            preview.gpuScaleRotations[g + 5] = rotations[r + 3];
        }
    }
    return preview;
}

export function transferPreviewResult(model, data) {
    if (!data) return;
    const transferList = [];
    const transferredBuffers = new Set();
    const addTransfer = (value) => {
        const buffer = value?.buffer;
        if (!buffer || transferredBuffers.has(buffer)) return;
        transferredBuffers.add(buffer);
        transferList.push(buffer);
    };
    addTransfer(data.positions);
    addTransfer(data.scales);
    addTransfer(data.rotations);
    addTransfer(data.colors);
    addTransfer(data.previewSourcePointIndexes);
    addTransfer(data.featuresRest);
    addTransfer(data.gpuScaleRotations);
    addTransfer(data.gpuCenterColors);
    addTransfer(data.gpuCompressedTextureUV);
    if (data.compressedTextureData) {
        addTransfer(data.compressedTextureData.raw);
        addTransfer(data.compressedTextureData.uvs);
        addTransfer(data.compressedTextureData.metas);
        addTransfer(data.compressedTextureData.shnMins);
        addTransfer(data.compressedTextureData.shnMaxs);
    }
    self.postMessage({
        type: 'decodePreview', protocolVersion: PROTOCOL_VERSION, buildVersion: BUILD_VERSION,
        requestId: model.requestId, modelId: model.modelId, success: true, data
    }, transferList);
}

function handleShardResult(record, message, coordinatorReceiveAbsMs) {
    const model = activeModel;
    if (!model || model.canceled || model.settled || shardPool[record.poolIndex] !== record) return;
    if (message.modelId !== model.modelId || message.requestId !== model.requestId) return;
    const range = record.inflight;
    if (!range || message.shardId !== range.shardId) return;
    try {
        assertProtocol(message);
        if (message.startBlock !== range.startBlock || message.blockCount !== range.blockCount ||
            message.startPoint !== range.startPoint || message.pointCount !== range.pointCount) {
            throw new Error('Shard worker returned a mismatched range.');
        }
        if (message.positions.length !== range.pointCount * 3 || message.scales.length !== range.pointCount * 3 ||
            message.rotations.length !== range.pointCount * 4 || message.colors.length !== range.pointCount * 4 ||
            message.validity.length !== range.pointCount) {
            throw new Error('Shard worker returned invalid typed-array lengths.');
        }
        if (model.featuresRest && (!message.featuresRest || message.featuresRest.length !== range.pointCount * 45)) {
            throw new Error('CPU reconstruction shard is missing features_rest data.');
        }

        const mergeStartedAt = performance.now();
        const mergeBeginAbsMs = absoluteNowMs();
        model.positions.set(message.positions, range.startPoint * 3);
        model.scales.set(message.scales, range.startPoint * 3);
        model.rotations.set(message.rotations, range.startPoint * 4);
        model.colors.set(message.colors, range.startPoint * 4);
        model.validity.set(message.validity, range.startPoint);
        if (model.featuresRest) model.featuresRest.set(message.featuresRest, range.startPoint * 45);
        model.timings.resultMergeMs += performance.now() - mergeStartedAt;
        const mergeEndAbsMs = absoluteNowMs();
        addTimelineEvent(model.timings, `result.receive.${message.shardId}`, coordinatorReceiveAbsMs, mergeBeginAbsMs);
        addTimelineEvent(model.timings, `result.merge.${message.shardId}`, mergeBeginAbsMs, mergeEndAbsMs);
        accumulateShardTimings(model.timings.shards, message.timings);
        recordCompletedShardTrace(
            model, range, message, coordinatorReceiveAbsMs, mergeBeginAbsMs, mergeEndAbsMs
        );

        clearTimeout(range.timeoutId);
        record.inflight = null;
        record.busy = false;
        record.idleSinceAbsMs = Number.isFinite(message.resultPostedAbsMs) ?
            message.resultPostedAbsMs : absoluteNowMs();
        model.timings.dispatch.inflight = Math.max(0, model.timings.dispatch.inflight - 1);
        model.completedBlocks += range.blockCount;
        model.completedPoints += range.pointCount;
        if (!Number.isFinite(model.timings.wall.firstShardResultAbsMs)) {
            model.timings.wall.firstShardResultAbsMs = coordinatorReceiveAbsMs;
        }
        dispatchQueuedPackets(model);
        if (model.previewEnabled && !model.previewSent) {
            const previewStartedAt = performance.now();
            try {
                const preview = buildPreviewData(model);
                if (preview) {
                    model.previewSent = true;
                    transferPreviewResult(model, preview);
                    model.timings.wall.previewSentAbsMs = absoluteNowMs();
                }
            } catch (error) {
                model.previewEnabled = false;
                model.timings.wall.previewError = error?.message || String(error);
            }
            model.timings.wall.previewBuildMs = (model.timings.wall.previewBuildMs || 0) + performance.now() - previewStartedAt;
        }
        schedulePump(model);
        if (model.completedBlocks === model.blockCount && shardPool.every((item) => !item?.busy)) finishModel(model);
    } catch (error) {
        failModel(model, error);
    }
}

export function buildGpuScaleRotations(model) {
    if (!model.postprocessCompaction || !model.compressedTextureData) return;
    const packedLength = gpuScaleRotationPackedArrayLength(model.pointCount);
    if (packedLength === null) {
        model.gpuScaleRotations = null;
        return;
    }
    try {
        const packed = new Float32Array(packedLength);
        for (let point = 0; point < model.pointCount; point++) {
            const scaleOffset = point * 3;
            const rotationOffset = point * 4;
            const packedOffset = point * 6;
            packed[packedOffset] = model.scales[scaleOffset];
            packed[packedOffset + 1] = model.scales[scaleOffset + 1];
            packed[packedOffset + 2] = model.scales[scaleOffset + 2];
            // The public UWA rotation layout is w,x,y,z. The shader input only
            // needs x,y,z and reconstructs w from the unit quaternion constraint.
            packed[packedOffset + 3] = model.rotations[rotationOffset + 1];
            packed[packedOffset + 4] = model.rotations[rotationOffset + 2];
            packed[packedOffset + 5] = model.rotations[rotationOffset + 3];
        }
        model.gpuScaleRotations = packed;
    } catch (_) {
        model.gpuScaleRotations = null;
    }
}

/**
 * Pack the two RGBA32UI inputs consumed by the direct compressed-texture
 * renderer. Keep this work beside the decoded arrays so the main thread can
 * install the result without another per-splat JavaScript loop.
 */
export function buildGpuTextureInputs(model) {
    if (!model) return;
    model.gpuCenterColors = null;
    model.gpuCompressedTextureUV = null;
    if (!model.postprocessCompaction || !model.compressedTextureData) return;

    const count = Number.isSafeInteger(model.pointCount) && model.pointCount >= 0 ? model.pointCount : -1;
    const positions = model.positions;
    const colors = model.colors;
    const uvs = model.compressedTextureData.uvs;
    if (count < 0 || !(positions instanceof Float32Array) || positions.length !== count * 3 ||
        !(colors instanceof Uint8Array) || colors.length !== count * 4) return;

    try {
        const packedLength = gpuTexturePackedArrayLength(count);
        if (packedLength === null) return;
        const packedCenterColors = new Uint32Array(packedLength);
        for (let point = 0; point < count; point++) {
            const centerOffset = point * 3;
            const packedOffset = point * 4;
            packedCenterColors[packedOffset] = rgbaArrayToUintForGpuPack(colors, point * 4);
            packedCenterColors[packedOffset + 1] = uintEncodedFloatForGpuPack(positions[centerOffset]);
            packedCenterColors[packedOffset + 2] = uintEncodedFloatForGpuPack(positions[centerOffset + 1]);
            packedCenterColors[packedOffset + 3] = uintEncodedFloatForGpuPack(positions[centerOffset + 2]);
        }
        model.gpuCenterColors = packedCenterColors;

        if (uvs instanceof Uint32Array && uvs.length === count * 2) {
            const packedUvs = new Uint32Array(packedLength);
            for (let point = 0; point < count; point++) {
                const sourceOffset = point * 2;
                const packedOffset = point * 4;
                packedUvs[packedOffset] = uvs[sourceOffset];
                packedUvs[packedOffset + 1] = uvs[sourceOffset + 1];
                // The shader reads U/V from R/G. Keep B/A zero to match the
                // existing main-thread padding loop exactly.
            }
            model.gpuCompressedTextureUV = packedUvs;
        }
    } catch (_) {
        // A large typed-array allocation can fail on constrained devices. The
        // result remains null so SplatMesh uses its existing packing fallback.
        model.gpuCenterColors = null;
        model.gpuCompressedTextureUV = null;
    }
}

export function compactModel(model) {
    const pruneStartedAt = performance.now();
    const sourcePointCount = model.pointCount;
    const minimumAlpha = Number.isFinite(model.minimumAlpha) ? model.minimumAlpha : 1;
    const validRuns = [];
    let validCount = 0;
    let validityInvalidCount = 0;
    let alphaBelowMinimumCount = 0;
    let alphaZeroCount = 0;
    let runStart = -1;
    for (let point = 0; point < sourcePointCount; point++) {
        const structurallyValid = !!model.validity[point];
        if (!structurallyValid) validityInvalidCount++;
        const alpha = model.colors[point * 4 + 3];
        if (alpha === 0) alphaZeroCount++;
        if (alpha < minimumAlpha) alphaBelowMinimumCount++;
        const valid = structurallyValid &&
            (!model.postprocessCompaction || alpha >= minimumAlpha);
        if (valid) {
            validCount++;
            if (runStart < 0) runStart = point;
        } else if (runStart >= 0) {
            validRuns.push(runStart, point);
            runStart = -1;
        }
    }
    if (runStart >= 0) validRuns.push(runStart, sourcePointCount);
    model.timings.compactionStats = {
        sourcePointCount,
        validityInvalidCount,
        alphaBelowMinimumCount,
        alphaZeroCount,
        validAfterCompactionCount: validCount,
        minimumAlpha,
        postprocessCompaction: !!model.postprocessCompaction
    };
    if (validCount === model.pointCount) {
        model.postprocessCompacted = !!model.postprocessCompaction;
        model.sourcePointCount = sourcePointCount;
        model.timings.pruneMs += performance.now() - pruneStartedAt;
        return;
    }

    const positions = new Float32Array(validCount * 3);
    const scales = new Float32Array(validCount * 3);
    const rotations = new Float32Array(validCount * 4);
    const colors = new Uint8Array(validCount * 4);
    const featuresRest = model.featuresRest ? new Float32Array(validCount * 45) : null;
    const compressedTextureUVs = model.compressedTextureData?.uvs ? new Uint32Array(validCount * 2) : null;
    let destination = 0;
    for (let run = 0; run < validRuns.length; run += 2) {
        const start = validRuns[run];
        const end = validRuns[run + 1];
        const runLength = end - start;
        positions.set(model.positions.subarray(start * 3, end * 3), destination * 3);
        scales.set(model.scales.subarray(start * 3, end * 3), destination * 3);
        rotations.set(model.rotations.subarray(start * 4, end * 4), destination * 4);
        colors.set(model.colors.subarray(start * 4, end * 4), destination * 4);
        if (featuresRest) featuresRest.set(model.featuresRest.subarray(start * 45, end * 45), destination * 45);
        if (compressedTextureUVs) {
            compressedTextureUVs.set(model.compressedTextureData.uvs.subarray(start * 2, end * 2), destination * 2);
        }
        destination += runLength;
    }
    model.pointCount = validCount;
    model.positions = positions;
    model.scales = scales;
    model.rotations = rotations;
    model.colors = colors;
    model.featuresRest = featuresRest;
    if (model.compressedTextureData) model.compressedTextureData.uvs = compressedTextureUVs;
    model.postprocessCompacted = !!model.postprocessCompaction;
    model.sourcePointCount = sourcePointCount;
    model.timings.pruneMs += performance.now() - pruneStartedAt;
}

function finishModel(model) {
    if (!model || model.settled || model.canceled) return;
    const reconstructionEndedAt = performance.now();
    const reconstructionEndAbsMs = absoluteNowMs();
    try {
        model.timings.wall.reconstructionEndAbsMs = reconstructionEndAbsMs;
        model.timings.wall.reconstructionEndSinceTraceOriginMs =
            reconstructionEndAbsMs - model.timings.wall.traceOriginAbsMs;
        if (Number.isFinite(model.timings.wall.reconstructionStartedAt)) {
            model.timings.wall.reconstructionWallMs =
                reconstructionEndedAt - model.timings.wall.reconstructionStartedAt;
            delete model.timings.wall.reconstructionStartedAt;
        }
        clearPacketQueue(model);
        model.timings.wall.allShardsCompleteAbsMs = absoluteNowMs();
        addTimelineEvent(model.timings, 'reconstruction', model.timings.wall.reconstructionStartAbsMs,
            model.timings.wall.reconstructionEndAbsMs);
        const compactStartedAt = performance.now();
        const compactStartedAbsMs = absoluteNowMs();
        compactModel(model);
        const compactEndedAbsMs = absoluteNowMs();
        model.timings.wall.compactModelMs = performance.now() - compactStartedAt;
        addTimelineEvent(model.timings, 'result.compact', compactStartedAbsMs, compactEndedAbsMs);
        const gpuInputPackStartedAt = performance.now();
        const gpuInputPackStartedAbsMs = absoluteNowMs();
        buildGpuScaleRotations(model);
        const gpuTexturePackStartedAt = performance.now();
        const gpuTexturePackStartedAbsMs = absoluteNowMs();
        buildGpuTextureInputs(model);
        const gpuTexturePackEndedAbsMs = absoluteNowMs();
        model.timings.wall.gpuTexturePackMs = performance.now() - gpuTexturePackStartedAt;
        model.timings.wall.gpuInputPackMs = performance.now() - gpuInputPackStartedAt;
        addTimelineEvent(model.timings, 'result.texture-pack', gpuTexturePackStartedAbsMs, gpuTexturePackEndedAbsMs);
        addTimelineEvent(model.timings, 'result.input-pack', gpuInputPackStartedAbsMs, gpuTexturePackEndedAbsMs);
        const resultAssemblyStartedAt = performance.now();
        const resultAssemblyStartedAbsMs = absoluteNowMs();
        model.settled = true;
        clearTimeout(model.deadlineId);
        const result = {
            numPoints: model.pointCount,
            positions: model.positions,
            scales: model.scales,
            rotations: model.rotations,
            colors: model.colors,
            featuresRest: model.featuresRest,
            compressedTextureData: model.compressedTextureData,
            postprocessCompacted: model.postprocessCompacted,
            postprocessMinimumAlpha: model.postprocessCompacted ? model.minimumAlpha : null,
            sourcePointCount: model.sourcePointCount ?? model.pointCount,
            validPointCount: model.pointCount,
            gpuScaleRotations: model.gpuScaleRotations || null,
            gpuCenterColors: model.gpuCenterColors || null,
            gpuCompressedTextureUV: model.gpuCompressedTextureUV || null,
            shDegree: model.shDegree,
            timings: model.timings
        };
        model.timings.wall.resultAssemblyMs = performance.now() - resultAssemblyStartedAt;
        const resultAssemblyEndedAbsMs = absoluteNowMs();
        addTimelineEvent(model.timings, 'result.assembly', resultAssemblyStartedAbsMs, resultAssemblyEndedAbsMs);
        model.resolve(result);
    } catch (error) {
        failModel(model, error);
    }
}

async function recoverShardWorker(record, error) {
    const model = activeModel;
    if (!model || model.canceled || model.settled || shardPool[record.poolIndex] !== record) return;
    const failedRange = record.inflight;
    if (!failedRange || failedRange.retries >= 1) {
        decoderSessionPrewarmPromise = null;
        terminateShardRecord(record);
        failModel(model, error);
        return;
    }
    if (failedRange.timeoutId) clearTimeout(failedRange.timeoutId);
    decoderSessionPrewarmPromise = null;
    terminateShardRecord(record, error);
    try {
        const generation = decoderSessionGeneration;
        assertDecoderSessionActive(generation);
        const replacement = createShardWorker(record.workerId, record.poolIndex, generation);
        shardPool[record.poolIndex] = replacement;
        await replacement.readyPromise;
        if (!isDecoderSessionActive(generation) ||
            model !== activeModel || model.canceled || model.settled) return;
        await beginModelOnWorker(replacement, model);
        if (!isDecoderSessionActive(generation) ||
            model !== activeModel || model.canceled || model.settled) return;
        dispatchRange(replacement, model, { ...failedRange, retries: failedRange.retries + 1, timeoutId: undefined });
    } catch (replacementError) {
        decoderSessionPrewarmPromise = null;
        failModel(model, new Error(`${error.message} Replacement worker failed: ${replacementError.message}`));
    }
}

function handleShardWorkerCrash(record, error) {
    if (!record.alive) return;
    const failure = error instanceof Error ? error : new Error(error?.message || String(error));
    const wasReady = record.ready;
    record.alive = false;
    record.ready = false;
    if (wasReady || !activeWarmupProgress) decoderSessionPrewarmPromise = null;
    if (record.readyTimeoutId) {
        clearTimeout(record.readyTimeoutId);
        record.readyTimeoutId = null;
    }
    if (record.readyReject) {
        record.readyReject(failure);
        record.readyResolve = null;
        record.readyReject = null;
    }
    if (record.modelReady) {
        clearTimeout(record.modelReady.timeoutId);
        record.modelReady.reject(failure);
        record.modelReady = null;
    }
    const shouldRecover = !!record.inflight;
    terminateShardRecord(record, failure);
    if (shouldRecover) {
        recoverShardWorker(record, failure).catch((recoveryError) => {
            if (activeModel && !activeModel.settled) failModel(activeModel, recoveryError);
        });
    }
}

function handleShardWorkerMessage(record, message, handlerReceiveAbsMs) {
    if (!isDecoderSessionActive(record.sessionGeneration) ||
        shardPool[record.poolIndex] !== record || !record.alive) {
        return;
    }
    try {
        assertProtocol(message);
        if (message.workerId !== record.workerId) {
            throw new Error(`Shard worker identity mismatch: ${message.workerId}/${record.workerId}`);
        }
        if (message.type === 'ready') {
            const readyAt = performance.now();
            record.readyReceiveAbsMs = handlerReceiveAbsMs;
            record.idleSinceAbsMs = handlerReceiveAbsMs;
            record.workerWarmupTrace = message.warmupTrace || null;
            if (record.readyTimeoutId) {
                clearTimeout(record.readyTimeoutId);
                record.readyTimeoutId = null;
            }
            record.ready = true;
            record.moduleSource = message.moduleSource || record.moduleSource;
            record.moduleFallbackReason = message.moduleFallbackReason || record.moduleFallbackReason;
            record.moduleInitMs = roundTimingMs(message.moduleInitMs);
            record.startupMs = roundTimingMs(readyAt - record.createdAt);
            record.roundTripMs = roundTimingMs(readyAt - (record.initPostedAt ?? record.createdAt));
            record.resourceTiming = normalizeResourceTiming(message.resourceTiming);
            const resolve = record.readyResolve;
            record.readyResolve = null;
            record.readyReject = null;
            resolve(message);
            const readyWorkerCount = shardPool.reduce(
                (count, item) => count + (item?.alive && item.ready ? 1 : 0),
                0
            );
            const usesSharedModule = record.moduleSource === 'shared-compiled-module';
            postWarmupProgress(
                `shard-${readyWorkerCount}-ready`,
                `Shard workers ready ${readyWorkerCount}/${configuredShardWorkerCount}` +
                    ` (${usesSharedModule ? 'shared precompiled module' : 'independent-load fallback'})`,
                {
                    workerId: record.workerId,
                    readyWorkerCount,
                    moduleSource: record.moduleSource,
                    moduleFallbackReason: record.moduleFallbackReason
                }
            );
        } else if (message.type === 'modelReady') {
            if (record.modelReady && record.modelReady.modelId === message.modelId &&
                record.modelReady.requestId === message.requestId) {
                clearTimeout(record.modelReady.timeoutId);
                const resolve = record.modelReady.resolve;
                record.modelReady = null;
                // Do not charge warmup/model initialization time as worker idle
                // time; idle accounting starts with the first model dispatch.
                record.idleSinceAbsMs = undefined;
                record.currentModelId = message.modelId;
                resolve(message);
            }
        } else if (message.type === 'shardResult') {
            handleShardResult(record, message, handlerReceiveAbsMs);
        } else if (message.type === 'workerError') {
            const error = new Error(message.error || `Shard worker ${record.workerId} failed.`);
            error.details = message.details;
            if (record.readyReject) {
                handleShardWorkerCrash(record, error);
                return;
            }
            if (record.modelReady) {
                if (message.modelId !== record.modelReady.modelId ||
                    message.requestId !== record.modelReady.requestId) return;
                clearTimeout(record.modelReady.timeoutId);
                record.modelReady.reject(error);
                record.modelReady = null;
            }
            if (activeModel && message.modelId === activeModel.modelId &&
                message.requestId === activeModel.requestId) {
                failModel(activeModel, error);
            }
        }
    } catch (error) {
        handleShardWorkerCrash(record, error);
    }
}

function createModel(prepared, metadata, auxiliary, requestId, videoTimings,
    traceOriginAbsMs, reconstructionTraceLevel) {
    const modelId = nextModelId++;
    const normalizedTraceOriginAbsMs = Number.isFinite(traceOriginAbsMs) ? traceOriginAbsMs : absoluteNowMs();
    const normalizedTraceLevel = reconstructionTraceLevel === 'js' ? 'js' : 'off';
    const workerCount = Math.max(1, configuredShardWorkerCount);
    const baseBlocksPerShard = prepared.decodeFeaturesRest ? CPU_BLOCKS_PER_SHARD : GPU_BLOCKS_PER_SHARD;
    // Keep enough work available for each worker while avoiding dozens of tiny
    // coordinator pack/serialize calls on small models. The packet ABI and
    // block-aligned ranges remain unchanged; only the default slice size adapts.
    // A bounded number of waves keeps every worker fed while making each
    // coordinator pack large enough to amortize per-shard map/serialization
    // overhead. The multiplier cap keeps packets bounded on large models.
    // Keep two waves for the small default pool, but avoid creating twice as
    // many packets as workers on larger pools.  Every packet repeats the
    // coordinator-side unpack/merge/serialize walk; with eight workers and
    // sixteen packets that overhead dominated the short reconstruction jobs.
    const targetShardCount = Math.max(workerCount <= 2 ? workerCount * 2 : workerCount, 1);
    const idealBlocksPerShard = Math.ceil(prepared.blockCount / targetShardCount);
    const adaptiveMultiplier = workerCount >= 4 ? MAX_ADAPTIVE_SHARD_MULTIPLIER * 2 : MAX_ADAPTIVE_SHARD_MULTIPLIER;
    const blocksPerShard = Math.max(baseBlocksPerShard,
        Math.min(baseBlocksPerShard * adaptiveMultiplier, idealBlocksPerShard));
    const model = {
        modelId,
        requestId,
        traceOriginAbsMs: normalizedTraceOriginAbsMs,
        reconstructionTraceLevel: normalizedTraceLevel,
        pointCount: prepared.pointCount,
        sourcePointCount: prepared.pointCount,
        postprocessCompaction: false,
        minimumAlpha: 1,
        postprocessCompacted: false,
        gpuScaleRotations: null,
        gpuCenterColors: null,
        gpuCompressedTextureUV: null,
        shDegree: prepared.shDegree,
        blockCount: prepared.blockCount,
        pointsPerBlock: prepared.pointsPerBlock,
        blocksPerShard,
        metadata,
        positions: new Float32Array(prepared.pointCount * 3),
        scales: new Float32Array(prepared.pointCount * 3),
        rotations: new Float32Array(prepared.pointCount * 4),
        colors: new Uint8Array(prepared.pointCount * 4),
        validity: new Uint8Array(prepared.pointCount),
        featuresRest: prepared.decodeFeaturesRest ? new Float32Array(prepared.pointCount * 45) : null,
        ...auxiliary,
        nextBlock: 0,
        nextShardId: 1,
        completedBlocks: 0,
        completedPoints: 0,
        previewSent: false,
        previewEnabled: false,
        packetQueue: [],
        packetQueueBytes: 0,
        maxPacketBytes: 0,
        pumpChannel: null,
        pumpScheduled: false,
        canceled: false,
        settled: false,
        deadlineId: null,
        resolve: null,
        reject: null,
        completion: null,
        timings: {
            prepare: {
                parseMs: prepared.parseMs,
                decodeNonVideoSubstreamsMs: prepared.decodeNonVideoSubstreamsMs,
                astcTextureDecodeMs: prepared.astcTextureDecodeMs,
                bcTextureEncodeMs: prepared.bcTextureEncodeMs,
                textureInputBytes: prepared.textureInputBytes,
                textureOutputBytes: prepared.textureOutputBytes,
                decodeVideoFallbackMs: prepared.decodeVideoFallbackMs,
                ffmpeg: (() => {
                    try {
                        return prepared.ffmpegDiagnosticsJson ? JSON.parse(prepared.ffmpegDiagnosticsJson) : null;
                    } catch (_) {
                        return null;
                    }
                })(),
                decodeSubstreamsMs: prepared.decodeSubstreamsMs,
                totalMs: prepared.totalMs,
                substreams: buildSubstreamTimings(prepared, videoTimings),
                ...videoTimings
            },
            packShardMs: 0,
            unpackMs: 0,
            taskExportCopyMs: 0,
            resultMergeMs: 0,
            pruneMs: 0,
            dispatch: {
                dispatchCount: 0,
                packedShardCount: 0,
                workerIdleMs: 0,
                queueWaitMs: 0,
                peakQueuedPackets: 0,
                peakQueuedBytes: 0,
                inflight: 0,
                maxInflight: 0,
                blocksPerShard,
                targetShardCount
            },
            wall: {
                ...(prepared.wallTimings || {}),
                clockMethod: absoluteClockMethod(),
                traceOriginAbsMs: normalizedTraceOriginAbsMs
            },
            timelineEvents: Array.isArray(prepared.wallTimings?.timelineEvents) ?
                prepared.wallTimings.timelineEvents : [],
            shards: {},
            ...(normalizedTraceLevel === 'js' ? {
                shardTrace: {
                    schema: 'uwa.reconstruction.shard-trace.v1',
                    clock: 'performance.timeOrigin+performance.now; fallback=Date.now',
                    origin: normalizedTraceOriginAbsMs,
                    originAbsMs: normalizedTraceOriginAbsMs,
                    level: normalizedTraceLevel,
                    tasks: [],
                    droppedTaskCount: 0,
                    truncated: false,
                    workerSummaries: []
                }
            } : {})
        }
    };
    model.completion = new Promise((resolve, reject) => {
        model.resolve = resolve;
        model.reject = reject;
    });
    model.deadlineId = setTimeout(() => failModel(model, new Error('SplatUWA model decode timed out.')), MODEL_TIMEOUT_MS);
    return model;
}

async function decodeTextureStrategy(request, textureStrategyValue) {
    const decodeStartedAt = performance.now();
    const decodeStartedEpochMs = Date.now();
    const decodeStartedAbsMs = absoluteNowMs();
    const timelineEvents = [];
    const textureStrategy = normalizeTextureStrategy(textureStrategyValue);
    if (textureStrategy === TextureStrategy.BC7 && !coordinatorTextureBuildCapabilities.bc7) {
        throw new Error('BC7 texture strategy requested, but this worker build has no BC7 encoder.');
    }
    if (textureStrategy === TextureStrategy.BC3 && !coordinatorTextureBuildCapabilities.bc3) {
        throw new Error('BC3 texture strategy requested, but this worker build has no BC3 encoder.');
    }

    const payloadExtractStartedAt = performance.now();
    const payloadExtractStartedAbsMs = absoluteNowMs();
    const payload = extractUwaCompressedPayload(request.buffer);
    const input = new Uint8Array(payload.bytes);
    const payloadExtractMs = performance.now() - payloadExtractStartedAt;
    addTimelineEvent({ timelineEvents }, 'prepare.payload-extract', payloadExtractStartedAbsMs, absoluteNowMs());
    postProgress(request.requestId, `payload ${payload.reason}, bytes=${input.byteLength}`);
    const moduleStartedAt = performance.now();
    const Module = await getCoordinatorModule();
    const coordinatorModuleWaitMs = performance.now() - moduleStartedAt;
    const preparation = {
        requestId: request.requestId,
        abortController: new AbortController()
    };
    activePreparation = preparation;
    let model = null;
    let coordinatorPrepareStartedAbsMs;
    try {
        const inputCopyStartedAt = performance.now();
        const inputPtr = Module._malloc(input.byteLength);
        if (!inputPtr) throw new Error(`Failed to allocate ${input.byteLength} coordinator input bytes.`);
        let staged;
        try {
            Module.HEAPU8.set(input, inputPtr);
            const beginPrepareStartedAt = performance.now();
            const beginPrepareStartedAbsMs = absoluteNowMs();
            coordinatorPrepareStartedAbsMs = beginPrepareStartedAbsMs;
            staged = coordinator.beginPrepare(
                inputPtr, input.byteLength, textureStrategyToNativeMode(textureStrategy), payload.compressedPayload
            );
            const beginPrepareEndedAbsMs = absoluteNowMs();
            addTimelineEvent({ timelineEvents }, 'prepare.begin', beginPrepareStartedAbsMs, beginPrepareEndedAbsMs);
            staged.wallTimings = {
                requestToDecodeStartMs: Number.isFinite(request.postedEpochMs) ? decodeStartedEpochMs - request.postedEpochMs : 0,
                payloadExtractMs,
                coordinatorModuleWaitMs,
                inputHeapCopyAndMallocMs: beginPrepareStartedAt - inputCopyStartedAt,
                beginPrepareWallMs: performance.now() - beginPrepareStartedAt,
                timelineEvents
            };
        } finally {
            Module._free(inputPtr);
        }
        if (!staged.success) {
            throw new Error(coordinator.getLastError() || 'Coordinator staged prepare failed.');
        }
        if (staged.protocolVersion !== PROTOCOL_VERSION || staged.buildVersion !== BUILD_VERSION) {
            throw new Error('Coordinator staged artifact protocol/build mismatch.');
        }

        const videoPrepareStartedAt = performance.now();
        const videoPrepareStartedAbsMs = absoluteNowMs();
        const videoTimings = await preparePendingVideos(Module, staged, preparation);
        const videoPrepareWallMs = performance.now() - videoPrepareStartedAt;
        addTimelineEvent({ timelineEvents }, 'prepare.video', videoPrepareStartedAbsMs, absoluteNowMs());
        assertPreparationActive(preparation);
        const finishPrepareStartedAt = performance.now();
        const finishPrepareStartedAbsMs = absoluteNowMs();
        const prepared = coordinator.finishPrepare();
        const finishPrepareEndedAbsMs = absoluteNowMs();
        addTimelineEvent({ timelineEvents }, 'prepare.finish', finishPrepareStartedAbsMs, finishPrepareEndedAbsMs);
        addTimelineEvent({ timelineEvents }, 'prepare', coordinatorPrepareStartedAbsMs, finishPrepareEndedAbsMs);
        prepared.wallTimings = {
            ...(staged.wallTimings || {}),
            videoPrepareWallMs,
            finishPrepareWallMs: performance.now() - finishPrepareStartedAt,
            timelineEvents
        };
        if (!prepared.success) {
            throw new Error(coordinator.getLastError() || 'Coordinator finish prepare failed.');
        }
        if (prepared.protocolVersion !== PROTOCOL_VERSION || prepared.buildVersion !== BUILD_VERSION) {
            throw new Error('Coordinator artifact protocol/build mismatch.');
        }
        if (prepared.pointCount === 0 || prepared.blockCount === 0 || prepared.pointsPerBlock === 0) {
            throw new Error('Coordinator returned an invalid decode descriptor.');
        }
        const expectsCpuFeatures = textureStrategy === TextureStrategy.CPU;
        const requestedNativeMode = textureStrategyToNativeMode(textureStrategy);
        if (Number.isFinite(prepared.textureOutputMode) && prepared.textureOutputMode !== requestedNativeMode) {
            throw new Error(
                `Coordinator returned texture mode ${prepared.textureOutputMode}; requested ${requestedNativeMode}.`
            );
        }
        if (!!prepared.decodeFeaturesRest !== expectsCpuFeatures) {
            throw new Error(
                `Coordinator returned an output mode inconsistent with ${textureStrategy} texture strategy.`
            );
        }

        const auxiliaryCopyStartedAt = performance.now();
        const auxiliaryCopyStartedAbsMs = absoluteNowMs();
        const metadata = Module.HEAPU8.slice(prepared.metadataPtr, prepared.metadataPtr + prepared.metadataSize).buffer;
        const shnMins = prepared.shnMinsCount > 0 && prepared.shnMinsPtr > 0 ?
            new Float32Array(Module.HEAPF32.slice(prepared.shnMinsPtr >>> 2,
                (prepared.shnMinsPtr >>> 2) + prepared.shnMinsCount)) : new Float32Array(0);
        const shnMaxs = prepared.shnMaxsCount > 0 && prepared.shnMaxsPtr > 0 ?
            new Float32Array(Module.HEAPF32.slice(prepared.shnMaxsPtr >>> 2,
                (prepared.shnMaxsPtr >>> 2) + prepared.shnMaxsCount)) : new Float32Array(0);
        let compressedTextureData = null;
        if (textureStrategy !== TextureStrategy.CPU) {
            const raw = prepared.astcRawSize > 0 ?
                Module.HEAPU8.slice(prepared.astcRawPtr, prepared.astcRawPtr + prepared.astcRawSize) : null;
            const uvs = prepared.astcUvCount > 0 ?
                Module.HEAPU32.slice(prepared.astcUvPtr >>> 2,
                    (prepared.astcUvPtr >>> 2) + prepared.astcUvCount) : null;
            const metas = prepared.astcMetasCount > 0 ?
                Module.HEAPU32.slice(prepared.astcMetasPtr >>> 2,
                    (prepared.astcMetasPtr >>> 2) + prepared.astcMetasCount) : null;
            if (!raw || !uvs || !metas || metas.length < 6 || metas.length % 6 !== 0) {
                throw new Error(`Coordinator returned an incomplete ${textureStrategy} texture payload.`);
            }
            if (uvs.length !== prepared.pointCount * 2) {
                throw new Error(`Coordinator returned an invalid ${textureStrategy} UV count.`);
            }
            const blockWidth = metas[0];
            const blockHeight = metas[0];
            const width = metas[1];
            const height = metas[2];
            const layers = metas.length / 6;
            const singleWidth = metas[3];
            const regionPixelCount = metas[4];
            const singleHeight = singleWidth > 0 ? regionPixelCount / singleWidth : 0;
            const validAstcBlocks = [4, 5, 6, 8, 10, 12];
            if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
                width > 16384 || height > 16384 || layers !== 1 || prepared.textureNum !== layers ||
                !Number.isInteger(singleWidth) || !Number.isInteger(singleHeight) ||
                singleWidth <= 0 || singleHeight <= 0 || singleWidth > width || singleHeight > height ||
                regionPixelCount < prepared.pointCount ||
                textureStrategy === TextureStrategy.ASTC && !validAstcBlocks.includes(blockWidth) ||
                textureStrategy !== TextureStrategy.ASTC && (blockWidth !== 4 || blockHeight !== 4) ||
                !Number.isFinite(prepared.shnMin) || !Number.isFinite(prepared.shnMax) ||
                prepared.shnMax < prepared.shnMin) {
                throw new Error(`Coordinator returned invalid ${textureStrategy} texture metadata.`);
            }
            let metadataBytes = 0;
            for (let layer = 0; layer < layers; layer++) {
                const offset = layer * 6;
                if (metas[offset] !== blockWidth || metas[offset + 1] !== width || metas[offset + 2] !== height ||
                    metas[offset + 3] !== singleWidth || metas[offset + 4] !== regionPixelCount) {
                    throw new Error(`Coordinator returned inconsistent ${textureStrategy} texture layers.`);
                }
                metadataBytes += metas[offset + 5];
            }
            const expectedBytes = Math.ceil(width / blockWidth) * Math.ceil(height / blockHeight) * 16 * layers;
            if (raw.byteLength !== metadataBytes || raw.byteLength !== expectedBytes) {
                throw new Error(`Coordinator returned an invalid ${textureStrategy} texture byte count.`);
            }
            compressedTextureData = {
                format: textureStrategy,
                raw,
                uvs,
                metas,
                width,
                height,
                layers,
                blockWidth,
                blockHeight,
                singleWidth,
                singleHeight,
                shnMin: prepared.shnMin,
                shnMax: prepared.shnMax,
                shnMins,
                shnMaxs,
                textureNum: prepared.textureNum
            };
        }
        prepared.wallTimings.auxiliaryCopyMs = performance.now() - auxiliaryCopyStartedAt;
        addTimelineEvent({ timelineEvents }, 'prepare.auxiliary-copy', auxiliaryCopyStartedAbsMs, absoluteNowMs());
        const auxiliary = { compressedTextureData };
        const shardPoolWaitStartedAt = performance.now();
        const shardPoolWaitStartedAbsMs = absoluteNowMs();
        const readyShardPool = await ensureTargetShardPool(decoderSessionGeneration, request.reconstructionWorkerCount);
        prepared.wallTimings.shardPoolWaitMs = performance.now() - shardPoolWaitStartedAt;
        addTimelineEvent({ timelineEvents }, 'prepare.shard-pool', shardPoolWaitStartedAbsMs, absoluteNowMs());
        assertPreparationActive(preparation);

        model = createModel(
            prepared, metadata, auxiliary, request.requestId, videoTimings,
            request.traceOriginAbsMs, request.reconstructionTraceLevel
        );
        model.postprocessCompaction = request.postprocessCompaction === true;
        model.minimumAlpha = Number.isFinite(request.minimumAlpha) ? request.minimumAlpha : 1;
        model.previewEnabled = request.enablePreview === true;
        model.timings.workerCount = configuredShardWorkerCount;
        model.timings.dispatchPipeline = 'bounded-packet-prefetch-v1';
        activePreparation = null;
        activeModel = model;
        postProgress(request.requestId,
            `prepared points=${model.pointCount}, blocks=${model.blockCount}, ` +
            `video=${videoTimings.videoDecoderPath}, shardWorkers=${configuredShardWorkerCount}`);
        try {
            const beginShardWorkersStartedAt = performance.now();
            await Promise.all(readyShardPool.map((record) => beginModelOnWorker(record, model)));
            model.timings.wall.beginShardWorkersMs = performance.now() - beginShardWorkersStartedAt;
            model.timings.wall.reconstructionStartedAt = performance.now();
            model.timings.wall.reconstructionStartAbsMs = absoluteNowMs();
            model.timings.wall.reconstructionStartSinceTraceOriginMs =
                model.timings.wall.reconstructionStartAbsMs - model.timings.wall.traceOriginAbsMs;
            readyShardPool.forEach((record) => {
                record.idleSinceAbsMs = model.timings.wall.reconstructionStartAbsMs;
            });
            pumpDispatch(model);
        } catch (error) {
            failModel(model, error);
        }
        const result = await model.completion;
        addTimelineEvent(model.timings, 'decode', decodeStartedAbsMs, absoluteNowMs());
        result.timings.wall.totalDecodeFunctionMs = performance.now() - decodeStartedAt;
        return result;
    } finally {
        if (activePreparation === preparation) activePreparation = null;
        coordinator?.release();
        if (activeModel === model) activeModel = null;
    }
}

function isTerminalTextureStrategyError(error) {
    const message = error?.message || String(error);
    return error?.name === 'AbortError' || /cancel|disposed|timed out|protocol\/build mismatch/i.test(message);
}

async function decode(request) {
    await prewarmDecoderSession(0, null, request.reconstructionWorkerCount);
    assertDecoderSessionActive();
    if (activePreparation || activeModel && !activeModel.settled) {
        throw new Error('A SplatUWA model is already being decoded.');
    }
    if (!(request.buffer instanceof ArrayBuffer)) throw new Error('Decode request is missing an ArrayBuffer.');

    const textureStrategies = normalizeTextureStrategyChain(
        request.textureStrategies || request.textureStrategy,
        TextureStrategy.CPU
    );
    const attempts = [];
    const failures = [];
    for (const textureStrategy of textureStrategies) {
        attempts.push(textureStrategy);
        try {
            const data = await decodeTextureStrategy(request, textureStrategy);
            data.textureStrategy = textureStrategy;
            data.textureAttempts = attempts.slice();
            data.textureFallbackErrors = failures;
            return data;
        } catch (error) {
            failures.push({ strategy: textureStrategy, message: error?.message || String(error) });
            if (isTerminalTextureStrategyError(error)) throw error;
            if (verboseLog) {
                console.warn(
                    `[SplatUWA coordinator] Texture strategy ${textureStrategy} failed; ` +
                    `trying the next fallback.`, error
                );
            }
        }
    }

    const summary = failures.map((failure) => `${failure.strategy}: ${failure.message}`).join('; ');
    const error = new Error(`All texture strategies failed (${attempts.join(' -> ')}). ${summary}`);
    error.details = { textureAttempts: attempts, textureFailures: failures };
    throw error;
}

function buildErrorDetails(error, stage) {
    return {
        name: error?.name,
        message: error?.message || String(error),
        stack: error?.stack,
        stage,
        modelId: activeModel?.modelId,
        requestId: activeModel?.requestId ?? activePreparation?.requestId,
        details: error?.details
    };
}

export function transferDecodeResult(requestId, data) {
    const transferPrepStartedAt = performance.now();
    const transferPrepStartedAbsMs = absoluteNowMs();
    const transferList = [];
    const transferredBuffers = new Set();
    const addTransfer = (value) => {
        const buffer = value?.buffer;
        if (!buffer || transferredBuffers.has(buffer)) return;
        transferredBuffers.add(buffer);
        transferList.push(buffer);
    };
    addTransfer(data.positions);
    addTransfer(data.scales);
    addTransfer(data.rotations);
    addTransfer(data.colors);
    addTransfer(data.featuresRest);
    addTransfer(data.gpuScaleRotations);
    addTransfer(data.gpuCenterColors);
    addTransfer(data.gpuCompressedTextureUV);
    if (data.compressedTextureData) {
        addTransfer(data.compressedTextureData.raw);
        addTransfer(data.compressedTextureData.uvs);
        addTransfer(data.compressedTextureData.metas);
    }
    const transferPrepEndedAbsMs = absoluteNowMs();
    const sentAt = performance.now();
    const sentEpochMs = Date.now();
    if (data.timings?.wall) {
        data.timings.wall.transferPrepMs = sentAt - transferPrepStartedAt;
        data.timings.wall.sentAt = sentAt;
        data.timings.wall.sentEpochMs = sentEpochMs;
        addTimelineEvent(data.timings, 'transfer.prepare', transferPrepStartedAbsMs, transferPrepEndedAbsMs);
    }
    self.postMessage({
        type: 'decodeResult',
        protocolVersion: PROTOCOL_VERSION,
        buildVersion: BUILD_VERSION,
        requestId,
        success: true,
        data,
        sentAt,
        sentEpochMs
    }, transferList);
}

function dispose() {
    if (!decoderSessionActive) return;
    decoderSessionActive = false;
    decoderSessionGeneration++;
    activeWarmupProgress = null;
    webCodecsProbeAbortController?.abort(sessionDisposedError());
    if (activePreparation && !activePreparation.abortController.signal.aborted) {
        activePreparation.abortController.abort(new Error('Decoder disposed.'));
    }
    if (activeModel && !activeModel.settled) failModel(activeModel, new Error('Decoder disposed.'));
    try {
        coordinator?.release();
    } catch (_) {}
    shardPool.forEach((record) => {
        if (!record) return;
        if (record.alive && record.worker) {
            try {
                record.worker.postMessage({
                    type: 'dispose',
                    protocolVersion: PROTOCOL_VERSION,
                    buildVersion: BUILD_VERSION,
                    workerId: record.workerId
                });
            } catch (_) {}
        }
        terminateShardRecord(record, sessionDisposedError());
    });
    shardPool = [];
    coordinator?.delete();
    coordinator = null;
    coordinatorModule = null;
    coordinatorModulePromise = null;
    reconstructionModulePreparation = null;
    reconstructionModulePreparationPromise = null;
    coordinatorWasmUrl = COORDINATOR_WASM_URL;
    coordinatorFlavor = 'single-thread';
    coordinatorTextureBuildCapabilities = { ...TextureBuildCapabilities };
    decoderSessionPrewarmPromise = null;
    webCodecsSessionPolicy = null;
    webCodecsSessionPolicyPromise = null;
    webCodecsProbeAbortController = null;
    webCodecsProbeStatus = 'disposed';
    webCodecsNegativeCapabilities.clear();
}

export async function handleDecoderWorkerMessage(event) {
    const handlerReceiveAbsMs = absoluteNowMs();
    const request = event.data || {};
    const requestId = request.requestId ?? 0;
    const requestWarmupTrace = request.type === 'warmup' ?
        createDecoderWarmupTrace(handlerReceiveAbsMs, requestId, request.bootstrapTrace) : null;
    verboseLog = !!request.verboseLog;
    let stage = request.type || 'unknown';
    try {
        if (request.type === 'warmup') {
            assertProtocol(request);
            const startedAt = performance.now();
            const stats = await prewarmDecoderSession(
                requestId, requestWarmupTrace, request.reconstructionWorkerCount
            );
            const response = {
                type: 'warmupResult',
                protocolVersion: PROTOCOL_VERSION,
                buildVersion: BUILD_VERSION,
                requestId,
                success: true,
                elapsedMs: performance.now() - startedAt,
                stats
            };
            stats.warmupTrace.decoder.resultPostBeginAbsMs = absoluteNowMs();
            self.postMessage(response);
        } else if (request.type === 'decode') {
            assertProtocol(request);
            stage = 'decode';
            const data = await decode(request);
            if (verboseLog) console.log('[SplatUWA coordinator] timings', data.timings);
            transferDecodeResult(requestId, data);
        } else if (request.type === 'cancelModel') {
            assertProtocol(request);
            if (activePreparation && (!request.requestId || activePreparation.requestId === request.requestId) &&
                !activePreparation.abortController.signal.aborted) {
                activePreparation.abortController.abort(new Error('SplatUWA decode canceled.'));
            } else if (activeModel && (!request.modelId || activeModel.modelId === request.modelId)) {
                failModel(activeModel, new Error('SplatUWA decode canceled.'));
            }
        } else if (request.type === 'dispose') {
            dispose();
            self.postMessage({
                type: 'disposeResult',
                protocolVersion: PROTOCOL_VERSION,
                buildVersion: BUILD_VERSION,
                requestId,
                success: true
            });
            self.close();
        } else {
            throw new Error(`Unknown decoder worker request type: ${request.type}`);
        }
    } catch (error) {
        if (!decoderSessionActive && request.type !== 'dispose') return;
        const details = buildErrorDetails(error, stage);
        const response = {
            type: request.type === 'warmup' ? 'warmupResult' :
                (request.type === 'dispose' ? 'disposeResult' : 'decodeResult'),
            protocolVersion: PROTOCOL_VERSION,
            buildVersion: BUILD_VERSION,
            requestId,
            success: false,
            error: details.message,
            details,
            ...(requestWarmupTrace ? { stats: { warmupTrace: requestWarmupTrace } } : {})
        };
        if (requestWarmupTrace) {
            requestWarmupTrace.decoder.resultPostBeginAbsMs = absoluteNowMs();
            requestWarmupTrace.attempt.status = 'error';
            requestWarmupTrace.attempt.failureStage = stage;
        }
        self.postMessage(response);
    }
}

if (!self.__UWA_SPLAT_DECODER_BOOTSTRAP__) {
    self.onmessage = handleDecoderWorkerMessage;
}
