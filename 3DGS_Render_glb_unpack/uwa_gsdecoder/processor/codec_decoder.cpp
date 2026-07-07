#include "codec_decoder.h"
#include "platform_video_decoder.h"
#include <iostream>
#include <memory>
#include <stdexcept>
#include <fstream>
#include <limits>
#include <cstdio>
#include <cstring>

// Include the Zstd headers when available.
#ifdef USE_ZSTD
#include <zstd.h>
#endif

// Include the ASTC headers when available.
#ifdef USE_ASTC
#include "astcenc.h"
#endif

// ==================== EntropyDecoder implementation ====================

EntropyDecoder::EntropyDecoder(EntropyType type)
    : entropyType(type)
{
}

bool EntropyDecoder::decode(const std::vector<uint8_t>& encoded,
                           std::vector<uint8_t>& decoded,
                           const std::vector<int>& shape,
                           int bitDepth) {
    switch (entropyType) {
        case EntropyType::ZLIB:
            return decodeZlib(encoded, decoded);
        case EntropyType::ZSTD:
            return decodeZstd(encoded, decoded);
        case EntropyType::NONE:
            decoded = encoded;  // Uncompressed input; copy it directly.
            return true;
        default:
            return false;
    }
}

bool EntropyDecoder::decodeZlib(const std::vector<uint8_t>& encoded,
                                std::vector<uint8_t>& decoded) {
    // TODO: Implement zlib decompression.
    // Requires linking against zlib.
    // Temporary fallback: copy the input directly.
    decoded = encoded;
    return true;
}

bool EntropyDecoder::decodeZstd(const std::vector<uint8_t>& encoded,
                                std::vector<uint8_t>& decoded) {
#ifdef USE_ZSTD
    // Read the decompressed size.
    unsigned long long const rSize = ZSTD_getFrameContentSize(encoded.data(), encoded.size());

    if (rSize == ZSTD_CONTENTSIZE_ERROR) {
        std::cerr << "Error: ZSTD_getFrameContentSize returned CONTENTSIZE_ERROR" << std::endl;
        return false;
    }

    if (rSize == ZSTD_CONTENTSIZE_UNKNOWN) {
        std::cerr << "Error: ZSTD_getFrameContentSize returned CONTENTSIZE_UNKNOWN" << std::endl;
        // Fall back to streaming decompression.
        // TODO: Implement streaming decompression.
        decoded = encoded;
        return false;
    }

    // Allocate the decompression buffer.
    decoded.resize(rSize);

    // Decompress the data.
    size_t const dSize = ZSTD_decompress(decoded.data(), decoded.size(),
                                         encoded.data(), encoded.size());

    if (ZSTD_isError(dSize)) {
        std::cerr << "Error: ZSTD_decompress failed: " << ZSTD_getErrorName(dSize) << std::endl;
        return false;
    }

    if (dSize != rSize) {
        std::cerr << "Error: Decompressed size mismatch: expected " << rSize
                  << ", got " << dSize << std::endl;
        return false;
    }

    return true;
#else
    // Without zstd support, copy the input directly.
    decoded = encoded;
    return true;
#endif
}

// ==================== TextureDecoder implementation ====================

TextureDecoder::TextureDecoder()
    : blockSize(4)
    , astcCpuDecode(true)
    , entropyDecodeType(0)
{
}

bool TextureDecoder::decode(const std::vector<uint8_t>& encoded,
                           std::vector<uint8_t>& decoded,
                           const std::vector<int>& shape,
                           int bitDepth) {
    // Check whether entropy decoding is required first.
    if (entropyDecodeType == 1) {
#ifdef USE_ZSTD
        // Read the decompressed size.
        unsigned long long const rSize = ZSTD_getFrameContentSize(encoded.data(), encoded.size());
        if (rSize == ZSTD_CONTENTSIZE_ERROR || rSize == ZSTD_CONTENTSIZE_UNKNOWN) {
            std::cerr << "      Error: Cannot determine decompressed size" << std::endl;
            return false;
        }

        // Decompress the input data.
        std::vector<uint8_t> decompressed(rSize);
        size_t const dSize = ZSTD_decompress(decompressed.data(), rSize,
                                            encoded.data(), encoded.size());

        if (ZSTD_isError(dSize)) {
            std::cerr << "      Error: ZSTD decompression failed: " << ZSTD_getErrorName(dSize) << std::endl;
            return false;
        }

        decompressed.resize(dSize);

        // Decode the decompressed ASTC data.
        return decodeAstc(decompressed, decoded, shape);
#else
        std::cerr << "Error: ZSTD not enabled but entropyDecodeType=1" << std::endl;
        return false;
#endif
    }
    else {
        return decodeAstc(encoded, decoded, shape);
    }
}

bool TextureDecoder::decodeAstc(const std::vector<uint8_t>& encoded,
                                std::vector<uint8_t>& decoded,
                                const std::vector<int>& shape) {
#ifdef USE_ASTC
    // Validate the encoded data size.
    if (encoded.size() < 17) {  // 1 byte header + 16 bytes ASTC header
        std::cerr << "Error: Data too small (" << encoded.size() << " < 17)" << std::endl;
        return false;
    }

    const uint8_t* data = encoded.data();
    size_t dataSize = encoded.size();
    // Validate the ASTC magic number.
    uint32_t magic = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
    if (magic != 0x5CA1AB13) {
        std::cerr << "        Error: Invalid ASTC magic number" << std::endl;
        return false;
    }

    // Parse the ASTC header.
    const uint8_t* astcHeader = data;
    uint32_t blockdimX = astcHeader[4];
    uint32_t blockdimY = astcHeader[5];
    uint32_t blockdimZ = astcHeader[6];

    // ASTC dimensions are stored as little-endian 24-bit values.
    uint32_t xsize = astcHeader[7] | (astcHeader[8] << 8) | (astcHeader[9] << 16);
    uint32_t ysize = astcHeader[10] | (astcHeader[11] << 8) | (astcHeader[12] << 16);
    uint32_t zsize = astcHeader[13] | (astcHeader[14] << 8) | (astcHeader[15] << 16);

    // Initialize the ASTC decoder.
    astcenc_profile profile = ASTCENC_PRF_LDR;
    astcenc_config config;
    astcenc_error status;
    astcenc_context* context;

    status = astcenc_config_init(profile, blockdimX, blockdimY, 1, ASTCENC_PRE_MEDIUM, 0, &config);
    if (status != ASTCENC_SUCCESS) {
        std::cerr << " Error: ASTC Decoder config error" << std::endl;
        return false;
    }

    status = astcenc_context_alloc(&config, 1, &context);
    if (status != ASTCENC_SUCCESS) {
        std::cerr << " Error: ASTC contex error" << std::endl;
        return false;
    }

    // Prepare the output image.
    astcenc_image image;
    image.data_type = ASTCENC_TYPE_U8;
    image.dim_x = xsize;
    image.dim_y = ysize;
    image.dim_z = 1;

    std::vector<uint8_t> colorBuffer(xsize * ysize * 4);
    std::vector<void*> imageData(1);
    imageData[0] = colorBuffer.data();
    image.data = imageData.data();

    // Decode the image.
    astcenc_swizzle swizzle = {ASTCENC_SWZ_R, ASTCENC_SWZ_G, ASTCENC_SWZ_B, ASTCENC_SWZ_A};
    status = astcenc_decompress_image(context, data + 16, dataSize - 16,
                                     &image, &swizzle, 0);

    astcenc_context_free(context);

    if (status != ASTCENC_SUCCESS) {
        std::cerr << " Error: ASTC decode error" << std::endl;
        return false;
    }

    // Convert the decoded pixels to RGB.
    // Use one loop to reduce per-pixel overhead.
    decoded.resize(xsize * ysize * 3);
    const uint8_t* src = colorBuffer.data();
    uint8_t* dst = decoded.data();
    size_t pixelCount = xsize * ysize;

    for (size_t i = 0; i < pixelCount; i++) {
        size_t srcIdx = i * 4;
        size_t dstIdx = i * 3;
        dst[dstIdx + 0] = src[srcIdx + 0];  // R
        dst[dstIdx + 1] = src[srcIdx + 1];  // G
        dst[dstIdx + 2] = src[srcIdx + 2];  // B
    }

    return true;
#else
    // Without ASTC support, copy the input directly.
    decoded = encoded;
    std::cout << " Warning: ASTC decoding skip since no dependency" << std::endl;
    return true;
#endif
}

// ==================== VideoDecoder implementation ====================

VideoDecoder::VideoDecoder()
    : codecId(CODEC_ID_H265)  // Default to H.265.
{
    // Create the platform video decoder.
    // The build target selects the hardware or software implementation.
    platformDecoder = createPlatformVideoDecoder();
}

void VideoDecoder::setCodecId(int codecId) {
    this->codecId = codecId;
    if (platformDecoder) {
        platformDecoder->setCodecId(codecId);
    }
}

bool VideoDecoder::decode(const std::vector<uint8_t>& encoded,
                         std::vector<uint8_t>& decoded,
                         const std::vector<int>& shape,
                         int bitDepth) {
    VideoFrameLayout layout;
    if (!decodePlanar(encoded, decoded, shape, bitDepth, layout)) return false;
    return convertYUV(decoded, layout);
}

bool VideoDecoder::decodePlanar(const std::vector<uint8_t>& encoded,
                                std::vector<uint8_t>& decoded,
                                const std::vector<int>& shape,
                                int bitDepth,
                                VideoFrameLayout& layout) {
    (void)bitDepth;
    const int width = shape.size() > 1 ? shape[1] : 0;
    const int height = shape.size() > 0 ? shape[0] : 0;
    const uint32_t expectedFrameCount = shape.size() > 2 && shape[2] > 0 ?
        static_cast<uint32_t>(shape[2]) : 0;

    if (!platformDecoder) {
        std::cerr << "Error: Platform decoder not available" << std::endl;
        decoded.clear();
        return false;
    }
    if (!platformDecoder->decodeToLayout(encoded, decoded, width, height, layout)) return false;

    size_t expectedBytes = 0;
    if (!videoFrameByteLength(layout, expectedBytes) || decoded.size() != expectedBytes ||
        (expectedFrameCount != 0 && (layout.frameCount != expectedFrameCount ||
            layout.width != static_cast<uint32_t>(width) ||
            layout.height != static_cast<uint32_t>(height)))) {
        std::cerr << "Error: Platform decoder returned an invalid explicit video layout" << std::endl;
        decoded.clear();
        return false;
    }
    return true;
}

bool VideoDecoder::convertYUV(std::vector<uint8_t>& data, const VideoFrameLayout& layout) {
    size_t sourceBytes = 0;
    if (!videoFrameByteLength(layout, sourceBytes) || data.size() != sourceBytes) return false;
    if (layout.pixelFormat == VideoPixelFormat::YUV444_INTERLEAVED) return true;

    const size_t width = layout.width;
    const size_t height = layout.height;
    const size_t lumaBytes = width * height;
    const size_t chromaBytes = lumaBytes / 4;
    const size_t sourceFrameBytes = sourceBytes / layout.frameCount;
    std::vector<uint8_t> interleaved(lumaBytes * 3 * layout.frameCount);

    for (uint32_t frame = 0; frame < layout.frameCount; ++frame) {
        const uint8_t* source = data.data() + sourceFrameBytes * frame;
        uint8_t* destination = interleaved.data() + lumaBytes * 3 * frame;
        for (size_t y = 0; y < height; ++y) {
            for (size_t x = 0; x < width; ++x) {
                const size_t pixel = y * width + x;
                const size_t destinationOffset = pixel * 3;
                destination[destinationOffset] = source[pixel];
                if (layout.pixelFormat == VideoPixelFormat::I400) {
                    destination[destinationOffset + 1] = 128;
                    destination[destinationOffset + 2] = 128;
                    continue;
                }
                const size_t chroma = (y / 2) * (width / 2) + x / 2;
                if (layout.pixelFormat == VideoPixelFormat::I420) {
                    destination[destinationOffset + 1] = source[lumaBytes + chroma];
                    destination[destinationOffset + 2] = source[lumaBytes + chromaBytes + chroma];
                } else {
                    destination[destinationOffset + 1] = source[lumaBytes + chroma * 2];
                    destination[destinationOffset + 2] = source[lumaBytes + chroma * 2 + 1];
                }
            }
        }
    }
    data = std::move(interleaved);
    return true;
}

// ==================== DecoderFactory implementation ====================

std::unique_ptr<CodecDecoder> DecoderFactory::createDecoder(int decodeType) {
    switch (decodeType) {
        case 0:  // EntropyCodec (ZSTD)
            return std::make_unique<EntropyDecoder>(EntropyDecoder::EntropyType::ZSTD);
        case 1:  // AstcCodec
            return std::make_unique<TextureDecoder>();
        case 2:  // VideoCodec
            return std::make_unique<VideoDecoder>();
        default:
            return nullptr;
    }
}

// ==================== ZSTD decompression helper ====================

bool decompressZstdIfNeeded(const std::vector<uint8_t>& input, std::vector<uint8_t>& output) {
    return decompressZstdIfNeeded(input.data(), input.size(), output);
}

bool decompressZstdIfNeeded(const uint8_t* input, size_t inputSize, std::vector<uint8_t>& output) {
    if (!input || inputSize == 0) {
        return false;
    }

    // Check for the ZSTD frame magic (0x28B52FFD; little-endian bytes form 0xFD2FB528).
    if (inputSize >= 4) {
        uint32_t magic;
        std::memcpy(&magic, input, 4);

        if (magic == 0xFD2FB528) {  // ZSTD magic number (little-endian)
#ifdef USE_ZSTD
            // Read the decompressed size.
            const unsigned long long frameContentSize = ZSTD_getFrameContentSize(input, inputSize);
            if (frameContentSize == ZSTD_CONTENTSIZE_ERROR || frameContentSize == ZSTD_CONTENTSIZE_UNKNOWN) {
                std::cerr << "Error: Cannot determine ZSTD decompressed size" << std::endl;
                return false;
            }
            if (frameContentSize > std::numeric_limits<size_t>::max()) {
                std::cerr << "Error: ZSTD decompressed size exceeds the platform limit" << std::endl;
                return false;
            }
            const size_t decompressedSize = static_cast<size_t>(frameContentSize);

            output.resize(decompressedSize);
            size_t result = ZSTD_decompress(output.data(), output.size(), input, inputSize);

            if (ZSTD_isError(result)) {
                std::cerr << "Error: ZSTD decompression failed: " << ZSTD_getErrorName(result) << std::endl;
                return false;
            }

            return true;
#else
            std::cerr << "Error: ZSTD compressed data but USE_ZSTD not defined" << std::endl;
            return false;
#endif
        }
    }

    // If the input is not ZSTD-compressed, copy it directly.
    output.assign(input, input + inputSize);
    return true;
}
