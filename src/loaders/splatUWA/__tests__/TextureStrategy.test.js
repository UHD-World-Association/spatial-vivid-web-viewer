import assert from 'node:assert/strict';
import test from 'node:test';

import {
    detectWebGL2TextureCapabilities,
    normalizeTextureStrategyChain,
    normalizeTextureStrategy,
    probeWebGL2TextureCapabilities,
    selectTextureStrategy,
    selectTextureStrategyChain,
    TextureBuildCapabilities,
    TextureStrategy,
    textureStrategyToNativeMode
} from '../TextureStrategy.js';

test('short-circuits the runtime probe after a successful ASTC upload canary', () => {
    const contextRequests = [];
    const extensionRequests = [];
    const uploads = [];
    const deletedTextures = [];
    let nextTextureId = 1;
    const canvas = {
        getContext(name) {
            contextRequests.push(name);
            return {
                TEXTURE_2D_ARRAY: 0x8c1a,
                NO_ERROR: 0,
                getExtension(extensionName) {
                    extensionRequests.push(extensionName);
                    return {};
                },
                createTexture() {
                    return { id: nextTextureId++ };
                },
                bindTexture() {},
                compressedTexImage3D(...args) {
                    uploads.push(args);
                },
                getError() {
                    return 0;
                },
                deleteTexture(texture) {
                    deletedTextures.push(texture);
                }
            };
        }
    };

    assert.deepEqual(probeWebGL2TextureCapabilities(canvas), {
        webgl2: true,
        astc: true,
        bc7: false,
        bc3: false
    });
    assert.deepEqual(contextRequests, ['webgl2']);
    assert.deepEqual(extensionRequests, ['WEBGL_compressed_texture_astc']);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0][0], 0x8c1a);
    assert.equal(uploads[0][2], 0x93b0);
    assert.deepEqual(uploads[0].slice(3, 8), [4, 4, 1, 0, uploads[0][7]]);
    assert.equal(uploads[0][7].byteLength, 16);
    assert.equal(deletedTextures.length, 1);
    assert.deepEqual(detectWebGL2TextureCapabilities(null), {
        webgl2: false,
        astc: false,
        bc7: false,
        bc3: false
    });
});

test('keeps the public extension-only detector compatible and independent from upload canaries', () => {
    const extensionRequests = [];
    const gl = {
        getExtension(extensionName) {
            extensionRequests.push(extensionName);
            return {};
        }
    };

    assert.deepEqual(detectWebGL2TextureCapabilities(gl), {
        webgl2: true,
        astc: true,
        bc7: true,
        bc3: true
    });
    assert.deepEqual(extensionRequests, [
        'WEBGL_compressed_texture_astc',
        'EXT_texture_compression_bptc',
        'WEBGL_compressed_texture_s3tc'
    ]);
});

test('builds runtime fallback chains from both GPU and encoder capabilities', () => {
    const allGpu = { webgl2: true, astc: true, bc7: true, bc3: true };
    const allBuilt = { bc7: true, bc3: true };
    assert.deepEqual(selectTextureStrategyChain(allGpu, allBuilt), ['astc', 'bc3', 'cpu']);
    assert.deepEqual(
        selectTextureStrategyChain({ ...allGpu, bc3: false }, allBuilt),
        ['astc', 'cpu']
    );
    assert.deepEqual(selectTextureStrategyChain({ ...allGpu, astc: false }, allBuilt), ['bc3', 'cpu']);
    assert.deepEqual(
        selectTextureStrategyChain({ ...allGpu, astc: false, bc3: false }, allBuilt),
        ['cpu']
    );
    assert.deepEqual(
        selectTextureStrategyChain({ ...allGpu, astc: false, bc7: false }, allBuilt),
        ['bc3', 'cpu']
    );
    assert.deepEqual(selectTextureStrategyChain(allGpu, { bc7: false, bc3: false }), ['astc', 'cpu']);
    assert.deepEqual(selectTextureStrategyChain({ webgl2: false }, allBuilt), ['cpu']);
});

test('downgrades only the compressed format whose upload canary fails and cleans up both textures', () => {
    const deletedTextures = [];
    const uploadedFormats = [];
    let nextTextureId = 1;
    const gl = {
        TEXTURE_2D_ARRAY: 0x8c1a,
        NO_ERROR: 0,
        getExtension(extensionName) {
            return extensionName !== 'EXT_texture_compression_bptc' ? {} : null;
        },
        createTexture() {
            return { id: nextTextureId++ };
        },
        bindTexture() {},
        compressedTexImage3D(target, level, internalFormat) {
            uploadedFormats.push(internalFormat);
            if (internalFormat === 0x93b0) throw new Error('ASTC upload rejected');
        },
        getError() {
            return 0;
        },
        deleteTexture(texture) {
            deletedTextures.push(texture);
        }
    };

    assert.deepEqual(probeWebGL2TextureCapabilities({ getContext: () => gl }), {
        webgl2: true,
        astc: false,
        bc7: false,
        bc3: true
    });
    assert.deepEqual(uploadedFormats, [0x93b0, 0x83f3]);
    assert.deepEqual(deletedTextures.map((texture) => texture.id), [1, 2]);
});

test('queries BC3 only after the ASTC extension is unavailable', () => {
    const extensionRequests = [];
    const uploadedFormats = [];
    const gl = {
        getExtension(extensionName) {
            extensionRequests.push(extensionName);
            return extensionName === 'WEBGL_compressed_texture_s3tc' ? {} : null;
        },
        createTexture() {
            return {};
        },
        bindTexture() {},
        compressedTexImage3D(target, level, internalFormat) {
            uploadedFormats.push(internalFormat);
        },
        getError() {
            return 0;
        },
        deleteTexture() {}
    };

    assert.deepEqual(probeWebGL2TextureCapabilities({ getContext: () => gl }), {
        webgl2: true,
        astc: false,
        bc7: false,
        bc3: true
    });
    assert.deepEqual(extensionRequests, [
        'WEBGL_compressed_texture_astc',
        'WEBGL_compressed_texture_s3tc'
    ]);
    assert.deepEqual(uploadedFormats, [0x83f3]);
});

test('treats canary API and cleanup failures as unsupported without throwing', () => {
    let deleteCalls = 0;
    const gl = {
        getExtension(extensionName) {
            return extensionName === 'WEBGL_compressed_texture_astc' ? {} : null;
        },
        createTexture() {
            return {};
        },
        bindTexture() {},
        compressedTexImage3D() {},
        getError() {
            return 0;
        },
        deleteTexture() {
            deleteCalls++;
            throw new Error('context lost during cleanup');
        }
    };

    assert.deepEqual(probeWebGL2TextureCapabilities({ getContext: () => gl }), {
        webgl2: true,
        astc: false,
        bc7: false,
        bc3: false
    });
    assert.equal(deleteCalls, 1);
    assert.deepEqual(probeWebGL2TextureCapabilities({
        getContext() {
            throw new Error('WebGL2 unavailable');
        }
    }), {
        webgl2: false,
        astc: false,
        bc7: false,
        bc3: false
    });
});

test('drains stale and cleanup GL errors so one format cannot poison the next canary', () => {
    const glErrors = [
        0x0500, 0,
        0,
        0x0502, 0,
        0,
        0,
        0
    ];
    const gl = {
        TEXTURE_2D_ARRAY: 0x8c1a,
        NO_ERROR: 0,
        getExtension(extensionName) {
            return extensionName === 'EXT_texture_compression_bptc' ? null : {};
        },
        createTexture() {
            return {};
        },
        bindTexture() {},
        compressedTexImage3D() {},
        getError() {
            return glErrors.shift() ?? 0;
        },
        deleteTexture() {}
    };

    assert.deepEqual(probeWebGL2TextureCapabilities({ getContext: () => gl }), {
        webgl2: true,
        astc: false,
        bc7: false,
        bc3: true
    });
    assert.equal(glErrors.length, 0);
});

test('selects ASTC, BC3, and CPU while the BC7 runtime path is disabled', () => {
    const allGpu = { webgl2: true, astc: true, bc7: true, bc3: true };
    const allBuilt = { bc7: true, bc3: true };
    assert.equal(selectTextureStrategy(allGpu, allBuilt), TextureStrategy.ASTC);
    assert.equal(selectTextureStrategy({ ...allGpu, astc: false }, allBuilt), TextureStrategy.BC3);
    assert.equal(
        selectTextureStrategy({ ...allGpu, astc: false, bc3: false }, allBuilt),
        TextureStrategy.CPU
    );
    assert.equal(selectTextureStrategy({ ...allGpu, astc: false, bc7: false }, allBuilt), TextureStrategy.BC3);
    assert.equal(selectTextureStrategy({ ...allGpu, webgl2: false }, allBuilt), TextureStrategy.CPU);
});

test('does not select BC formats when their encoders are absent from the build', () => {
    const desktopGpu = { webgl2: true, astc: false, bc7: true, bc3: true };
    assert.deepEqual(TextureBuildCapabilities, { bc7: false, bc3: false });
    assert.equal(selectTextureStrategy(desktopGpu, TextureBuildCapabilities), TextureStrategy.CPU);
    assert.equal(selectTextureStrategy(desktopGpu, { bc7: false, bc3: true }), TextureStrategy.BC3);
});

test('normalizes legacy booleans only at the public boundary', () => {
    assert.deepEqual(Object.values(TextureStrategy), ['astc', 'bc7', 'bc3', 'cpu']);
    assert.equal(normalizeTextureStrategy(true), TextureStrategy.CPU);
    assert.equal(normalizeTextureStrategy(false), TextureStrategy.ASTC);
    assert.equal(normalizeTextureStrategy({ useCpuDecode: true }), TextureStrategy.CPU);
    assert.equal(normalizeTextureStrategy({ textureStrategy: TextureStrategy.BC7 }), TextureStrategy.BC7);
    assert.equal(normalizeTextureStrategy(undefined, TextureStrategy.CPU), TextureStrategy.CPU);
    assert.equal(textureStrategyToNativeMode(TextureStrategy.ASTC), 0);
    assert.equal(textureStrategyToNativeMode(TextureStrategy.CPU), 1);
    assert.throws(() => normalizeTextureStrategy('dxt'), /Unsupported texture strategy/);
    assert.deepEqual(normalizeTextureStrategyChain({ textureStrategies: ['bc7', 'bc3'] }), ['bc7', 'bc3', 'cpu']);
    assert.deepEqual(normalizeTextureStrategyChain(false), ['astc', 'cpu']);
    assert.deepEqual(normalizeTextureStrategyChain(true), ['cpu']);
});
