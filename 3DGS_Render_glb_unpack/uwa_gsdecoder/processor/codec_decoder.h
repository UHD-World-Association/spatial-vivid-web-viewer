#ifndef CODEC_DECODER_H
#define CODEC_DECODER_H

#include <vector>
#include <cstdint>
#include <string>
#include <map>
#include <memory>
#include "platform_video_decoder.h"

/**
 * Base decoder interface.
 * All codec decoders implement this interface.
 */
class CodecDecoder {
public:
    virtual ~CodecDecoder() = default;

    /**
     * Decode encoded input.
     * @param encoded Encoded input data.
     * @param decoded Decoded output data.
     * @param shape Data shape [height, width, channels, ...].
     * @param bitDepth Bit depth.
     * @return Whether the operation succeeded.
     */
    virtual bool decode(const std::vector<uint8_t>& encoded,
                       std::vector<uint8_t>& decoded,
                       const std::vector<int>& shape,
                       int bitDepth) = 0;

    /**
     * Return the decoder type.
     */
    virtual std::string getType() const = 0;
};

/**
 * Entropy decoder.
 * Supports zlib and Zstd decoding.
 */
class EntropyDecoder : public CodecDecoder {
public:
    enum class EntropyType {
        NONE = 0,
        ZLIB = 1,
        ZSTD = 2
    };

    EntropyDecoder(EntropyType type = EntropyType::ZLIB);
    ~EntropyDecoder() override = default;

    bool decode(const std::vector<uint8_t>& encoded,
               std::vector<uint8_t>& decoded,
               const std::vector<int>& shape,
               int bitDepth) override;

    std::string getType() const override { return "EntropyDecoder"; }

private:
    EntropyType entropyType;

    bool decodeZlib(const std::vector<uint8_t>& encoded, std::vector<uint8_t>& decoded);
    bool decodeZstd(const std::vector<uint8_t>& encoded, std::vector<uint8_t>& decoded);
};

/**
 * Texture decoder.
 * Supports ASTC decoding.
 */
class TextureDecoder : public CodecDecoder {
public:
    TextureDecoder();
    ~TextureDecoder() override = default;

    bool decode(const std::vector<uint8_t>& encoded,
               std::vector<uint8_t>& decoded,
               const std::vector<int>& shape,
               int bitDepth) override;

    std::string getType() const override { return "TextureDecoder"; }

    // Entropy decoding type: 0=none, 1=Zstd.
    uint8_t entropyDecodeType;

private:
    // ASTC decoding parameters.
    int blockSize;
    bool astcCpuDecode;

    bool decodeAstc(const std::vector<uint8_t>& encoded,
                   std::vector<uint8_t>& decoded,
                   const std::vector<int>& shape);
};

/**
 * Video decoder.
 * Supports H.264/AVC and H.265/HEVC decoding.
 * Uses a platform decoder for cross-platform hardware acceleration.
 */
class VideoDecoder : public CodecDecoder {
public:
    VideoDecoder();
    ~VideoDecoder() override = default;

    bool decode(const std::vector<uint8_t>& encoded,
               std::vector<uint8_t>& decoded,
               const std::vector<int>& shape,
               int bitDepth) override;

    bool decodePlanar(const std::vector<uint8_t>& encoded,
                      std::vector<uint8_t>& decoded,
                      const std::vector<int>& shape,
                      int bitDepth,
                      VideoFrameLayout& layout);

    std::string getType() const override { return "VideoDecoder"; }

    /**
     * Set the codec type.
     * @param codecId Codec ID (1=H.264, 2=H.265).
     */
    void setCodecId(int codecId);

private:
    int codecId;  // 1: H.264, 2: H.265
    std::unique_ptr<IPlatformVideoDecoder> platformDecoder;  // Platform decoder.

    /**
     * In-place YUV format conversion.
     * Converts YUV400/YUV420 to YUV444.
     * @param data Decoded data, modified in place.
     * @param width Video width.
     * @param height Video height.
     */
    bool convertYUV(std::vector<uint8_t>& data, const VideoFrameLayout& layout);
};

/**
 * Decoder factory.
 * Creates the decoder corresponding to a decode type.
 */
class DecoderFactory {
public:
    static std::unique_ptr<CodecDecoder> createDecoder(int decodeType);
};

/**
 * Conditionally decompress Zstd input when needed.
 * @param input Input data, which may be Zstd-compressed or raw.
 * @param output Output data.
 * @return Whether the operation succeeded.
 */
bool decompressZstdIfNeeded(const std::vector<uint8_t>& input, std::vector<uint8_t>& output);

/**
 * Pointer-based Zstd decompression helper.
 * @param input Input data pointer.
 * @param inputSize Input size in bytes.
 * @param output Output data.
 * @return Whether the operation succeeded.
 */
bool decompressZstdIfNeeded(const uint8_t* input, size_t inputSize, std::vector<uint8_t>& output);

#endif // CODEC_DECODER_H
