#include "platform_video_decoder.h"
#include <iostream>

#ifdef __OHOS__
#include <multimedia/player_framework/native_avcodec_videodecoder.h>
#include <multimedia/player_framework/native_avcapability.h>

/**
 * OpenHarmony OH_AVCodec hardware video decoder.
 * Uses the OpenHarmony NDK OH_AVCodec API.
 */
class OHOSVideoDecoder : public IPlatformVideoDecoder {
public:
    OHOSVideoDecoder() : codec(nullptr) {}
    ~OHOSVideoDecoder() override {
        reset();
    }

    bool decode(const std::vector<uint8_t>& encoded,
               std::vector<uint8_t>& decoded,
               int width, int height) override {
        // TODO: Implement OH_AVCodec decoding.
        // 1. Create the decoder with OH_VideoDecoder_CreateByMime(OH_AVCODEC_MIMETYPE_VIDEO_HEVC).
        // 2. Configure the decoder with OH_VideoDecoder_Configure.
        // 3. Start the decoder with OH_VideoDecoder_Start.
        // 4. Submit the input buffer with OH_VideoDecoder_PushInputBuffer.
        // 5. Render the output buffer with OH_VideoDecoder_RenderOutputBuffer.

        std::cerr << "OHOS AVCodec decoder not implemented yet" << std::endl;
        decoded = encoded;
        return false;
    }

    bool isHardwareAccelerated() const override {
        return true;
    }

    void reset() override {
        if (codec) {
            OH_VideoDecoder_Destroy(codec);
            codec = nullptr;
        }
    }

private:
    OH_AVCodec* codec;
};

std::unique_ptr<IPlatformVideoDecoder> createOHOSVideoDecoder() {
    return std::make_unique<OHOSVideoDecoder>();
}

#else
// Stub implementation for non-OHOS platforms.
std::unique_ptr<IPlatformVideoDecoder> createOHOSVideoDecoder() {
    return nullptr;
}
#endif
