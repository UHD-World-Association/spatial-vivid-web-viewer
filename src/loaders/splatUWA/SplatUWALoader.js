import * as THREE from 'three';
import { SplatBuffer } from '../SplatBuffer.js';
import { UncompressedSplatArray } from '../UncompressedSplatArray.js';
import { LoaderStatus } from '../LoaderStatus.js';
import { AbortablePromise, AbortedPromiseError } from '../../AbortablePromise.js';
import { fetchWithProgress, getSphericalHarmonicsComponentCountForDegree } from '../../Util.js';
import {
    normalizeTextureStrategyChain,
    normalizeTextureStrategy,
    probeWebGL2TextureCapabilities,
    selectTextureStrategyChain,
    TextureBuildCapabilities,
    TextureStrategy
} from './TextureStrategy.js';
import { copyCoefficientMajorRgbToChannelMajor } from './SphericalHarmonicsLayout.js';
import { processDecodedModel } from './postprocess/UwaPostprocess.js';

const DECODER_WORKER_URL = 'lib/SplatDecoderBootstrap.worker.js';
const DECODER_REQUEST_TIMEOUT_MS = 60000;
const DECODER_DISPOSE_TIMEOUT_MS = 5000;
const DECODER_PROTOCOL_VERSION = 2;
const DECODER_BUILD_VERSION = 20260909;

let decoderWorkerState = null;
let decoderRequestChain = Promise.resolve();
let decoderWarmupPromise = null;
let decoderDisposePromise = null;
let decoderLifecycleGeneration = 0;

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

function sumTimingMs(...values) {
    let total = 0;
    let hasValue = false;
    for (const value of values) {
        if (!Number.isFinite(value)) continue;
        total += value;
        hasValue = true;
    }
    return hasValue ? total : undefined;
}

function emitTimingTable(label, scalarRows) {
    if (typeof console === 'undefined') return;

    const rows = scalarRows.filter((row) => Number.isFinite(row.ms)).map((row) => ({
        phase: row.phase,
        ms: roundTimingMs(row.ms)
    }));
    let groupOpened = false;
    try {
        if (typeof console.group === 'function') {
            console.group(label);
            groupOpened = true;
        } else if (typeof console.log === 'function') {
            console.log(label);
        }
        if (rows.length > 0) {
            if (typeof console.table === 'function') console.table(rows);
            else if (typeof console.log === 'function') console.log(rows);
        }
    } catch (_) {
        // Timing diagnostics must never interrupt loading.
    } finally {
        if (groupOpened && typeof console.groupEnd === 'function') {
            try {
                console.groupEnd();
            } catch (_) {}
        }
    }
}

function addLoaderTimings(message, inflight, responseAt) {
    const responseEpochMs = Date.now();
    return {
        ...message,
        loaderTimings: {
            queueWaitMs: roundTimingMs(inflight.queueWaitMs),
            workerRoundTripMs: roundTimingMs(responseAt - inflight.postedAt),
            postMessageReturnMs: roundTimingMs(Number.isFinite(message.sentEpochMs) ?
                responseEpochMs - message.sentEpochMs : 0),
            requestTotalMs: roundTimingMs(responseAt - inflight.enqueuedAt),
            ...(inflight.warmupMainEndpoints ? {
                warmupMainEndpoints: inflight.warmupMainEndpoints
            } : {})
        }
    };
}

function buildWorkerFailure(message, error) {
    const failure = new Error(message);
    if (error) failure.cause = error;
    return failure;
}

function resetDecoderWorkerState(state, error = null) {
    if (!state) return;

    if (state.inflight) {
        if (state.inflight.timeoutId) clearTimeout(state.inflight.timeoutId);
        const reject = state.inflight.reject;
        state.inflight = null;
        reject(error || new Error('SplatUWA decoder worker was disposed.'));
    }

    if (state.worker) {
        state.worker.onmessage = null;
        state.worker.onerror = null;
        state.worker.onmessageerror = null;
        state.worker.terminate();
        state.worker = null;
    }

    state.warm = false;
    if (state.disposeTimeoutId) clearTimeout(state.disposeTimeoutId);
    const disposeResolve = state.disposeResolve;
    state.disposeResolve = null;

    if (decoderWorkerState === state) {
        decoderWorkerState = null;
        decoderWarmupPromise = null;
    }
    if (disposeResolve) disposeResolve();
}

function handleDecoderWorkerMessage(state, event) {
    const mainReceiveAbsMs = absoluteNowMs();
    const message = event.data || {};
    const inflight = state.inflight;
    if (inflight?.warmupMainEndpoints) {
        inflight.warmupMainEndpoints.mainReceiveAbsMs = mainReceiveAbsMs;
    }

    if (message.protocolVersion !== DECODER_PROTOCOL_VERSION || message.buildVersion !== DECODER_BUILD_VERSION) {
        resetDecoderWorkerState(state, new Error(
            `SplatUWA worker protocol/build mismatch: ${message.protocolVersion}/${message.buildVersion}`
        ));
        return;
    }

    if (message.type === 'progress') {
        if (inflight && inflight.requestId === message.requestId) {
            if (typeof inflight.onProgress === 'function') {
                try {
                    inflight.onProgress({
                        phase: message.phase || 'progress',
                        message: message.message,
                        elapsedMs: message.elapsedMs,
                        details: message.details || null
                    });
                } catch (_) {
                    // Status observers must never interrupt worker initialization.
                }
            }
            if (inflight.verboseLog) {
                const elapsedMs = Math.round(performance.now() - inflight.startedAt);
                console.log(`[SplatUWA Loader] Worker progress after ${elapsedMs} ms: ${message.message}`);
            }
        }
        return;
    }

    // Preview messages are emitted while the full decode request remains
    // inflight. They carry independent transferred arrays and must never
    // settle or clear the request timeout.
    if (message.type === 'decodePreview') {
        if (inflight && inflight.requestId === message.requestId && typeof inflight.onPreview === 'function') {
            try {
                inflight.onPreview(message.data, message);
            } catch (error) {
                if (inflight.verboseLog) console.warn('[SplatUWA Loader] Preview callback failed.', error);
            }
        }
        return;
    }

    if (message.type === 'disposeResult' && state.disposing &&
        message.requestId === state.disposeRequestId) {
        resetDecoderWorkerState(state);
        return;
    }

    if (!inflight || inflight.requestId !== message.requestId) return;

    const response = addLoaderTimings(message, inflight, performance.now());
    if (inflight.timeoutId) clearTimeout(inflight.timeoutId);
    state.inflight = null;

    if (response.type === 'warmupResult') {
        if (response.success) {
            state.warm = true;
            if (inflight.warmupMainEndpoints) {
                inflight.warmupMainEndpoints.resolveAbsMs = absoluteNowMs();
            }
            inflight.resolve(response);
        } else {
            const failure = buildWorkerFailure(response.error || 'Decoder warmup failed.', response.details);
            inflight.reject(failure);
            resetDecoderWorkerState(state);
        }
        return;
    }

    if (response.type === 'decodeResult') {
        if (response.success) {
            state.warm = true;
            inflight.resolve(response);
        } else {
            inflight.reject(buildWorkerFailure(response.error || 'Worker decoding failed.', response.details));
        }
    }
}

function ensureDecoderWorkerState(warmupMainEndpoints = null) {
    if (decoderWorkerState?.worker) {
        if (warmupMainEndpoints) {
            warmupMainEndpoints.workerCreatedForAttempt = false;
            warmupMainEndpoints.workerConstructor = decoderWorkerState.workerConstructorTrace;
        }
        return decoderWorkerState;
    }

    const workerCreateBeginAbsMs = absoluteNowMs();
    const worker = new Worker(DECODER_WORKER_URL, { type: 'module' });
    const workerCreateEndAbsMs = absoluteNowMs();
    const workerConstructorTrace = {
        clockMethod: absoluteClockMethod(),
        workerCreateBeginAbsMs,
        workerCreateEndAbsMs
    };
    const state = {
        worker,
        workerConstructorTrace,
        nextRequestId: 1,
        inflight: null,
        warm: false,
        warmupDiagnostics: null,
        disposing: false,
        disposeRequestId: 0,
        disposeTimeoutId: null,
        disposeResolve: null
    };

    if (warmupMainEndpoints) {
        warmupMainEndpoints.workerCreatedForAttempt = true;
        warmupMainEndpoints.workerConstructor = workerConstructorTrace;
    }

    worker.onmessage = (event) => {
        handleDecoderWorkerMessage(state, event);
    };

    worker.onerror = (error) => {
        console.error('[SplatUWA Loader] Decoder worker error:', error);
        resetDecoderWorkerState(state, buildWorkerFailure('Decoder worker crashed.', error));
    };

    worker.onmessageerror = (error) => {
        console.error('[SplatUWA Loader] Decoder worker message clone/transfer error:', error);
        resetDecoderWorkerState(state, buildWorkerFailure('Decoder worker message error.', error));
    };

    decoderWorkerState = state;
    return state;
}

function enqueueDecoderWorkerRequest(messageFactory, timeoutMessage, verboseLog = false,
    requestGeneration = decoderLifecycleGeneration, onProgress = null, warmupMainEndpoints = null,
    onPreview = null) {

    const enqueuedAt = performance.now();
    if (warmupMainEndpoints) warmupMainEndpoints.enqueueAbsMs = absoluteNowMs();
    const runRequest = async () => {
        if (warmupMainEndpoints) warmupMainEndpoints.requestRunAbsMs = absoluteNowMs();
        if (decoderDisposePromise) await decoderDisposePromise;
        if (warmupMainEndpoints) warmupMainEndpoints.disposeWaitEndAbsMs = absoluteNowMs();
        if (requestGeneration !== decoderLifecycleGeneration) {
            throw new Error('SplatUWA decoder request was canceled by disposal.');
        }
        if (warmupMainEndpoints) warmupMainEndpoints.ensureBeginAbsMs = absoluteNowMs();
        const state = ensureDecoderWorkerState(warmupMainEndpoints);
        if (warmupMainEndpoints) warmupMainEndpoints.ensureEndAbsMs = absoluteNowMs();
        if (state.disposing) throw new Error('SplatUWA decoder is being disposed.');
        return new Promise((resolve, reject) => {
            const requestId = state.nextRequestId++;
            if (warmupMainEndpoints) warmupMainEndpoints.requestId = requestId;
            const { message, transferList = [] } = messageFactory(requestId);
            const timeoutId = setTimeout(() => {
                if (!state.inflight || state.inflight.requestId !== requestId) return;
                resetDecoderWorkerState(state, new Error(timeoutMessage));
            }, DECODER_REQUEST_TIMEOUT_MS);
            const postedAt = performance.now();

            state.inflight = {
                requestId,
                resolve,
                reject,
                timeoutId,
                startedAt: postedAt,
                enqueuedAt,
                postedAt,
                queueWaitMs: postedAt - enqueuedAt,
                verboseLog,
                onProgress,
                onPreview,
                warmupMainEndpoints
            };

            try {
                if (warmupMainEndpoints) warmupMainEndpoints.mainPostBeginAbsMs = absoluteNowMs();
                state.worker.postMessage(message, transferList);
                if (warmupMainEndpoints) warmupMainEndpoints.mainPostReturnAbsMs = absoluteNowMs();
            } catch (error) {
                resetDecoderWorkerState(state, buildWorkerFailure('Failed to post message to decoder worker.', error));
            }
        });
    };

    const requestPromise = decoderRequestChain.then(runRequest, runRequest);
    decoderRequestChain = requestPromise.then(() => undefined, () => undefined);
    return requestPromise;
}

function roundSignedTimingMs(value) {
    if (!Number.isFinite(value)) return undefined;
    return Math.round(value * 100) / 100;
}

function buildWarmupOuterGap(main, decoder) {
    const definitions = [
        ['call-to-enqueue', main.callAbsMs, main.enqueueAbsMs],
        ['enqueue-to-request-run', main.enqueueAbsMs, main.requestRunAbsMs],
        ['request-run-to-dispose-wait-end', main.requestRunAbsMs, main.disposeWaitEndAbsMs],
        ['dispose-wait-end-to-main-post-return', main.disposeWaitEndAbsMs, main.mainPostReturnAbsMs],
        ['main-post-return-to-decoder-handler', main.mainPostReturnAbsMs, decoder.handlerReceiveAbsMs],
        ['decoder-handler-to-full-ready-begin', decoder.handlerReceiveAbsMs, decoder.fullReadyBeginAbsMs],
        ['full-ready-end-to-result-post', decoder.fullReadyEndAbsMs, decoder.resultPostBeginAbsMs],
        ['result-post-to-main-receive', decoder.resultPostBeginAbsMs, main.mainReceiveAbsMs],
        ['main-receive-to-resolve', main.mainReceiveAbsMs, main.resolveAbsMs],
        ['resolve-to-promise-then', main.resolveAbsMs, main.promiseThenAbsMs]
    ];
    const negativeSegments = [];
    const segments = definitions.map(([phase, startAbsMs, endAbsMs]) => {
        const rawDurationMs = Number.isFinite(startAbsMs) && Number.isFinite(endAbsMs) ?
            endAbsMs - startAbsMs : undefined;
        const valid = Number.isFinite(rawDurationMs) && rawDurationMs >= 0;
        if (Number.isFinite(rawDurationMs) && rawDurationMs < 0) negativeSegments.push(phase);
        return {
            phase,
            startAbsMs,
            endAbsMs,
            startSinceCallMs: Number.isFinite(startAbsMs) && Number.isFinite(main.callAbsMs) ?
                startAbsMs - main.callAbsMs : undefined,
            rawDurationMs,
            durationMs: valid ? roundSignedTimingMs(rawDurationMs) : undefined,
            valid
        };
    });
    const allFinite = segments.every((segment) => Number.isFinite(segment.rawDurationMs));
    const rawSumMs = allFinite ? segments.reduce((sum, segment) => sum + segment.rawDurationMs, 0) : undefined;
    const wallSpanMs = Number.isFinite(main.callAbsMs) && Number.isFinite(main.promiseThenAbsMs) ?
        main.promiseThenAbsMs - main.callAbsMs : undefined;
    const fullReadySpanMs = Number.isFinite(decoder.fullReadyBeginAbsMs) &&
        Number.isFinite(decoder.fullReadyEndAbsMs) ?
        decoder.fullReadyEndAbsMs - decoder.fullReadyBeginAbsMs : undefined;
    const measuredOuterGapMs = Number.isFinite(wallSpanMs) && Number.isFinite(fullReadySpanMs) ?
        wallSpanMs - fullReadySpanMs : undefined;
    const closureErrorMs = Number.isFinite(rawSumMs) && Number.isFinite(measuredOuterGapMs) ?
        rawSumMs - measuredOuterGapMs : undefined;
    return {
        relation: 'strictly-exclusive-chain-outside-full-ready',
        segments,
        rawSumMs,
        measuredOuterGapMs,
        closureErrorMs,
        clockValid: allFinite && negativeSegments.length === 0 &&
            Number.isFinite(fullReadySpanMs) && fullReadySpanMs >= 0,
        negativeSegments
    };
}

function validateWarmupTraceClocks(main, decoder, bootstrap, shardWorkers, outerGap) {
    const definitions = [
        ['main:ensure', main.ensureBeginAbsMs, main.ensureEndAbsMs],
        ['main:worker-constructor', main.workerConstructor?.workerCreateBeginAbsMs,
            main.workerConstructor?.workerCreateEndAbsMs],
        ['main:post-call', main.mainPostBeginAbsMs, main.mainPostReturnAbsMs],
        ['decoder:full-ready', decoder.fullReadyBeginAbsMs, decoder.fullReadyEndAbsMs]
    ];
    for (const [name, branch] of Object.entries(decoder.branches || {})) {
        definitions.push([`decoder:${name}`, branch.beginAbsMs, branch.endAbsMs]);
    }
    if (decoder.reconstructionCompile) {
        definitions.push(['decoder:reconstruction-compile', decoder.reconstructionCompile.beginAbsMs,
            decoder.reconstructionCompile.endAbsMs]);
    }
    const scalarEndpoints = [
        ['decoder:module-body-marker', decoder.moduleBodyStartAbsMs]
    ];
    if (bootstrap) {
        definitions.push(
            ['bootstrap:entry-to-import-begin', bootstrap.bootstrapEntryAbsMs, bootstrap.importBeginAbsMs],
            ['bootstrap:module-graph-import', bootstrap.importBeginAbsMs, bootstrap.importEndAbsMs],
            ['bootstrap:first-message-queue', bootstrap.firstMessageQueuedAbsMs,
                bootstrap.firstMessageDispatchAbsMs]
        );
    }
    for (const shard of shardWorkers) {
        const prefix = `shard-${shard.workerId}`;
        const parent = shard.parent || {};
        const worker = shard.worker || {};
        definitions.push(
            [`${prefix}:constructor`, parent.createBeginAbsMs, parent.createEndAbsMs],
            [`${prefix}:create-to-init-post`, parent.createEndAbsMs, parent.initPostBeginAbsMs],
            [`${prefix}:init-post-call`, parent.initPostBeginAbsMs, parent.initPostReturnAbsMs],
            [`${prefix}:init-delivery`, parent.initPostReturnAbsMs, worker.initHandlerReceiveAbsMs],
            [`${prefix}:handler-to-wasm`, worker.initHandlerReceiveAbsMs, worker.wasmInitBeginAbsMs],
            [`${prefix}:wasm-init`, worker.wasmInitBeginAbsMs, worker.wasmInitEndAbsMs],
            [`${prefix}:wasm-to-ready-post`, worker.wasmInitEndAbsMs, worker.readyPostBeginAbsMs],
            [`${prefix}:ready-post-to-parent-receive`, worker.readyPostBeginAbsMs, parent.readyReceiveAbsMs]
        );
        scalarEndpoints.push([`${prefix}:module-body-marker`, worker.moduleBodyStartAbsMs]);
    }
    const negativeSegments = [...outerGap.negativeSegments];
    const invalidSegments = [];
    for (const [phase, startAbsMs, endAbsMs] of definitions) {
        if (!Number.isFinite(startAbsMs) || !Number.isFinite(endAbsMs)) {
            invalidSegments.push(phase);
        } else if (endAbsMs - startAbsMs < 0) {
            negativeSegments.push(phase);
        }
    }
    for (const [phase, endpointAbsMs] of scalarEndpoints) {
        if (!Number.isFinite(endpointAbsMs)) invalidSegments.push(phase);
    }
    return {
        clockValid: outerGap.clockValid && invalidSegments.length === 0 && negativeSegments.length === 0,
        negativeSegments: [...new Set(negativeSegments)],
        invalidSegments
    };
}

function buildWarmupTrace(result) {
    const statsTrace = result?.stats?.warmupTrace || {};
    const main = result?.loaderTimings?.warmupMainEndpoints || {};
    const decoder = statsTrace.decoder || statsTrace;
    const bootstrap = statsTrace.bootstrap && typeof statsTrace.bootstrap === 'object' ?
        statsTrace.bootstrap : null;
    const resources = Array.isArray(statsTrace.resources) ? statsTrace.resources : [];
    const shardWorkers = Array.isArray(statsTrace.shardWorkers) ? statsTrace.shardWorkers : [];
    const outerGap = buildWarmupOuterGap(main, decoder);
    const clockValidation = validateWarmupTraceClocks(main, decoder, bootstrap, shardWorkers, outerGap);
    const decoderAttempt = statsTrace.attempt || {};
    return {
        schema: 'uwa.warmup.trace.v1',
        attempt: {
            kind: 'physical',
            physical: true,
            cached: false,
            status: decoderAttempt.status || 'success',
            requestId: main.requestId ?? decoderAttempt.requestId,
            lifecycleGeneration: main.lifecycleGeneration ?? decoderAttempt.lifecycleGeneration,
            workerCreatedForAttempt: !!main.workerCreatedForAttempt
        },
        clocks: {
            main: main.clockMethod || 'unknown',
            decoder: decoder.clockMethod || 'unknown',
            bootstrap: bootstrap?.clockMethod || 'not-recorded',
            shardWorkers: shardWorkers.map((worker) => ({
                workerId: worker.workerId,
                parent: worker.parent?.clockMethod || decoder.clockMethod || 'unknown',
                worker: worker.worker?.clockMethod || 'unknown'
            }))
        },
        raw: {
            main,
            decoder,
            bootstrap,
            resources,
            shardWorkers
        },
        resources,
        outerGap,
        clockValid: clockValidation.clockValid,
        negativeSegments: clockValidation.negativeSegments,
        invalidSegments: clockValidation.invalidSegments,
        closureErrorMs: outerGap.closureErrorMs
    };
}

function warmupTraceTableRows(trace) {
    const callAbsMs = trace?.raw?.main?.callAbsMs;
    const rows = [];
    const add = (lane, phase, startAbsMs, endAbsMs, relation) => {
        const rawDurationMs = Number.isFinite(startAbsMs) && Number.isFinite(endAbsMs) ?
            endAbsMs - startAbsMs : undefined;
        rows.push({
            lane,
            phase,
            startSinceCallMs: Number.isFinite(startAbsMs) && Number.isFinite(callAbsMs) ?
                roundSignedTimingMs(startAbsMs - callAbsMs) : undefined,
            durationMs: Number.isFinite(rawDurationMs) && rawDurationMs >= 0 ?
                roundSignedTimingMs(rawDurationMs) : undefined,
            relation
        });
    };
    for (const segment of trace?.outerGap?.segments || []) {
        add('outerGap', segment.phase, segment.startAbsMs, segment.endAbsMs, 'exclusive chain');
    }
    const main = trace?.raw?.main || {};
    add('Main', 'ensure worker', main.ensureBeginAbsMs, main.ensureEndAbsMs, 'overlay');
    add('Main', 'Worker constructor', main.workerConstructor?.workerCreateBeginAbsMs,
        main.workerConstructor?.workerCreateEndAbsMs,
        main.workerCreatedForAttempt ? 'created by physical attempt' : 'historical physical worker');
    add('Main', 'postMessage call', main.mainPostBeginAbsMs, main.mainPostReturnAbsMs, 'overlay');

    const bootstrap = trace?.raw?.bootstrap || {};
    if (Number.isFinite(bootstrap.bootstrapEntryAbsMs)) {
        add('Bootstrap', 'Worker startup to bootstrap entry',
            main.workerConstructor?.workerCreateBeginAbsMs ?? main.callAbsMs,
            bootstrap.bootstrapEntryAbsMs, 'overlap envelope; may overlap main-thread setup');
        add('Bootstrap', 'Decoder module graph import', bootstrap.importBeginAbsMs,
            bootstrap.importEndAbsMs, 'fetch/compile/evaluate envelope; not pure download');
        add('Bootstrap', 'First message queued to dispatch', bootstrap.firstMessageQueuedAbsMs,
            bootstrap.firstMessageDispatchAbsMs, 'message wait; overlaps module graph while loading');
    }

    const decoder = trace?.raw?.decoder || {};
    add('Decoder', 'module body first point', decoder.moduleBodyStartAbsMs, undefined,
        'marker after static imports; excludes static import internals');
    add('Decoder', 'Full ready', decoder.fullReadyBeginAbsMs, decoder.fullReadyEndAbsMs,
        'authoritative internal envelope');
    for (const [name, branch] of Object.entries(decoder.branches || {})) {
        add('Decoder', name, branch.beginAbsMs, branch.endAbsMs, `parallel branch; entry=${branch.entryState}`);
    }
    const compile = decoder.reconstructionCompile || {};
    add('Decoder', 'Reconstruction module compile', compile.beginAbsMs, compile.endAbsMs,
        `${compile.execution || 'unknown'}; shared dependency with shard pool; source=${compile.source || 'unknown'}`);

    for (const shard of trace?.raw?.shardWorkers || []) {
        const parent = shard.parent || {};
        const worker = shard.worker || {};
        const lane = `Shard ${shard.workerId}`;
        add(lane, 'Worker constructor', parent.createBeginAbsMs, parent.createEndAbsMs, 'startup overlay');
        add(lane, 'init post', parent.initPostBeginAbsMs, parent.initPostReturnAbsMs,
            `startup attempt ${shard.startupAttemptId}`);
        add(lane, 'module body first point', worker.moduleBodyStartAbsMs, undefined,
            'marker after static imports; ordering vs post not assumed');
        add(lane, 'WASM init', worker.wasmInitBeginAbsMs, worker.wasmInitEndAbsMs,
            `parallel worker init; source=${shard.moduleSource || 'unknown'}`);
        add(lane, 'ready roundtrip', parent.initPostBeginAbsMs, parent.readyReceiveAbsMs,
            'parallel shard startup');
    }
    return rows;
}

function warmupBootstrapTableRows(trace) {
    const callAbsMs = trace?.raw?.main?.callAbsMs;
    const main = trace?.raw?.main || {};
    const bootstrap = trace?.raw?.bootstrap || {};
    const decoder = trace?.raw?.decoder || {};
    const unavailable = 'N/A';
    const row = (module, phase, startAbsMs, endAbsMs, meaning) => {
        const relative = (value) => Number.isFinite(value) && Number.isFinite(callAbsMs) ?
            roundSignedTimingMs(value - callAbsMs) : unavailable;
        return {
            module,
            phase,
            startSinceCallMs: relative(startAbsMs),
            endSinceCallMs: relative(endAbsMs),
            durationMs: Number.isFinite(startAbsMs) && Number.isFinite(endAbsMs) ?
                roundSignedTimingMs(endAbsMs - startAbsMs) : unavailable,
            meaning
        };
    };
    return [
        row('Bootstrap', 'Worker startup to bootstrap entry',
            main.workerConstructor?.workerCreateBeginAbsMs ?? main.callAbsMs,
            bootstrap.bootstrapEntryAbsMs, 'Worker startup interval; may overlap main-thread preparation'),
        row('Bootstrap', 'Decoder module graph import', bootstrap.importBeginAbsMs,
            bootstrap.importEndAbsMs, bootstrap.importMeaning ||
                'Module graph fetch/compile/evaluation interval; not download time alone'),
        row('Bootstrap', 'First message queued to dispatch', bootstrap.firstMessageQueuedAbsMs,
            bootstrap.firstMessageDispatchAbsMs, 'Message-wait interval; may overlap module graph import during loading'),
        row('Decoder', 'Module body first point', decoder.moduleBodyStartAbsMs, null,
            decoder.moduleBodyMeaning || 'First module-body marker after static imports complete')
    ];
}

function warmupResourceTableRows(trace) {
    const callAbsMs = trace?.raw?.main?.callAbsMs;
    const unavailable = 'N/A';
    const sinceCall = (value) => Number.isFinite(value) && Number.isFinite(callAbsMs) ?
        roundSignedTimingMs(value - callAbsMs) : unavailable;
    return (trace?.resources || []).filter((resource) =>
        resource?.timing && typeof resource.timing === 'object'
    ).map((resource) => {
        const timing = resource.timing;
        const hasTimingEvidence = [
            timing.startTimeAbsMs, timing.fetchStartAbsMs, timing.responseStartAbsMs,
            timing.responseEndAbsMs, timing.durationMs
        ].some(Number.isFinite);
        let cacheEvidence = 'Transfer bytes were not collected; network and cache cannot be distinguished';
        if (Number.isFinite(timing.transferSize) && timing.transferSize > 0) {
            cacheEvidence = 'Network transfer confirmed';
        } else if (timing.transferSize === 0 && hasTimingEvidence) {
            cacheEvidence = 'No measurable transfer occurred (possibly cached or local)';
        }
        const value = (candidate) => Number.isFinite(candidate) ? candidate : unavailable;
        return {
            resourceName: resource.name || resource.kind || 'resource',
            owner: resource.owner || 'unknown',
            url: timing.url || resource.entryUrl || unavailable,
            initiatorType: timing.initiatorType || unavailable,
            protocol: timing.nextHopProtocol || unavailable,
            startSinceCallMs: sinceCall(timing.startTimeAbsMs),
            fetchStartSinceCallMs: sinceCall(timing.fetchStartAbsMs),
            responseStartSinceCallMs: sinceCall(timing.responseStartAbsMs),
            responseEndSinceCallMs: sinceCall(timing.responseEndAbsMs),
            endSinceCallMs: sinceCall(timing.responseEndAbsMs),
            durationMs: Number.isFinite(timing.durationMs) ? roundSignedTimingMs(timing.durationMs) : unavailable,
            transferSize: value(timing.transferSize),
            encodedBodySize: value(timing.encodedBodySize),
            decodedBodySize: value(timing.decodedBodySize),
            cacheEvidence
        };
    });
}

function emitFlatTimingTable(label, rows) {
    let groupOpened = false;
    if (typeof console.group === 'function') {
        console.group(label);
        groupOpened = true;
    } else if (typeof console.log === 'function') {
        console.log(label);
    }
    if (typeof console.table === 'function') console.table(rows);
    else if (typeof console.log === 'function') console.log(rows);
    if (groupOpened && typeof console.groupEnd === 'function') console.groupEnd();
}

function emitWarmupTrace(trace) {
    if (typeof console === 'undefined') return;
    try {
        const rows = warmupTraceTableRows(trace);
        if (typeof console.table === 'function') console.table(rows);
        else if (typeof console.log === 'function') console.log('[SplatUWA Warmup Trace] table', rows);
        if (typeof console.log === 'function') console.log('[SplatUWA Warmup Trace] raw', trace);
        emitFlatTimingTable('[SplatUWA Warmup Bootstrap]', warmupBootstrapTableRows(trace));
        emitFlatTimingTable('[SplatUWA Warmup Resources]', warmupResourceTableRows(trace));
    } catch (_) {
        // Warmup diagnostics must never interrupt initialization.
    }
}

function buildWarmupDiagnostics(result, elapsedMs) {
    const stats = result?.stats || {};
    const loaderTimings = result?.loaderTimings || {};
    const roundedElapsedMs = roundTimingMs(elapsedMs);
    const internalTotalMs = stats.fullReadyMs ?? stats.totalMs ?? stats.parallelInitMs;
    const warmupTrace = buildWarmupTrace(result);
    return {
        elapsedMs: roundedElapsedMs,
        coordinatorModuleMs: roundTimingMs(stats.coordinatorModuleMs),
        shardWarmupMs: roundTimingMs(stats.shardWarmupMs),
        fullReadyMs: roundTimingMs(stats.fullReadyMs ?? stats.totalMs),
        parallelInitMs: roundTimingMs(stats.parallelInitMs ?? stats.totalMs),
        serialEquivalentMs: roundTimingMs(stats.serialEquivalentMs),
        estimatedOverlapMs: roundTimingMs(stats.estimatedOverlapMs),
        outerGapMs: Number.isFinite(elapsedMs) && Number.isFinite(internalTotalMs) ?
            roundSignedTimingMs(elapsedMs - internalTotalMs) : undefined,
        queueWaitMs: roundTimingMs(loaderTimings.queueWaitMs),
        workerRoundTripMs: roundTimingMs(loaderTimings.workerRoundTripMs),
        requestTotalMs: roundTimingMs(loaderTimings.requestTotalMs),
        shardWorkerCount: Number.isFinite(stats.shardWorkerCount) ? Math.max(0, stats.shardWorkerCount) : 0,
        targetShardWorkerCount: Number.isFinite(stats.targetShardWorkerCount) ?
            Math.max(0, stats.targetShardWorkerCount) : 0,
        reconstructionModuleMs: roundTimingMs(stats.reconstructionModuleMs),
        reconstructionModuleSource: stats.reconstructionModuleSource || 'unknown',
        reconstructionModuleShared: !!stats.reconstructionModuleShared,
        reconstructionModuleFallbackReason: stats.reconstructionModuleFallbackReason || null,
        workerElapsedMs: roundTimingMs(result?.elapsedMs),
        webCodecsCapability: stats.webCodecsCapability || null,
        webCodecsProbeStatus: stats.webCodecsProbeStatus ||
            stats.webCodecsCapability?.status || 'unknown',
        webCodecsProbeMs: roundTimingMs(stats.webCodecsProbeMs),
        textureBuildCapabilities: {
            bc7: !!(stats.textureBuildCapabilities?.bc7 ?? TextureBuildCapabilities.bc7),
            bc3: !!(stats.textureBuildCapabilities?.bc3 ?? TextureBuildCapabilities.bc3)
        },
        stats,
        loaderTimings,
        warmupTrace
    };
}

export class SplatUWALoader {

    // The current performance branch uses the direct postprocess path by default.
    // Set the URL to ?uwaPostprocess=legacy (or 0/false) for the old SplatBuffer path.
    static useUwaPostprocess = true;
    static reconstructionWorkerCount = 2;
    static reconstructionWorkerCountOverride = null;
    static reconstructionTraceLevelOverride = null;

    static setReconstructionTraceLevel(value) {
        SplatUWALoader.reconstructionTraceLevelOverride = value === 'js' ? 'js' : null;
        return SplatUWALoader.reconstructionTraceLevelOverride || 'off';
    }

    static isUwaPostprocessEnabled() {
        let value = null;
        if (typeof window !== 'undefined' && typeof URLSearchParams !== 'undefined') {
            try {
                value = new URLSearchParams(window.location?.search || '').get('uwaPostprocess');
            } catch (_) {}
        }
        if (value === 'legacy' || value === '0' || value === 'false' || value === 'off') return false;
        if (SplatUWALoader.useUwaPostprocess === true) return true;
        if (value === null) return false;
        try {
            return value === 'direct' || value === '1' || value === 'true';
        } catch (_) {
            return false;
        }
    }

    static setReconstructionWorkerCount(value) {
        const count = Number.parseInt(value, 10);
        if (!Number.isFinite(count)) return SplatUWALoader.getReconstructionWorkerCount();
        SplatUWALoader.reconstructionWorkerCountOverride = Math.max(1, Math.min(8, count));
        return SplatUWALoader.reconstructionWorkerCountOverride;
    }

    static buildDirectCompressedTextureSplatBuffer(data, minimumAlpha, bufferShDegree = 1, timing = null) {
        const mark = (key, start) => {
            if (!timing) return;
            const elapsed = performance.now() - start;
            if (Number.isFinite(elapsed)) timing[key] = (timing[key] || 0) + elapsed;
        };
        const splatCount = data.numPoints;
        const positions = data.positions;
        const scales = data.scales;
        const rotations = data.rotations;
        const colors = data.colors;
        const compressedTextureUVs = data.compressedTextureData.uvs;
        const compressionLevel = 0;
        const sceneCenter = new THREE.Vector3();
        const sectionCount = 1;

        const validAlphaScanStart = performance.now();
        let validSplatCount = 0;
        let alphaBelowMinimumCount = 0;
        let alphaZeroCount = 0;
        for (let i = 0; i < splatCount; i++) {
            const alpha = colors[i * 4 + 3];
            if (alpha === 0) alphaZeroCount++;
            if (alpha < minimumAlpha) alphaBelowMinimumCount++;
            if (alpha >= minimumAlpha) {
                validSplatCount++;
            }
        }
        mark('validAlphaScanMs', validAlphaScanStart);
        if (timing) {
            timing.alphaBelowMinimumCount = alphaBelowMinimumCount;
            timing.alphaZeroCount = alphaZeroCount;
            timing.minimumAlpha = minimumAlpha;
        }

        const { bytesPerSplat } = SplatBuffer.calculateComponentStorage(compressionLevel, bufferShDegree);
        const sectionDataSizeBytes = validSplatCount * bytesPerSplat;
        const unifiedBufferSize = SplatBuffer.HeaderSizeBytes +
                                  SplatBuffer.SectionHeaderSizeBytes * sectionCount +
                                  sectionDataSizeBytes;
        const headerAllocationStart = performance.now();
        const unifiedBuffer = new ArrayBuffer(unifiedBufferSize);

        SplatBuffer.writeHeaderToBuffer({
            versionMajor: SplatBuffer.CurrentMajorVersion,
            versionMinor: SplatBuffer.CurrentMinorVersion,
            maxSectionCount: sectionCount,
            sectionCount: sectionCount,
            maxSplatCount: validSplatCount,
            splatCount: validSplatCount,
            compressionLevel: compressionLevel,
            sceneCenter: sceneCenter
        }, unifiedBuffer);

        SplatBuffer.writeSectionHeaderToBuffer({
            maxSplatCount: validSplatCount,
            splatCount: validSplatCount,
            bucketSize: 0,
            bucketCount: 0,
            bucketBlockSize: 0,
            compressionScaleRange: 0,
            storageSizeBytes: sectionDataSizeBytes,
            fullBucketCount: 0,
            partiallyFilledBucketCount: 0,
            sphericalHarmonicsDegree: bufferShDegree
        }, compressionLevel, unifiedBuffer, SplatBuffer.HeaderSizeBytes);
        mark('headerAllocationMs', headerAllocationStart);

        const tempSplat = UncompressedSplatArray.createSplat(bufferShDegree);
        const bucketCenter = new THREE.Vector3();
        let bufferOffset = SplatBuffer.HeaderSizeBytes + SplatBuffer.SectionHeaderSizeBytes;
        const directPositions = new Float32Array(validSplatCount * 3);
        const directScales = new Float32Array(validSplatCount * 3);
        const directRotations = new Float32Array(validSplatCount * 4);
        const directColors = new Uint8Array(validSplatCount * 4);
        const directAstcUVs = new Uint32Array(validSplatCount * 2);
        let directIndex = 0;

        const directAttributeStart = performance.now();
        for (let i = 0; i < splatCount; i++) {
            const opacity = colors[i * 4 + 3];
            if (opacity < minimumAlpha) continue;

            tempSplat[0] = positions[i * 3 + 0];
            tempSplat[1] = positions[i * 3 + 1];
            tempSplat[2] = positions[i * 3 + 2];
            tempSplat[3] = scales[i * 3 + 0];
            tempSplat[4] = scales[i * 3 + 1];
            tempSplat[5] = scales[i * 3 + 2];
            tempSplat[6] = rotations[i * 4 + 0];
            tempSplat[7] = rotations[i * 4 + 1];
            tempSplat[8] = rotations[i * 4 + 2];
            tempSplat[9] = rotations[i * 4 + 3];
            tempSplat[10] = colors[i * 4 + 0];
            tempSplat[11] = colors[i * 4 + 1];
            tempSplat[12] = colors[i * 4 + 2];
            tempSplat[13] = opacity;
            tempSplat[14] = compressedTextureUVs[i * 2 + 0];
            tempSplat[15] = compressedTextureUVs[i * 2 + 1];

            const positionBase = directIndex * 3;
            const rotationBase = directIndex * 4;
            const uvBase = directIndex * 2;
            directPositions[positionBase] = tempSplat[0];
            directPositions[positionBase + 1] = tempSplat[1];
            directPositions[positionBase + 2] = tempSplat[2];
            directScales[positionBase] = tempSplat[3];
            directScales[positionBase + 1] = tempSplat[4];
            directScales[positionBase + 2] = tempSplat[5];
            directRotations[rotationBase] = tempSplat[6];
            directRotations[rotationBase + 1] = tempSplat[7];
            directRotations[rotationBase + 2] = tempSplat[8];
            directRotations[rotationBase + 3] = tempSplat[9];
            directColors[rotationBase] = tempSplat[10];
            directColors[rotationBase + 1] = tempSplat[11];
            directColors[rotationBase + 2] = tempSplat[12];
            directColors[rotationBase + 3] = tempSplat[13];
            directAstcUVs[uvBase] = tempSplat[14];
            directAstcUVs[uvBase + 1] = tempSplat[15];

            SplatBuffer.writeSplatDataToSectionBuffer(
                tempSplat, unifiedBuffer, bufferOffset, compressionLevel, bufferShDegree,
                bucketCenter, 1, 0, undefined, undefined, true
            );
            bufferOffset += bytesPerSplat;
            directIndex++;
        }
        const directWriteMs = performance.now() - directAttributeStart;
        if (timing && Number.isFinite(directWriteMs)) {
            // The direct path intentionally uses one pass, so attribute copy and
            // binary record writing are reported as one combined measurement.
            timing.directAttributeCopyAndRecordWriteMs = (timing.directAttributeCopyAndRecordWriteMs || 0) + directWriteMs;
        }

        const directFinalizeStart = performance.now();
        const splatBuffer = new SplatBuffer(unifiedBuffer);
        splatBuffer.directCompressedTextureData = {
            positions: directPositions,
            scales: directScales,
            rotations: directRotations,
            colors: directColors,
            uvs: directAstcUVs
        };
        splatBuffer.directASTCData = {
            ...splatBuffer.directCompressedTextureData,
            astcUVs: directAstcUVs
        };
        mark('directFinalizeMs', directFinalizeStart);
        return splatBuffer;
    }

    static buildDirectASTCSplatBuffer(data, minimumAlpha, bufferShDegree = 1, timing = null) {
        const compressedTextureData = data.compressedTextureData || {
            format: TextureStrategy.ASTC,
            uvs: data.astcUVs
        };
        return SplatUWALoader.buildDirectCompressedTextureSplatBuffer(
            { ...data, compressedTextureData }, minimumAlpha, bufferShDegree, timing
        );
    }

    static getVerboseLoggingEnabled() {
        if (typeof window === 'undefined') return false;
        return new URLSearchParams(window.location.search).has('debug');
    }

    static getReconstructionTraceLevel() {
        if (SplatUWALoader.reconstructionTraceLevelOverride) return SplatUWALoader.reconstructionTraceLevelOverride;
        if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined') return 'off';
        try {
            return new URLSearchParams(window.location?.search || '').get('reconTrace') === 'js' ? 'js' : 'off';
        } catch (_) {
            return 'off';
        }
    }

    static getReconstructionWorkerCount() {
        if (Number.isInteger(SplatUWALoader.reconstructionWorkerCountOverride)) {
            return SplatUWALoader.reconstructionWorkerCountOverride;
        }
        if (typeof window === 'undefined' || typeof URLSearchParams === 'undefined') return 2;
        const value = Number.parseInt(new URLSearchParams(window.location?.search || '').get('uwaReconWorkers'), 10);
        return Number.isFinite(value) ? Math.max(1, Math.min(8, value)) :
            Math.max(1, Math.min(8, SplatUWALoader.reconstructionWorkerCount));
    }

    static prewarmDecoderWorker(onStatus = null) {
        const apiCallAbsMs = absoluteNowMs();
        if (decoderWarmupPromise) return decoderWarmupPromise;
        if (decoderWorkerState?.worker && decoderWorkerState.warm) {
            const diagnostics = decoderWorkerState.warmupDiagnostics;
            if (typeof onStatus === 'function') {
                try {
                    onStatus({
                        phase: 'full-ready',
                        message: `Workers fully ready ${diagnostics?.shardWorkerCount || 2}/` +
                            `${diagnostics?.targetShardWorkerCount || 2}`,
                        elapsedMs: diagnostics?.fullReadyMs,
                        details: diagnostics
                    });
                } catch (_) {}
            }
            if (!diagnostics?.warmupTrace) return Promise.resolve(diagnostics);
            return Promise.resolve({
                ...diagnostics,
                warmupTrace: {
                    ...diagnostics.warmupTrace,
                    attempt: {
                        kind: 'cached',
                        physical: false,
                        cached: true,
                        status: 'cached',
                        cacheCallAbsMs: apiCallAbsMs,
                        physicalAttemptRequestId: diagnostics.warmupTrace.attempt?.requestId,
                        physicalTraceReused: true,
                        workerCreatedForAttempt: false
                    }
                }
            });
        }

        const verboseLog = SplatUWALoader.getVerboseLoggingEnabled();
        const warmupStartTime = performance.now();
        const callAbsMs = absoluteNowMs();
        const warmupMainEndpoints = {
            clockMethod: absoluteClockMethod(),
            callAbsMs,
            apiCallAbsMs,
            lifecycleGeneration: decoderLifecycleGeneration
        };

        const warmupRequest = enqueueDecoderWorkerRequest((requestId) => ({
            message: {
                type: 'warmup',
                protocolVersion: DECODER_PROTOCOL_VERSION,
                buildVersion: DECODER_BUILD_VERSION,
                requestId,
                verboseLog,
                reconstructionWorkerCount: SplatUWALoader.getReconstructionWorkerCount()
            }
        }), 'SplatUWA decoder warmup timed out.', verboseLog,
        decoderLifecycleGeneration, typeof onStatus === 'function' ? onStatus : null, warmupMainEndpoints)
        .then((result) => {
            warmupMainEndpoints.promiseThenAbsMs = absoluteNowMs();
            const elapsedMs = performance.now() - warmupStartTime;
            const diagnostics = buildWarmupDiagnostics(result, elapsedMs);
            emitTimingTable(
                `[SplatUWA Timing] Full worker warmup ` +
                `(${diagnostics.shardWorkerCount}/${diagnostics.targetShardWorkerCount} shard workers)`,
                [
                { phase: 'Wall total', ms: elapsedMs },
                { phase: 'Full ready', ms: result?.stats?.fullReadyMs ?? result?.stats?.totalMs },
                { phase: 'Coordinator module', ms: result?.stats?.coordinatorModuleMs },
                { phase: 'Reconstruction module compile', ms: result?.stats?.reconstructionModuleMs },
                { phase: 'Shard workers ready', ms: result?.stats?.shardWarmupMs },
                { phase: 'WebCodecs capability probe', ms: result?.stats?.webCodecsProbeMs },
                { phase: 'Estimated overlap', ms: result?.stats?.estimatedOverlapMs },
                { phase: 'Loader roundtrip', ms: result?.loaderTimings?.workerRoundTripMs }
                ]
            );
            emitWarmupTrace(diagnostics.warmupTrace);
            if (verboseLog && typeof console !== 'undefined' && typeof console.log === 'function') {
                try {
                    console.log('[SplatUWA Timing] Worker warmup details', diagnostics);
                } catch (_) {}
            }
            if (decoderWorkerState?.worker) decoderWorkerState.warmupDiagnostics = diagnostics;
            return diagnostics;
        });

        let trackedWarmupPromise;
        trackedWarmupPromise = warmupRequest.finally(() => {
            if (decoderWarmupPromise === trackedWarmupPromise) decoderWarmupPromise = null;
        });
        decoderWarmupPromise = trackedWarmupPromise;
        return trackedWarmupPromise;
    }

    static loadFromURL(fileName, onProgress, progressiveLoad, onSectionBuilt, minimumAlpha, compressionLevel,
        optimizeSplatData, sphericalHarmonicsDegree, headers, texturePolicyOrUseCpuDecode, onPreview = null) {
        const loadGeneration = decoderLifecycleGeneration;
        const download = fetchWithProgress(fileName, onProgress, true, headers);
        let canceled = false;
        const previewCallback = typeof onPreview === 'function' ? onPreview :
            (progressiveLoad && typeof onSectionBuilt === 'function' ? onSectionBuilt : null);
        const guardedPreview = previewCallback ? (result) => {
            if (!canceled && loadGeneration === decoderLifecycleGeneration) return previewCallback(result);
        } : null;
        let settled = false;
        let resolveLoad;
        let rejectLoad;

        const resolveOnce = (value) => {
            if (settled) return;
            settled = true;
            resolveLoad(value);
        };
        const rejectOnce = (error) => {
            if (settled) return;
            settled = true;
            rejectLoad(error);
        };
        const loadCanceledByDisposal = () => new Error('SplatUWA load was canceled by disposal.');

        let warmupPromise;
        try {
            warmupPromise = Promise.resolve(SplatUWALoader.prewarmDecoderWorker());
        } catch (error) {
            warmupPromise = Promise.reject(error);
        }

        let texturePolicyPromise;
        try {
            texturePolicyPromise = Promise.resolve(texturePolicyOrUseCpuDecode);
        } catch (error) {
            texturePolicyPromise = Promise.reject(error);
        }

        const loadPromise = new AbortablePromise((resolve, reject) => {
            resolveLoad = resolve;
            rejectLoad = reject;

            Promise.all([download.promise, warmupPromise, texturePolicyPromise])
            .then(([arrayBuffer, diagnostics, texturePolicy]) => {
                if (canceled) return;
                if (loadGeneration !== decoderLifecycleGeneration) throw loadCanceledByDisposal();

                const textureStrategies = texturePolicy === undefined || texturePolicy === null ?
                    selectTextureStrategyChain(
                        probeWebGL2TextureCapabilities(), diagnostics?.textureBuildCapabilities
                    ) :
                    normalizeTextureStrategyChain(texturePolicy, TextureStrategy.ASTC);

                if (onProgress) onProgress(0, 'Decoding via WASM Worker...', LoaderStatus.Processing);
                if (canceled) return;
                if (loadGeneration !== decoderLifecycleGeneration) throw loadCanceledByDisposal();

                return SplatUWALoader.parse(arrayBuffer, minimumAlpha, compressionLevel,
                    optimizeSplatData, textureStrategies, loadGeneration, sphericalHarmonicsDegree, guardedPreview);
            })
            .then((splatBuffer) => {
                if (canceled) return;
                if (loadGeneration !== decoderLifecycleGeneration) throw loadCanceledByDisposal();
                resolveOnce(splatBuffer);
            })
            .catch((error) => {
                download.abort(error);
                rejectOnce(error);
            });
        }, (reason) => {
            if (settled || canceled) return;
            canceled = true;
            download.abort(reason);
            rejectOnce(new AbortedPromiseError(reason || 'SplatUWA load was aborted.'));
        });

        return loadPromise;
    }

    static loadFromFileData(fileData, minimumAlpha, compressionLevel, optimizeSplatData, sphericalHarmonicsDegree,
        texturePolicyOrUseCpuDecode = true, onPreview = null) {
        const textureStrategies = normalizeTextureStrategyChain(texturePolicyOrUseCpuDecode, TextureStrategy.CPU);
        return SplatUWALoader.parse(fileData.data, minimumAlpha, compressionLevel, optimizeSplatData,
            textureStrategies, decoderLifecycleGeneration, sphericalHarmonicsDegree, onPreview);
    }

    static async parse(arrayBuffer, minimumAlpha, compressionLevel, optimizeSplatData, texturePolicyValue,
        requestGeneration = decoderLifecycleGeneration, sphericalHarmonicsDegree, onPreview = null) {
        const traceOriginAbsMs = absoluteNowMs();
        const startedAt = performance.now();
        const inputBytes = arrayBuffer.byteLength;
        const verboseLog = SplatUWALoader.getVerboseLoggingEnabled();
        const reconstructionTraceLevel = SplatUWALoader.getReconstructionTraceLevel();
        const reconstructionWorkerCount = SplatUWALoader.getReconstructionWorkerCount();
        const textureStrategies = normalizeTextureStrategyChain(texturePolicyValue, TextureStrategy.CPU);
        const preferredTextureStrategy = textureStrategies[0];

        const prewarmStartTime = performance.now();
        await SplatUWALoader.prewarmDecoderWorker();
        const prewarmWaitMs = performance.now() - prewarmStartTime;
        if (requestGeneration !== decoderLifecycleGeneration) {
            throw new Error('SplatUWA decode was canceled by disposal.');
        }

        if (verboseLog && typeof console !== 'undefined' && typeof console.log === 'function') {
            try {
                console.log(
                    `[SplatUWA Loader] Decode start. bytes=${arrayBuffer.byteLength}, ` +
                    `textureStrategies=${textureStrategies.join(' -> ')}`
                );
            } catch (_) {}
        }

        let workerResponse;
        const previewHandler = typeof onPreview === 'function' ? (previewData) => {
            if (requestGeneration !== decoderLifecycleGeneration) return;
            try {
                const textureStrategy = previewData?.compressedTextureData ?
                    normalizeTextureStrategy(previewData.compressedTextureData.format, preferredTextureStrategy) : TextureStrategy.CPU;
                const hasCompressedTexture = !!previewData?.compressedTextureData;
                const requestedShDegree = Number.isInteger(sphericalHarmonicsDegree) ?
                    Math.max(0, Math.min(3, sphericalHarmonicsDegree)) : Math.max(0, Math.min(3, previewData?.shDegree || 0));
                const renderShDegree = hasCompressedTexture ?
                    Math.max(1, Math.min(3, previewData.shDegree || requestedShDegree || 1, Math.max(1, requestedShDegree))) :
                    Math.max(0, Math.min(3, previewData?.shDegree || 0, requestedShDegree));
                const result = processDecodedModel(previewData, {
                    minimumAlpha, textureStrategy, shDegree: renderShDegree
                });
                result.shDegree = renderShDegree;
                if (result.compressedTextureData) result.compressedTextureData.shDegree = renderShDegree;
                result.isUwaPreviewResult = true;
                // Unselected/pending points are not alpha-pruned from the final model.
                delete result.uwaPostprocessTimings.compactionDroppedCount;
                result.previewSourcePointIndexes = previewData.previewSourcePointIndexes || null;
                result.uwaPreviewTimings = {
                    receivedAbsMs: absoluteNowMs(),
                    sourceCount: previewData.sourcePointCount,
                    previewPointCount: result.numPoints,
                    pendingOrUnselectedPointCount: previewData.sourcePointCount - result.numPoints,
                    maxPreviewPoints: 65536
                };
                Promise.resolve(onPreview(result)).catch((error) => {
                    console.warn('[SplatUWA Loader] Preview callback failed.', error);
                });
            } catch (error) {
                if (verboseLog) console.warn('[SplatUWA Loader] Failed to process decode preview.', error);
            }
        } : null;
        try {
            workerResponse = await enqueueDecoderWorkerRequest((requestId) => ({
                message: {
                    type: 'decode',
                    protocolVersion: DECODER_PROTOCOL_VERSION,
                    buildVersion: DECODER_BUILD_VERSION,
                    requestId,
                    buffer: arrayBuffer,
                    textureStrategy: preferredTextureStrategy,
                    textureStrategies,
                    postedEpochMs: Date.now(),
                    verboseLog,
                    traceOriginAbsMs,
                    reconstructionTraceLevel,
                    reconstructionWorkerCount,
                    postprocessCompaction: SplatUWALoader.isUwaPostprocessEnabled(),
                    minimumAlpha: Number.isFinite(minimumAlpha) ? minimumAlpha : 1,
                    enablePreview: !!previewHandler,
                },
                transferList: [arrayBuffer]
            }), 'SplatUWA worker decode timed out.', verboseLog, requestGeneration, null, null, previewHandler);
        } catch (error) {
            throw buildWorkerFailure(`Texture strategies ${textureStrategies.join(' -> ')} failed: ${error.message}`, error);
        }
        const { success, data, error, details, loaderTimings } = workerResponse;

        if (!success) {
            console.error('[SplatUWA Loader] Worker decode failed:', details || error);
            throw new Error(error || 'Worker decoding failed');
        }

        const workerTimings = data?.timings || {};
        try {
            const splatCount = data.numPoints;
            const textureStrategy = normalizeTextureStrategy(data.textureStrategy, preferredTextureStrategy);

            const compressedTextureData = data.compressedTextureData || null;
            const hasCompressedTexture = !!(compressedTextureData?.raw?.byteLength);
            if (hasCompressedTexture && compressedTextureData.format !== textureStrategy) {
                throw new Error(
                    `Decoder returned ${compressedTextureData.format} texture bytes for ${textureStrategy} strategy.`
                );
            }
            if (textureStrategy !== TextureStrategy.CPU && !hasCompressedTexture) {
                throw new Error(`Texture strategy ${textureStrategy} produced no compressed texture payload.`);
            }
            if (textureStrategy === TextureStrategy.CPU && hasCompressedTexture) {
                throw new Error('CPU texture strategy unexpectedly returned compressed texture bytes.');
            }
            const requestedShDegree = Number.isInteger(sphericalHarmonicsDegree) ?
                Math.max(0, Math.min(3, sphericalHarmonicsDegree)) : Math.max(0, Math.min(3, data.shDegree));
            const renderShDegree = hasCompressedTexture ?
                Math.max(1, Math.min(3, data.shDegree, Math.max(1, requestedShDegree))) :
                Math.max(0, Math.min(3, data.shDegree, requestedShDegree));
            if (!hasCompressedTexture && renderShDegree > 0 &&
                (!data.featuresRest || data.featuresRest.length !== splatCount * 45)) {
                throw new Error('CPU texture fallback returned incomplete spherical harmonics data.');
            }

            if (SplatUWALoader.isUwaPostprocessEnabled()) {
                const postprocessStartedAt = performance.now();
                const result = processDecodedModel(data, {
                    minimumAlpha,
                    textureStrategy,
                    shDegree: renderShDegree
                });
                result.shDegree = renderShDegree;
                if (result.compressedTextureData) result.compressedTextureData.shDegree = renderShDegree;
                result.uwaPostprocessTimings.workerTimings = workerTimings;
                result.uwaPostprocessTimings.loaderTimings = loaderTimings || null;
                result.uwaPostprocessTimings.totalMs = performance.now() - postprocessStartedAt;
                result.uwaLoadTimings = {
                    inputBytes,
                    splatCount: result.numPoints,
                    textureStrategy,
                    textureStrategies,
                    hasCompressedTexture,
                    totalMs: performance.now() - startedAt,
                    prewarmWaitMs,
                    workerRoundTripMs: loaderTimings?.workerRoundTripMs,
                    uwaPostprocessTimings: result.uwaPostprocessTimings,
                    workerTimings: { ...workerTimings, loaderRequest: loaderTimings || null }
                };
                return result;
            }

            const splatBufferConstructionStartedAt = performance.now();
            const splatBufferTimings = {};
            let splatBuffer;
            if (hasCompressedTexture) {
                // The ASTC path retains only UVs in the buffer; it does not reserve storage for the full SH degree.
                // Build one SplatBuffer directly from typed arrays to avoid millions of JS splat objects and a second
                // ArrayBuffer memory peak.
                splatBuffer = SplatUWALoader.buildDirectCompressedTextureSplatBuffer(
                    data, minimumAlpha, 1, splatBufferTimings
                );
            } else {
                const positions = data.positions;
                const scales = data.scales;
                const rotations = data.rotations;
                const colors = data.colors;
                const featuresRest = data.featuresRest;
                const shComponentCount = getSphericalHarmonicsComponentCountForDegree(renderShDegree);
                const shCoefficientCount = shComponentCount / 3;
                if (shComponentCount > 0 && (!featuresRest || featuresRest.length !== splatCount * 45)) {
                    throw new Error('CPU texture fallback returned incomplete spherical harmonics data.');
                }
                const validAlphaScanStart = performance.now();
                let validCpuSplatCount = 0;
                for (let i = 0; i < splatCount; i++) {
                    if (colors[i * 4 + 3] >= minimumAlpha) validCpuSplatCount++;
                }
                splatBufferTimings.splatBufferValidAlphaScanMs = performance.now() - validAlphaScanStart;
                splatBufferTimings.splatBufferValidAlphaCount = validCpuSplatCount;

                const splatArrayStart = performance.now();
                const splatArray = new UncompressedSplatArray(renderShDegree, false);
                for (let i = 0; i < splatCount; i++) {
                    const opacity = colors[i * 4 + 3];
                    if (opacity < minimumAlpha) continue;

                    const splat = splatArray.addSplatFromComonents(
                        positions[i * 3 + 0], positions[i * 3 + 1], positions[i * 3 + 2],
                        scales[i * 3 + 0], scales[i * 3 + 1], scales[i * 3 + 2],
                        rotations[i * 4 + 0], rotations[i * 4 + 1], rotations[i * 4 + 2], rotations[i * 4 + 3],
                        colors[i * 4 + 0], colors[i * 4 + 1], colors[i * 4 + 2], opacity
                    );
                    copyCoefficientMajorRgbToChannelMajor(
                        featuresRest, i * 45, splat, 14, shCoefficientCount
                    );
                }
                const splatArrayAndShMs = performance.now() - splatArrayStart;
                splatBufferTimings.splatBufferUncompressedArrayAndShConversionMs = splatArrayAndShMs;

                if (optimizeSplatData) {
                    const { SplatBufferGenerator } = await import('../SplatBufferGenerator.js');
                    const generator = SplatBufferGenerator.getStandardGenerator(
                        minimumAlpha, compressionLevel, 0, new THREE.Vector3(), 0, 0
                    );
                    splatBuffer = generator.generateFromUncompressedSplatArray(splatArray, splatBufferTimings);
                } else {
                    splatBuffer = SplatBuffer.generateFromUncompressedSplatArrays(
                        [splatArray], minimumAlpha, 0, new THREE.Vector3(), undefined, undefined, [], splatBufferTimings
                    );
                }
            }
            const splatBufferConstructionMs = performance.now() - splatBufferConstructionStartedAt;
            const splatBufferBuildEndAbsMs = absoluteNowMs();

            if (hasCompressedTexture) {
                splatBuffer.compressedTextureData = {
                    ...compressedTextureData,
                    shDegree: renderShDegree
                };
                splatBuffer.hasCompressedTexture = true;

                // Public compatibility aliases for callers built around the original ASTC-only payload.
                if (compressedTextureData.format === TextureStrategy.ASTC) {
                    splatBuffer.astcData = splatBuffer.compressedTextureData;
                    splatBuffer.hasAstc = true;
                }
            }

            const shardTimings = workerTimings.shards || {};
            const finiteTiming = (value) => Number.isFinite(value) ? value : undefined;
            const videoDecoderPath = workerTimings.prepare?.videoDecoderPath || 'unknown';
            const substreams = workerTimings.prepare?.substreams || {};
            splatBuffer.uwaLoadTimings = {
                inputBytes,
                splatCount,
                textureStrategy,
                textureStrategies,
                hasCompressedTexture,
                totalMs: performance.now() - startedAt,
                prewarmWaitMs,
                workerRoundTripMs: loaderTimings?.workerRoundTripMs,
                splatBufferBuildMs: splatBufferConstructionMs,
                splatBufferBuildEndAbsMs,
                splatBufferTimings,
                reconstructionTimings: {
                    wallMs: finiteTiming(workerTimings.wall?.reconstructionWallMs),
                    packShardMs: finiteTiming(workerTimings.packShardMs),
                    unpackMs: finiteTiming(workerTimings.unpackMs),
                    workerKernelMs: finiteTiming(shardTimings.kernelTotalMs),
                    packetParseMs: finiteTiming(shardTimings.packetParseMs),
                    predictionMs: finiteTiming(shardTimings.predictionMs),
                    dequantizeMs: finiteTiming(shardTimings.dequantizeMs),
                    transformMs: finiteTiming(shardTimings.transformMs),
                    nonlinearMs: finiteTiming(shardTimings.nonlinearMs),
                    outputCopyMs: finiteTiming(shardTimings.outputCopyMs),
                    resultMergeMs: finiteTiming(workerTimings.resultMergeMs),
                    pruneMs: finiteTiming(workerTimings.pruneMs)
                },
                workerTimings: {
                    ...workerTimings,
                    loaderRequest: loaderTimings || null
                }
            };
            emitTimingTable(`[SplatUWA Timing] Decode / SplatBuffer build (video: ${videoDecoderPath})`, [
                { phase: 'Loader total', ms: performance.now() - startedAt },
                { phase: 'Worker roundtrip', ms: loaderTimings?.workerRoundTripMs },
                { phase: 'Coordinator prepare total', ms: workerTimings.prepare?.totalMs },
                { phase: 'Parse stream', ms: workerTimings.prepare?.parseMs },
                { phase: 'Decode non-video streams', ms: workerTimings.prepare?.decodeNonVideoSubstreamsMs },
                { phase: `Adopt raw YUV444P video (${workerTimings.prepare?.rawVideoStreamCount || 0} streams)`,
                  ms: workerTimings.prepare?.rawVideoAdoptMs },
                { phase: 'ASTC texture decode', ms: workerTimings.prepare?.astcTextureDecodeMs },
                { phase: 'BC texture encode', ms: workerTimings.prepare?.bcTextureEncodeMs },
                { phase: 'Substream 0 (non-video)', ms: substreams['0']?.primaryDecodeMs },
                { phase: 'Substream 1 (non-video)', ms: substreams['1']?.primaryDecodeMs },
                { phase: `Substream 2 (video/${substreams['2']?.actualPath || videoDecoderPath})`,
                  ms: substreams['2']?.primaryDecodeMs },
                { phase: 'Substream 3 (texture)', ms: substreams['3']?.primaryDecodeMs },
                { phase: 'Substream 4 (non-video)', ms: substreams['4']?.primaryDecodeMs },
                { phase: 'WebCodecs video wall time', ms: workerTimings.prepare?.webCodecsMs },
                { phase: 'WebCodecs plane copy', ms: workerTimings.prepare?.webCodecsCopyMs },
                { phase: 'Decoded video JS -> WASM', ms: workerTimings.prepare?.jsToWasmInjectMs },
                { phase: 'FFmpeg video fallback wall time', ms: workerTimings.prepare?.ffmpegFallbackWallMs },
                { phase: 'Unpack attributes', ms: workerTimings.unpackMs },
                { phase: 'Shard kernel total (cumulative, not wall-clock)', ms: shardTimings.kernelTotalMs },
                { phase: 'Shard result copy total (cumulative, not wall-clock)', ms: shardTimings.resultCopyMs },
                { phase: 'Coordinator pack + export', ms: workerTimings.taskExportCopyMs },
                { phase: 'Merge / prune total', ms: sumTimingMs(workerTimings.resultMergeMs, workerTimings.pruneMs) },
                { phase: 'SplatBuffer construction', ms: splatBufferConstructionMs }
            ]);
            if (typeof console !== 'undefined' && typeof console.log === 'function') {
                const attempts = Array.isArray(data.textureAttempts) ? data.textureAttempts.join(' -> ') : textureStrategy;
                console.log(`[SplatUWA Loader] Texture strategy: ${textureStrategy}; attempts: ${attempts}`);
                if (Number.isFinite(workerTimings.prepare?.textureOutputBytes)) {
                    console.log(
                        `[SplatUWA Loader] Texture bytes: input=${workerTimings.prepare.textureInputBytes || 0}, ` +
                        `output=${workerTimings.prepare.textureOutputBytes}`
                    );
                }
            }
            if (verboseLog && typeof console !== 'undefined' && typeof console.log === 'function') {
                try {
                    console.log('[SplatUWA Timing] Loader request details', loaderTimings);
                    console.log('[SplatUWA Timing] Worker decode details', workerTimings);
                } catch (_) {}
            }
            if (reconstructionTraceLevel === 'js' && workerTimings.shardTrace &&
                typeof console !== 'undefined' && typeof console.log === 'function') {
                try {
                    console.log('[SplatUWA Reconstruction Trace] completed', workerTimings.shardTrace);
                } catch (_) {}
            }

            return splatBuffer;
        } catch (err) {
            console.error('[SplatUWA Loader] Failed to build SplatBuffer from worker data:', err);
            throw err;
        }
    }

    static dispose() {
        if (decoderDisposePromise) return decoderDisposePromise;
        decoderLifecycleGeneration++;
        decoderWarmupPromise = null;
        const state = decoderWorkerState;
        if (!state) return Promise.resolve();

        state.disposing = true;
        if (state.inflight) {
            if (state.inflight.timeoutId) clearTimeout(state.inflight.timeoutId);
            const reject = state.inflight.reject;
            state.inflight = null;
            reject(new Error('SplatUWA decoder disposed.'));
        }

        const disposeCompletion = new Promise((resolve) => {
            state.disposeResolve = resolve;
        });
        let trackedDisposePromise;
        trackedDisposePromise = disposeCompletion.finally(() => {
            if (decoderDisposePromise === trackedDisposePromise) decoderDisposePromise = null;
        });
        decoderDisposePromise = trackedDisposePromise;
        state.disposeRequestId = state.nextRequestId++;
        state.disposeTimeoutId = setTimeout(() => {
            resetDecoderWorkerState(state, new Error('SplatUWA decoder dispose timed out.'));
        }, DECODER_DISPOSE_TIMEOUT_MS);
        try {
            state.worker.postMessage({
                type: 'dispose',
                protocolVersion: DECODER_PROTOCOL_VERSION,
                buildVersion: DECODER_BUILD_VERSION,
                requestId: state.disposeRequestId
            });
        } catch (error) {
            resetDecoderWorkerState(state, buildWorkerFailure('Failed to dispose decoder worker.', error));
        }
        return trackedDisposePromise;
    }
}
