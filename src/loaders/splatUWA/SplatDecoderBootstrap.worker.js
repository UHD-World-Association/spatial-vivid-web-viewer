const BOOTSTRAP_TRACE_SCHEMA = 'uwa.decoder.bootstrap.trace.v1';
const DECODER_MODULE_URL = new URL('./SplatDecoder.worker.js', import.meta.url).href;

function absoluteNowMs() {
    try {
        const timeOrigin = performance.timeOrigin;
        const now = performance.now();
        const absolute = timeOrigin + now;
        if (Number.isFinite(timeOrigin) && Number.isFinite(now) && Number.isFinite(absolute)) return absolute;
    } catch (_) {}
    return Date.now();
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

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function serializeResourceTiming(entry) {
    const timeOriginMs = Number.isFinite(performance?.timeOrigin) ? performance.timeOrigin : null;
    const absolute = (value) => Number.isFinite(timeOriginMs) && Number.isFinite(value) ? timeOriginMs + value : null;
    return {
        name: typeof entry?.name === 'string' ? entry.name : '',
        url: typeof entry?.name === 'string' ? entry.name : '',
        initiatorType: typeof entry?.initiatorType === 'string' ? entry.initiatorType : '',
        timeOriginMs,
        startTime: finiteOrNull(entry?.startTime),
        startTimeAbsMs: absolute(entry?.startTime),
        duration: finiteOrNull(entry?.duration),
        fetchStart: finiteOrNull(entry?.fetchStart),
        responseStart: finiteOrNull(entry?.responseStart),
        responseEnd: finiteOrNull(entry?.responseEnd),
        fetchStartAbsMs: absolute(entry?.fetchStart),
        responseStartAbsMs: absolute(entry?.responseStart),
        responseEndAbsMs: absolute(entry?.responseEnd),
        transferSize: finiteOrNull(entry?.transferSize),
        encodedBodySize: finiteOrNull(entry?.encodedBodySize),
        decodedBodySize: finiteOrNull(entry?.decodedBodySize),
        nextHopProtocol: typeof entry?.nextHopProtocol === 'string' ? entry.nextHopProtocol : '',
        transferEvidence: Number.isFinite(entry?.transferSize) && entry.transferSize > 0 ?
            'positive-transfer-size-reported' : 'zero-or-unavailable-is-not-proof-of-no-download'
    };
}

function collectJavaScriptResourceTiming() {
    try {
        return performance.getEntriesByType('resource')
            .filter((entry) => entry?.initiatorType === 'script' || /\.m?js(?:$|[?#])/i.test(entry?.name || ''))
            .map(serializeResourceTiming);
    } catch (_) {
        return [];
    }
}

const bootstrapTrace = {
    schema: BOOTSTRAP_TRACE_SCHEMA,
    clockMethod: absoluteClockMethod(),
    bootstrapEntryAbsMs: absoluteNowMs(),
    importBeginAbsMs: null,
    importEndAbsMs: null,
    firstMessageQueuedAbsMs: null,
    firstMessageDispatchAbsMs: null,
    queuedMessageCountAtImportEnd: 0,
    javaScriptResourceTiming: [],
    entryMeaning: 'first bootstrap module-body point; excludes worker construction and bootstrap fetch internals',
    importMeaning: 'dynamic module-graph fetch/compile/evaluate envelope; not a pure download duration',
    resourceTimingMeaning: 'cache and transfer fields are browser evidence only; missing or zero values do not prove no download'
};

const messageQueue = [];
let state = 'LOADING';
let decoderMessageHandler = null;
let nextMessageSequence = 1;

function isObjectMessageData(value) {
    return value !== null && typeof value === 'object';
}

function traceSnapshot(sequence, queuedAbsMs, dispatchAbsMs) {
    return {
        ...bootstrapTrace,
        javaScriptResourceTiming: bootstrapTrace.javaScriptResourceTiming.map((entry) => ({ ...entry })),
        messageSequence: sequence,
        requestQueuedAbsMs: queuedAbsMs,
        requestDispatchAbsMs: dispatchAbsMs,
        stateAtDispatch: state
    };
}

function eventWithBootstrapTrace(event, sequence, queuedAbsMs, dispatchAbsMs) {
    if (!isObjectMessageData(event?.data)) return event;
    const forwardedEvent = Object.create(event);
    Object.defineProperty(forwardedEvent, 'data', {
        value: {
            ...event.data,
            bootstrapTrace: traceSnapshot(sequence, queuedAbsMs, dispatchAbsMs)
        },
        enumerable: true
    });
    return forwardedEvent;
}

function dispatchMessage(record) {
    const dispatchAbsMs = absoluteNowMs();
    if (!Number.isFinite(bootstrapTrace.firstMessageDispatchAbsMs)) {
        bootstrapTrace.firstMessageDispatchAbsMs = dispatchAbsMs;
    }
    const forwardedEvent = eventWithBootstrapTrace(
        record.event, record.sequence, record.queuedAbsMs, dispatchAbsMs
    );
    decoderMessageHandler.call(self, forwardedEvent);
}

function replayNextMessage() {
    if (state !== 'REPLAYING') return;
    const record = messageQueue.shift();
    if (!record) {
        state = 'READY';
        return;
    }
    dispatchMessage(record);
    setTimeout(replayNextMessage, 0);
}

self.onmessage = (event) => {
    const queuedAbsMs = absoluteNowMs();
    if (!Number.isFinite(bootstrapTrace.firstMessageQueuedAbsMs)) {
        bootstrapTrace.firstMessageQueuedAbsMs = queuedAbsMs;
    }
    const record = { event, queuedAbsMs, sequence: nextMessageSequence++ };
    if (state === 'READY') {
        dispatchMessage(record);
        return;
    }
    if (state === 'LOADING' || state === 'REPLAYING') messageQueue.push(record);
};

self.__UWA_SPLAT_DECODER_BOOTSTRAP__ = true;
bootstrapTrace.importBeginAbsMs = absoluteNowMs();
import(DECODER_MODULE_URL).then((decoderModule) => {
    bootstrapTrace.importEndAbsMs = absoluteNowMs();
    bootstrapTrace.javaScriptResourceTiming = collectJavaScriptResourceTiming();
    bootstrapTrace.queuedMessageCountAtImportEnd = messageQueue.length;
    if (typeof decoderModule?.handleDecoderWorkerMessage !== 'function') {
        throw new Error('SplatUWA decoder module did not export handleDecoderWorkerMessage().');
    }
    decoderMessageHandler = decoderModule.handleDecoderWorkerMessage;
    state = 'REPLAYING';
    setTimeout(replayNextMessage, 0);
}).catch((error) => {
    state = 'FAILED';
    messageQueue.length = 0;
    setTimeout(() => {
        throw error;
    }, 0);
});
