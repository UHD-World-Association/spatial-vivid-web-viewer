#include "platform_video_decoder.h"
#include <iostream>

#ifdef __APPLE__
#include <VideoToolbox/VideoToolbox.h>
#include <CoreVideo/CoreVideo.h>

/**
 * Apple VideoToolbox hardware video decoder.
 * Uses the VideoToolbox framework on iOS and macOS.
 */
class AppleVideoDecoder : public IPlatformVideoDecoder {
public:
    AppleVideoDecoder() : session(nullptr) {}
    ~AppleVideoDecoder() override {
        reset();
    }

    bool decode(const std::vector<uint8_t>& encoded,
               std::vector<uint8_t>& decoded,
               int width, int height) override {
        // TODO: Implement VideoToolbox decoding.
        // 1. Create a CMBlockBuffer with CMBlockBufferCreateWithMemoryBlock.
        // 2. Create a CMSampleBuffer with CMSampleBufferCreate.
        // 3. Decode with VTDecompressionSessionDecodeFrame.
        // 4. Read YUV data from the CVPixelBuffer.

        std::cerr << "Apple VideoToolbox decoder not implemented yet" << std::endl;
        decoded = encoded;
        return false;
    }

    bool isHardwareAccelerated() const override {
        return true;
    }

    void reset() override {
        if (session) {
            VTDecompressionSessionInvalidate(session);
            CFRelease(session);
            session = nullptr;
        }
    }

private:
    VTDecompressionSessionRef session;
};

std::unique_ptr<IPlatformVideoDecoder> createAppleVideoDecoder() {
    return std::make_unique<AppleVideoDecoder>();
}

#else
// Stub implementation for non-Apple platforms.
std::unique_ptr<IPlatformVideoDecoder> createAppleVideoDecoder() {
    return nullptr;
}
#endif
