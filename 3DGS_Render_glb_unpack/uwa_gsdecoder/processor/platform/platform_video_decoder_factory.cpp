#include "platform_video_decoder.h"
#include <iostream>

// Forward declarations for platform-specific decoder factories.
#if defined(__ANDROID__)
std::unique_ptr<IPlatformVideoDecoder> createAndroidVideoDecoder();
#elif defined(__APPLE__)
std::unique_ptr<IPlatformVideoDecoder> createAppleVideoDecoder();
#elif defined(__OHOS__)
std::unique_ptr<IPlatformVideoDecoder> createOHOSVideoDecoder();
#else
// Use FFmpeg on platforms other than Android, Apple, and OpenHarmony.
std::unique_ptr<IPlatformVideoDecoder> createFFmpegVideoDecoder();
#endif

/**
 * Creates the platform video decoder.
 *
 * Selection logic:
 * 1. Select the platform hardware decoder through compile-time macros.
 * 2. Use hardware decoders on Android, Apple platforms, and OpenHarmony.
 * 3. Use FFmpeg software decoding on other platforms.
 */
std::unique_ptr<IPlatformVideoDecoder> createPlatformVideoDecoder() {
#if defined(__ANDROID__)
    // Android: use the MediaCodec NDK API.
    auto decoder = createAndroidVideoDecoder();
    if (decoder) {
        std::cout << "[GSDecoder] Using Android MediaCodec decoder" << std::endl;
        return decoder;
    }
    std::cerr << "Error: Android MediaCodec not available" << std::endl;
    return nullptr;

#elif defined(__APPLE__)
    // Apple platforms: use VideoToolbox.
    auto decoder = createAppleVideoDecoder();
    if (decoder) {
        std::cout << "[GSDecoder] Using Apple VideoToolbox decoder" << std::endl;
        return decoder;
    }
    std::cerr << "Error: Apple VideoToolbox not available" << std::endl;
    return nullptr;

#elif defined(__OHOS__)
    // OpenHarmony: use the OH_AVCodec NDK API.
    auto decoder = createOHOSVideoDecoder();
    if (decoder) {
        std::cout << "[GSDecoder] Using OHOS AVCodec decoder" << std::endl;
        return decoder;
    }
    std::cerr << "Error: OHOS AVCodec not available" << std::endl;
    return nullptr;

#else
    // Other platforms: use FFmpeg software decoding.
    std::cout << "[GSDecoder] Using FFmpeg software decoder" << std::endl;
    return createFFmpegVideoDecoder();
#endif
}
