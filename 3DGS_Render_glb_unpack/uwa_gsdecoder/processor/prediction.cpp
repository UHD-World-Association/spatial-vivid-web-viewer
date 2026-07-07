#include "prediction.h"
#include <iostream>
#include <cmath>

constexpr int DEFAULT_CHANNELS_MEANS = 3;
constexpr int DEFAULT_CHANNELS_OPACITY = 1;
constexpr int DEFAULT_CHANNELS_SCALING = 3;
constexpr int DEFAULT_CHANNELS_ROTATION = 4;
constexpr int DEFAULT_CHANNELS_FEATURES_DC = 3;
constexpr int DEFAULT_CHANNELS_DEFAULT = 3;

static int getChannelCount(const std::string& attrName) {
    if (attrName == "means") return DEFAULT_CHANNELS_MEANS;
    if (attrName == "opacity") return DEFAULT_CHANNELS_OPACITY;
    if (attrName == "scaling") return DEFAULT_CHANNELS_SCALING;
    if (attrName == "rotation") return DEFAULT_CHANNELS_ROTATION;
    if (attrName == "features_dc") return DEFAULT_CHANNELS_FEATURES_DC;
    return DEFAULT_CHANNELS_DEFAULT;
}

Prediction::Prediction() {
}

Prediction::~Prediction() {
}

bool Prediction::deprocess(std::map<std::string, std::vector<int32_t>>& quantizedAttrs,
                          const std::map<std::string, PredictionMeta>& metaMap) {
    for (auto& [attrName, data] : quantizedAttrs) {
        if (metaMap.find(attrName) == metaMap.end()) continue;

        const auto& meta = metaMap.at(attrName);
        int numChannels = getChannelCount(attrName);

        switch (meta.predictionType) {
            case 0:  // None
                break;

            case 1:  // Minor prediction
                if (!deprocessMinorBlock(data, meta.byteshift, meta.blocksize, numChannels)) {
                    std::cerr << "Error: Failed to deprocess minor prediction for " << attrName << std::endl;
                    return false;
                }
                break;

            default:
                std::cerr << "Error: Unsupported prediction type " << meta.predictionType << std::endl;
                return false;
        }
    }
    return true;
}

bool Prediction::deprocessMinor(std::vector<int32_t>& data, int byteshift, int numChannels) {
    if (byteshift <= 0) return true;

    int levels = 1 << byteshift;
    size_t numValues = data.size();

    x_h_buffer_.resize(numValues);
    x_l_buffer_.resize(numValues);

    for (size_t i = 0; i < numValues; i++) {
        x_h_buffer_[i] = data[i] / levels;
        x_l_buffer_[i] = data[i] % levels;
    }

    for (int c = 0; c < numChannels; c++) {
        int32_t cumsum = 0;
        for (size_t i = c; i < numValues; i += numChannels) {
            cumsum = (cumsum + x_h_buffer_[i]) % 256;
            x_h_buffer_[i] = cumsum;
        }
    }

    for (size_t i = 0; i < numValues; i++) {
        data[i] = (x_h_buffer_[i] * levels + x_l_buffer_[i]);
    }

    return true;
}

bool Prediction::deprocessMinorBlock(std::vector<int32_t>& data, int byteshift, int blockSize, int numChannels) {
    if (byteshift < 0) return true;

    int levels = 1 << byteshift;
    int blockSizeSquared = blockSize * blockSize;
    size_t numValues = data.size();

    if (numValues % numChannels != 0) {
        std::cerr << "Error: Data size not multiple of channels" << std::endl;
        return false;
    }

    size_t numPoints = numValues / numChannels;

    x_h_buffer_.resize(numValues);
    x_l_buffer_.resize(numValues);

    for (size_t i = 0; i < numValues; i++) {
        x_h_buffer_[i] = data[i] / levels;
        x_l_buffer_[i] = data[i] % levels;
    }

    size_t numBlocks = numPoints / blockSizeSquared;
    if (numPoints % blockSizeSquared != 0) numBlocks++;

    for (size_t b = 0; b < numBlocks; b++) {
        size_t blockStart = b * blockSizeSquared * numChannels;
        size_t blockEnd = std::min(blockStart + blockSizeSquared * numChannels, numValues);

        for (int c = 0; c < numChannels; c++) {
            int32_t cumsum = 0;
            for (size_t i = blockStart + c; i < blockEnd; i += numChannels) {
                cumsum = (cumsum + x_h_buffer_[i]) % 256;
                x_h_buffer_[i] = cumsum;
            }
        }
    }

    for (size_t i = 0; i < numValues; i++) {
        data[i] = (x_h_buffer_[i] * levels + x_l_buffer_[i]);
    }

    return true;
}
