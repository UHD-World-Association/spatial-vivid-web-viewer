export const TextureStrategy = Object.freeze({
    ASTC: 'astc',
    BC7: 'bc7',
    BC3: 'bc3',
    CPU: 'cpu'
});

export const TextureBuildCapabilities = Object.freeze({
    bc7: false,
    bc3: false
});

const textureStrategies = new Set(Object.values(TextureStrategy));

export function normalizeTextureStrategy(value, defaultStrategy = TextureStrategy.ASTC) {
    if (!textureStrategies.has(defaultStrategy)) {
        throw new TypeError(`Invalid default texture strategy: ${String(defaultStrategy)}`);
    }
    if (value === undefined || value === null) return defaultStrategy;
    if (value === true) return TextureStrategy.CPU;
    if (value === false) return TextureStrategy.ASTC;
    if (typeof value === 'object') {
        if (value.textureStrategy !== undefined) {
            return normalizeTextureStrategy(value.textureStrategy, defaultStrategy);
        }
        if (value.useCpuDecode !== undefined) {
            return normalizeTextureStrategy(value.useCpuDecode, defaultStrategy);
        }
    }
    if (textureStrategies.has(value)) return value;
    throw new TypeError(`Unsupported texture strategy: ${String(value)}`);
}

export function textureStrategyToNativeMode(value) {
    const strategy = normalizeTextureStrategy(value);
    if (strategy === TextureStrategy.ASTC) return 0;
    if (strategy === TextureStrategy.CPU) return 1;
    if (strategy === TextureStrategy.BC7) return 2;
    return 3;
}

function hasExtension(gl, extensionName) {
    try {
        return !!gl.getExtension(extensionName);
    } catch (_) {
        return false;
    }
}

export function detectWebGL2TextureCapabilities(gl) {
    if (!gl || typeof gl.getExtension !== 'function') {
        return { webgl2: false, astc: false, bc7: false, bc3: false };
    }
    return {
        webgl2: true,
        astc: hasExtension(gl, 'WEBGL_compressed_texture_astc'),
        bc7: hasExtension(gl, 'EXT_texture_compression_bptc'),
        bc3: hasExtension(gl, 'WEBGL_compressed_texture_s3tc')
    };
}

function probeCompressedTexture2DArrayUpload(gl, internalFormat) {
    const texture2DArray = gl?.TEXTURE_2D_ARRAY ?? 0x8c1a;
    const noError = gl?.NO_ERROR ?? 0;
    const drainErrors = () => {
        let sawError = false;
        try {
            for (let index = 0; index < 8; index++) {
                const error = gl.getError();
                if (error === noError) return sawError;
                sawError = true;
            }
        } catch (_) {
            return true;
        }
        return true;
    };
    let texture = null;
    let supported = false;
    try {
        if (typeof gl?.createTexture !== 'function' ||
            typeof gl?.bindTexture !== 'function' ||
            typeof gl?.compressedTexImage3D !== 'function' ||
            typeof gl?.getError !== 'function' ||
            typeof gl?.deleteTexture !== 'function') {
            return false;
        }
        drainErrors();
        texture = gl.createTexture();
        if (!texture) return false;
        gl.bindTexture(texture2DArray, texture);
        gl.compressedTexImage3D(
            texture2DArray,
            0,
            internalFormat,
            4,
            4,
            1,
            0,
            new Uint8Array(16)
        );
        supported = !drainErrors();
    } catch (_) {
        supported = false;
    } finally {
        if (texture) {
            try {
                gl.bindTexture(texture2DArray, null);
            } catch (_) {
                supported = false;
            }
            try {
                gl.deleteTexture(texture);
            } catch (_) {
                supported = false;
            }
        }
        if (drainErrors()) supported = false;
    }
    return supported;
}

export function probeWebGL2TextureCapabilities(canvas) {
    const probeCanvas = canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : null);
    if (!probeCanvas || typeof probeCanvas.getContext !== 'function') {
        return detectWebGL2TextureCapabilities(null);
    }
    let gl = null;
    try {
        gl = probeCanvas.getContext('webgl2');
    } catch (_) {
        // A failed WebGL2 context probe is equivalent to no GPU compressed-texture path.
    }
    if (!gl || typeof gl.getExtension !== 'function') {
        return detectWebGL2TextureCapabilities(null);
    }

    const astc = hasExtension(gl, 'WEBGL_compressed_texture_astc') &&
        probeCompressedTexture2DArrayUpload(gl, 0x93b0);
    if (astc) return { webgl2: true, astc: true, bc7: false, bc3: false };

    const bc3 = hasExtension(gl, 'WEBGL_compressed_texture_s3tc') &&
        probeCompressedTexture2DArrayUpload(gl, 0x83f3);
    return { webgl2: true, astc: false, bc7: false, bc3 };
}

export function selectTextureStrategy(gpuCapabilities = {}, buildCapabilities = {}) {
    if (gpuCapabilities.webgl2 && gpuCapabilities.astc) return TextureStrategy.ASTC;
    if (gpuCapabilities.webgl2 && gpuCapabilities.bc3 && buildCapabilities.bc3) return TextureStrategy.BC3;
    return TextureStrategy.CPU;
}

export function selectTextureStrategyChain(gpuCapabilities = {}, buildCapabilities = {}) {
    const strategies = [];
    if (gpuCapabilities.webgl2 && gpuCapabilities.astc) strategies.push(TextureStrategy.ASTC);
    if (gpuCapabilities.webgl2 && gpuCapabilities.bc3 && buildCapabilities.bc3) {
        strategies.push(TextureStrategy.BC3);
    }
    strategies.push(TextureStrategy.CPU);
    return strategies;
}

export function normalizeTextureStrategyChain(value, defaultStrategy = TextureStrategy.ASTC) {
    let candidates;
    if (Array.isArray(value)) {
        candidates = value;
    } else if (value && typeof value === 'object' && Array.isArray(value.textureStrategies)) {
        candidates = value.textureStrategies;
    } else {
        const preferred = normalizeTextureStrategy(value, defaultStrategy);
        candidates = preferred === TextureStrategy.CPU ? [preferred] : [preferred, TextureStrategy.CPU];
    }

    const normalized = [];
    for (const candidate of candidates) {
        const strategy = normalizeTextureStrategy(candidate, defaultStrategy);
        if (!normalized.includes(strategy)) normalized.push(strategy);
    }
    if (normalized.length === 0) throw new TypeError('Texture strategy chain cannot be empty.');
    if (!normalized.includes(TextureStrategy.CPU)) normalized.push(TextureStrategy.CPU);
    return normalized;
}
