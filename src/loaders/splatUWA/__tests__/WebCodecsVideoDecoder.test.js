import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyWebCodecsFastPath,
    compactVideoFramePlanes,
    createWebCodecsCapabilityKey,
    decodeVideoStreamWithWebCodecs,
    isWebCodecsNegativeCapabilityError,
    parseHevcAnnexBNalUnits,
    parseHevcSps,
    splitHevcAccessUnits,
    VIDEO_PIXEL_FORMAT,
    videoBufferByteLength
} from '../WebCodecsVideoDecoder.js';
import {
    getWebCodecsCapabilityCanary,
    WEB_CODECS_CANARY_DESCRIPTOR
} from '../WebCodecsCapabilityCanary.js';

class BitWriter {
    constructor() {
        this.bits = [];
    }

    writeBits(value, bitCount) {
        const numericValue = BigInt(value);
        for (let bit = bitCount - 1; bit >= 0; bit--) {
            this.bits.push(Number((numericValue >> BigInt(bit)) & 1n));
        }
    }

    writeUnsignedExpGolomb(value) {
        const codeNum = value + 1;
        const bitCount = Math.floor(Math.log2(codeNum)) + 1;
        this.writeBits(0, bitCount - 1);
        this.writeBits(codeNum, bitCount);
    }

    finishRbsp() {
        this.bits.push(1);
        while (this.bits.length % 8 !== 0) this.bits.push(0);
        const bytes = new Uint8Array(this.bits.length / 8);
        for (let bit = 0; bit < this.bits.length; bit++) {
            bytes[bit >> 3] |= this.bits[bit] << (7 - (bit & 7));
        }
        return bytes;
    }
}

test('uses a production canary matching the target 4K HEVC Main configuration', () => {
    const canary = getWebCodecsCapabilityCanary();
    const sps = parseHevcSps(canary);
    assert.equal(sps.codec, 'hev1.1.6.L150.90');
    assert.equal(sps.profileIdc, 1);
    assert.equal(sps.chroma, '420');
    assert.equal(sps.bitDepthLuma, 8);
    assert.equal(sps.displayWidth, WEB_CODECS_CANARY_DESCRIPTOR.frameWidth);
    assert.equal(sps.displayHeight, WEB_CODECS_CANARY_DESCRIPTOR.frameHeight);
    assert.equal(splitHevcAccessUnits(canary).length, WEB_CODECS_CANARY_DESCRIPTOR.frameCount);
    assert.equal(classifyWebCodecsFastPath(WEB_CODECS_CANARY_DESCRIPTOR, canary).eligible, true);
});

function escapeRbsp(rbsp) {
    const escaped = [];
    let zeroCount = 0;
    for (const byte of rbsp) {
        if (zeroCount >= 2 && byte <= 3) {
            escaped.push(3);
            zeroCount = 0;
        }
        escaped.push(byte);
        zeroCount = byte === 0 ? zeroCount + 1 : 0;
    }
    return escaped;
}

function annexBNal(type, payload) {
    return [0, 0, 0, 1, type << 1, 1, ...payload];
}

function buildSps({
    width = 4,
    height = 2,
    profileIdc = 1,
    chromaFormatIdc = 1,
    bitDepthMinus8 = 0
} = {}) {
    const writer = new BitWriter();
    writer.writeBits(0, 4);
    writer.writeBits(0, 3);
    writer.writeBits(1, 1);
    writer.writeBits(0, 2);
    writer.writeBits(0, 1);
    writer.writeBits(profileIdc, 5);
    writer.writeBits(0x60000000, 32);
    writer.writeBits(0xb0, 8);
    writer.writeBits(0, 40);
    writer.writeBits(93, 8);
    writer.writeUnsignedExpGolomb(0);
    writer.writeUnsignedExpGolomb(chromaFormatIdc);
    writer.writeUnsignedExpGolomb(width);
    writer.writeUnsignedExpGolomb(height);
    writer.writeBits(0, 1);
    writer.writeUnsignedExpGolomb(bitDepthMinus8);
    writer.writeUnsignedExpGolomb(bitDepthMinus8);
    return annexBNal(33, escapeRbsp(writer.finishRbsp()));
}

test('parses an exact RFC6381 HEVC codec and 8-bit SPS layout', () => {
    const encoded = new Uint8Array([
        ...buildSps(),
        ...annexBNal(19, [0x80, 0x55])
    ]);
    const sps = parseHevcSps(encoded);
    assert.equal(sps.codec, 'hev1.1.6.L93.B0');
    assert.equal(sps.displayWidth, 4);
    assert.equal(sps.displayHeight, 2);
    assert.equal(sps.chroma, '420');
    assert.equal(sps.bitDepthLuma, 8);
});

test('rejects high-bit-depth HEVC before WebCodecs configuration', () => {
    const encoded = new Uint8Array([
        ...buildSps({ bitDepthMinus8: 2 }),
        ...annexBNal(19, [0x80, 0x55])
    ]);
    assert.throws(() => parseHevcSps(encoded), /only supports 8-bit HEVC/);
});

test('classifies only HEVC Main 8-bit 4:2:0 streams for the session fast path', () => {
    const descriptor = { codecId: 2, frameWidth: 4, frameHeight: 2, frameCount: 1 };
    const buildStream = (spsOptions) => new Uint8Array([
        ...buildSps(spsOptions),
        ...annexBNal(19, [0x80, 0x55])
    ]);

    assert.equal(classifyWebCodecsFastPath(descriptor, buildStream()).eligible, true);
    assert.match(classifyWebCodecsFastPath(
        { ...descriptor, codecId: 1 }, buildStream()
    ).reason, /H\.264 is outside/);
    assert.match(classifyWebCodecsFastPath(
        descriptor, buildStream({ profileIdc: 2 })
    ).reason, /profile_idc 2/);
    assert.match(classifyWebCodecsFastPath(
        descriptor, buildStream({ bitDepthMinus8: 2 })
    ).reason, /only supports 8-bit HEVC/);
    assert.match(classifyWebCodecsFastPath(
        descriptor, buildStream({ chromaFormatIdc: 2 })
    ).reason, /422 chroma/);
});

test('rejects out-of-class streams before probing WebCodecs configurations', async (context) => {
    const originalVideoDecoder = globalThis.VideoDecoder;
    const originalEncodedVideoChunk = globalThis.EncodedVideoChunk;
    context.after(() => {
        globalThis.VideoDecoder = originalVideoDecoder;
        globalThis.EncodedVideoChunk = originalEncodedVideoChunk;
    });

    let configProbeCount = 0;
    globalThis.VideoDecoder = class {
        static async isConfigSupported() {
            configProbeCount++;
            return { supported: true };
        }
    };
    globalThis.EncodedVideoChunk = class {};
    const descriptor = { codecId: 2, frameWidth: 4, frameHeight: 2, frameCount: 1 };
    const buildStream = (spsOptions) => new Uint8Array([
        ...buildSps(spsOptions),
        ...annexBNal(19, [0x80, 0x55])
    ]);

    await assert.rejects(
        decodeVideoStreamWithWebCodecs({ ...descriptor, codecId: 1 }, buildStream()),
        /H\.264 is outside/
    );
    await assert.rejects(
        decodeVideoStreamWithWebCodecs(descriptor, buildStream({ profileIdc: 2 })),
        /profile_idc 2/
    );
    await assert.rejects(
        decodeVideoStreamWithWebCodecs(descriptor, buildStream({ bitDepthMinus8: 2 })),
        /only supports 8-bit HEVC/
    );
    await assert.rejects(
        decodeVideoStreamWithWebCodecs(descriptor, buildStream({ chromaFormatIdc: 2 })),
        /422 chroma/
    );
    assert.equal(configProbeCount, 0);
});

test('times out a stalled WebCodecs configuration probe', async (context) => {
    const originalVideoDecoder = globalThis.VideoDecoder;
    const originalEncodedVideoChunk = globalThis.EncodedVideoChunk;
    context.after(() => {
        globalThis.VideoDecoder = originalVideoDecoder;
        globalThis.EncodedVideoChunk = originalEncodedVideoChunk;
    });

    globalThis.VideoDecoder = class {
        static isConfigSupported() {
            return new Promise(() => {});
        }
    };
    globalThis.EncodedVideoChunk = class {};
    const encoded = new Uint8Array([
        ...buildSps(),
        ...annexBNal(19, [0x80, 0x55])
    ]);

    await assert.rejects(
        decodeVideoStreamWithWebCodecs({
            codecId: 2,
            frameWidth: 4,
            frameHeight: 2,
            frameCount: 1
        }, encoded, { timeoutMs: 20 }),
        (error) => error?.code === 'TIMEOUT' && /timed out/.test(error.message)
    );
});

test('reports an unavailable WebCodecs API for an eligible stream', async (context) => {
    const originalVideoDecoder = globalThis.VideoDecoder;
    const originalEncodedVideoChunk = globalThis.EncodedVideoChunk;
    context.after(() => {
        globalThis.VideoDecoder = originalVideoDecoder;
        globalThis.EncodedVideoChunk = originalEncodedVideoChunk;
    });

    globalThis.VideoDecoder = undefined;
    globalThis.EncodedVideoChunk = undefined;
    const encoded = new Uint8Array([
        ...buildSps(),
        ...annexBNal(19, [0x80, 0x55])
    ]);
    await assert.rejects(
        decodeVideoStreamWithWebCodecs({
            codecId: 2,
            frameWidth: 4,
            frameHeight: 2,
            frameCount: 1
        }, encoded),
        /WebCodecs VideoDecoder is unavailable/
    );
});

test('splits HEVC slices into complete access units', () => {
    const encoded = new Uint8Array([
        ...buildSps(),
        ...annexBNal(34, [0x80]),
        ...annexBNal(19, [0x80, 0x11]),
        ...annexBNal(1, [0x80, 0x22])
    ]);
    const accessUnits = splitHevcAccessUnits(encoded);
    assert.equal(accessUnits.length, 2);
    assert.equal(accessUnits[0].type, 'key');
    assert.equal(accessUnits[1].type, 'delta');
});

test('prepends cached parameter sets to later HEVC key access units', () => {
    const vps = annexBNal(32, [0x01]);
    const sps = buildSps();
    const pps = annexBNal(34, [0x80]);
    const encoded = new Uint8Array([
        ...vps,
        ...sps,
        ...pps,
        ...annexBNal(19, [0x80, 0x11]),
        ...annexBNal(1, [0x80, 0x22]),
        ...annexBNal(20, [0x80, 0x33])
    ]);
    const accessUnits = splitHevcAccessUnits(encoded);
    assert.deepEqual(accessUnits.map((accessUnit) => accessUnit.type), ['key', 'delta', 'key']);

    const repeatedKeyNalTypes = parseHevcAnnexBNalUnits(accessUnits[2].data).map((nal) => nal.type);
    assert.deepEqual(repeatedKeyNalTypes, [32, 33, 34, 20]);
});

test('compacts padded I420 planes without expanding chroma', () => {
    const copied = new Uint8Array([
        1, 2, 3, 4, 0,
        5, 6, 7, 8, 0,
        10, 20, 0,
        30, 40, 0
    ]);
    const compact = compactVideoFramePlanes(copied, [
        { offset: 0, stride: 5 },
        { offset: 10, stride: 3 },
        { offset: 13, stride: 3 }
    ], 'I420', 4, 2);
    assert.deepEqual(Array.from(compact), [1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 30, 40]);
    assert.equal(compact.byteLength, videoBufferByteLength(VIDEO_PIXEL_FORMAT.I420, 4, 2));
});

test('compacts padded NV12 planes and rejects odd 4:2:0 dimensions', () => {
    assert.deepEqual(Array.from(compactVideoFramePlanes(
        new Uint8Array([1, 2, 0, 3, 4, 0, 10, 30, 0, 0]),
        [{ offset: 0, stride: 3 }, { offset: 6, stride: 4 }],
        'NV12', 2, 2
    )), [1, 2, 3, 4, 10, 30]);
    assert.throws(() => videoBufferByteLength(VIDEO_PIXEL_FORMAT.NV12, 3, 2), /even frame dimensions/);
});

test('runs the WebCodecs lifecycle and closes every decoded frame', async (context) => {
    const originalVideoDecoder = globalThis.VideoDecoder;
    const originalEncodedVideoChunk = globalThis.EncodedVideoChunk;
    context.after(() => {
        globalThis.VideoDecoder = originalVideoDecoder;
        globalThis.EncodedVideoChunk = originalEncodedVideoChunk;
    });

    const frameSources = [
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 10, 30, 20, 40]),
        new Uint8Array([11, 12, 13, 14, 15, 16, 17, 18, 50, 70, 60, 80])
    ];
    const frames = [];
    class FakeVideoFrame {
        constructor(source) {
            this.source = source;
            this.format = 'NV12';
            this.codedWidth = 4;
            this.codedHeight = 2;
            this.displayWidth = 4;
            this.displayHeight = 2;
            this.visibleRect = { x: 0, y: 0, width: 4, height: 2 };
            this.closed = false;
            frames.push(this);
        }

        allocationSize(options) {
            assert.equal(Object.hasOwn(options, 'format'), false);
            return this.source.byteLength;
        }

        async copyTo(destination, options) {
            assert.equal(Object.hasOwn(options, 'format'), false);
            destination.set(this.source);
            return [
                { offset: 0, stride: 4 },
                { offset: 8, stride: 4 }
            ];
        }

        close() {
            assert.equal(this.closed, false);
            this.closed = true;
        }
    }

    class FakeEncodedVideoChunk {
        constructor(init) {
            Object.assign(this, init);
        }
    }

    class FakeVideoDecoder {
        static async isConfigSupported(config) {
            FakeVideoDecoder.supportConfigs.push(config);
            return {
                supported: config.hardwareAcceleration === 'prefer-software',
                config: {
                    codec: config.codec,
                    codedWidth: config.codedWidth,
                    codedHeight: config.codedHeight
                }
            };
        }

        constructor(init) {
            this.init = init;
            this.chunks = [];
            this.state = 'unconfigured';
            FakeVideoDecoder.instance = this;
        }

        configure(config) {
            this.config = config;
            this.state = 'configured';
        }

        decode(chunk) {
            this.chunks.push(chunk);
        }

        async flush() {
            this.chunks.forEach((chunk, index) => this.init.output(new FakeVideoFrame(frameSources[index])));
        }

        close() {
            this.state = 'closed';
        }
    }
    FakeVideoDecoder.supportConfigs = [];
    globalThis.VideoDecoder = FakeVideoDecoder;
    globalThis.EncodedVideoChunk = FakeEncodedVideoChunk;

    const encoded = new Uint8Array([
        ...buildSps(),
        ...annexBNal(34, [0x80]),
        ...annexBNal(19, [0x80, 0x11]),
        ...annexBNal(1, [0x80, 0x22])
    ]);
    const result = await decodeVideoStreamWithWebCodecs({
        codecId: 2,
        frameWidth: 4,
        frameHeight: 2,
        frameCount: 2
    }, encoded, { accelerationPreference: 'prefer-software' });

    assert.equal(result.codec, 'hev1.1.6.L93.B0');
    assert.equal(result.pixelFormat, VIDEO_PIXEL_FORMAT.NV12);
    assert.equal(result.decoded.byteLength, 24);
    assert.deepEqual(Array.from(result.decoded), Array.from(new Uint8Array([...frameSources[0], ...frameSources[1]])));
    assert.equal(result.layout.format, 'NV12');
    assert.equal(result.layout.frameCount, 2);
    assert.ok(result.timing.copyMs >= 0);
    assert.deepEqual(FakeVideoDecoder.instance.chunks.map((chunk) => chunk.type), ['key', 'delta']);
    assert.equal(FakeVideoDecoder.supportConfigs.length, 1);
    assert.equal(FakeVideoDecoder.supportConfigs[0].hardwareAcceleration, 'prefer-software');
    assert.equal(FakeVideoDecoder.instance.config.hardwareAcceleration, 'prefer-software');
    assert.equal(FakeVideoDecoder.instance.state, 'closed');
    assert.equal(frames.length, 2);
    assert.ok(frames.every((frame) => frame.closed));
});

test('retries software decoding when hardware output is RGB', async (context) => {
    const originalVideoDecoder = globalThis.VideoDecoder;
    const originalEncodedVideoChunk = globalThis.EncodedVideoChunk;
    context.after(() => {
        globalThis.VideoDecoder = originalVideoDecoder;
        globalThis.EncodedVideoChunk = originalEncodedVideoChunk;
    });

    const decodedI420 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 10, 20, 30, 40]);
    const configuredAccelerations = [];
    const frames = [];
    class FakeVideoFrame {
        constructor(format) {
            this.format = format;
            this.codedWidth = 4;
            this.codedHeight = 2;
            this.displayWidth = 4;
            this.displayHeight = 2;
            this.visibleRect = { x: 0, y: 0, width: 4, height: 2 };
            this.closed = false;
            frames.push(this);
        }

        allocationSize() {
            return decodedI420.byteLength;
        }

        async copyTo(destination) {
            destination.set(decodedI420);
            return [
                { offset: 0, stride: 4 },
                { offset: 8, stride: 2 },
                { offset: 10, stride: 2 }
            ];
        }

        close() {
            this.closed = true;
        }
    }

    class FakeEncodedVideoChunk {
        constructor(init) {
            Object.assign(this, init);
        }
    }

    class FakeVideoDecoder {
        static async isConfigSupported(config) {
            return { supported: true, config };
        }

        constructor(init) {
            this.init = init;
            this.state = 'unconfigured';
        }

        configure(config) {
            this.config = config;
            this.state = 'configured';
            configuredAccelerations.push(config.hardwareAcceleration || 'default');
        }

        decode() {}

        async flush() {
            const format = this.config.hardwareAcceleration === 'prefer-hardware' ? 'RGBA' : 'I420';
            this.init.output(new FakeVideoFrame(format));
        }

        close() {
            this.state = 'closed';
        }
    }

    globalThis.VideoDecoder = FakeVideoDecoder;
    globalThis.EncodedVideoChunk = FakeEncodedVideoChunk;
    const encoded = new Uint8Array([
        ...buildSps(),
        ...annexBNal(19, [0x80, 0x11])
    ]);
    const result = await decodeVideoStreamWithWebCodecs({
        codecId: 2,
        frameWidth: 4,
        frameHeight: 2,
        frameCount: 1
    }, encoded);

    assert.deepEqual(configuredAccelerations, ['prefer-hardware', 'prefer-software']);
    assert.equal(result.config.hardwareAcceleration, 'prefer-software');
    assert.equal(result.pixelFormat, VIDEO_PIXEL_FORMAT.I420);
    assert.deepEqual(Array.from(result.decoded), Array.from(decodedI420));
    assert.equal(frames.length, 2);
    assert.ok(frames.every((frame) => frame.closed));
});

test('marks RGB and null VideoFrame formats as cacheable capability failures', async (context) => {
    const originalVideoDecoder = globalThis.VideoDecoder;
    const originalEncodedVideoChunk = globalThis.EncodedVideoChunk;
    context.after(() => {
        globalThis.VideoDecoder = originalVideoDecoder;
        globalThis.EncodedVideoChunk = originalEncodedVideoChunk;
    });

    class FakeEncodedVideoChunk {
        constructor(init) {
            Object.assign(this, init);
        }
    }
    globalThis.EncodedVideoChunk = FakeEncodedVideoChunk;
    const encoded = new Uint8Array([
        ...buildSps(),
        ...annexBNal(19, [0x80, 0x11])
    ]);

    for (const format of ['RGBA', null]) {
        let frameClosed = false;
        class FakeVideoDecoder {
            static async isConfigSupported(config) {
                return { supported: true, config };
            }

            constructor(init) {
                this.init = init;
                this.state = 'unconfigured';
            }

            configure() {
                this.state = 'configured';
            }

            decode() {}

            async flush() {
                this.init.output({
                    format,
                    codedWidth: 4,
                    codedHeight: 2,
                    displayWidth: 4,
                    displayHeight: 2,
                    visibleRect: { x: 0, y: 0, width: 4, height: 2 },
                    close() {
                        frameClosed = true;
                    }
                });
            }

            close() {
                this.state = 'closed';
            }
        }
        globalThis.VideoDecoder = FakeVideoDecoder;

        await assert.rejects(
            decodeVideoStreamWithWebCodecs({
                codecId: 2,
                frameWidth: 4,
                frameHeight: 2,
                frameCount: 1
            }, encoded),
            (error) => isWebCodecsNegativeCapabilityError(error) &&
                /unsupported VideoFrame format|null pixel format/.test(error.message)
        );
        assert.equal(frameClosed, true);
    }
});

test('builds a stable negative-capability key from codec configuration and dimensions', () => {
    const stream = new Uint8Array([
        ...buildSps(),
        ...annexBNal(19, [0x80, 0x11])
    ]);
    const widerStream = new Uint8Array([
        ...buildSps({ width: 6 }),
        ...annexBNal(19, [0x80, 0x11])
    ]);
    const descriptor = { codecId: 2, frameWidth: 4, frameHeight: 2 };
    const key = createWebCodecsCapabilityKey(descriptor, stream);
    assert.match(key, /profile=1/);
    assert.match(key, /level=93/);
    assert.match(key, /bitDepth=8\/8/);
    assert.match(key, /chroma=1/);
    assert.match(key, /config=prefer-hardware,prefer-software,default/);
    assert.notEqual(key, createWebCodecsCapabilityKey(
        { ...descriptor, frameWidth: 6 }, widerStream
    ));
});
