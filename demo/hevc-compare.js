import createSplatUWAWasm from './lib/splat_uwa_wasm.js';
import {
    decodeVideoStreamWithWebCodecs,
    videoBufferByteLength
} from './lib/WebCodecsVideoDecoder.js';

const TEXTURE_MODE_ASTC = 0;
const FORMAT_NAMES = ['YUV444_INTERLEAVED', 'I420', 'NV12', 'I400', 'YUV444P'];
const statusNode = document.querySelector('#status');
const outputNode = document.querySelector('#output');
const runButton = document.querySelector('#run');
const downloadButton = document.querySelector('#download');
let lastReport = null;

function setStatus(message) {
    statusNode.textContent = message;
}

function parseUwaPayload(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) {
        return { bytes: new Uint8Array(buffer), compressedPayload: false };
    }
    if (view.getUint32(4, true) !== 2) throw new Error('只支持 GLB 2.0。');
    let offset = 12;
    let json = null;
    let binOffset = 0;
    let binLength = 0;
    while (offset + 8 <= view.byteLength) {
        const chunkLength = view.getUint32(offset, true);
        const chunkType = view.getUint32(offset + 4, true);
        const chunkOffset = offset + 8;
        if (chunkOffset + chunkLength > view.byteLength) throw new Error('GLB chunk 越界。');
        if (chunkType === 0x4e4f534a) {
            json = JSON.parse(new TextDecoder().decode(
                new Uint8Array(buffer, chunkOffset, chunkLength)
            ).trim());
        } else if (chunkType === 0x004e4942) {
            binOffset = chunkOffset;
            binLength = chunkLength;
        }
        offset = chunkOffset + chunkLength;
    }
    if (!json || !binLength) throw new Error('GLB 缺少 JSON/BIN chunk。');
    const extensionNames = new Set([
        'UWA_gaussian_splatting_compression_EGSC',
        'UWA_primitive_3DGS_compression'
    ]);
    const stack = [json];
    let extension = null;
    while (stack.length && !extension) {
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
    const index = extension?.bufferView ?? extension?.buffer_view ?? extension?.buffer_view_index;
    const bufferView = Number.isInteger(index) ? json.bufferViews?.[index] : null;
    if (!bufferView || !Number.isInteger(bufferView.byteLength)) {
        throw new Error('GLB 没有 UWA 压缩 bufferView。');
    }
    const byteOffset = bufferView.byteOffset || 0;
    if (byteOffset < 0 || bufferView.byteLength <= 0 || byteOffset + bufferView.byteLength > binLength) {
        throw new Error('UWA bufferView 越界。');
    }
    return {
        bytes: new Uint8Array(buffer, binOffset + byteOffset, bufferView.byteLength),
        compressedPayload: true,
        bufferView: index
    };
}

function copyHeap(Module, ptr, size) {
    if (!ptr || !size) return new Uint8Array();
    return Module.HEAPU8.slice(Number(ptr), Number(ptr) + Number(size));
}

function fnv1a(bytes) {
    let hash = 0x811c9dc5;
    for (const value of bytes) {
        hash ^= value;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function byteStats(bytes) {
    let min = 255;
    let max = 0;
    let zero = 0;
    let sum = 0;
    for (const value of bytes) {
        min = Math.min(min, value);
        max = Math.max(max, value);
        zero += value === 0 ? 1 : 0;
        sum += value;
    }
    return {
        bytes: bytes.byteLength,
        hash: fnv1a(bytes),
        min: bytes.length ? min : null,
        max: bytes.length ? max : null,
        zeroCount: zero,
        mean: bytes.length ? sum / bytes.length : null
    };
}

function lumaPlane(bytes, format, width, height, frameCount) {
    const frameBytes = videoBufferByteLength(format, width, height, 1);
    const lumaBytes = width * height;
    const result = new Uint8Array(lumaBytes * frameCount);
    for (let frame = 0; frame < frameCount; frame++) {
        result.set(bytes.subarray(frame * frameBytes, frame * frameBytes + lumaBytes), frame * lumaBytes);
    }
    return result;
}

function compareBytes(left, right) {
    const count = Math.min(left.length, right.length);
    let diffBytes = Math.abs(left.length - right.length);
    let maxAbsDiff = 0;
    let sumAbsDiff = 0;
    let firstDiff = -1;
    for (let i = 0; i < count; i++) {
        const delta = Math.abs(left[i] - right[i]);
        if (delta) {
            diffBytes++;
            if (firstDiff < 0) firstDiff = i;
            maxAbsDiff = Math.max(maxAbsDiff, delta);
            sumAbsDiff += delta;
        }
    }
    return {
        same: left.length === right.length && diffBytes === 0,
        comparedBytes: count,
        diffBytes,
        firstDiff,
        maxAbsDiff,
        meanAbsDiff: count ? sumAbsDiff / count : null
    };
}

function pendingDescriptor(coordinator, Module, pendingIndex) {
    const pending = coordinator.getPendingVideo(pendingIndex);
    if (!pending.success) throw new Error(coordinator.getLastError() || `读取 pending video ${pendingIndex} 失败。`);
    return {
        streamIndex: pending.streamIndex,
        codecId: pending.codecId,
        frameWidth: pending.frameWidth,
        frameHeight: pending.frameHeight,
        frameCount: pending.frameCount,
        encoded: copyHeap(Module, pending.encodedPtr, pending.encodedSize)
    };
}

async function instantiateCoordinator() {
    const Module = await createSplatUWAWasm({
        locateFile: (path) => path.endsWith('.wasm') ? './lib/splat_uwa_wasm.wasm' : path
    });
    return { Module, coordinator: new Module.SplatUWACoordinatorWasm() };
}

function beginCoordinator(run, payload) {
    const { Module, coordinator } = run;
    const ptr = Module._malloc(payload.bytes.byteLength);
    if (!ptr) throw new Error('WASM 输入内存分配失败。');
    try {
        Module.HEAPU8.set(payload.bytes, ptr);
        const staged = coordinator.beginPrepare(
            ptr, payload.bytes.byteLength, TEXTURE_MODE_ASTC, payload.compressedPayload
        );
        if (!staged.success) throw new Error(coordinator.getLastError() || 'beginPrepare 失败。');
        return staged;
    } finally {
        Module._free(ptr);
    }
}

function getStoredDecoded(run, streamIndex) {
    const { Module, coordinator } = run;
    const result = coordinator.getDecodedVideo(streamIndex);
    if (!result.success) throw new Error(coordinator.getLastError() || `读取 decoded stream ${streamIndex} 失败。`);
    return {
        streamIndex,
        format: FORMAT_NAMES[result.pixelFormat] || `ABI-${result.pixelFormat}`,
        pixelFormat: result.pixelFormat,
        width: result.frameWidth,
        height: result.frameHeight,
        frameCount: result.frameCount,
        bytes: copyHeap(Module, result.decodedPtr, result.decodedSize)
    };
}

async function decodeOne(url, method, sharedRun = null) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    const input = await response.arrayBuffer();
    const payload = parseUwaPayload(input);
    const run = sharedRun || await instantiateCoordinator();
    const startedAt = performance.now();
    const staged = beginCoordinator(run, payload);
    const streams = [];
    try {
        for (let pendingIndex = 0; pendingIndex < staged.pendingVideoCount; pendingIndex++) {
            const descriptor = pendingDescriptor(run.coordinator, run.Module, pendingIndex);
            if (method === 'webcodecs') {
                const decoded = await decodeVideoStreamWithWebCodecs(descriptor.encoded ? {
                    ...descriptor,
                    encoded: undefined
                } : descriptor, descriptor.encoded, {
                    accelerationPreference: 'prefer-hardware',
                    timeoutMs: 60000
                });
                const decodedPtr = run.Module._malloc(decoded.decoded.byteLength);
                if (!decodedPtr) throw new Error('WebCodecs decoded buffer 分配失败。');
                try {
                    run.Module.HEAPU8.set(decoded.decoded, decodedPtr);
                    if (!run.coordinator.injectDecodedVideo(
                        descriptor.streamIndex, decodedPtr, decoded.decoded.byteLength, decoded.pixelFormat
                    )) throw new Error(run.coordinator.getLastError() || '注入 WebCodecs 输出失败。');
                } finally {
                    run.Module._free(decodedPtr);
                }
                const stored = getStoredDecoded(run, descriptor.streamIndex);
                streams.push({
                    streamIndex: descriptor.streamIndex,
                    path: 'webcodecs',
                    encodedBytes: descriptor.encoded.byteLength,
                    format: decoded.layout.format,
                    pixelFormat: decoded.pixelFormat,
                    width: descriptor.frameWidth,
                    height: descriptor.frameHeight,
                    frameCount: descriptor.frameCount,
                    decodeMs: decoded.timing?.totalMs,
                    copyMs: decoded.timing?.copyMs,
                    rangeNormalized: !!decoded.rangeNormalized,
                    detectedFullRange: !!decoded.detectedFullRange,
                    minLuma: decoded.minLuma ?? null,
                    maxLuma: decoded.maxLuma ?? null,
                    zeroLuma: decoded.zeroLuma ?? null,
                    colorSpace: decoded.colorSpace || null,
                    storedMatchesWebCodecs: compareBytes(decoded.decoded, stored.bytes),
                    bytes: decoded.decoded,
                    stored
                });
            }
        }
        if (method === 'ffmpeg') {
            if (!run.coordinator.decodePendingVideosWithFallback()) {
                throw new Error(run.coordinator.getLastError() || 'FFmpeg 解码失败。');
            }
            for (let pendingIndex = 0; pendingIndex < staged.pendingVideoCount; pendingIndex++) {
                const descriptor = pendingDescriptor(run.coordinator, run.Module, pendingIndex);
                const stored = getStoredDecoded(run, descriptor.streamIndex);
                streams.push({
                    streamIndex: descriptor.streamIndex,
                    path: 'ffmpeg',
                    encodedBytes: descriptor.encoded.byteLength,
                    format: stored.format,
                    pixelFormat: stored.pixelFormat,
                    width: stored.width,
                    height: stored.height,
                    frameCount: stored.frameCount,
                    bytes: stored.bytes,
                    stored
                });
            }
        }
        const elapsedMs = performance.now() - startedAt;
        return {
            url,
            inputBytes: input.byteLength,
            compressedPayload: payload.compressedPayload,
            pendingVideoCount: staged.pendingVideoCount,
            // pendingVideoCount only covers compressed streams handed to
            // WebCodecs/FFmpeg. codec0 raw YUV video is adopted during
            // beginPrepare and must be reported separately.
            rawVideoStreamCount: staged.rawVideoStreamCount || 0,
            rawVideoInputBytes: staged.rawVideoInputBytes || 0,
            rawVideoAdoptMs: staged.rawVideoAdoptMs || 0,
            elapsedMs,
            streams: streams.map((stream) => {
                const luma = lumaPlane(stream.bytes, stream.pixelFormat, stream.width, stream.height, stream.frameCount);
                return {
                    streamIndex: stream.streamIndex,
                    path: stream.path,
                    encodedBytes: stream.encodedBytes,
                    format: stream.format,
                    pixelFormat: stream.pixelFormat,
                    width: stream.width,
                    height: stream.height,
                    frameCount: stream.frameCount,
                    decodeMs: stream.decodeMs ?? null,
                    copyMs: stream.copyMs ?? null,
                    full: byteStats(stream.bytes),
                    luma: byteStats(luma),
                    storedMatchesWebCodecs: stream.storedMatchesWebCodecs || null,
                    bytes: stream.bytes,
                    lumaBytes: luma
                };
            })
        };
    } finally {
        run.coordinator.release();
        if (!sharedRun) run.coordinator.delete();
    }
}

function stripBinary(report) {
    return JSON.parse(JSON.stringify(report, (key, value) => {
        if (key === 'bytes' || key === 'lumaBytes') return undefined;
        return value;
    }));
}

function compareMethods(webReport, ffmpegReport) {
    const comparisons = [];
    for (const webStream of webReport.streams) {
        const ffmpegStream = ffmpegReport.streams.find((item) => item.streamIndex === webStream.streamIndex);
        if (!ffmpegStream) {
            comparisons.push({ streamIndex: webStream.streamIndex, error: 'FFmpeg 没有对应 stream' });
            continue;
        }
        comparisons.push({
            streamIndex: webStream.streamIndex,
            format: { webcodecs: webStream.format, ffmpeg: ffmpegStream.format },
            dimensions: {
                webcodecs: [webStream.width, webStream.height, webStream.frameCount],
                ffmpeg: [ffmpegStream.width, ffmpegStream.height, ffmpegStream.frameCount]
            },
            fullBytes: compareBytes(webStream.bytes, ffmpegStream.bytes),
            lumaBytes: compareBytes(webStream.lumaBytes, ffmpegStream.lumaBytes),
            webcodecsLuma: webStream.luma,
            ffmpegLuma: ffmpegStream.luma
        });
    }
    return comparisons;
}

async function run() {
    runButton.disabled = true;
    downloadButton.disabled = true;
    outputNode.textContent = '';
    const sceneUrls = [
        ['library', document.querySelector('#libraryUrl').value.trim()],
        ['lumber', document.querySelector('#lumberUrl').value.trim()]
    ].filter(([, url]) => url);
    const report = {
        schema: 'uwa.hevc.decoder.compare.v1',
        startedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        webCodecs: typeof VideoDecoder === 'function',
        scenes: []
    };
    try {
        for (const [name, url] of sceneUrls) {
            setStatus(`${name}: WebCodecs 解码中…`);
            const sharedRun = await instantiateCoordinator();
            try {
                const web = await decodeOne(url, 'webcodecs', sharedRun);
                setStatus(`${name}: FFmpeg 解码中…`);
                const ffmpeg = await decodeOne(url, 'ffmpeg', sharedRun);
                report.scenes.push({
                    name, url, webcodecs: stripBinary(web), ffmpeg: stripBinary(ffmpeg),
                    comparisons: compareMethods(web, ffmpeg)
                });
            } finally {
                sharedRun.coordinator.delete();
            }
            setStatus(`${name}: 完成`);
            outputNode.textContent = JSON.stringify(report, null, 2);
        }
        report.finishedAt = new Date().toISOString();
        lastReport = report;
        outputNode.textContent = JSON.stringify(report, null, 2);
        downloadButton.disabled = false;
        setStatus('全部完成。请下载 JSON 或直接复制页面内容。');
    } catch (error) {
        report.error = error?.stack || error?.message || String(error);
        lastReport = report;
        outputNode.textContent = JSON.stringify(report, null, 2);
        setStatus('失败：' + (error?.message || String(error)));
    } finally {
        runButton.disabled = false;
    }
}

runButton.addEventListener('click', () => run().catch((error) => setStatus(String(error))));
downloadButton.addEventListener('click', () => {
    if (!lastReport) return;
    const blob = new Blob([JSON.stringify(lastReport, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `uwa-hevc-compare-${new Date().toISOString().replaceAll(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
