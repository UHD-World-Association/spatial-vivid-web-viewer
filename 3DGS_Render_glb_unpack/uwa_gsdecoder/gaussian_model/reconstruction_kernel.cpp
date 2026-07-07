#include "reconstruction_kernel.h"

#include "../processor/prediction.h"
#include "../processor/quantizer.h"
#include "../processor/transform.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>

namespace uwa {
namespace {

constexpr uint32_t kMetadataMagic = 0x4d415755; // UWAM
constexpr uint32_t kShardMagic = 0x53415755;    // UWAS
constexpr float kShC0 = 0.2820947917738781f;
constexpr uint32_t kMaxAttributeCount = 7;

enum class IntegerLane : uint32_t {
    U8 = 1,
    U16 = 2,
    U32 = 3,
    I32 = 4
};

class ByteWriter {
public:
    ByteWriter() = default;
    explicit ByteWriter(std::vector<uint8_t>& output) : output_(&output) {
        output.clear();
    }

    void u8(uint8_t value) { data().push_back(value); }

    void u16(uint16_t value) {
        data().push_back(static_cast<uint8_t>(value));
        data().push_back(static_cast<uint8_t>(value >> 8));
    }

    void u32(uint32_t value) {
        data().push_back(static_cast<uint8_t>(value));
        data().push_back(static_cast<uint8_t>(value >> 8));
        data().push_back(static_cast<uint8_t>(value >> 16));
        data().push_back(static_cast<uint8_t>(value >> 24));
    }

    void i32(int32_t value) { u32(static_cast<uint32_t>(value)); }

    void f32(float value) {
        uint32_t bits = 0;
        static_assert(sizeof(bits) == sizeof(value), "Unexpected float width");
        std::memcpy(&bits, &value, sizeof(bits));
        u32(bits);
    }

    void bytes(const uint8_t* bytesData, size_t size) {
        data().insert(data().end(), bytesData, bytesData + size);
    }

    uint8_t* append(size_t size) {
        auto& output = data();
        if (size > std::numeric_limits<size_t>::max() - output.size()) return nullptr;
        const size_t offset = output.size();
        output.resize(offset + size);
        return size == 0 ? nullptr : output.data() + offset;
    }

    std::vector<uint8_t> take() { return output_ ? std::vector<uint8_t>() : std::move(owned_); }

private:
    std::vector<uint8_t>& data() { return output_ ? *output_ : owned_; }
    std::vector<uint8_t>* output_ = nullptr;
    std::vector<uint8_t> owned_;
};

class ByteReader {
public:
    ByteReader(const uint8_t* data, size_t size) : data_(data), size_(size) {}

    bool u8(uint8_t& value) {
        if (remaining() < 1) return false;
        value = data_[offset_++];
        return true;
    }

    bool u16(uint16_t& value) {
        if (remaining() < 2) return false;
        value = static_cast<uint16_t>(data_[offset_]) |
                static_cast<uint16_t>(data_[offset_ + 1] << 8);
        offset_ += 2;
        return true;
    }

    bool u32(uint32_t& value) {
        if (remaining() < 4) return false;
        value = static_cast<uint32_t>(data_[offset_]) |
                (static_cast<uint32_t>(data_[offset_ + 1]) << 8) |
                (static_cast<uint32_t>(data_[offset_ + 2]) << 16) |
                (static_cast<uint32_t>(data_[offset_ + 3]) << 24);
        offset_ += 4;
        return true;
    }

    bool i32(int32_t& value) {
        uint32_t bits = 0;
        if (!u32(bits)) return false;
        value = static_cast<int32_t>(bits);
        return true;
    }

    bool f32(float& value) {
        uint32_t bits = 0;
        if (!u32(bits)) return false;
        std::memcpy(&value, &bits, sizeof(value));
        return true;
    }

    bool skip(size_t count) {
        if (remaining() < count) return false;
        offset_ += count;
        return true;
    }

    bool bytes(const uint8_t*& value, size_t count) {
        if (remaining() < count) return false;
        value = count == 0 ? data_ : data_ + offset_;
        offset_ += count;
        return true;
    }

    size_t remaining() const { return size_ - offset_; }
    size_t offset() const { return offset_; }

private:
    const uint8_t* data_ = nullptr;
    size_t size_ = 0;
    size_t offset_ = 0;
};

template <typename Clock = std::chrono::high_resolution_clock>
double elapsedMs(const typename Clock::time_point& start) {
    return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

bool readFloatVector(ByteReader& reader, uint32_t count, std::vector<float>& values) {
    if (count > reader.remaining() / sizeof(float)) return false;
    values.resize(count);
    for (float& value : values) {
        if (!reader.f32(value)) return false;
    }
    return true;
}

bool readIntVector(ByteReader& reader, uint32_t count, std::vector<int32_t>& values) {
    if (count > reader.remaining() / sizeof(int32_t)) return false;
    values.resize(count);
    for (int32_t& value : values) {
        if (!reader.i32(value)) return false;
    }
    return true;
}

IntegerLane chooseLane(const std::vector<int32_t>& values) {
    if (values.empty()) return IntegerLane::U8;
    const auto [minimum, maximum] = std::minmax_element(values.begin(), values.end());
    if (*minimum >= 0 && *maximum <= std::numeric_limits<uint8_t>::max()) return IntegerLane::U8;
    if (*minimum >= 0 && *maximum <= std::numeric_limits<uint16_t>::max()) return IntegerLane::U16;
    if (*minimum >= 0) return IntegerLane::U32;
    return IntegerLane::I32;
}

uint32_t laneWidth(IntegerLane lane) {
    switch (lane) {
        case IntegerLane::U8: return 1;
        case IntegerLane::U16: return 2;
        case IntegerLane::U32:
        case IntegerLane::I32: return 4;
    }
    return 0;
}

bool writeLaneValues(ByteWriter& writer, IntegerLane lane, const std::vector<int32_t>& values) {
    const uint32_t width = laneWidth(lane);
    if (width == 0 || values.size() > std::numeric_limits<size_t>::max() / width) return false;
    const size_t byteLength = values.size() * width;
    uint8_t* output = writer.append(byteLength);
    if (byteLength != 0 && output == nullptr) return false;

    switch (lane) {
        case IntegerLane::U8:
            for (size_t i = 0; i < values.size(); ++i) {
                output[i] = static_cast<uint8_t>(values[i]);
            }
            break;
        case IntegerLane::U16:
            for (size_t i = 0; i < values.size(); ++i) {
                const uint16_t value = static_cast<uint16_t>(values[i]);
                output[i * 2] = static_cast<uint8_t>(value);
                output[i * 2 + 1] = static_cast<uint8_t>(value >> 8);
            }
            break;
        case IntegerLane::U32:
        case IntegerLane::I32:
            for (size_t i = 0; i < values.size(); ++i) {
                const uint32_t value = static_cast<uint32_t>(values[i]);
                output[i * 4] = static_cast<uint8_t>(value);
                output[i * 4 + 1] = static_cast<uint8_t>(value >> 8);
                output[i * 4 + 2] = static_cast<uint8_t>(value >> 16);
                output[i * 4 + 3] = static_cast<uint8_t>(value >> 24);
            }
            break;
    }
    return true;
}

bool readLaneValues(ByteReader& reader,
                    IntegerLane lane,
                    uint32_t count,
                    uint32_t byteLength,
                    std::vector<int32_t>& values) {
    const uint32_t width = laneWidth(lane);
    if (width == 0 || count > std::numeric_limits<uint32_t>::max() / width || byteLength != count * width) {
        return false;
    }
    const uint8_t* payload = nullptr;
    if (!reader.bytes(payload, byteLength)) return false;
    values.resize(count);
    switch (lane) {
        case IntegerLane::U8:
            for (size_t i = 0; i < values.size(); ++i) values[i] = payload[i];
            break;
        case IntegerLane::U16:
            for (size_t i = 0; i < values.size(); ++i) {
                const size_t offset = i * 2;
                values[i] = static_cast<int32_t>(static_cast<uint16_t>(payload[offset]) |
                                                 static_cast<uint16_t>(payload[offset + 1] << 8));
            }
            break;
        case IntegerLane::U32:
            for (size_t i = 0; i < values.size(); ++i) {
                const size_t offset = i * 4;
                const uint32_t current = static_cast<uint32_t>(payload[offset]) |
                                          (static_cast<uint32_t>(payload[offset + 1]) << 8) |
                                          (static_cast<uint32_t>(payload[offset + 2]) << 16) |
                                          (static_cast<uint32_t>(payload[offset + 3]) << 24);
                if (current > static_cast<uint32_t>(std::numeric_limits<int32_t>::max())) return false;
                values[i] = static_cast<int32_t>(current);
            }
            break;
        case IntegerLane::I32:
            for (size_t i = 0; i < values.size(); ++i) {
                const size_t offset = i * 4;
                const uint32_t bits = static_cast<uint32_t>(payload[offset]) |
                                      (static_cast<uint32_t>(payload[offset + 1]) << 8) |
                                      (static_cast<uint32_t>(payload[offset + 2]) << 16) |
                                      (static_cast<uint32_t>(payload[offset + 3]) << 24);
                std::memcpy(&values[i], &bits, sizeof(values[i]));
            }
            break;
        default:
            return false;
        }

    return true;
}

uint8_t toColorByte(float value) {
    const float clamped = std::max(0.0f, std::min(255.0f, value));
    return static_cast<uint8_t>(clamped);
}

bool validateMetadata(const ReconstructionMetadata& metadata, std::string& error) {
    if (metadata.totalPoints == 0 || metadata.blockSide == 0 || metadata.pointsPerBlock == 0) {
        error = "Reconstruction metadata has invalid point or block geometry";
        return false;
    }
    if (metadata.blockSide > std::numeric_limits<uint32_t>::max() / metadata.blockSide ||
        metadata.blockSide * metadata.blockSide != metadata.pointsPerBlock) {
        error = "Reconstruction metadata blockSide/pointsPerBlock mismatch";
        return false;
    }
    if (metadata.attributes.empty() || metadata.attributes.size() > kMaxAttributeCount) {
        error = "Reconstruction metadata has invalid attribute count";
        return false;
    }

    std::array<bool, static_cast<size_t>(ShardAttribute::Importance) + 1> seen{};
    for (const auto& attribute : metadata.attributes) {
        const uint32_t id = static_cast<uint32_t>(attribute.attribute);
        if (id > static_cast<uint32_t>(ShardAttribute::Importance) || seen[id]) {
            error = "Reconstruction metadata contains an invalid or duplicate attribute";
            return false;
        }
        seen[id] = true;
        if (attribute.name != attributeName(attribute.attribute) ||
            attribute.channels != attributeChannels(attribute.attribute)) {
            error = "Reconstruction metadata attribute layout mismatch";
            return false;
        }
        if (attribute.prediction.predictionType != 0 && attribute.prediction.predictionType != 1) {
            error = "Unsupported prediction type in reconstruction metadata";
            return false;
        }
        if (attribute.prediction.blocksize <= 0 ||
            metadata.blockSide % static_cast<uint32_t>(attribute.prediction.blocksize) != 0) {
            error = "Prediction block does not divide reconstruction superblock";
            return false;
        }
    }
    return true;
}

} // namespace

void ReconstructionResult::clear() {
    startBlock = 0;
    blockCount = 0;
    startPoint = 0;
    pointCount = 0;
    positions.clear();
    opacity.clear();
    scales.clear();
    rotations.clear();
    featuresDc.clear();
    colors.clear();
    validity.clear();
    featuresRest.clear();
    timings = ReconstructionTimings();
}

bool attributeFromName(const std::string& name, ShardAttribute& attribute) {
    if (name == "means") attribute = ShardAttribute::Means;
    else if (name == "opacity") attribute = ShardAttribute::Opacity;
    else if (name == "scaling") attribute = ShardAttribute::Scaling;
    else if (name == "rotation") attribute = ShardAttribute::Rotation;
    else if (name == "features_dc") attribute = ShardAttribute::FeaturesDc;
    else if (name == "features_rest") attribute = ShardAttribute::FeaturesRest;
    else if (name == "importance") attribute = ShardAttribute::Importance;
    else return false;
    return true;
}

const char* attributeName(ShardAttribute attribute) {
    switch (attribute) {
        case ShardAttribute::Means: return "means";
        case ShardAttribute::Opacity: return "opacity";
        case ShardAttribute::Scaling: return "scaling";
        case ShardAttribute::Rotation: return "rotation";
        case ShardAttribute::FeaturesDc: return "features_dc";
        case ShardAttribute::FeaturesRest: return "features_rest";
        case ShardAttribute::Importance: return "importance";
    }
    return "unknown";
}

uint32_t attributeChannels(ShardAttribute attribute) {
    switch (attribute) {
        case ShardAttribute::Means: return 3;
        case ShardAttribute::Opacity: return 1;
        case ShardAttribute::Scaling: return 3;
        case ShardAttribute::Rotation: return 4;
        case ShardAttribute::FeaturesDc: return 3;
        case ShardAttribute::FeaturesRest: return 45;
        case ShardAttribute::Importance: return 1;
    }
    return 0;
}

bool serializeReconstructionMetadata(const ReconstructionMetadata& metadata,
                                     std::vector<uint8_t>& output,
                                     std::string& error) {
    if (!validateMetadata(metadata, error)) return false;

    // Reuse the packet capacity across shards. This avoids allocating and then
    // moving a new byte vector for every worker request.
    ByteWriter writer(output);
    writer.u32(kMetadataMagic);
    writer.u32(kShardProtocolVersion);
    writer.u32(kShardBuildVersion);
    writer.u32(metadata.totalPoints);
    writer.u32(metadata.blockSide);
    writer.u32(metadata.pointsPerBlock);
    writer.u32(metadata.shDegree);
    writer.u32(metadata.decodeFeaturesRest ? 1u : 0u);
    writer.u32(static_cast<uint32_t>(metadata.attributes.size()));

    for (const auto& attribute : metadata.attributes) {
        writer.u32(static_cast<uint32_t>(attribute.attribute));
        writer.u32(attribute.channels);
        writer.i32(attribute.prediction.predictionType);
        writer.i32(attribute.prediction.byteshift);
        writer.i32(attribute.prediction.blocksize);
        writer.i32(attribute.quantization.quantType);
        writer.i32(attribute.quantization.bitDepth);
        writer.i32(attribute.transformType);
        writer.u32(static_cast<uint32_t>(attribute.quantization.minVals.size()));
        writer.u32(static_cast<uint32_t>(attribute.quantization.maxVals.size()));
        writer.u32(static_cast<uint32_t>(attribute.quantization.groupSize.size()));
        for (float value : attribute.quantization.minVals) writer.f32(value);
        for (float value : attribute.quantization.maxVals) writer.f32(value);
        for (int32_t value : attribute.quantization.groupSize) writer.i32(value);
    }

    return true;
}

bool deserializeReconstructionMetadata(const uint8_t* data,
                                       size_t size,
                                       ReconstructionMetadata& metadata,
                                       std::string& error) {
    metadata = ReconstructionMetadata();
    if (!data || size == 0) {
        error = "Empty reconstruction metadata packet";
        return false;
    }

    ByteReader reader(data, size);
    uint32_t magic = 0;
    uint32_t protocolVersion = 0;
    uint32_t buildVersion = 0;
    uint32_t decodeFeaturesRest = 0;
    uint32_t attributeCount = 0;
    if (!reader.u32(magic) || !reader.u32(protocolVersion) || !reader.u32(buildVersion) ||
        !reader.u32(metadata.totalPoints) || !reader.u32(metadata.blockSide) ||
        !reader.u32(metadata.pointsPerBlock) || !reader.u32(metadata.shDegree) ||
        !reader.u32(decodeFeaturesRest) || !reader.u32(attributeCount)) {
        error = "Truncated reconstruction metadata header";
        return false;
    }
    if (magic != kMetadataMagic || protocolVersion != kShardProtocolVersion || buildVersion != kShardBuildVersion) {
        error = "Reconstruction metadata protocol/build mismatch";
        return false;
    }
    if (decodeFeaturesRest > 1 || attributeCount == 0 || attributeCount > kMaxAttributeCount) {
        error = "Invalid reconstruction metadata flags or attribute count";
        return false;
    }
    metadata.decodeFeaturesRest = decodeFeaturesRest != 0;
    metadata.attributes.reserve(attributeCount);

    for (uint32_t i = 0; i < attributeCount; ++i) {
        ReconstructionAttributeMetadata attribute;
        uint32_t attributeId = 0;
        uint32_t minCount = 0;
        uint32_t maxCount = 0;
        uint32_t groupCount = 0;
        int32_t predictionType = 0;
        int32_t predictionByteshift = 0;
        int32_t predictionBlocksize = 0;
        int32_t quantType = 0;
        int32_t bitDepth = 0;
        if (!reader.u32(attributeId) || !reader.u32(attribute.channels) ||
            !reader.i32(predictionType) || !reader.i32(predictionByteshift) ||
            !reader.i32(predictionBlocksize) || !reader.i32(quantType) ||
            !reader.i32(bitDepth) || !reader.i32(attribute.transformType) ||
            !reader.u32(minCount) || !reader.u32(maxCount) || !reader.u32(groupCount)) {
            error = "Truncated reconstruction attribute metadata";
            return false;
        }
        if (attributeId > static_cast<uint32_t>(ShardAttribute::Importance)) {
            error = "Unknown reconstruction attribute id";
            return false;
        }
        attribute.attribute = static_cast<ShardAttribute>(attributeId);
        attribute.name = attributeName(attribute.attribute);
        attribute.prediction.predictionType = predictionType;
        attribute.prediction.byteshift = predictionByteshift;
        attribute.prediction.blocksize = predictionBlocksize;
        attribute.quantization.quantType = quantType;
        attribute.quantization.bitDepth = bitDepth;
        if (!readFloatVector(reader, minCount, attribute.quantization.minVals) ||
            !readFloatVector(reader, maxCount, attribute.quantization.maxVals) ||
            !readIntVector(reader, groupCount, attribute.quantization.groupSize)) {
            error = "Truncated reconstruction quantization metadata";
            return false;
        }
        metadata.attributes.push_back(std::move(attribute));
    }

    if (reader.remaining() != 0) {
        error = "Unexpected trailing reconstruction metadata bytes";
        return false;
    }
    return validateMetadata(metadata, error);
}

bool serializePackedShard(const PackedShard& shard,
                          std::vector<uint8_t>& output,
                          std::string& error) {
    if (shard.blockCount == 0 || shard.pointCount == 0 || shard.blocks.size() != shard.blockCount) {
        error = "Invalid packed shard range";
        return false;
    }

    size_t estimatedSize = 8u * sizeof(uint32_t);
    std::vector<std::vector<IntegerLane>> selectedLanes;
    selectedLanes.reserve(shard.blocks.size());
    for (const auto& block : shard.blocks) {
        if (estimatedSize > std::numeric_limits<size_t>::max() - 3u * sizeof(uint32_t)) {
            error = "Packed shard size overflow";
            return false;
        }
        estimatedSize += 3u * sizeof(uint32_t);
        auto& blockLanes = selectedLanes.emplace_back();
        blockLanes.reserve(block.attributes.size());
        for (const auto& attribute : block.attributes) {
            const IntegerLane lane = chooseLane(attribute.values);
            const size_t width = laneWidth(lane);
            if (width == 0 || attribute.values.size() > std::numeric_limits<size_t>::max() / width) {
                error = "Packed shard attribute is too large";
                return false;
            }
            const size_t valueBytes = attribute.values.size() * width;
            if (valueBytes > std::numeric_limits<size_t>::max() - 4u * sizeof(uint32_t) ||
                estimatedSize > std::numeric_limits<size_t>::max() -
                    (4u * sizeof(uint32_t) + valueBytes)) {
                error = "Packed shard size overflow";
                return false;
            }
            estimatedSize += 4u * sizeof(uint32_t) + valueBytes;
            blockLanes.push_back(lane);
        }
    }
    output.reserve(estimatedSize);

    // Reuse the packet capacity across shards instead of allocating a fresh
    // vector and moving it on every worker request.
    ByteWriter writer(output);
    writer.u32(kShardMagic);
    writer.u32(kShardProtocolVersion);
    writer.u32(kShardBuildVersion);
    writer.u32(shard.startBlock);
    writer.u32(shard.blockCount);
    writer.u32(shard.startPoint);
    writer.u32(shard.pointCount);
    writer.u32(static_cast<uint32_t>(shard.blocks.size()));

    for (size_t blockIndex = 0; blockIndex < shard.blocks.size(); ++blockIndex) {
        const auto& block = shard.blocks[blockIndex];
        if (block.globalBlock != shard.startBlock + blockIndex || block.pointCount == 0 ||
            block.attributes.empty() || block.attributes.size() > kMaxAttributeCount) {
            error = "Invalid packed shard block record";
            return false;
        }
        writer.u32(block.globalBlock);
        writer.u32(block.pointCount);
        writer.u32(static_cast<uint32_t>(block.attributes.size()));

        std::array<bool, static_cast<size_t>(ShardAttribute::Importance) + 1> seen{};
        for (size_t attributeIndex = 0; attributeIndex < block.attributes.size(); ++attributeIndex) {
            const auto& attribute = block.attributes[attributeIndex];
            const uint32_t id = static_cast<uint32_t>(attribute.attribute);
            if (id > static_cast<uint32_t>(ShardAttribute::Importance) || seen[id]) {
                error = "Invalid or duplicate packed shard attribute";
                return false;
            }
            seen[id] = true;
            const IntegerLane lane = selectedLanes[blockIndex][attributeIndex];
            const uint32_t width = laneWidth(lane);
            if (attribute.values.size() > std::numeric_limits<uint32_t>::max() / width) {
                error = "Packed shard attribute is too large";
                return false;
            }
            const uint32_t count = static_cast<uint32_t>(attribute.values.size());
            writer.u32(id);
            writer.u32(static_cast<uint32_t>(lane));
            writer.u32(count);
            writer.u32(count * width);
            if (!writeLaneValues(writer, lane, attribute.values)) {
                error = "Packed shard size overflow";
                return false;
            }
        }
    }

    return true;
}

bool reconstructPackedShard(const ReconstructionMetadata& metadata,
                            const uint8_t* packetData,
                            size_t packetSize,
                            ReconstructionResult& result,
                            std::string& error) {
    using Clock = std::chrono::high_resolution_clock;
    const auto totalStart = Clock::now();
    result.clear();
    if (!validateMetadata(metadata, error)) return false;
    if (!packetData || packetSize == 0) {
        error = "Empty shard packet";
        return false;
    }

    ByteReader reader(packetData, packetSize);
    uint32_t magic = 0;
    uint32_t protocolVersion = 0;
    uint32_t buildVersion = 0;
    uint32_t serializedBlockCount = 0;
    if (!reader.u32(magic) || !reader.u32(protocolVersion) || !reader.u32(buildVersion) ||
        !reader.u32(result.startBlock) || !reader.u32(result.blockCount) ||
        !reader.u32(result.startPoint) || !reader.u32(result.pointCount) ||
        !reader.u32(serializedBlockCount)) {
        error = "Truncated shard packet header";
        return false;
    }
    if (magic != kShardMagic || protocolVersion != kShardProtocolVersion || buildVersion != kShardBuildVersion) {
        error = "Shard packet protocol/build mismatch";
        return false;
    }
    if (result.blockCount == 0 || serializedBlockCount != result.blockCount ||
        result.startPoint != result.startBlock * metadata.pointsPerBlock ||
        result.startPoint >= metadata.totalPoints || result.pointCount > metadata.totalPoints - result.startPoint) {
        error = "Invalid shard packet range";
        return false;
    }

    result.positions.resize(static_cast<size_t>(result.pointCount) * 3);
    result.opacity.resize(result.pointCount);
    result.scales.resize(static_cast<size_t>(result.pointCount) * 3);
    result.rotations.resize(static_cast<size_t>(result.pointCount) * 4);
    result.featuresDc.resize(static_cast<size_t>(result.pointCount) * 3);
    result.colors.resize(static_cast<size_t>(result.pointCount) * 4);
    result.validity.resize(result.pointCount);
    if (metadata.decodeFeaturesRest) {
        result.featuresRest.resize(static_cast<size_t>(result.pointCount) * 45);
    }

    std::map<std::string, PredictionMeta> predictionMetadata;
    std::map<std::string, QuantMeta> quantizationMetadata;
    TransformMeta transformMetadata;
    std::array<const ReconstructionAttributeMetadata*, static_cast<size_t>(ShardAttribute::Importance) + 1>
        attributeMetadata{};
    for (const auto& attribute : metadata.attributes) {
        predictionMetadata[attribute.name] = attribute.prediction;
        quantizationMetadata[attribute.name] = attribute.quantization;
        transformMetadata.transformMap[attribute.name] = attribute.transformType;
        attributeMetadata[static_cast<size_t>(attribute.attribute)] = &attribute;
    }

    // Keep the legacy processor interfaces (which accept string-keyed maps),
    // but retain their node/vector storage across blocks. Reusing the fixed set
    // of metadata attributes avoids rebuilding map nodes and releasing large
    // quantized buffers on every block.
    std::map<std::string, std::vector<int32_t>> quantizedAttributes;
    std::map<std::string, std::vector<float>> dequantizedAttributes;
    std::map<std::string, std::vector<float>> transformedAttributes;
    for (const auto& attribute : metadata.attributes) {
        quantizedAttributes.emplace(attribute.name, std::vector<int32_t>());
        dequantizedAttributes.emplace(attribute.name, std::vector<float>());
        transformedAttributes.emplace(attribute.name, std::vector<float>());
    }
    std::array<std::vector<int32_t>*, static_cast<size_t>(ShardAttribute::Importance) + 1>
        quantizedSlots{};
    for (const auto& attribute : metadata.attributes) {
        const size_t id = static_cast<size_t>(attribute.attribute);
        const auto it = quantizedAttributes.find(attribute.name);
        if (id < quantizedSlots.size() && it != quantizedAttributes.end()) quantizedSlots[id] = &it->second;
    }
    Prediction prediction;
    Quantizer quantizer;
    Transform transform;

    const auto parseStart = Clock::now();
    for (uint32_t blockRecord = 0; blockRecord < serializedBlockCount; ++blockRecord) {
        uint32_t globalBlock = 0;
        uint32_t blockPointCount = 0;
        uint32_t blockAttributeCount = 0;
        if (!reader.u32(globalBlock) || !reader.u32(blockPointCount) || !reader.u32(blockAttributeCount)) {
            error = "Truncated shard block header";
            return false;
        }
        if (globalBlock != result.startBlock + blockRecord || blockPointCount == 0 ||
            blockPointCount > metadata.pointsPerBlock || blockAttributeCount == 0 ||
            blockAttributeCount > metadata.attributes.size()) {
            error = "Invalid shard block geometry or attribute count";
            return false;
        }
        const uint32_t globalPoint = globalBlock * metadata.pointsPerBlock;
        const uint32_t expectedPointCount = std::min(metadata.pointsPerBlock, metadata.totalPoints - globalPoint);
        if (blockPointCount != expectedPointCount || globalPoint < result.startPoint ||
            globalPoint + blockPointCount > result.startPoint + result.pointCount) {
            error = "Shard block does not match its declared global range";
            return false;
        }

        // Reset values in place. The map nodes and vector capacities survive
        // across blocks; readLaneValues will resize only the active attributes.
        for (auto& entry : quantizedAttributes) entry.second.clear();
        std::array<bool, static_cast<size_t>(ShardAttribute::Importance) + 1> seen{};
        for (uint32_t attributeRecord = 0; attributeRecord < blockAttributeCount; ++attributeRecord) {
            uint32_t attributeId = 0;
            uint32_t laneId = 0;
            uint32_t valueCount = 0;
            uint32_t byteLength = 0;
            if (!reader.u32(attributeId) || !reader.u32(laneId) ||
                !reader.u32(valueCount) || !reader.u32(byteLength)) {
                error = "Truncated shard attribute header";
                return false;
            }
            if (attributeId > static_cast<uint32_t>(ShardAttribute::Importance) || seen[attributeId]) {
                error = "Unknown or duplicate shard attribute id";
                return false;
            }
            seen[attributeId] = true;
            const auto* metadataEntry = attributeMetadata[attributeId];
            if (!metadataEntry || valueCount != blockPointCount * metadataEntry->channels) {
                error = "Shard attribute layout does not match reconstruction metadata";
                return false;
            }
            auto* values = quantizedSlots[attributeId];
            if (!values) {
                error = "Shard attribute is absent from reconstruction metadata";
                return false;
            }
            if (!readLaneValues(reader, static_cast<IntegerLane>(laneId), valueCount, byteLength, *values)) {
                error = "Invalid or truncated shard attribute payload";
                return false;
            }
        }

        const char* requiredAttributes[] = {"means", "opacity", "scaling", "rotation", "features_dc"};
        for (const char* required : requiredAttributes) {
            const auto requiredIt = quantizedAttributes.find(required);
            if (requiredIt == quantizedAttributes.end() || requiredIt->second.empty()) {
                error = std::string("Shard is missing required attribute: ") + required;
                return false;
            }
        }

        auto stageStart = Clock::now();
        if (!prediction.deprocess(quantizedAttributes, predictionMetadata)) {
            error = "Prediction failed for shard block";
            return false;
        }
        result.timings.predictionMs += elapsedMs(stageStart);

        stageStart = Clock::now();
        for (auto& entry : dequantizedAttributes) entry.second.clear();
        if (!quantizer.dequantize(quantizedAttributes, dequantizedAttributes, quantizationMetadata,
                                  static_cast<int>(globalBlock), static_cast<int>(metadata.pointsPerBlock))) {
            error = "Dequantization failed for shard block";
            return false;
        }
        result.timings.dequantizeMs += elapsedMs(stageStart);

        stageStart = Clock::now();
        for (auto& entry : transformedAttributes) entry.second.clear();
        if (!transform.deprocess(dequantizedAttributes, transformedAttributes, transformMetadata)) {
            error = "Transform failed for shard block";
            return false;
        }
        result.timings.transformMs += elapsedMs(stageStart);

        auto requireFloatAttribute = [&](const char* name, size_t expected) -> const std::vector<float>* {
            const auto it = transformedAttributes.find(name);
            if (it == transformedAttributes.end() || it->second.size() != expected) return nullptr;
            return &it->second;
        };
        const auto* means = requireFloatAttribute("means", static_cast<size_t>(blockPointCount) * 3);
        const auto* opacity = requireFloatAttribute("opacity", blockPointCount);
        const auto* scaling = requireFloatAttribute("scaling", static_cast<size_t>(blockPointCount) * 3);
        const auto* rotation = requireFloatAttribute("rotation", static_cast<size_t>(blockPointCount) * 4);
        const auto* featuresDc = requireFloatAttribute("features_dc", static_cast<size_t>(blockPointCount) * 3);
        const std::vector<float>* featuresRest = nullptr;
        if (metadata.decodeFeaturesRest) {
            featuresRest = requireFloatAttribute("features_rest", static_cast<size_t>(blockPointCount) * 45);
        }
        if (!means || !opacity || !scaling || !rotation || !featuresDc ||
            (metadata.decodeFeaturesRest && !featuresRest)) {
            error = "Reconstructed shard attribute has an unexpected length";
            return false;
        }

        stageStart = Clock::now();
        const size_t localPointOffset = globalPoint - result.startPoint;
        for (uint32_t point = 0; point < blockPointCount; ++point) {
            const size_t localPoint = localPointOffset + point;
            const float decodedOpacity = 1.0f / (1.0f + std::exp(-(*opacity)[point]));
            result.opacity[localPoint] = decodedOpacity;
            result.validity[localPoint] = decodedOpacity > -9.0f ? 1 : 0;
            result.scales[localPoint * 3] = std::exp((*scaling)[point * 3]);
            result.scales[localPoint * 3 + 1] = std::exp((*scaling)[point * 3 + 1]);
            result.scales[localPoint * 3 + 2] = std::exp((*scaling)[point * 3 + 2]);

            const float red = (*featuresDc)[point * 3] * kShC0 + 0.5f;
            const float green = (*featuresDc)[point * 3 + 1] * kShC0 + 0.5f;
            const float blue = (*featuresDc)[point * 3 + 2] * kShC0 + 0.5f;
            result.colors[localPoint * 4] = toColorByte(red * 255.0f);
            result.colors[localPoint * 4 + 1] = toColorByte(green * 255.0f);
            result.colors[localPoint * 4 + 2] = toColorByte(blue * 255.0f);
            result.colors[localPoint * 4 + 3] = toColorByte(decodedOpacity * 255.0f);
        }
        result.timings.nonlinearMs += elapsedMs(stageStart);

        stageStart = Clock::now();
        std::copy(means->begin(), means->end(), result.positions.begin() + localPointOffset * 3);
        std::copy(rotation->begin(), rotation->end(), result.rotations.begin() + localPointOffset * 4);
        std::copy(featuresDc->begin(), featuresDc->end(), result.featuresDc.begin() + localPointOffset * 3);
        if (featuresRest) {
            std::copy(featuresRest->begin(), featuresRest->end(), result.featuresRest.begin() + localPointOffset * 45);
        }
        result.timings.outputCopyMs += elapsedMs(stageStart);
    }
    result.timings.packetParseMs = elapsedMs(parseStart) - result.timings.predictionMs -
                                   result.timings.dequantizeMs - result.timings.transformMs -
                                   result.timings.nonlinearMs - result.timings.outputCopyMs;
    result.timings.packetParseMs = std::max(0.0, result.timings.packetParseMs);

    if (reader.remaining() != 0) {
        error = "Unexpected trailing shard packet bytes";
        return false;
    }
    result.timings.totalMs = elapsedMs(totalStart);
    return true;
}

} // namespace uwa
