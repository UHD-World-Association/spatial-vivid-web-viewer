#ifndef RECONSTRUCTION_KERNEL_H
#define RECONSTRUCTION_KERNEL_H

#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

#include "../processor/stream.h"

namespace uwa {

constexpr uint32_t kShardProtocolVersion = 2;
constexpr uint32_t kShardBuildVersion = 20260909;

enum class ShardAttribute : uint32_t {
    Means = 0,
    Opacity = 1,
    Scaling = 2,
    Rotation = 3,
    FeaturesDc = 4,
    FeaturesRest = 5,
    Importance = 6
};

struct ReconstructionAttributeMetadata {
    ShardAttribute attribute = ShardAttribute::Means;
    std::string name;
    uint32_t channels = 0;
    PredictionMeta prediction;
    QuantMeta quantization;
    int32_t transformType = 0;
};

struct ReconstructionMetadata {
    uint32_t totalPoints = 0;
    uint32_t blockSide = 0;
    uint32_t pointsPerBlock = 0;
    uint32_t shDegree = 0;
    bool decodeFeaturesRest = false;
    std::vector<ReconstructionAttributeMetadata> attributes;
};

struct QuantizedAttributeBlock {
    ShardAttribute attribute = ShardAttribute::Means;
    std::vector<int32_t> values;
};

struct QuantizedBlock {
    uint32_t globalBlock = 0;
    uint32_t pointCount = 0;
    std::vector<QuantizedAttributeBlock> attributes;
};

struct PackedShard {
    uint32_t startBlock = 0;
    uint32_t blockCount = 0;
    uint32_t startPoint = 0;
    uint32_t pointCount = 0;
    std::vector<QuantizedBlock> blocks;
};

struct ReconstructionTimings {
    double packetParseMs = 0.0;
    double predictionMs = 0.0;
    double dequantizeMs = 0.0;
    double transformMs = 0.0;
    double nonlinearMs = 0.0;
    double outputCopyMs = 0.0;
    double totalMs = 0.0;
};

struct ReconstructionResult {
    uint32_t startBlock = 0;
    uint32_t blockCount = 0;
    uint32_t startPoint = 0;
    uint32_t pointCount = 0;
    std::vector<float> positions;
    std::vector<float> opacity;
    std::vector<float> scales;
    std::vector<float> rotations;
    std::vector<float> featuresDc;
    std::vector<uint8_t> colors;
    std::vector<uint8_t> validity;
    std::vector<float> featuresRest;
    ReconstructionTimings timings;

    void clear();
};

bool attributeFromName(const std::string& name, ShardAttribute& attribute);
const char* attributeName(ShardAttribute attribute);
uint32_t attributeChannels(ShardAttribute attribute);

bool serializeReconstructionMetadata(const ReconstructionMetadata& metadata,
                                     std::vector<uint8_t>& output,
                                     std::string& error);
bool deserializeReconstructionMetadata(const uint8_t* data,
                                       size_t size,
                                       ReconstructionMetadata& metadata,
                                       std::string& error);
bool serializePackedShard(const PackedShard& shard,
                          std::vector<uint8_t>& output,
                          std::string& error);
bool reconstructPackedShard(const ReconstructionMetadata& metadata,
                            const uint8_t* packetData,
                            size_t packetSize,
                            ReconstructionResult& result,
                            std::string& error);

} // namespace uwa

#endif // RECONSTRUCTION_KERNEL_H
