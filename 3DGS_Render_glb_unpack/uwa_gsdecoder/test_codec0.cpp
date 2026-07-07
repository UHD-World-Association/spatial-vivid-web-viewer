#include <cstdint>
#include <iostream>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "gaussian_model/gs_decoder.h"
#include "gaussian_model/reconstruction_kernel.h"
#include "processor/platform_video_decoder.h"
#include "processor/stream.h"
#include "processor/unpacker.h"

namespace {

bool expect(bool condition, const std::string& message) {
    if (!condition) std::cerr << "FAIL: " << message << std::endl;
    return condition;
}

void appendUint32(std::vector<uint8_t>& output, uint32_t value) {
    output.push_back(static_cast<uint8_t>(value >> 24));
    output.push_back(static_cast<uint8_t>(value >> 16));
    output.push_back(static_cast<uint8_t>(value >> 8));
    output.push_back(static_cast<uint8_t>(value));
}

std::vector<uint8_t> makeRawPayload(uint32_t width, uint32_t height, uint32_t frames) {
    std::vector<uint8_t> payload(static_cast<size_t>(width) * height * frames * 3);
    for (uint32_t frame = 0; frame < frames; ++frame) {
        for (uint32_t channel = 0; channel < 3; ++channel) {
            for (uint32_t y = 0; y < height; ++y) {
                for (uint32_t x = 0; x < width; ++x) {
                    const size_t offset = (((static_cast<size_t>(frame) * 3 + channel) * height + y) * width + x);
                    payload[offset] = static_cast<uint8_t>(frame * 100 + channel * 20 + y * width + x);
                }
            }
        }
    }
    return payload;
}

void appendLittleEndianUint32(std::vector<uint8_t>& output, uint32_t value) {
    output.push_back(static_cast<uint8_t>(value));
    output.push_back(static_cast<uint8_t>(value >> 8));
    output.push_back(static_cast<uint8_t>(value >> 16));
    output.push_back(static_cast<uint8_t>(value >> 24));
}

uwa::ReconstructionMetadata makePacketMetadata() {
    uwa::ReconstructionMetadata metadata;
    metadata.totalPoints = 1;
    metadata.blockSide = 1;
    metadata.pointsPerBlock = 1;
    for (const auto attribute : {uwa::ShardAttribute::Means, uwa::ShardAttribute::Opacity,
                                 uwa::ShardAttribute::Scaling, uwa::ShardAttribute::Rotation,
                                 uwa::ShardAttribute::FeaturesDc}) {
        uwa::ReconstructionAttributeMetadata entry;
        entry.attribute = attribute;
        entry.name = uwa::attributeName(attribute);
        entry.channels = uwa::attributeChannels(attribute);
        entry.prediction.blocksize = 1;
        metadata.attributes.push_back(std::move(entry));
    }
    return metadata;
}

uwa::PackedShard makePackedShard() {
    uwa::PackedShard shard;
    shard.blockCount = 1;
    shard.pointCount = 1;
    uwa::QuantizedBlock block;
    block.pointCount = 1;
    block.attributes = {
        {uwa::ShardAttribute::Means, {256, 65536, 1}},
        {uwa::ShardAttribute::Opacity, {5}},
        {uwa::ShardAttribute::Scaling, {-1, 0, 1}},
        {uwa::ShardAttribute::Rotation, {300, 400, 500, 600}},
        {uwa::ShardAttribute::FeaturesDc, {7, 8, 9}}
    };
    shard.blocks.push_back(std::move(block));
    return shard;
}

bool testPackedShardLaneEncodingAndValidation() {
    const auto metadata = makePacketMetadata();
    const auto shard = makePackedShard();
    std::vector<uint8_t> packet;
    std::string error;
    if (!expect(uwa::serializePackedShard(shard, packet, error), "packed shard serialization must succeed")) return false;

    std::vector<uint8_t> expected;
    for (const uint32_t value : {0x53415755u, uwa::kShardProtocolVersion, uwa::kShardBuildVersion,
                                 0u, 1u, 0u, 1u, 1u, 0u, 1u, 5u}) {
        appendLittleEndianUint32(expected, value);
    }
    // The expected packet uses packed lane bytes, while its headers remain u32 fields.
    expected.resize(44);
    appendLittleEndianUint32(expected, 0u); // means attribute id
    appendLittleEndianUint32(expected, 3u); // U32 lane
    appendLittleEndianUint32(expected, 3u);
    appendLittleEndianUint32(expected, 12u);
    for (const uint32_t value : {256u, 65536u, 1u}) appendLittleEndianUint32(expected, value);
    appendLittleEndianUint32(expected, 1u); // opacity attribute id
    appendLittleEndianUint32(expected, 1u); // U8 lane
    appendLittleEndianUint32(expected, 1u);
    appendLittleEndianUint32(expected, 1u);
    expected.push_back(5u);
    appendLittleEndianUint32(expected, 2u); // scaling attribute id
    appendLittleEndianUint32(expected, 4u); // I32 lane
    appendLittleEndianUint32(expected, 3u);
    appendLittleEndianUint32(expected, 12u);
    for (const uint32_t value : {0xFFFFFFFFu, 0u, 1u}) appendLittleEndianUint32(expected, value);
    appendLittleEndianUint32(expected, 3u); // rotation attribute id
    appendLittleEndianUint32(expected, 2u); // U16 lane
    appendLittleEndianUint32(expected, 4u);
    appendLittleEndianUint32(expected, 8u);
    for (const uint16_t value : {300u, 400u, 500u, 600u}) {
        expected.push_back(static_cast<uint8_t>(value));
        expected.push_back(static_cast<uint8_t>(value >> 8));
    }
    appendLittleEndianUint32(expected, 4u); // features_dc attribute id
    appendLittleEndianUint32(expected, 1u); // U8 lane
    appendLittleEndianUint32(expected, 3u);
    appendLittleEndianUint32(expected, 3u);
    expected.insert(expected.end(), {7u, 8u, 9u});
    if (!expect(packet == expected, "packed shard bytes must remain protocol-compatible")) return false;

    uwa::ReconstructionResult result;
    if (!expect(uwa::reconstructPackedShard(metadata, packet.data(), packet.size(), result, error),
                "packed shard with all four integer lanes must decode")) return false;
    if (!expect(result.positions == std::vector<float>({256.0f, 65536.0f, 1.0f}),
                "decoded U32 lane values must preserve order")) return false;

    auto truncated = packet;
    truncated.pop_back();
    if (!expect(!uwa::reconstructPackedShard(metadata, truncated.data(), truncated.size(), result, error),
                "truncated packed shard payload must fail")) return false;
    auto trailing = packet;
    trailing.push_back(0u);
    if (!expect(!uwa::reconstructPackedShard(metadata, trailing.data(), trailing.size(), result, error),
                "trailing packed shard bytes must fail")) return false;
    auto overflow = packet;
    overflow[60] = 0xFFu;
    overflow[61] = 0xFFu;
    overflow[62] = 0xFFu;
    overflow[63] = 0xFFu;
    if (!expect(!uwa::reconstructPackedShard(metadata, overflow.data(), overflow.size(), result, error),
                "U32 values above INT32_MAX must fail")) return false;
    return true;
}

std::shared_ptr<VideoMeta> makeVideoMeta(uint32_t width, uint32_t height, uint32_t frames) {
    auto video = std::make_shared<VideoMeta>();
    video->videoDecodeInformation.packingMapVideoCodecId = 0;
    auto& packing = video->videoPackingInformation;
    packing.packingMapWidth = static_cast<uint16_t>(width);
    packing.packingMapHeight = static_cast<uint16_t>(height);
    packing.regionWidth = static_cast<uint16_t>(width);
    packing.regionHeight = static_cast<uint16_t>(height);
    packing.packingMapFrameNumMinus1 = static_cast<uint16_t>(frames - 1);
    packing.packingScaningType = 0;
    packing.packingRegionCountMinus1 = 0;
    packing.initialize();
    packing.regionFrameIndex[0] = 1;
    packing.regionTopLeftX[0] = 0;
    packing.regionTopLeftY[0] = 0;
    packing.attributeType[0] = 0;
    packing.attributeChannelOffset[0] = 0;
    packing.attributeChannelNum[0] = 3;
    packing.byteshift[0] = 0;
    return video;
}

std::vector<uint8_t> makeRawGsbs(const std::vector<uint8_t>& payload,
                                 uint32_t width, uint32_t height, uint32_t frames) {
    Unit metadataUnit(0);
    auto& metadata = *metadataUnit.unitPayload.gsbsMetadata;
    metadata.initialize2(width * height, 1, 0, 1);
    metadata.subGsPointsNum[0] = width * height;
    metadata.subBitstreamSize[0] = static_cast<uint32_t>(payload.size());
    metadata.gsSubsetId[0] = 0;
    metadata.subBitstreamDecodeType[0] = 2;
    metadata.subBitstreamMeta.push_back(makeVideoMeta(width, height, frames));
    metadata.subBitstreamMetaType.push_back(SubBitstreamMetaType::VIDEO);
    metadata.reconstructionInformation.resize(1);
    metadata.reconstructionCount[0] = 0;
    if (!metadataUnit.write()) return {};

    Unit substreamUnit(1);
    substreamUnit.unitPayload.gsbsSubBitstreams->initialize(1);
    substreamUnit.unitPayload.gsbsSubBitstreams->gstcSubBitstreamData[0] = payload;
    if (!substreamUnit.write()) return {};

    const auto metadataBytes = metadataUnit.writer.getBytes();
    const auto substreamBytes = substreamUnit.writer.getBytes();
    std::vector<uint8_t> output;
    output.reserve(8 + metadataBytes.size() + substreamBytes.size());
    appendUint32(output, static_cast<uint32_t>(metadataBytes.size()));
    output.insert(output.end(), metadataBytes.begin(), metadataBytes.end());
    appendUint32(output, static_cast<uint32_t>(substreamBytes.size()));
    output.insert(output.end(), substreamBytes.begin(), substreamBytes.end());
    return output;
}

bool testPixelFormatAndPlanarUnpack() {
    constexpr uint32_t width = 3;
    constexpr uint32_t height = 2;
    constexpr uint32_t frames = 2;
    const auto payload = makeRawPayload(width, height, frames);
    const VideoFrameLayout layout{VideoPixelFormat::YUV444P, width, height, frames};
    VideoPixelFormat abiFormat = VideoPixelFormat::YUV444_INTERLEAVED;
    if (!expect(videoPixelFormatFromAbi(4, abiFormat) && abiFormat == VideoPixelFormat::YUV444P,
                "stable pixel-format ABI value 4 must resolve only to YUV444P")) {
        return false;
    }
    if (!expect(videoPixelFormatMatchesCodec(CODEC_ID_RAW, VideoPixelFormat::YUV444P) &&
                !videoPixelFormatMatchesCodec(CODEC_ID_RAW, VideoPixelFormat::YUV444_INTERLEAVED),
                "codec0 validation must reject non-planar YUV444 layouts")) {
        return false;
    }
    size_t byteLength = 0;
    if (!expect(videoFrameByteLength(layout, byteLength), "YUV444P byte length must be valid") ||
        !expect(byteLength == payload.size(), "YUV444P byte length must include every frame and plane")) {
        return false;
    }

    auto video = makeVideoMeta(width, height, frames);
    Unpacker unpacker;
    std::map<std::string, std::vector<int32_t>> attributes;
    if (!expect(unpacker.unpackVideo(payload, attributes, *video, layout, 0, -1, width * height),
                "planar multi-frame video must unpack with per-frame height")) {
        return false;
    }
    const auto found = attributes.find("means");
    if (!expect(found != attributes.end(), "unpack must produce means")) return false;
    const auto& values = found->second;
    if (!expect(values.size() == width * height * 3, "unpacked means size must be pixel-major RGB")) return false;
    for (uint32_t y = 0; y < height; ++y) {
        for (uint32_t x = 0; x < width; ++x) {
            const size_t pixel = static_cast<size_t>(y) * width + x;
            for (uint32_t channel = 0; channel < 3; ++channel) {
                const int32_t expected = static_cast<int32_t>(100 + channel * 20 + pixel);
                if (!expect(values[pixel * 3 + channel] == expected,
                            "unpacker must sample frame/channel/y/x planar order")) return false;
            }
        }
    }
    return true;
}

bool testRawOnlyStagedLifecycle() {
    constexpr uint32_t width = 3;
    constexpr uint32_t height = 2;
    constexpr uint32_t frames = 2;
    const auto payload = makeRawPayload(width, height, frames);
    const auto stream = makeRawGsbs(payload, width, height, frames);
    GSDecoder decoder;
    if (!expect(decoder.beginPrepareFromMemory(stream.data(), stream.size(), TextureOutputMode::CPU),
                "raw-only beginPrepareFromMemory must succeed")) {
        std::cerr << decoder.getLastError() << std::endl;
        return false;
    }
    if (!expect(decoder.getPendingVideoStreams().empty(), "codec0 must never enter the pending queue") ||
        !expect(getTimingStats().rawVideoStreamCount == 1, "raw stream count must be recorded") ||
        !expect(getTimingStats().rawVideoInputBytes == payload.size(), "raw input bytes must be recorded") ||
        !expect(decoder.finishPreparedDecode(), "raw-only finishPreparedDecode must succeed")) {
        std::cerr << decoder.getLastError() << std::endl;
        return false;
    }
    return true;
}

bool testMalformedLengthsFail() {
    constexpr uint32_t width = 3;
    constexpr uint32_t height = 2;
    constexpr uint32_t frames = 2;
    const auto valid = makeRawPayload(width, height, frames);
    for (int delta : {-1, 1}) {
        auto malformed = valid;
        if (delta < 0) malformed.pop_back();
        else malformed.push_back(0);
        const auto stream = makeRawGsbs(malformed, width, height, frames);
        GSDecoder decoder;
        if (!expect(!decoder.beginPrepareFromMemory(stream.data(), stream.size(), TextureOutputMode::CPU),
                    delta < 0 ? "N-1 raw payload must fail" : "N+1 raw payload must fail")) {
            return false;
        }
    }
    return true;
}

bool testTextureScanParity() {
    TextureMeta texture;
    auto& packing = texture.texturePackingInformation;
    packing.packingMapWidth = 4;
    packing.packingMapHeight = 4;
    packing.regionWidth = 2;
    packing.regionHeight = 2;
    packing.packingScaningType = 1;
    packing.packingScaningBlockSize = 2;
    packing.packingRegionCountMinus1 = 1;
    packing.textureChannelNum = 1;
    packing.byteshift = 1;
    if (!packing.initialize()) return false;
    packing.regionTopLeftX[0] = 0; packing.regionTopLeftY[0] = 0;
    packing.regionTopLeftX[1] = 2; packing.regionTopLeftY[1] = 2;
    texture.attributeType = 1;
    std::vector<uint8_t> payload(16);
    for (size_t i = 0; i < payload.size(); ++i) payload[i] = static_cast<uint8_t>(i);
    Unpacker unpacker;
    std::map<std::string, std::vector<int32_t>> attrs;
    if (!expect(unpacker.unpackTexture(payload, attrs, texture, 0, -1, 4), "texture block scan must unpack")) return false;
    const auto it = attrs.find("opacity");
    if (!expect(it != attrs.end() && it->second.size() == 8, "multi-region texture channel layout")) return false;
    const int expected[] = {0, 20, 2, 22, 8, 28, 10, 30};
    for (size_t i = 0; i < 8; ++i)
        if (!expect(it->second[i] == expected[i], "texture block offsets/byteshift parity")) return false;

    packing.packingScaningType = 0;
    packing.regionWidth = 2; packing.regionHeight = 2;
    packing.packingRegionCountMinus1 = 0;
    packing.regionTopLeftX.resize(1); packing.regionTopLeftY.resize(1);
    packing.regionTopLeftX[0] = 1; packing.regionTopLeftY[0] = 1;
    attrs.clear();
    if (!expect(unpacker.unpackTexture(payload, attrs, texture, 0, -1, 4), "texture row scan must unpack")) return false;
    const auto row = attrs.find("opacity");
    if (!expect(row != attrs.end() && row->second == std::vector<int32_t>({10, 12, 18, 20}), "texture row offsets parity")) return false;
    return true;
}

bool testTexturePlanReuseAndShardParity() {
    Unpacker unpacker;
    for (int scan : {0, 1}) for (int channels : {1, 3}) for (int shift : {0, 1, 8}) {
        TextureMeta texture;
        texture.attributeType = 20;
        auto& p = texture.texturePackingInformation;
        p.packingMapWidth = 16;
        p.packingMapHeight = 8;
        p.regionWidth = 6;
        p.regionHeight = 4;
        p.packingScaningType = scan;
        p.packingScaningBlockSize = 2;
        p.packingRegionCountMinus1 = 1;
        p.textureChannelNum = channels;
        p.byteshift = shift;
        if (!p.initialize()) return false;
        p.regionTopLeftX = {1, 9};
        p.regionTopLeftY = {1, 3};
        const int chunk = scan ? 8 : 7;
        // Preserve vectors while changing the active region count, then reuse
        // the same plan on new decoded bytes and after explicit lifecycle reset.
        for (int regions : {2, 1, 2}) for (int seed : {3, 97}) {
            p.packingRegionCountMinus1 = regions - 1;
            std::vector<uint8_t> data(16 * 8 * channels);
            for (size_t j = 0; j < data.size(); ++j) data[j] = static_cast<uint8_t>(j * 17 + seed);
            for (int shard = -1; shard * chunk < 24; ++shard) {
                const int points = shard < 0 ? 24 : std::min(chunk, 24 - shard * chunk);
                std::vector<int32_t> expected(points * regions * channels, 0);
                for (int r = 0; r < regions; ++r) {
                    if (scan) unpacker.extractBlockScan(data, expected.data(), p.regionTopLeftX[r], p.regionTopLeftY[r],
                        6, 4, 16, channels, 2, regions * channels, r * channels, channels, shift, shard, chunk);
                    else unpacker.extractRowFirstScan(data, expected.data(), p.regionTopLeftX[r], p.regionTopLeftY[r],
                        6, 4, 16, channels, regions * channels, r * channels, channels, shift, shard, chunk);
                }
                std::map<std::string, std::vector<int32_t>> actual;
                if (!expect(unpacker.unpackTexture(data, actual, texture, 0, shard, chunk), "cached texture shard unpack"))
                    return false;
                if (!expect(actual["features_rest"] == expected, "cached texture must match legacy scan for each shard")) {
                    std::cerr << "scan=" << scan << " channels=" << channels << " shift=" << shift << " regions=" << regions << " seed=" << seed << " shard=" << shard << std::endl;
                    return false;
                }
            }
            unpacker.clearPlans();
        }
    }
    return true;
}

} // namespace

int main() {
    if (!testPixelFormatAndPlanarUnpack() ||
        !testRawOnlyStagedLifecycle() ||
        !testMalformedLengthsFail() ||
        !testTextureScanParity() ||
        !testTexturePlanReuseAndShardParity() ||
        !testPackedShardLaneEncodingAndValidation()) {
        return 1;
    }
    std::cout << "codec0 tests passed" << std::endl;
    return 0;
}
