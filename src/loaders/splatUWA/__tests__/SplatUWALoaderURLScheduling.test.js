import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { AbortedPromiseError } from '../../../AbortablePromise.js';
import { LoaderStatus } from '../../LoaderStatus.js';
import { SplatUWALoader } from '../SplatUWALoader.js';

const originalFetch = globalThis.fetch;
const originalPrewarmDecoderWorker = SplatUWALoader.prewarmDecoderWorker;
const originalParse = SplatUWALoader.parse;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return { promise, resolve, reject };
}

function installControlledFetch() {
    const calls = [];
    globalThis.fetch = (path, options = {}) => {
        const response = deferred();
        const call = {
            path,
            options,
            response,
            aborted: false
        };
        calls.push(call);
        options.signal?.addEventListener('abort', () => {
            call.aborted = true;
            response.reject(options.signal.reason || new Error('Download aborted.'));
        }, { once: true });
        return response.promise;
    };
    return calls;
}

function finishDownload(call, bytes = new Uint8Array([1, 2, 3, 4])) {
    let readCount = 0;
    call.response.resolve({
        ok: true,
        headers: {
            get(name) {
                return name === 'Content-Length' ? String(bytes.byteLength) : null;
            }
        },
        body: {
            getReader() {
                return {
                    read() {
                        if (readCount++ === 0) return Promise.resolve({ value: bytes, done: false });
                        return Promise.resolve({ value: undefined, done: true });
                    }
                };
            }
        }
    });
}

function failDownload(call, error) {
    call.response.reject(error);
}

function loadFromURL(onProgress, texturePolicy) {
    return SplatUWALoader.loadFromURL(
        '/scene.glb',
        onProgress,
        false,
        undefined,
        1,
        0,
        true,
        2,
        undefined,
        texturePolicy
    );
}

async function waitFor(predicate, message = 'Condition was not reached.') {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (predicate()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(message);
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    SplatUWALoader.prewarmDecoderWorker = originalPrewarmDecoderWorker;
    SplatUWALoader.parse = originalParse;
});

test('starts download and full decoder warmup together, then waits for download and promised policy', async () => {
    const fetchCalls = installControlledFetch();
    const warmup = deferred();
    const policy = deferred();
    const parseResult = { name: 'splat-buffer' };
    const parseCalls = [];
    let warmupCalls = 0;
    SplatUWALoader.prewarmDecoderWorker = () => {
        warmupCalls++;
        return warmup.promise;
    };
    SplatUWALoader.parse = (...args) => {
        parseCalls.push(args);
        return Promise.resolve(parseResult);
    };

    const load = loadFromURL(undefined, policy.promise);
    assert.equal(fetchCalls.length, 1);
    assert.equal(warmupCalls, 1);

    warmup.resolve({ textureBuildCapabilities: { bc3: true } });
    policy.resolve({ textureStrategies: ['bc3', 'cpu'] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parseCalls.length, 0);

    finishDownload(fetchCalls[0]);
    await waitFor(() => parseCalls.length === 1);
    assert.deepEqual(parseCalls[0][4], ['bc3', 'cpu']);
    assert.equal(await load.promise, parseResult);
});

test('waits for warmup when download finishes first and emits Processing only at the join', async () => {
    const fetchCalls = installControlledFetch();
    const warmup = deferred();
    const progressEvents = [];
    const parseCalls = [];
    SplatUWALoader.prewarmDecoderWorker = () => warmup.promise;
    SplatUWALoader.parse = (...args) => {
        parseCalls.push(args);
        return Promise.resolve({});
    };

    const load = loadFromURL((...args) => progressEvents.push(args), 'astc');
    finishDownload(fetchCalls[0]);
    await waitFor(() => progressEvents.some(([percent]) => percent === 100));
    assert.equal(parseCalls.length, 0);
    assert.equal(progressEvents.some((event) => event[2] === LoaderStatus.Processing), false);

    warmup.resolve({});
    await load.promise;
    assert.equal(parseCalls.length, 1);
    assert.deepEqual(parseCalls[0][4], ['astc', 'cpu']);
    assert.equal(progressEvents.filter((event) => event[2] === LoaderStatus.Processing).length, 1);
});

test('keeps boolean, string, object, and null texture policies backward compatible', async () => {
    const fetchCalls = installControlledFetch();
    const parseStrategies = [];
    SplatUWALoader.prewarmDecoderWorker = () => Promise.resolve({
        textureBuildCapabilities: { bc3: true }
    });
    SplatUWALoader.parse = (...args) => {
        parseStrategies.push(args[4]);
        return Promise.resolve({});
    };

    const cases = [
        { policy: true, expected: ['cpu'] },
        { policy: false, expected: ['astc', 'cpu'] },
        { policy: 'bc3', expected: ['bc3', 'cpu'] },
        { policy: { textureStrategies: ['bc7'] }, expected: ['bc7', 'cpu'] },
        { policy: null, expected: ['cpu'] }
    ];
    for (let index = 0; index < cases.length; index++) {
        const load = loadFromURL(undefined, cases[index].policy);
        finishDownload(fetchCalls[index]);
        await load.promise;
        assert.deepEqual(parseStrategies[index], cases[index].expected);
    }
});

test('synchronous warmup and policy acquisition failures abort download and preserve the failure', async () => {
    for (const failureSource of ['warmup-sync', 'policy-rejection', 'policy-getter']) {
        const fetchCalls = installControlledFetch();
        const failure = new Error(`${failureSource} failed`);
        SplatUWALoader.prewarmDecoderWorker = () => {
            if (failureSource === 'warmup-sync') throw failure;
            return new Promise(() => {});
        };
        SplatUWALoader.parse = () => assert.fail('parse must not run after a join failure');
        let policy = 'cpu';
        if (failureSource === 'policy-rejection') policy = Promise.reject(failure);
        if (failureSource === 'policy-getter') {
            policy = Object.defineProperty({}, 'then', {
                get() {
                    throw failure;
                }
            });
        }

        const load = loadFromURL(undefined, policy);
        await assert.rejects(load.promise, (error) => error === failure);
        assert.equal(fetchCalls[0].aborted, true);
    }
});

test('a download failure does not cancel or dispose shared decoder warmup', async () => {
    const fetchCalls = installControlledFetch();
    const warmup = deferred();
    let parseCalls = 0;
    SplatUWALoader.prewarmDecoderWorker = () => warmup.promise;
    SplatUWALoader.parse = () => {
        parseCalls++;
    };
    const downloadFailure = new Error('network failed');

    const load = loadFromURL(undefined, 'cpu');
    failDownload(fetchCalls[0], downloadFailure);
    await assert.rejects(load.promise, AbortedPromiseError);
    assert.equal(parseCalls, 0);

    warmup.resolve({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parseCalls, 0);
});

test('abort rejects with AbortedPromiseError during download and never parses', async () => {
    const fetchCalls = installControlledFetch();
    const warmup = deferred();
    let parseCalls = 0;
    SplatUWALoader.prewarmDecoderWorker = () => warmup.promise;
    SplatUWALoader.parse = () => {
        parseCalls++;
    };

    const load = loadFromURL(undefined, 'cpu');
    load.abort('user canceled');
    await assert.rejects(load.promise, AbortedPromiseError);
    assert.equal(fetchCalls[0].aborted, true);
    warmup.resolve({});
    assert.equal(parseCalls, 0);
});

test('abort after download completion while warmup is pending never parses', async () => {
    const fetchCalls = installControlledFetch();
    const warmup = deferred();
    let parseCalls = 0;
    SplatUWALoader.prewarmDecoderWorker = () => warmup.promise;
    SplatUWALoader.parse = () => {
        parseCalls++;
    };

    const load = loadFromURL(undefined, 'cpu');
    finishDownload(fetchCalls[0]);
    await new Promise((resolve) => setImmediate(resolve));
    load.abort('user canceled after download');
    await assert.rejects(load.promise, AbortedPromiseError);
    warmup.resolve({});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parseCalls, 0);
});

test('abort from the Processing callback prevents parse', async () => {
    const fetchCalls = installControlledFetch();
    let parseCalls = 0;
    SplatUWALoader.prewarmDecoderWorker = () => Promise.resolve({});
    SplatUWALoader.parse = () => {
        parseCalls++;
    };

    let load;
    load = loadFromURL((percent, label, status) => {
        if (status === LoaderStatus.Processing) load.abort('callback canceled');
    }, 'cpu');
    finishDownload(fetchCalls[0]);
    await assert.rejects(load.promise, AbortedPromiseError);
    assert.equal(parseCalls, 0);
});

test('dispose from the Processing callback invalidates the generation before parse', async () => {
    const fetchCalls = installControlledFetch();
    let parseCalls = 0;
    SplatUWALoader.prewarmDecoderWorker = () => Promise.resolve({});
    SplatUWALoader.parse = () => {
        parseCalls++;
    };

    const load = loadFromURL((percent, label, status) => {
        if (status === LoaderStatus.Processing) SplatUWALoader.dispose();
    }, 'cpu');
    finishDownload(fetchCalls[0]);
    await assert.rejects(load.promise, /canceled by disposal/);
    assert.equal(parseCalls, 0);
});

test('late disposal while policy is pending prevents parse', async () => {
    const fetchCalls = installControlledFetch();
    const policy = deferred();
    let parseCalls = 0;
    SplatUWALoader.prewarmDecoderWorker = () => Promise.resolve({});
    SplatUWALoader.parse = () => {
        parseCalls++;
    };

    const load = loadFromURL(undefined, policy.promise);
    finishDownload(fetchCalls[0]);
    await new Promise((resolve) => setImmediate(resolve));
    await SplatUWALoader.dispose();
    policy.resolve('cpu');
    await assert.rejects(load.promise, /canceled by disposal/);
    assert.equal(parseCalls, 0);
});

test('abort after parse dispatch ignores its late result without interrupting shared work', async () => {
    const fetchCalls = installControlledFetch();
    const parse = deferred();
    let parseCalls = 0;
    SplatUWALoader.prewarmDecoderWorker = () => Promise.resolve({});
    SplatUWALoader.parse = () => {
        parseCalls++;
        return parse.promise;
    };

    const load = loadFromURL(undefined, 'cpu');
    finishDownload(fetchCalls[0]);
    await waitFor(() => parseCalls === 1);
    load.abort('canceled after decode dispatch');
    await assert.rejects(load.promise, AbortedPromiseError);
    parse.resolve({ name: 'late splat buffer' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(parseCalls, 1);
});

test('progressive UWA callback stays live until abort, then ignores late previews and full results', async () => {
    const fetchCalls = installControlledFetch();
    const parse = deferred();
    const previews = [];
    let deliverPreview;
    SplatUWALoader.prewarmDecoderWorker = () => Promise.resolve({});
    SplatUWALoader.parse = (...args) => {
        deliverPreview = args[7];
        return parse.promise;
    };
    const load = SplatUWALoader.loadFromURL('/scene.glb', undefined, true,
        (preview) => previews.push(preview), 1, 0, true, 2, undefined, 'cpu');
    finishDownload(fetchCalls[0]);
    await waitFor(() => typeof deliverPreview === 'function');
    deliverPreview({numPoints: 3});
    assert.equal(previews.length, 1);
    load.abort('cancel preview pipeline');
    await assert.rejects(load.promise, AbortedPromiseError);
    deliverPreview({numPoints: 6});
    parse.resolve({numPoints: 100});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(previews.length, 1);
});

test('dispose invalidates a preview observer from a previous loader generation', async () => {
    const fetchCalls = installControlledFetch();
    const parse = deferred();
    let deliverPreview;
    let previewCalls = 0;
    SplatUWALoader.prewarmDecoderWorker = () => Promise.resolve({});
    SplatUWALoader.parse = (...args) => {
        deliverPreview = args[7];
        return parse.promise;
    };
    const load = SplatUWALoader.loadFromURL('/scene.glb', undefined, false, undefined,
        1, 0, true, 2, undefined, 'cpu', () => previewCalls++);
    finishDownload(fetchCalls[0]);
    await waitFor(() => typeof deliverPreview === 'function');
    await SplatUWALoader.dispose();
    deliverPreview({numPoints: 6});
    parse.resolve({numPoints: 100});
    await assert.rejects(load.promise, /canceled by disposal/);
    assert.equal(previewCalls, 0);
});
