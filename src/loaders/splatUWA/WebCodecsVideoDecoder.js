const H264_CODEC_ID = 1;
const HEVC_CODEC_ID = 2;
const DEFAULT_DECODE_TIMEOUT_MS = 20000;

export const VIDEO_PIXEL_FORMAT = Object.freeze({
    YUV444_INTERLEAVED: 0,
    I420: 1,
    NV12: 2,
    I400: 3
});

const OUTPUT_FORMAT_TO_ABI = Object.freeze({
    I420: VIDEO_PIXEL_FORMAT.I420,
    NV12: VIDEO_PIXEL_FORMAT.NV12
});

export class WebCodecsVideoDecodeError extends Error {
    constructor(message, cause = undefined, code = 'DECODE_FAILED') {
        super(message);
        this.name = 'WebCodecsVideoDecodeError';
        if (cause !== undefined) this.cause = cause;
        this.code = code;
    }
}

function fail(message, cause = undefined, code = 'DECODE_FAILED') {
    throw new WebCodecsVideoDecodeError(message, cause, code);
}

function asUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    fail('The encoded video stream is not a byte buffer.');
}

function findStartCode(bytes, fromOffset) {
    for (let offset = fromOffset; offset + 3 <= bytes.length; offset++) {
        if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) continue;
        if (bytes[offset + 2] === 1) return { offset, length: 3 };
        if (offset + 4 <= bytes.length && bytes[offset + 2] === 0 && bytes[offset + 3] === 1) {
            return { offset, length: 4 };
        }
    }
    return null;
}

export function parseHevcAnnexBNalUnits(encoded) {
    const bytes = asUint8Array(encoded);
    const nalUnits = [];
    let startCode = findStartCode(bytes, 0);
    if (!startCode) fail('The HEVC stream is not Annex-B encoded.');

    while (startCode) {
        const nextStartCode = findStartCode(bytes, startCode.offset + startCode.length);
        const dataOffset = startCode.offset + startCode.length;
        const endOffset = nextStartCode ? nextStartCode.offset : bytes.length;
        if (endOffset - dataOffset >= 2) {
            const nalType = (bytes[dataOffset] >> 1) & 0x3f;
            const layerId = ((bytes[dataOffset] & 1) << 5) | (bytes[dataOffset + 1] >> 3);
            const temporalIdPlus1 = bytes[dataOffset + 1] & 0x07;
            if (temporalIdPlus1 === 0) fail('The HEVC stream contains an invalid NAL header.');
            if (layerId !== 0) fail('Multi-layer HEVC is not supported by the WebCodecs path.');
            nalUnits.push({
                type: nalType,
                startOffset: startCode.offset,
                dataOffset,
                endOffset
            });
        }
        startCode = nextStartCode;
    }

    if (nalUnits.length === 0) fail('The HEVC Annex-B stream does not contain any NAL units.');
    return nalUnits;
}

function concatenateNalUnits(bytes, nalUnits) {
    let contiguous = true;
    for (let index = 1; index < nalUnits.length; index++) {
        if (nalUnits[index - 1].endOffset !== nalUnits[index].startOffset) {
            contiguous = false;
            break;
        }
    }
    if (contiguous) {
        return bytes.subarray(nalUnits[0].startOffset, nalUnits[nalUnits.length - 1].endOffset);
    }
    let byteLength = 0;
    for (const nal of nalUnits) byteLength += nal.endOffset - nal.startOffset;
    const output = new Uint8Array(byteLength);
    let outputOffset = 0;
    for (const nal of nalUnits) {
        const source = bytes.subarray(nal.startOffset, nal.endOffset);
        output.set(source, outputOffset);
        outputOffset += source.byteLength;
    }
    return output;
}

function isVclNal(nalType) {
    return nalType >= 0 && nalType <= 31;
}

function isIrapNal(nalType) {
    return nalType >= 16 && nalType <= 23;
}

function isParameterSetNal(nalType) {
    return nalType === 32 || nalType === 33 || nalType === 34;
}

function startsFollowingAccessUnit(nalType) {
    return nalType === 32 || nalType === 33 || nalType === 34 || nalType === 35 || nalType === 39;
}

export function splitHevcAccessUnits(encoded) {
    const bytes = asUint8Array(encoded);
    const nalUnits = parseHevcAnnexBNalUnits(bytes);
    const accessUnits = [];
    const parameterSets = new Map();
    let current = [];
    let hasVcl = false;

    const flush = () => {
        if (!hasVcl) return;
        const type = current.some((nal) => isIrapNal(nal.type)) ? 'key' : 'delta';
        let outputNalUnits = current;
        if (type === 'key') {
            const presentTypes = new Set(current.map((nal) => nal.type));
            const prefix = [32, 33, 34]
                .map((nalType) => parameterSets.get(nalType))
                .filter((nal) => nal && !presentTypes.has(nal.type));
            if (prefix.length > 0) outputNalUnits = [...prefix, ...current];
        }
        accessUnits.push({
            data: concatenateNalUnits(bytes, outputNalUnits),
            type
        });
        current = [];
        hasVcl = false;
    };

    for (const nal of nalUnits) {
        if (hasVcl && startsFollowingAccessUnit(nal.type)) flush();
        if (isParameterSetNal(nal.type)) parameterSets.set(nal.type, nal);
        if (isVclNal(nal.type)) {
            if (nal.dataOffset + 2 >= nal.endOffset) fail('The HEVC stream contains a truncated slice NAL.');
            const firstSliceSegmentInPicture = (bytes[nal.dataOffset + 2] & 0x80) !== 0;
            if (hasVcl && firstSliceSegmentInPicture) flush();
            hasVcl = true;
        }
        current.push(nal);
    }
    flush();

    if (accessUnits.length === 0) fail('The HEVC stream does not contain a decodable access unit.');
    return accessUnits;
}

function unescapeRbsp(bytes) {
    const output = [];
    let zeroCount = 0;
    for (const byte of bytes) {
        if (zeroCount === 2 && byte === 0x03) {
            zeroCount = 0;
            continue;
        }
        output.push(byte);
        zeroCount = byte === 0 ? zeroCount + 1 : 0;
    }
    return new Uint8Array(output);
}

class BitReader {
    constructor(bytes) {
        this.bytes = bytes;
        this.bitOffset = 0;
    }

    readBits(bitCount) {
        if (bitCount < 0 || bitCount > 32 || this.bitOffset + bitCount > this.bytes.length * 8) {
            fail('The HEVC SPS is truncated.');
        }
        let value = 0;
        for (let bit = 0; bit < bitCount; bit++) {
            const byteOffset = this.bitOffset >> 3;
            const bitInByte = 7 - (this.bitOffset & 7);
            value = value * 2 + ((this.bytes[byteOffset] >> bitInByte) & 1);
            this.bitOffset++;
        }
        return value;
    }

    skipBits(bitCount) {
        this.readBits(bitCount);
    }

    readUnsignedExpGolomb() {
        let leadingZeroBits = 0;
        while (this.readBits(1) === 0) {
            leadingZeroBits++;
            if (leadingZeroBits > 31) fail('The HEVC SPS contains an oversized Exp-Golomb value.');
        }
        if (leadingZeroBits === 0) return 0;
        return Math.pow(2, leadingZeroBits) - 1 + this.readBits(leadingZeroBits);
    }
}

function reverseBits32(value) {
    let result = 0;
    let remaining = value >>> 0;
    for (let bit = 0; bit < 32; bit++) {
        result = (result * 2) + (remaining & 1);
        remaining >>>= 1;
    }
    return result >>> 0;
}

function parseProfileTierLevel(reader, maxSubLayersMinus1) {
    const profileSpace = reader.readBits(2);
    const tierFlag = reader.readBits(1);
    const profileIdc = reader.readBits(5);
    const compatibilityFlags = reader.readBits(32) >>> 0;
    const constraintBytes = [];
    for (let byte = 0; byte < 6; byte++) constraintBytes.push(reader.readBits(8));
    const levelIdc = reader.readBits(8);

    const subLayerProfilePresent = [];
    const subLayerLevelPresent = [];
    for (let layer = 0; layer < maxSubLayersMinus1; layer++) {
        subLayerProfilePresent.push(reader.readBits(1) !== 0);
        subLayerLevelPresent.push(reader.readBits(1) !== 0);
    }
    if (maxSubLayersMinus1 > 0) reader.skipBits((8 - maxSubLayersMinus1) * 2);
    for (let layer = 0; layer < maxSubLayersMinus1; layer++) {
        if (subLayerProfilePresent[layer]) reader.skipBits(88);
        if (subLayerLevelPresent[layer]) reader.skipBits(8);
    }

    while (constraintBytes.length > 0 && constraintBytes[constraintBytes.length - 1] === 0) {
        constraintBytes.pop();
    }
    const profileSpacePrefix = ['', 'A', 'B', 'C'][profileSpace];
    const compatibility = reverseBits32(compatibilityFlags).toString(16).toUpperCase();
    const codecParts = [
        'hev1',
        `${profileSpacePrefix}${profileIdc}`,
        compatibility,
        `${tierFlag ? 'H' : 'L'}${levelIdc}`
    ];
    for (const byte of constraintBytes) codecParts.push(byte.toString(16).padStart(2, '0').toUpperCase());
    return {
        codec: codecParts.join('.'),
        profileIdc,
        levelIdc,
        tier: tierFlag ? 'high' : 'main'
    };
}

export function parseHevcSps(encoded) {
    const bytes = asUint8Array(encoded);
    const nalUnits = parseHevcAnnexBNalUnits(bytes);
    const spsNal = nalUnits.find((nal) => nal.type === 33);
    if (!spsNal || spsNal.dataOffset + 2 >= spsNal.endOffset) fail('The HEVC stream is missing a valid SPS.');

    const rbsp = unescapeRbsp(bytes.subarray(spsNal.dataOffset + 2, spsNal.endOffset));
    const reader = new BitReader(rbsp);
    reader.skipBits(4);
    const maxSubLayersMinus1 = reader.readBits(3);
    reader.skipBits(1);
    const profileTierLevel = parseProfileTierLevel(reader, maxSubLayersMinus1);

    reader.readUnsignedExpGolomb();
    const chromaFormatIdc = reader.readUnsignedExpGolomb();
    if (chromaFormatIdc > 3) fail(`The HEVC SPS uses unsupported chroma_format_idc ${chromaFormatIdc}.`);
    let separateColourPlaneFlag = false;
    if (chromaFormatIdc === 3) separateColourPlaneFlag = reader.readBits(1) !== 0;
    if (separateColourPlaneFlag) fail('Separate-colour-plane HEVC is not supported by the WebCodecs path.');

    const codedWidth = reader.readUnsignedExpGolomb();
    const codedHeight = reader.readUnsignedExpGolomb();
    const conformanceWindowFlag = reader.readBits(1) !== 0;
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (conformanceWindowFlag) {
        cropLeft = reader.readUnsignedExpGolomb();
        cropRight = reader.readUnsignedExpGolomb();
        cropTop = reader.readUnsignedExpGolomb();
        cropBottom = reader.readUnsignedExpGolomb();
    }
    const bitDepthLuma = reader.readUnsignedExpGolomb() + 8;
    const bitDepthChroma = reader.readUnsignedExpGolomb() + 8;
    if (bitDepthLuma !== 8 || bitDepthChroma !== 8) {
        fail(`The WebCodecs path only supports 8-bit HEVC (stream is ${bitDepthLuma}/${bitDepthChroma}-bit).`);
    }

    const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    const displayWidth = codedWidth - subWidthC * (cropLeft + cropRight);
    const displayHeight = codedHeight - subHeightC * (cropTop + cropBottom);
    if (codedWidth <= 0 || codedHeight <= 0 || displayWidth <= 0 || displayHeight <= 0) {
        fail('The HEVC SPS declares invalid coded or display dimensions.');
    }

    return {
        ...profileTierLevel,
        codedWidth,
        codedHeight,
        displayWidth,
        displayHeight,
        visibleX: subWidthC * cropLeft,
        visibleY: subHeightC * cropTop,
        chromaFormatIdc,
        chroma: ['monochrome', '420', '422', '444'][chromaFormatIdc],
        bitDepthLuma,
        bitDepthChroma
    };
}

export function classifyWebCodecsFastPath(streamInfo, encoded) {
    if (!streamInfo || !Number.isInteger(streamInfo.codecId)) {
        return { eligible: false, reason: 'The pending video descriptor is invalid.' };
    }
    if (streamInfo.codecId === H264_CODEC_ID) {
        return { eligible: false, reason: 'H.264 is outside the WebCodecs fast-path class.' };
    }
    if (streamInfo.codecId !== HEVC_CODEC_ID) {
        return { eligible: false, reason: `Video codec id ${streamInfo.codecId} is outside the WebCodecs fast-path class.` };
    }
    if (!Number.isInteger(streamInfo.frameWidth) || streamInfo.frameWidth <= 0 ||
        !Number.isInteger(streamInfo.frameHeight) || streamInfo.frameHeight <= 0 ||
        !Number.isInteger(streamInfo.frameCount) || streamInfo.frameCount <= 0) {
        return { eligible: false, reason: 'The pending video descriptor has invalid dimensions or frame count.' };
    }

    let sps;
    try {
        sps = parseHevcSps(encoded);
    } catch (error) {
        return {
            eligible: false,
            reason: error?.message || 'The HEVC stream could not be classified.',
            error
        };
    }
    if (sps.profileIdc !== 1) {
        return {
            eligible: false,
            reason: `HEVC profile_idc ${sps.profileIdc} is outside the Main-profile WebCodecs fast path.`,
            sps
        };
    }
    if (sps.bitDepthLuma !== 8 || sps.bitDepthChroma !== 8) {
        return {
            eligible: false,
            reason: `HEVC ${sps.bitDepthLuma}/${sps.bitDepthChroma}-bit is outside the 8-bit WebCodecs fast path.`,
            sps
        };
    }
    if (sps.chromaFormatIdc !== 1) {
        return {
            eligible: false,
            reason: `HEVC ${sps.chroma} chroma is outside the 4:2:0 WebCodecs fast path.`,
            sps
        };
    }
    if (streamInfo.frameWidth % 2 !== 0 || streamInfo.frameHeight % 2 !== 0) {
        return { eligible: false, reason: 'Compact 4:2:0 video requires even frame dimensions.', sps };
    }
    if (sps.displayWidth !== streamInfo.frameWidth || sps.displayHeight !== streamInfo.frameHeight) {
        return {
            eligible: false,
            reason: `HEVC SPS dimensions ${sps.displayWidth}x${sps.displayHeight} do not match ` +
                `${streamInfo.frameWidth}x${streamInfo.frameHeight}.`,
            sps
        };
    }
    return { eligible: true, reason: '', sps };
}

export function videoBufferByteLength(pixelFormat, width, height, frameCount = 1) {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0 ||
        !Number.isInteger(frameCount) || frameCount <= 0) {
        fail('The decoded video layout has invalid dimensions or frame count.');
    }
    const lumaBytes = width * height;
    if (!Number.isSafeInteger(lumaBytes) || lumaBytes <= 0) fail('The decoded video dimensions are too large.');

    let frameBytes;
    if (pixelFormat === VIDEO_PIXEL_FORMAT.YUV444_INTERLEAVED) {
        frameBytes = lumaBytes * 3;
    } else if (pixelFormat === VIDEO_PIXEL_FORMAT.I420 || pixelFormat === VIDEO_PIXEL_FORMAT.NV12) {
        if (width % 2 !== 0 || height % 2 !== 0) {
            fail('Compact 4:2:0 video requires even frame dimensions.');
        }
        frameBytes = lumaBytes + lumaBytes / 2;
    } else if (pixelFormat === VIDEO_PIXEL_FORMAT.I400) {
        frameBytes = lumaBytes;
    } else {
        fail(`Unsupported video pixel format ABI value ${pixelFormat}.`);
    }
    const byteLength = frameBytes * frameCount;
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) fail('The decoded video buffer is too large.');
    return byteLength;
}

function planeDefinitions(format, width, height) {
    if (format === 'I420') {
        return [
            { name: 'Y', rowBytes: width, rows: height },
            { name: 'U', rowBytes: width / 2, rows: height / 2 },
            { name: 'V', rowBytes: width / 2, rows: height / 2 }
        ];
    }
    if (format === 'NV12') {
        return [
            { name: 'Y', rowBytes: width, rows: height },
            { name: 'UV', rowBytes: width, rows: height / 2 }
        ];
    }
    fail(`Unsupported planar VideoFrame format ${format || 'unknown'}.`, undefined, 'UNSUPPORTED_OUTPUT_FORMAT');
}

function validatePlaneLayout(source, layout, plane) {
    if (!layout || !Number.isInteger(layout.offset) || !Number.isInteger(layout.stride)) {
        fail('VideoFrame.copyTo returned an invalid plane layout.', undefined, 'UNSUPPORTED_OUTPUT_LAYOUT');
    }
    const lastByte = layout.offset + (plane.rows - 1) * layout.stride + plane.rowBytes;
    if (layout.offset < 0 || layout.stride < plane.rowBytes || !Number.isSafeInteger(lastByte) ||
        lastByte > source.byteLength) {
        fail('A copied VideoFrame plane is shorter than its layout.', undefined, 'UNSUPPORTED_OUTPUT_LAYOUT');
    }
}

export function compactVideoFramePlanes(sourceData, layouts, format, width, height) {
    const source = asUint8Array(sourceData);
    const normalizedFormat = String(format || '').toUpperCase();
    const pixelFormat = OUTPUT_FORMAT_TO_ABI[normalizedFormat];
    if (pixelFormat === undefined) {
        fail(`Unsupported planar VideoFrame format ${format || 'unknown'}.`, undefined, 'UNSUPPORTED_OUTPUT_FORMAT');
    }
    const frameByteLength = videoBufferByteLength(pixelFormat, width, height);
    const planes = planeDefinitions(normalizedFormat, width, height);
    if (!Array.isArray(layouts) || layouts.length !== planes.length) {
        fail(`VideoFrame.copyTo returned ${layouts?.length ?? 0} planes for ${normalizedFormat}.`,
            undefined, 'UNSUPPORTED_OUTPUT_LAYOUT');
    }
    planes.forEach((plane, index) => validatePlaneLayout(source, layouts[index], plane));

    const compact = new Uint8Array(frameByteLength);
    let destinationOffset = 0;
    for (let planeIndex = 0; planeIndex < planes.length; planeIndex++) {
        const plane = planes[planeIndex];
        const layout = layouts[planeIndex];
        for (let row = 0; row < plane.rows; row++) {
            const sourceOffset = layout.offset + row * layout.stride;
            compact.set(source.subarray(sourceOffset, sourceOffset + plane.rowBytes), destinationOffset);
            destinationOffset += plane.rowBytes;
        }
    }
    return compact;
}

// UWA HEVC streams are encoded as limited-range YUV.  Some WebCodecs
// implementations expose the same samples expanded to full range; these
// bytes are Gaussian attributes rather than display pixels, so the conversion
// must be undone before they enter the reconstruction decoder.
export function normalizeVideoFrameRange(decoded, format, width, height, fullRange = undefined) {
    const normalizedFormat = String(format || '').toUpperCase();
    if (!(decoded instanceof Uint8Array) ||
        normalizedFormat !== 'I420' && normalizedFormat !== 'NV12') {
        return { normalized: false, detectedFullRange: false, minLuma: null, maxLuma: null, zeroLuma: null };
    }
    const lumaBytes = width * height;
    if (!Number.isInteger(lumaBytes) || lumaBytes <= 0 || decoded.byteLength < lumaBytes) {
        return { normalized: false, detectedFullRange: false, minLuma: null, maxLuma: null, zeroLuma: null };
    }
    let minLuma = 255;
    let maxLuma = 0;
    let zeroLuma = 0;
    for (let i = 0; i < lumaBytes; i++) {
        const value = decoded[i];
        if (value < minLuma) minLuma = value;
        if (value > maxLuma) maxLuma = value;
        if (value === 0) zeroLuma++;
    }
    // Limited-range 8-bit Y is nominally [16, 235], but UWA stores arbitrary
    // attribute bytes and valid source samples can be 0/255. Only use the
    // sample heuristic when the endpoint spike is large enough to identify
    // Safari's expansion; an explicit VideoColorSpace flag takes precedence.
    const likelyExpanded = fullRange == null && minLuma === 0 && maxLuma === 255 &&
        zeroLuma > lumaBytes / 100;
    const detectedFullRange = fullRange === true || likelyExpanded;
    if (!detectedFullRange) {
        return { normalized: false, detectedFullRange, minLuma, maxLuma, zeroLuma };
    }
    for (let i = 0; i < lumaBytes; i++) {
        // Apple VideoToolbox uses the inclusive 16..235 span (220 codes).
        // Preserve 0/255 sentinels because UWA attributes are not display
        // colors and those endpoint bytes can be intentional source values.
        if (decoded[i] !== 0 && decoded[i] !== 255) {
            decoded[i] = Math.max(16, Math.min(235, Math.round(decoded[i] * 220 / 255 + 16)));
        }
    }
    // Only normalize Y here. UWA video planes carry quantized attributes, not
    // display chroma; in particular, the current opacity stream intentionally
    // has zero-filled U/V planes. Rewriting those bytes as color chroma would
    // change otherwise valid attribute data.
    return { normalized: true, detectedFullRange, minLuma, maxLuma, zeroLuma };
}

function formatLayoutSummary(format, layouts, width, height) {
    const planes = planeDefinitions(format, width, height);
    return {
        format,
        planes: planes.map((plane, index) => ({
            name: plane.name,
            offset: layouts[index].offset,
            stride: layouts[index].stride,
            rowBytes: plane.rowBytes,
            rows: plane.rows
        }))
    };
}

async function copyVideoFrame(frame, streamInfo, sps) {
    const visibleRect = frame.visibleRect;
    const visibleWidth = visibleRect?.width ?? frame.displayWidth;
    const visibleHeight = visibleRect?.height ?? frame.displayHeight;
    if (frame.codedWidth !== sps.codedWidth || frame.codedHeight !== sps.codedHeight ||
        visibleWidth !== streamInfo.frameWidth || visibleHeight !== streamInfo.frameHeight ||
        frame.displayWidth !== streamInfo.frameWidth || frame.displayHeight !== streamInfo.frameHeight) {
        fail(`WebCodecs returned unexpected frame dimensions ${frame.codedWidth}x${frame.codedHeight} ` +
            `(visible ${visibleWidth}x${visibleHeight}).`, undefined, 'UNSUPPORTED_OUTPUT_LAYOUT');
    }

    if (frame.format == null) {
        fail('WebCodecs returned a VideoFrame with a null pixel format.', undefined, 'UNSUPPORTED_OUTPUT_FORMAT');
    }
    const copiedFormat = String(frame.format).toUpperCase();
    if (OUTPUT_FORMAT_TO_ABI[copiedFormat] === undefined) {
        fail(`WebCodecs returned unsupported VideoFrame format ${copiedFormat}.`,
            undefined, 'UNSUPPORTED_OUTPUT_FORMAT');
    }
    if (sps.chromaFormatIdc !== 1) {
        fail(`VideoFrame format ${copiedFormat} cannot exactly represent encoded ${sps.chroma} chroma.`,
            undefined, 'UNSUPPORTED_OUTPUT_FORMAT');
    }

    const rect = {
        x: visibleRect?.x ?? 0,
        y: visibleRect?.y ?? 0,
        width: visibleWidth,
        height: visibleHeight
    };
    if (rect.x !== sps.visibleX || rect.y !== sps.visibleY) {
        fail(`WebCodecs returned visible origin ${rect.x},${rect.y}; expected ` +
            `${sps.visibleX},${sps.visibleY}.`, undefined, 'UNSUPPORTED_OUTPUT_LAYOUT');
    }
    if (rect.x % 2 !== 0 || rect.y % 2 !== 0 || rect.width % 2 !== 0 || rect.height % 2 !== 0) {
        fail('WebCodecs returned a non-aligned 4:2:0 visible rectangle.',
            undefined, 'UNSUPPORTED_OUTPUT_LAYOUT');
    }
    const copyOptions = { rect };
    let allocationSize;
    try {
        allocationSize = frame.allocationSize(copyOptions);
    } catch (error) {
        fail(`VideoFrame format ${copiedFormat} cannot be copied without conversion.`, error);
    }
    if (!Number.isSafeInteger(allocationSize) || allocationSize <= 0) {
        fail('VideoFrame reported an invalid copy allocation size.', undefined, 'UNSUPPORTED_OUTPUT_LAYOUT');
    }
    const copied = new Uint8Array(allocationSize);
    let layouts;
    const copyStartedAt = performance.now();
    try {
        layouts = await frame.copyTo(copied, copyOptions);
    } catch (error) {
        fail(`VideoFrame.copyTo failed for ${copiedFormat}.`, error);
    }
    const decoded = compactVideoFramePlanes(
        copied, layouts, copiedFormat, streamInfo.frameWidth, streamInfo.frameHeight
    );
    const colorSpace = frame.colorSpace || null;
    const range = normalizeVideoFrameRange(
        decoded,
        copiedFormat,
        streamInfo.frameWidth,
        streamInfo.frameHeight,
        colorSpace && typeof colorSpace.fullRange === 'boolean' ? colorSpace.fullRange : undefined
    );
    return {
        decoded,
        format: copiedFormat,
        pixelFormat: OUTPUT_FORMAT_TO_ABI[copiedFormat],
        layout: formatLayoutSummary(copiedFormat, layouts, streamInfo.frameWidth, streamInfo.frameHeight),
        copyMs: performance.now() - copyStartedAt,
        rangeNormalized: range.normalized,
        detectedFullRange: range.detectedFullRange,
        minLuma: range.minLuma,
        maxLuma: range.maxLuma,
        zeroLuma: range.zeroLuma,
        colorSpace: colorSpace ? {
            primaries: colorSpace.primaries ?? null,
            transfer: colorSpace.transfer ?? null,
            matrix: colorSpace.matrix ?? null,
            fullRange: colorSpace.fullRange ?? null
        } : null
    };
}

export function isWebCodecsNegativeCapabilityError(error) {
    const visited = new Set();
    let current = error;
    while (current && !visited.has(current)) {
        visited.add(current);
        if (current.code === 'UNSUPPORTED_OUTPUT_FORMAT' || current.code === 'UNSUPPORTED_OUTPUT_LAYOUT') return true;
        current = current.cause;
    }
    return false;
}

export function createWebCodecsCapabilityKey(streamInfo, encoded, parsedSps = null) {
    const sps = parsedSps || parseHevcSps(encoded);
    return [
        `codecId=${streamInfo?.codecId}`,
        `codec=${sps.codec}`,
        `profile=${sps.profileIdc}`,
        `level=${sps.levelIdc}`,
        `bitDepth=${sps.bitDepthLuma}/${sps.bitDepthChroma}`,
        `chroma=${sps.chromaFormatIdc}`,
        `coded=${sps.codedWidth}x${sps.codedHeight}`,
        `display=${streamInfo?.frameWidth}x${streamInfo?.frameHeight}`,
        'config=prefer-hardware,prefer-software,default'
    ].join('|');
}

function abortReason(signal) {
    const reason = signal?.reason;
    if (reason instanceof Error) return reason;
    return new Error(reason ? String(reason) : 'WebCodecs video decoding was canceled.');
}

function awaitWithDeadline(promise, signal, deadline, timeoutMs) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
        return Promise.reject(new WebCodecsVideoDecodeError(
            `WebCodecs video decode timed out after ${Math.ceil(timeoutMs)} ms.`,
            undefined,
            'TIMEOUT'
        ));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            if (signal) signal.removeEventListener('abort', onAbort);
            callback(value);
        };
        const onAbort = () => finish(reject, abortReason(signal));
        const timeoutId = setTimeout(() => {
            finish(reject, new WebCodecsVideoDecodeError(
                `WebCodecs video decode timed out after ${Math.ceil(timeoutMs)} ms.`,
                undefined,
                'TIMEOUT'
            ));
        }, remainingMs);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error)
        );
        if (signal?.aborted) onAbort();
    });
}

function closeDecoder(decoder) {
    if (!decoder) return;
    try {
        if (decoder.state !== 'closed') decoder.close();
    } catch (_) {}
}

export async function decodeVideoStreamWithWebCodecs(streamInfo, encoded, options = {}) {
    const totalStartedAt = Number.isFinite(options._totalStartedAt) ?
        options._totalStartedAt : performance.now();
    const bytes = asUint8Array(encoded);
    const eligibility = classifyWebCodecsFastPath(streamInfo, bytes);
    if (!eligibility.eligible) fail(eligibility.reason, eligibility.error);
    const sps = eligibility.sps;
    videoBufferByteLength(VIDEO_PIXEL_FORMAT.I420,
        streamInfo.frameWidth, streamInfo.frameHeight, streamInfo.frameCount);
    const accessUnits = splitHevcAccessUnits(bytes);
    if (accessUnits.length !== streamInfo.frameCount) {
        fail(`HEVC access-unit count ${accessUnits.length} does not match expected frame count ${streamInfo.frameCount}.`);
    }

    const signal = options.signal;
    if (signal?.aborted) throw abortReason(signal);
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ?
        options.timeoutMs : DEFAULT_DECODE_TIMEOUT_MS;
    const timeoutDeadline = Number.isFinite(options._timeoutDeadline) ?
        options._timeoutDeadline : totalStartedAt + timeoutMs;
    const VideoDecoderClass = globalThis.VideoDecoder;
    const EncodedVideoChunkClass = globalThis.EncodedVideoChunk;
    if (typeof VideoDecoderClass !== 'function' || typeof EncodedVideoChunkClass !== 'function' ||
        typeof VideoDecoderClass.isConfigSupported !== 'function') {
        fail('WebCodecs VideoDecoder is unavailable.');
    }

    const baseConfig = {
        codec: sps.codec,
        codedWidth: sps.codedWidth,
        codedHeight: sps.codedHeight
    };
    const chromaLabel = {
        monochrome: 'monochrome',
        420: '4:2:0',
        422: '4:2:2',
        444: '4:4:4'
    }[sps.chroma];
    const configSummary = `${sps.codec} (profile_idc=${sps.profileIdc}, ${chromaLabel}, ` +
        `${sps.bitDepthLuma}-bit, ${sps.codedWidth}x${sps.codedHeight})`;
    let requestedConfigCandidates;
    if (options.accelerationPreference === 'prefer-hardware' ||
        options.accelerationPreference === 'prefer-software') {
        requestedConfigCandidates = [{
            ...baseConfig,
            hardwareAcceleration: options.accelerationPreference
        }];
    } else if (options.accelerationPreference === 'default') {
        requestedConfigCandidates = [baseConfig];
    }
    const configCandidates = options._configCandidates || requestedConfigCandidates || [
        { ...baseConfig, hardwareAcceleration: 'prefer-hardware' },
        { ...baseConfig, hardwareAcceleration: 'prefer-software' },
        baseConfig
    ];
    let config = null;
    let selectedConfigIndex = -1;
    let lastSupportError;
    const configProbeStartedAt = performance.now();
    for (let candidateIndex = 0; candidateIndex < configCandidates.length; candidateIndex++) {
        const candidate = configCandidates[candidateIndex];
        try {
            const support = await awaitWithDeadline(
                VideoDecoderClass.isConfigSupported(candidate), signal, timeoutDeadline, timeoutMs
            );
            if (support?.supported) {
                config = { ...candidate, ...(support.config || {}) };
                selectedConfigIndex = candidateIndex;
                break;
            }
        } catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            if (error?.code === 'TIMEOUT') throw error;
            lastSupportError = error;
        }
    }
    if (!config && lastSupportError) {
        fail(`WebCodecs rejected HEVC configuration ${configSummary}.`, lastSupportError);
    }
    if (!config && options._priorCapabilityError) throw options._priorCapabilityError;
    if (!config) {
        fail(`WebCodecs does not support HEVC configuration ${configSummary} ` +
            '(hardware-preferred, software-preferred, or default acceleration).');
    }
    const configProbeMs = (options._configProbeMs || 0) + performance.now() - configProbeStartedAt;
    const remainingConfigCandidates = configCandidates.slice(selectedConfigIndex + 1);

    const attemptTimeoutMs = Math.max(1, timeoutDeadline - performance.now());
    const frameCopies = [];
    let decoder = null;
    let rejectFatal;
    const fatalPromise = new Promise((resolve, reject) => {
        rejectFatal = reject;
    });
    fatalPromise.catch(() => {});

    const onAbort = () => {
        rejectFatal(abortReason(signal));
        closeDecoder(decoder);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timeoutId = setTimeout(() => {
        rejectFatal(new WebCodecsVideoDecodeError(
            `WebCodecs video decode timed out after ${Math.ceil(attemptTimeoutMs)} ms.`));
        closeDecoder(decoder);
    }, attemptTimeoutMs);

    try {
        const decodeStartedAt = performance.now();
        decoder = new VideoDecoderClass({
            output: (frame) => {
                if (signal?.aborted || frameCopies.length >= streamInfo.frameCount) {
                    frame.close();
                    if (!signal?.aborted) {
                        rejectFatal(new WebCodecsVideoDecodeError('WebCodecs returned too many video frames.'));
                    }
                    return;
                }
                const copy = copyVideoFrame(frame, streamInfo, sps)
                    .catch((error) => {
                        rejectFatal(error);
                        throw error;
                    })
                    .finally(() => frame.close());
                copy.catch(() => {});
                frameCopies.push(copy);
            },
            error: (error) => rejectFatal(new WebCodecsVideoDecodeError('WebCodecs decoder error.', error))
        });
        decoder.configure(config);
        for (let accessUnitIndex = 0; accessUnitIndex < accessUnits.length; accessUnitIndex++) {
            if (signal?.aborted) throw abortReason(signal);
            const accessUnit = accessUnits[accessUnitIndex];
            decoder.decode(new EncodedVideoChunkClass({
                type: accessUnit.type,
                timestamp: accessUnitIndex,
                duration: 1,
                data: accessUnit.data
            }));
        }

        const flushPromise = decoder.flush();
        flushPromise.catch(() => {});
        await Promise.race([flushPromise, fatalPromise]);
        const copiedFrames = await Promise.race([Promise.all(frameCopies), fatalPromise]);
        if (copiedFrames.length !== streamInfo.frameCount) {
            fail(`WebCodecs returned ${copiedFrames.length} frames; expected ${streamInfo.frameCount}.`);
        }

        const firstFrame = copiedFrames[0];
        if (!firstFrame) fail('WebCodecs returned no decoded frames.');
        for (let frameIndex = 1; frameIndex < copiedFrames.length; frameIndex++) {
            if (copiedFrames[frameIndex].format !== firstFrame.format) {
                fail(`WebCodecs changed VideoFrame format from ${firstFrame.format} to ` +
                    `${copiedFrames[frameIndex].format}.`, undefined, 'UNSUPPORTED_OUTPUT_FORMAT');
            }
        }
        const frameByteLength = videoBufferByteLength(
            firstFrame.pixelFormat, streamInfo.frameWidth, streamInfo.frameHeight
        );
        const decoded = new Uint8Array(frameByteLength * streamInfo.frameCount);
        for (let frameIndex = 0; frameIndex < copiedFrames.length; frameIndex++) {
            if (copiedFrames[frameIndex].decoded.byteLength !== frameByteLength) {
                fail(`WebCodecs frame ${frameIndex} has an invalid byte layout.`);
            }
            decoded.set(copiedFrames[frameIndex].decoded, frameIndex * frameByteLength);
        }
        const copyMs = copiedFrames.reduce((sum, frame) => sum + frame.copyMs, 0);
        const rangeNormalized = copiedFrames.some((frame) => frame.rangeNormalized);
        const detectedFullRange = copiedFrames.some((frame) => frame.detectedFullRange);
        const uniqueLayouts = [];
        const seenLayouts = new Set();
        for (const frame of copiedFrames) {
            const key = JSON.stringify(frame.layout);
            if (!seenLayouts.has(key)) {
                seenLayouts.add(key);
                uniqueLayouts.push(frame.layout);
            }
        }
        return {
            decoded,
            pixelFormat: firstFrame.pixelFormat,
            codec: sps.codec,
            chroma: sps.chroma,
            frameCount: copiedFrames.length,
            config: {
                codec: config.codec,
                codedWidth: config.codedWidth,
                codedHeight: config.codedHeight,
                hardwareAcceleration: config.hardwareAcceleration || 'default'
            },
            layout: {
                format: firstFrame.format,
                width: streamInfo.frameWidth,
                height: streamInfo.frameHeight,
                frameCount: copiedFrames.length,
                frameByteLength,
                observedPlaneLayouts: uniqueLayouts
            },
            timing: {
                configProbeMs,
                decodeAndFlushMs: performance.now() - decodeStartedAt,
                copyMs,
                totalMs: performance.now() - totalStartedAt
            },
            rangeNormalized,
            detectedFullRange,
            colorSpace: copiedFrames[0].colorSpace,
            minLuma: copiedFrames[0].minLuma,
            maxLuma: copiedFrames[0].maxLuma,
            zeroLuma: copiedFrames[0].zeroLuma
        };
    } catch (error) {
        closeDecoder(decoder);
        await Promise.allSettled(frameCopies);
        if (signal?.aborted) throw abortReason(signal);
        if (isWebCodecsNegativeCapabilityError(error) && remainingConfigCandidates.length > 0) {
            const remainingTimeoutMs = timeoutDeadline - performance.now();
            if (remainingTimeoutMs > 0) {
                return decodeVideoStreamWithWebCodecs(streamInfo, bytes, {
                    ...options,
                    _totalStartedAt: totalStartedAt,
                    _timeoutDeadline: timeoutDeadline,
                    _configProbeMs: configProbeMs,
                    _configCandidates: remainingConfigCandidates,
                    _priorCapabilityError: error
                });
            }
            fail('WebCodecs timeout expired before all acceleration configurations could be tested.');
        }
        if (error instanceof WebCodecsVideoDecodeError || error instanceof Error && signal?.aborted) throw error;
        fail(error?.message || 'WebCodecs video decoding failed.', error);
    } finally {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        closeDecoder(decoder);
    }
}
