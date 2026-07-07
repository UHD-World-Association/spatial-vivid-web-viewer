#ifndef PLATFORM_VIDEO_DECODER_H
#define PLATFORM_VIDEO_DECODER_H

#include <vector>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>

// Codec IDs shared across platform decoder implementations.
constexpr int CODEC_ID_RAW = 0;   // Raw per-frame YUV444P
constexpr int CODEC_ID_H264 = 1;  // H.264/AVC
constexpr int CODEC_ID_H265 = 2;  // H.265/HEVC

// Stable ABI shared by native decoders, the WASM bridge, and JavaScript.
enum class VideoPixelFormat : uint32_t {
    YUV444_INTERLEAVED = 0,
    I420 = 1,
    NV12 = 2,
    I400 = 3,
    YUV444P = 4
};
static_assert(static_cast<uint32_t>(VideoPixelFormat::YUV444_INTERLEAVED) == 0 &&
              static_cast<uint32_t>(VideoPixelFormat::I420) == 1 &&
              static_cast<uint32_t>(VideoPixelFormat::NV12) == 2 &&
              static_cast<uint32_t>(VideoPixelFormat::I400) == 3 &&
              static_cast<uint32_t>(VideoPixelFormat::YUV444P) == 4,
              "Video pixel format ABI values must remain stable");

struct VideoFrameLayout {
    VideoPixelFormat pixelFormat = VideoPixelFormat::YUV444_INTERLEAVED;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t frameCount = 0;
};

inline bool videoPixelFormatFromAbi(uint32_t value, VideoPixelFormat& pixelFormat) {
    switch (value) {
        case 0: pixelFormat = VideoPixelFormat::YUV444_INTERLEAVED; return true;
        case 1: pixelFormat = VideoPixelFormat::I420; return true;
        case 2: pixelFormat = VideoPixelFormat::NV12; return true;
        case 3: pixelFormat = VideoPixelFormat::I400; return true;
        case 4: pixelFormat = VideoPixelFormat::YUV444P; return true;
        default: return false;
    }
}

inline const char* videoPixelFormatName(VideoPixelFormat pixelFormat) {
    switch (pixelFormat) {
        case VideoPixelFormat::YUV444_INTERLEAVED: return "YUV444_INTERLEAVED";
        case VideoPixelFormat::I420: return "I420";
        case VideoPixelFormat::NV12: return "NV12";
        case VideoPixelFormat::I400: return "I400";
        case VideoPixelFormat::YUV444P: return "YUV444P";
    }
    return "UNKNOWN";
}

inline bool videoPixelFormatMatchesCodec(uint32_t codecId, VideoPixelFormat pixelFormat) {
    return codecId != CODEC_ID_RAW || pixelFormat == VideoPixelFormat::YUV444P;
}

inline bool videoFrameByteLength(const VideoFrameLayout& layout, size_t& byteLength) {
    byteLength = 0;
    if (layout.width == 0 || layout.height == 0 || layout.frameCount == 0) return false;

    const size_t width = layout.width;
    const size_t height = layout.height;
    if (width > std::numeric_limits<size_t>::max() / height) return false;
    const size_t lumaBytes = width * height;
    size_t frameBytes = 0;
    switch (layout.pixelFormat) {
        case VideoPixelFormat::YUV444_INTERLEAVED:
        case VideoPixelFormat::YUV444P:
            if (lumaBytes > std::numeric_limits<size_t>::max() / 3) return false;
            frameBytes = lumaBytes * 3;
            break;
        case VideoPixelFormat::I420:
        case VideoPixelFormat::NV12:
            if ((layout.width & 1u) != 0 || (layout.height & 1u) != 0 ||
                lumaBytes > std::numeric_limits<size_t>::max() - lumaBytes / 2) {
                return false;
            }
            frameBytes = lumaBytes + lumaBytes / 2;
            break;
        case VideoPixelFormat::I400:
            frameBytes = lumaBytes;
            break;
        default:
            return false;
    }
    if (frameBytes > std::numeric_limits<size_t>::max() / layout.frameCount) return false;
    byteLength = frameBytes * layout.frameCount;
    return true;
}

/**
 * Platform video decoder interface.
 * Abstracts hardware-decoding capabilities on different platforms.
 */
class IPlatformVideoDecoder {
public:
    virtual ~IPlatformVideoDecoder() = default;

    /**
     * Set the codec type.
     * @param codecId Codec ID (CODEC_ID_H264=1, CODEC_ID_H265=2).
     */
    virtual void setCodecId(int codecId) {
        this->codecId = codecId;
    }

    /**
     * Return the codec type.
     */
    int getCodecId() const {
        return codecId;
    }

    /**
     * Decode the video stream.
     * @param encoded Encoded input data.
     * @param decoded Decoded output data in YUV or RGB format.
     * @param width Video width.
     * @param height Video height.
     * @return Whether the operation succeeded.
     */
    virtual bool decode(const std::vector<uint8_t>& encoded,
                       std::vector<uint8_t>& decoded,
                       int width, int height) = 0;

    /**
     * Decode into a compact buffer and describe its exact per-frame layout.
     * Implementations with a native planar output override this method.
     */
    virtual bool decodeToLayout(const std::vector<uint8_t>& encoded,
                                std::vector<uint8_t>& decoded,
                                int width, int height,
                                VideoFrameLayout& layout) {
        if (!decode(encoded, decoded, width, height)) return false;
        layout = {
            VideoPixelFormat::YUV444_INTERLEAVED,
            static_cast<uint32_t>(width),
            static_cast<uint32_t>(height),
            1
        };
        size_t expectedBytes = 0;
        return videoFrameByteLength(layout, expectedBytes) && decoded.size() == expectedBytes;
    }

    /**
     * Report whether this implementation uses hardware acceleration.
     * @return true for hardware acceleration; false for software decoding.
     */
    virtual bool isHardwareAccelerated() const { return false; }

    /**
     * Reset decoder state.
     * Used when seeking or restarting decoding.
     */
    virtual void reset() {}

protected:
    int codecId = CODEC_ID_H265;  // Default to H.265.
};

/**
 * Create a platform video decoder.
 * Selects the implementation from compile-time platform macros.
 * Falls back to software decoding when hardware decoding is unavailable.
 *
 * @return Platform video decoder instance.
 */
std::unique_ptr<IPlatformVideoDecoder> createPlatformVideoDecoder();

#endif // PLATFORM_VIDEO_DECODER_H
