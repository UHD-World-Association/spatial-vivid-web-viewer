#ifndef TEXTURE_TRANSCODER_H
#define TEXTURE_TRANSCODER_H

#include <cstdint>
#include <string>
#include <vector>

enum class BcTextureFormat {
    BC7,
    BC3
};

struct BcTranscodeResult {
    std::vector<uint8_t> data;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t sourceBlockWidth = 0;
    uint32_t sourceBlockHeight = 0;
    double astcDecodeMs = 0.0;
    double bcEncodeMs = 0.0;
};

bool transcodeAstcToBc(const std::vector<uint8_t>& astcFile,
                       BcTextureFormat format,
                       BcTranscodeResult& result,
                       std::string& error);

#endif
