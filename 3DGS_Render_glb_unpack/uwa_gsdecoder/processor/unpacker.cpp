#include "unpacker.h"
#include <iostream>
#include <cmath>
#include <algorithm>
#include <limits>

// Default channel counts.
constexpr int CHANNELS_MEANS = 3;       // means: x, y, z
constexpr int CHANNELS_OPACITY = 1;     // Opacity: one channel.
constexpr int CHANNELS_SCALING = 3;     // scaling: x, y, z
constexpr int CHANNELS_ROTATION = 4;    // rotation: w, x, y, z
constexpr int CHANNELS_FEATURES_DC = 3; // features_dc: r, g, b
constexpr int CHANNELS_IMPORTANCE = 1;  // Importance: one channel.
constexpr size_t kMaxCachedPlanBytes = 256u * 1024u;

// Attribute names are used as std::map keys throughout the legacy unpacker
// interface. Keep one immutable key per attribute type so hot block paths do not
// construct a temporary std::string for every region.
const std::string& attributeNameKey(int attrType) {
    static const std::string means = "means";
    static const std::string opacity = "opacity";
    static const std::string scaling = "scaling";
    static const std::string rotation = "rotation";
    static const std::string featuresDc = "features_dc";
    static const std::string featuresRest = "features_rest";
    static const std::string importance = "importance";
    static const std::string unknown = "unknown";
    switch (attrType) {
        case 0: return means;
        case 1: return opacity;
        case 2: return scaling;
        case 3: return rotation;
        case 4: return featuresDc;
        case 20: return featuresRest;
        case 21: return importance;
        default:
            return (attrType >= 5 && attrType <= 19) ? featuresRest : unknown;
    }
}

int canonicalChannelCount(int attrType, int channelOffset, int channelNum) {
    switch (attrType) {
        case 0: return CHANNELS_MEANS;
        case 1: return CHANNELS_OPACITY;
        case 2: return CHANNELS_SCALING;
        case 3: return CHANNELS_ROTATION;
        case 4: return CHANNELS_FEATURES_DC;
        case 20: return channelOffset + channelNum;
        case 21: return CHANNELS_IMPORTANCE;
        default: return channelOffset + channelNum;
    }
}

template <typename Left, typename Right>
bool intVectorEqual(const Left& left, const Right& right) {
    return left.size() == right.size() && std::equal(left.begin(), left.end(), right.begin(),
        [](auto lhs, auto rhs) { return static_cast<int>(lhs) == static_cast<int>(rhs); });
}

Unpacker::Unpacker() {
}

Unpacker::~Unpacker() {
}

void Unpacker::clearPlans() {
    std::lock_guard<std::mutex> lock(planMutex_);
    hasTexturePlan_ = false;
    texturePlanKey_ = TexturePlanKey();
    texturePlan_ = TexturePlan();
}

bool Unpacker::buildTexturePlan(const TextureMeta& textureMeta,
                                TexturePlanKey& key,
                                TexturePlan& plan) const {
    const auto& packing = textureMeta.texturePackingInformation;
    const int regionCount = static_cast<int>(packing.packingRegionCountMinus1) + 1;
    key.regionCount = regionCount;
    key.regionWidth = packing.regionWidth;
    key.regionHeight = packing.regionHeight;
    key.blockSize = packing.packingScaningBlockSize;
    key.mapWidth = packing.packingMapWidth;
    key.channelNum = packing.textureChannelNum;
    key.scanType = packing.packingScaningType;
    key.regionX.assign(packing.regionTopLeftX.begin(), packing.regionTopLeftX.end());
    key.regionY.assign(packing.regionTopLeftY.begin(), packing.regionTopLeftY.end());
    if (regionCount <= 0 || key.regionWidth <= 0 || key.regionHeight <= 0 ||
        key.mapWidth <= 0 || key.channelNum <= 0 ||
        static_cast<int>(key.regionX.size()) < regionCount ||
        static_cast<int>(key.regionY.size()) < regionCount) {
        return false;
    }
    if (key.scanType == 1 && (key.blockSize <= 0 || key.regionWidth % key.blockSize != 0 ||
                              key.regionHeight % key.blockSize != 0)) {
        return false;
    }
    plan = TexturePlan();
    plan.regionWidth = key.regionWidth;
    plan.regionHeight = key.regionHeight;
    plan.blockSize = key.blockSize;
    plan.mapWidth = key.mapWidth;
    plan.channelNum = key.channelNum;
    plan.scanType = key.scanType;
    plan.regions.resize(static_cast<size_t>(regionCount));

    const size_t pixelCount = static_cast<size_t>(key.regionWidth) * key.regionHeight;
    for (int region = 0; region < regionCount; ++region) {
        auto& output = plan.regions[static_cast<size_t>(region)];
        output.channelOffset = region * key.channelNum;
        output.sourceOffsets.reserve(key.scanType == 1 ? 0 : pixelCount);
        auto appendOffset = [&](size_t offset) {
            if (offset > std::numeric_limits<uint32_t>::max()) return false;
            output.sourceOffsets.push_back(static_cast<uint32_t>(offset));
            return true;
        };
        if (key.scanType == 1) {
            const int blocksPerRow = key.regionWidth / key.blockSize;
            const int rows = key.regionHeight / key.blockSize;
            const size_t patternCount = static_cast<size_t>(key.blockSize) * key.blockSize;
            output.blockPattern.reserve(patternCount);
            for (int y = 0; y < key.blockSize; ++y) for (int x = 0; x < key.blockSize; ++x)
                output.blockPattern.push_back(static_cast<uint32_t>((static_cast<size_t>(y) * key.mapWidth + x) * key.channelNum));
            for (int block = 0; block < blocksPerRow * rows; ++block) {
                const int blockY = block / blocksPerRow;
                const int blockX = block % blocksPerRow;
                const size_t origin = (static_cast<size_t>(key.regionY[region] + blockY * key.blockSize) * key.mapWidth +
                                       static_cast<size_t>(key.regionX[region] + blockX * key.blockSize)) * key.channelNum;
                if (!appendOffset(origin)) return false;
                output.blockOrigins.push_back(output.sourceOffsets.back());
                output.sourceOffsets.pop_back();
            }
        } else {
            for (int y = 0; y < key.regionHeight; ++y) {
                for (int x = 0; x < key.regionWidth; ++x) {
                    const size_t srcY = static_cast<size_t>(key.regionY[region] + y);
                    const size_t srcX = static_cast<size_t>(key.regionX[region] + x);
                    const size_t offset = (srcY * static_cast<size_t>(key.mapWidth) + srcX) *
                                          static_cast<size_t>(key.channelNum);
                    if (!appendOffset(offset)) return false;
                }
            }
        }
    }
    return true;
}

void Unpacker::extractBlockScan(
    const std::vector<uint8_t>& srcData,
    int32_t* dstData,
    int regionX, int regionY, int regionW, int regionH,
    int mapWidth, int channelNum, int blockSize,
    int totalChannels, int channelOffset, int srcChannelNum,
    int byteshift,
    int blockIdx, int chunkblocksize) {

    int blocksPerRow = regionW / blockSize;
    int pointsPerBlock = blockSize * blockSize;

    // A negative blockIdx processes all blocks for compatibility with the legacy interface.
    bool processAll = (blockIdx < 0);

    // Precompute values used for byte shifting.
    int shift = (byteshift < 0) ? 0 : byteshift;

    // Determine the block range to process.
    int startBlock = processAll ? 0 : blockIdx * (chunkblocksize / pointsPerBlock);
    int endBlock = processAll ? (blocksPerRow * (regionH / blockSize)) : std::min((startBlock + (chunkblocksize / pointsPerBlock)), (blocksPerRow * (regionH / blockSize)));

    for (int b = startBlock; b < endBlock; b++) {
        int blockY = b / blocksPerRow;
        int blockX = b % blocksPerRow;

        // Iterate over every pixel in the block.
        for (int by = 0; by < blockSize; by++) {
            for (int bx = 0; bx < blockSize; bx++) {
                int y = blockY * blockSize + by;
                int x = blockX * blockSize + bx;

                // Calculate the row-major source position in the packing map.
                int srcY = regionY + y;
                int srcX = regionX + x;
                int srcIdx = (srcY * mapWidth + srcX) * srcChannelNum;

                // Calculate the contiguous zero-based destination position.
                int dstIdx = (b - startBlock) * pointsPerBlock + (by * blockSize + bx);

                // Apply byte shifting and type conversion while writing directly to the destination.
                for (int c = 0; c < channelNum; c++) {
                    int32_t value = static_cast<int32_t>(srcData[srcIdx + c]);
                    // Apply the byte shift.
                    value = value << shift;
                    // Accumulate into the destination element.
                    dstData[dstIdx * totalChannels + channelOffset + c] += value;
                }
            }
        }
    }
}

void Unpacker::extractRowFirstScan(
    const std::vector<uint8_t>& srcData,
    int32_t* dstData,
    int regionX, int regionY, int regionW, int regionH,
    int mapWidth, int channelNum,
    int totalChannels, int channelOffset, int srcChannelNum,
    int byteshift,
    int idx, int chunkblocksize) {

    // A negative row index processes all rows for compatibility with the legacy interface.
    bool processAll = (idx < 0);

    // Precompute values used for byte shifting.
    int shiftLimit = (byteshift < 0) ? ((1 << (-byteshift)) - 1) : 0;

    // Determine the range to process.
    int startIdx = processAll ? 0 : idx * chunkblocksize;
    int endIdx = processAll ? regionH * regionW : std::min(regionH * regionW, idx * chunkblocksize + chunkblocksize);

    for (int i = startIdx; i < endIdx; i++) {
        int y = i / regionW;
        int x = i % regionW;

        int srcIdx = ((regionY + y) * mapWidth + (regionX + x)) * srcChannelNum;
        // Calculate the contiguous zero-based destination position.
        int dstIdx = i - startIdx;

        // Apply byte shifting and type conversion while writing directly to the destination.
        for (int c = 0; c < channelNum; c++) {
            if (srcIdx + c < static_cast<int>(srcData.size())) {
                int32_t value = static_cast<int32_t>(srcData[srcIdx + c]);

                // Apply the byte shift.
                if (byteshift >= 0) {
                    value = value << byteshift;
                } else {
                    value = std::min(value, shiftLimit);
                }

                // Accumulate into the destination element.
                dstData[dstIdx * totalChannels + channelOffset + c] += value;
            }
        }
    }
}

bool Unpacker::unpackTexture(
    const std::vector<uint8_t>& decodedData,
    std::map<std::string, std::vector<int32_t>>& unpackedAttrs,
    const TextureMeta& textureMeta,
    int streamIndex,
    int blockIdx, int chunkblocksize) {

    const auto& packingInfo = textureMeta.texturePackingInformation;
    const int attrType = textureMeta.attributeType;
    const std::string& attrName = attributeNameKey(attrType);
    const int channelNum = packingInfo.textureChannelNum;
    const int regionCount = packingInfo.packingRegionCountMinus1 + 1;
    const int totalChannels = regionCount * channelNum;

    // Keep cache memory bounded. Large or unusual layouts use the established
    // extraction path directly; this preserves correctness without retaining a
    // per-pixel table for the whole model.
    const size_t pixelCount = (packingInfo.regionWidth > 0 && packingInfo.regionHeight > 0) ?
        static_cast<size_t>(packingInfo.regionWidth) * static_cast<size_t>(packingInfo.regionHeight) : 0;
    const size_t cachedEntries = packingInfo.packingScaningType == 1 && packingInfo.packingScaningBlockSize > 0 ?
        (static_cast<size_t>(packingInfo.packingScaningBlockSize) * packingInfo.packingScaningBlockSize +
         (static_cast<size_t>(packingInfo.regionWidth) / packingInfo.packingScaningBlockSize) *
         (static_cast<size_t>(packingInfo.regionHeight) / packingInfo.packingScaningBlockSize)) *
            static_cast<size_t>(std::max(1, regionCount)) : pixelCount * static_cast<size_t>(std::max(1, regionCount));
    const bool cacheTooLarge = regionCount <= 0 || channelNum <= 0 || cachedEntries > kMaxCachedPlanBytes / 4u;
    if (cacheTooLarge) {
        const int numPixels = blockIdx >= 0 ?
            std::min(packingInfo.regionWidth * packingInfo.regionHeight - blockIdx * chunkblocksize, chunkblocksize) :
            packingInfo.regionWidth * packingInfo.regionHeight;
        auto attrIt = unpackedAttrs.find(attrName);
        if (attrIt == unpackedAttrs.end()) {
            attrIt = unpackedAttrs.emplace(attrName, std::vector<int32_t>(std::max(0, numPixels * totalChannels), 0)).first;
        }
        for (int r = 0; r < regionCount; ++r) {
            if (packingInfo.packingScaningType == 1) {
                extractBlockScan(decodedData, attrIt->second.data(), packingInfo.regionTopLeftX[r], packingInfo.regionTopLeftY[r],
                    packingInfo.regionWidth, packingInfo.regionHeight, packingInfo.packingMapWidth, channelNum,
                    packingInfo.packingScaningBlockSize, totalChannels, r * channelNum, channelNum,
                    packingInfo.byteshift, blockIdx, chunkblocksize);
            } else {
                extractRowFirstScan(decodedData, attrIt->second.data(), packingInfo.regionTopLeftX[r], packingInfo.regionTopLeftY[r],
                    packingInfo.regionWidth, packingInfo.regionHeight, packingInfo.packingMapWidth, channelNum,
                    totalChannels, r * channelNum, channelNum, packingInfo.byteshift, blockIdx, chunkblocksize);
            }
        }
        return true;
    }

    std::unique_lock<std::mutex> planLock(planMutex_);
    const bool sameTextureLayout = hasTexturePlan_ &&
        texturePlanKey_.regionCount == regionCount &&
        texturePlanKey_.regionWidth == packingInfo.regionWidth &&
        texturePlanKey_.regionHeight == packingInfo.regionHeight &&
        texturePlanKey_.blockSize == packingInfo.packingScaningBlockSize &&
        texturePlanKey_.mapWidth == packingInfo.packingMapWidth &&
        texturePlanKey_.channelNum == packingInfo.textureChannelNum &&
        texturePlanKey_.scanType == packingInfo.packingScaningType &&
        intVectorEqual(texturePlanKey_.regionX, packingInfo.regionTopLeftX) &&
        intVectorEqual(texturePlanKey_.regionY, packingInfo.regionTopLeftY);
    if (!sameTextureLayout) {
        TexturePlanKey requestedKey;
        TexturePlan requestedPlan;
        if (!buildTexturePlan(textureMeta, requestedKey, requestedPlan)) return false;
        texturePlanKey_ = requestedKey;
        texturePlan_ = std::move(requestedPlan);
        hasTexturePlan_ = true;
    }
    const TexturePlan& activePlan = texturePlan_;
    const int blockSize = activePlan.blockSize;
    const int pointsPerBlock = blockSize > 0 ? blockSize * blockSize : 0;

    // Size the buffer according to blockIdx.
    int numPixels;
    if (blockIdx >= 0) {
        // Process a single block.
        numPixels = std::min(packingInfo.regionWidth * packingInfo.regionHeight - blockIdx * chunkblocksize, chunkblocksize);
    } else {
        // In full-model mode, process every pixel.
        numPixels = packingInfo.regionWidth * packingInfo.regionHeight;
    }

    auto attrIt = unpackedAttrs.find(attrName);
    if (attrIt == unpackedAttrs.end()) {
        attrIt = unpackedAttrs.emplace(attrName,
            std::vector<int32_t>(numPixels * totalChannels, 0)).first;
    }

    const int byteshift = packingInfo.byteshift;
    const bool processAll = blockIdx < 0;
    int startOrdinal = 0;
    int endOrdinal = packingInfo.regionWidth * packingInfo.regionHeight;
    if (packingInfo.packingScaningType == 1) {
        if (pointsPerBlock <= 0) return false;
        const int blocksPerRow = packingInfo.regionWidth / blockSize;
        const int totalBlocks = blocksPerRow * (packingInfo.regionHeight / blockSize);
        const int startBlock = processAll ? 0 : blockIdx * (chunkblocksize / pointsPerBlock);
        const int endBlock = processAll ? totalBlocks :
            std::min(startBlock + chunkblocksize / pointsPerBlock, totalBlocks);
        startOrdinal = startBlock * pointsPerBlock;
        endOrdinal = endBlock * pointsPerBlock;
    } else if (!processAll) {
        startOrdinal = blockIdx * chunkblocksize;
        endOrdinal = std::min(endOrdinal, startOrdinal + chunkblocksize);
    }
    for (int r = 0; r < regionCount; ++r) {
        const auto& region = activePlan.regions[static_cast<size_t>(r)];
        int32_t* dstData = attrIt->second.data();
        const int shift = byteshift < 0 ? 0 : byteshift;
        const int shiftLimit = byteshift < 0 ? (1 << (-byteshift)) - 1 : 0;
        const auto copyPixel = [&](size_t srcIdx, int destinationPixel) {
            for (int channel = 0; channel < channelNum; ++channel) {
                if (srcIdx + static_cast<size_t>(channel) >= decodedData.size()) continue;
                int32_t value = static_cast<int32_t>(decodedData[srcIdx + static_cast<size_t>(channel)]) << shift;
                if (byteshift < 0 && packingInfo.packingScaningType != 1) value = std::min(value, shiftLimit);
                dstData[destinationPixel * totalChannels + region.channelOffset + channel] += value;
            }
        };
        if (packingInfo.packingScaningType == 1) {
            const int firstBlock = startOrdinal / pointsPerBlock;
            const int lastBlock = endOrdinal / pointsPerBlock;
            int destinationPixel = 0;
            for (int block = firstBlock; block < lastBlock; ++block) {
                const size_t origin = region.blockOrigins[static_cast<size_t>(block)];
                for (const uint32_t offset : region.blockPattern) {
                    copyPixel(origin + offset, destinationPixel++);
                }
            }
        } else {
            for (int ordinal = startOrdinal; ordinal < endOrdinal; ++ordinal) {
                copyPixel(region.sourceOffsets[static_cast<size_t>(ordinal)], ordinal - startOrdinal);
            }
        }
    }

    return true;
}

bool Unpacker::unpackVideo(
    const std::vector<uint8_t>& decodedData,
    std::map<std::string, std::vector<int32_t>>& unpackedAttrs,
    const VideoMeta& videoMeta,
    const VideoFrameLayout& layout,
    int streamIndex,
    int blockIdx, int chunkblocksize) {

    (void)streamIndex;
    const auto& packingInfo = videoMeta.videoPackingInformation;
    int frameCount = packingInfo.packingMapFrameNumMinus1 + 1;
    int regionCount = packingInfo.packingRegionCountMinus1 + 1;
    int frameHeight = packingInfo.packingMapHeight;
    int blockSize = packingInfo.packingScaningBlockSize;

    size_t expectedBytes = 0;
    if (layout.width != packingInfo.packingMapWidth ||
        layout.height != static_cast<uint32_t>(frameHeight) ||
        layout.frameCount != static_cast<uint32_t>(frameCount) ||
        !videoFrameByteLength(layout, expectedBytes) || decodedData.size() != expectedBytes) {
        std::cerr << "      Error: Invalid explicit video layout" << std::endl;
        return false;
    }

    const size_t width = layout.width;
    const size_t height = layout.height;
    const size_t lumaBytes = width * height;
    const size_t chromaBytes = lumaBytes / 4;
    const size_t frameStride = expectedBytes / layout.frameCount;
    auto sampleChannel = [&](int frame, int x, int y, int channel) -> uint8_t {
        const size_t frameBase = static_cast<size_t>(frame) * frameStride;
        const size_t pixel = static_cast<size_t>(y) * width + x;
        if (layout.pixelFormat == VideoPixelFormat::YUV444_INTERLEAVED) {
            return decodedData[frameBase + pixel * 3 + channel];
        }
        if (layout.pixelFormat == VideoPixelFormat::YUV444P) {
            return decodedData[frameBase + static_cast<size_t>(channel) * lumaBytes + pixel];
        }
        if (channel == 0) return decodedData[frameBase + pixel];
        if (layout.pixelFormat == VideoPixelFormat::I400) return 128;

        const size_t chroma = (static_cast<size_t>(y) / 2) * (width / 2) +
            static_cast<size_t>(x) / 2;
        if (layout.pixelFormat == VideoPixelFormat::I420) {
            return decodedData[frameBase + lumaBytes + (channel - 1) * chromaBytes + chroma];
        }
        return decodedData[frameBase + lumaBytes + chroma * 2 + channel - 1];
    };

    for (int r = 0; r < regionCount; r++) {
        int frameIdx = packingInfo.regionFrameIndex[r];
        int regionX = packingInfo.regionTopLeftX[r];
        int regionY = packingInfo.regionTopLeftY[r];
        int regionW = packingInfo.regionWidth;
        int regionH = packingInfo.regionHeight;
        int attrType = packingInfo.attributeType[r];
        int channelOffset = packingInfo.attributeChannelOffset[r];
        int channelNum = packingInfo.attributeChannelNum[r];
        int byteshift = packingInfo.byteshift[r];

        const std::string& attrName = attributeNameKey(attrType);

        if (frameIdx < 0 || frameIdx >= frameCount || regionX < 0 || regionY < 0 ||
            regionW <= 0 || regionH <= 0 || channelNum <= 0 || channelNum > 3 ||
            regionX + regionW > static_cast<int>(layout.width) ||
            regionY + regionH > static_cast<int>(layout.height)) {
            std::cerr << "      Error: Video region is outside its explicit frame layout" << std::endl;
            return false;
        }

        // Determine the pixel count from blockIdx.
        int numPixels;
        if (blockIdx >= 0) {
            numPixels = std::min(regionW * regionH - blockIdx * chunkblocksize, chunkblocksize);
        } else {
            numPixels = regionW * regionH;
        }

        // Determine the attribute's total channel count.
        const int totalChannels = canonicalChannelCount(attrType, channelOffset, channelNum);

        if (numPixels <= 0 || totalChannels <= 0 || channelOffset < 0 ||
            channelOffset + channelNum > totalChannels) {
            return false;
        }
        const size_t requiredValues = static_cast<size_t>(numPixels) * totalChannels;

        auto attrIt = unpackedAttrs.find(attrName);
        if (attrIt == unpackedAttrs.end()) {
            attrIt = unpackedAttrs.emplace(attrName,
                std::vector<int32_t>(requiredValues, 0)).first;
        } else if (attrIt->second.size() < requiredValues) {
            attrIt->second.resize(requiredValues, 0);
        }

        int32_t* dstData = attrIt->second.data();

        if (packingInfo.packingScaningType == 1) {
            if (blockSize <= 0 || regionW % blockSize != 0 || regionH % blockSize != 0) return false;
            const int blocksPerRow = regionW / blockSize;
            const int pointsPerBlock = blockSize * blockSize;
            const int totalBlocks = blocksPerRow * (regionH / blockSize);
            const bool processAll = blockIdx < 0;
            const int startBlock = processAll ? 0 : blockIdx * (chunkblocksize / pointsPerBlock);
            const int endBlock = processAll ? totalBlocks :
                std::min(startBlock + chunkblocksize / pointsPerBlock, totalBlocks);
            const int shift = byteshift < 0 ? 0 : byteshift;
            for (int block = startBlock; block < endBlock; ++block) {
                const int blockY = block / blocksPerRow;
                const int blockX = block % blocksPerRow;
                for (int y = 0; y < blockSize; ++y) {
                    for (int x = 0; x < blockSize; ++x) {
                        const int destinationPixel = (block - startBlock) * pointsPerBlock + y * blockSize + x;
                        for (int channel = 0; channel < channelNum; ++channel) {
                            const int32_t value = static_cast<int32_t>(sampleChannel(
                                frameIdx, regionX + blockX * blockSize + x,
                                regionY + blockY * blockSize + y, channel));
                            dstData[destinationPixel * totalChannels + channelOffset + channel] += value << shift;
                        }
                    }
                }
            }
        } else {
            const bool processAll = blockIdx < 0;
            const int startPixel = processAll ? 0 : blockIdx * chunkblocksize;
            const int endPixel = processAll ? regionW * regionH :
                std::min(regionW * regionH, startPixel + chunkblocksize);
            const int shiftLimit = byteshift < 0 ? (1 << (-byteshift)) - 1 : 0;
            for (int pixel = startPixel; pixel < endPixel; ++pixel) {
                const int y = pixel / regionW;
                const int x = pixel % regionW;
                const int destinationPixel = pixel - startPixel;
                for (int channel = 0; channel < channelNum; ++channel) {
                    int32_t value = static_cast<int32_t>(sampleChannel(
                        frameIdx, regionX + x, regionY + y, channel));
                    value = byteshift >= 0 ? value << byteshift : std::min(value, shiftLimit);
                    dstData[destinationPixel * totalChannels + channelOffset + channel] += value;
                }
            }
        }
    }

    return true;
}

bool Unpacker::unpackEntropy(
    const std::vector<uint8_t>& decodedData,
    std::map<std::string, std::vector<int32_t>>& unpackedAttrs,
    const EntropyMeta& entropyMeta,
    int streamIndex,
    size_t startIdx,
    size_t endIdx) {

    // Read the entropy stream attribute type.
    int attrType = entropyMeta.attributeType;
    const std::string& attrName = attributeNameKey(attrType);
    int bitdepth = entropyMeta.bitdepth;
    int byteshift = entropyMeta.byteshift;

    // Determine the channel count.
    int numChannels = 1;
    if (attrName == "means") {
        numChannels = 3;
    } else if (attrName == "scaling") {
        numChannels = 3;
    } else if (attrName == "rotation") {
        numChannels = 4;
    } else if (attrName == "features_dc") {
        numChannels = 3;
    } else if (attrName == "features_rest") {
        numChannels = 45;  // 15 * 3
    } else if (attrName == "opacity") {
        numChannels = 1;
    } else if (attrName == "importance") {
        numChannels = 1;
    }

    // Calculate the starting and ending value indices.
    size_t startValueIdx = startIdx * numChannels;
    size_t endValueIdx = endIdx * numChannels;

    // Process only the requested range when one is specified.
    if (endIdx == 0) {
        endValueIdx = (bitdepth == 16) ? decodedData.size() / 2 : decodedData.size();
    }

    size_t numValuesToProcess = endValueIdx - startValueIdx;

    // Initialize the attribute buffer.
    auto attrIt = unpackedAttrs.find(attrName);
    if (attrIt == unpackedAttrs.end()) {
        attrIt = unpackedAttrs.emplace(attrName,
            std::vector<int32_t>(numValuesToProcess, 0)).first;
    } else if (attrIt->second.size() < numValuesToProcess) {
        attrIt->second.resize(numValuesToProcess, 0);
    }
    auto& destination = attrIt->second;

    // Process the requested range directly to avoid a temporary buffer.
    if (bitdepth == 16) {
        // 16-bit data: combine each pair of bytes as a big-endian value.
        for (size_t i = 0; i < numValuesToProcess; i++) {
            size_t srcIdx = (startValueIdx + i) * 2;
            if (srcIdx + 1 < decodedData.size()) {
                int32_t value = static_cast<int32_t>(decodedData[srcIdx] << 8) |
                               (static_cast<int32_t>(decodedData[srcIdx + 1]));

                if (byteshift >= 0) {
                    value <<= byteshift;
                } else {
                    int limit = (1 << (-byteshift)) - 1;
                    value = std::min(value, limit);
                }

                destination[i] += value;
            }
        }
    }
    else if (bitdepth == 8) {
        // 8-bit data: use each byte directly.
        for (size_t i = 0; i < numValuesToProcess; i++) {
            size_t srcIdx = startValueIdx + i;
            if (srcIdx < decodedData.size()) {
                int32_t value = static_cast<int32_t>(decodedData[srcIdx]);

                if (byteshift >= 0) {
                    value <<= byteshift;
                } else {
                    int limit = (1 << (-byteshift)) - 1;
                    value = std::min(value, limit);
                }

                destination[i] += value;
            }
        }
    }
    else {
        std::cerr << "      Error: Unsupported bitdepth " << bitdepth << std::endl;
        return false;
    }

    return true;
}
