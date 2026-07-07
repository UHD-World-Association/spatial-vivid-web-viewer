#include "quantizer.h"
#include <cmath>
#include <iostream>

Quantizer::Quantizer() {
}

Quantizer::~Quantizer() {
}

bool Quantizer::dequantize(std::map<std::string, std::vector<int32_t>>& quantizedAttrs,
                           std::map<std::string, std::vector<float>>& dequantizedAttrs,
                           const std::map<std::string, QuantMeta>& metaMap,
                           int blockIdx, int pointsPerBlock) {
    for (auto& [attrName, data] : quantizedAttrs) {
        std::vector<float> dequantizedData;

        if (metaMap.find(attrName) != metaMap.end()) {
            const auto& meta = metaMap.at(attrName);

            switch (meta.quantType) {
                case 0:
                    dequantizeNone(data, dequantizedData);
                    break;
                case 1:
                    dequantizeStandard(data, dequantizedData, meta);
                    break;
                case 2:
                    dequantizeMinMax(data, dequantizedData, meta);
                    break;
                case 3:
                    dequantizeGroupMinMax(data, dequantizedData, meta, blockIdx, pointsPerBlock);
                    break;
                default:
                    dequantizeNone(data, dequantizedData);
                    break;
            }
        } else {
            dequantizeNone(data, dequantizedData);
        }

        dequantizedAttrs[attrName] = std::move(dequantizedData);
    }

    return true;
}

bool Quantizer::dequantizeNone(const std::vector<int32_t>& quantizedData,
                               std::vector<float>& dequantizedData) {
    dequantizedData.resize(quantizedData.size());
    for (size_t i = 0; i < quantizedData.size(); i++) {
        dequantizedData[i] = static_cast<float>(quantizedData[i]);
    }
    return true;
}

bool Quantizer::dequantizeStandard(const std::vector<int32_t>& quantizedData,
                                   std::vector<float>& dequantizedData,
                                   const QuantMeta& meta) {
    dequantizedData.resize(quantizedData.size());
    int maxQuantValue = (1 << meta.bitDepth) - 1;

    for (size_t i = 0; i < quantizedData.size(); i++) {
        dequantizedData[i] = static_cast<float>(quantizedData[i]) / maxQuantValue;
    }

    return true;
}

bool Quantizer::dequantizeMinMax(const std::vector<int32_t>& quantizedData,
                                 std::vector<float>& dequantizedData,
                                 const QuantMeta& meta) {
    dequantizedData.resize(quantizedData.size());

    if (meta.minVals.empty() || meta.maxVals.empty()) {
        return dequantizeNone(quantizedData, dequantizedData);
    }

    int maxQuantValue = (1 << meta.bitDepth) - 1;
    int numComponents = meta.minVals.size();

    for (size_t i = 0; i < quantizedData.size(); i++) {
        int compIdx = i % numComponents;
        float minVal = meta.minVals[compIdx];
        float maxVal = meta.maxVals[compIdx];
        float range = maxVal - minVal + 1e-6f;

        dequantizedData[i] = (static_cast<float>(quantizedData[i]) / maxQuantValue) * range + minVal;
    }

    return true;
}

bool Quantizer::dequantizeGroupMinMax(const std::vector<int32_t>& quantizedData,
                                      std::vector<float>& dequantizedData,
                                      const QuantMeta& meta,
                                      int blockIdx, int pointsPerBlock) {
    dequantizedData.resize(quantizedData.size());

    if (meta.groupSize.empty()) {
        return dequantizeMinMax(quantizedData, dequantizedData, meta);
    }

    int maxQuantValue = (1 << meta.bitDepth) - 1;
    int numGroups = meta.groupSize.size();
    int numComponents = meta.minVals.size() / numGroups;

    // In block mode, determine each group from the point's global index.
    if (blockIdx >= 0) {
        // Calculate the block's starting index in the global point cloud.
        const int POINTS_PER_BLOCK = pointsPerBlock;
        int startGlobalIdx = blockIdx * POINTS_PER_BLOCK;

        // Points are stored in order, so advance the group boundary once per
        // point instead of rescanning every group for every component.
        int groupIdx = 0;
        int nextGroupEnd = meta.groupSize[0];
        const size_t pointCount = quantizedData.size() / static_cast<size_t>(numComponents);
        for (size_t point = 0; point < pointCount; ++point) {
            const int globalPointIdx = startGlobalIdx + static_cast<int>(point);
            while (groupIdx + 1 < numGroups && globalPointIdx >= nextGroupEnd) {
                ++groupIdx;
                nextGroupEnd += meta.groupSize[groupIdx];
            }
            const int metaBase = groupIdx * numComponents;
            const size_t dataBase = point * static_cast<size_t>(numComponents);
            for (int compIdx = 0; compIdx < numComponents; ++compIdx) {
                const int metaIdx = metaBase + compIdx;
                const float minVal = meta.minVals[metaIdx];
                const float maxVal = meta.maxVals[metaIdx];
                const float range = maxVal - minVal + 1e-6f;
                dequantizedData[dataBase + static_cast<size_t>(compIdx)] =
                    (static_cast<float>(quantizedData[dataBase + static_cast<size_t>(compIdx)]) /
                     maxQuantValue) * range + minVal;
            }
        }
        return true;
    }

    // In full-model mode, iterate by groupSize.
    size_t dataIdx = 0;
    for (int groupIdx = 0; groupIdx < numGroups; groupIdx++) {
        int groupSize = meta.groupSize[groupIdx];

        for (int pointIdx = 0; pointIdx < groupSize; pointIdx++) {
            for (int compIdx = 0; compIdx < numComponents; compIdx++) {
                if (dataIdx >= quantizedData.size()) break;

                int metaIdx = groupIdx * numComponents + compIdx;
                float minVal = meta.minVals[metaIdx];
                float maxVal = meta.maxVals[metaIdx];
                float range = maxVal - minVal + 1e-6f;

                dequantizedData[dataIdx] = (static_cast<float>(quantizedData[dataIdx]) / maxQuantValue) * range + minVal;
                dataIdx++;
            }
        }
    }

    return true;
}
