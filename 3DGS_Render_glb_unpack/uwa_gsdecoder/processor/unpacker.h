#ifndef UNPACKER_H
#define UNPACKER_H

#include <vector>
#include <cstdint>
#include <string>
#include <map>
#include <mutex>
#include <limits>
#include "stream.h"
#include "platform_video_decoder.h"

/**
 * Attribute unpacker.
 * Unpacks packed attribute data into independent attribute tensors.
 */
class Unpacker {
public:
    Unpacker();
    ~Unpacker();

    /**
     * Unpack a texture stream.
     * @param decodedData Decoded data.
     * @param unpackedAttrs Unpacked attributes keyed by attribute name.
     * @param textureMeta Texture metadata.
     * @param streamIndex Substream index.
     * @param blockIdx Block index; -1 processes all blocks.
     * @return Whether the operation succeeded.
     */
    bool unpackTexture(
        const std::vector<uint8_t>& decodedData,
        std::map<std::string, std::vector<int32_t>>& unpackedAttrs,
        const TextureMeta& textureMeta,
        int streamIndex,
        int blockIdx = -1,
        int chunkblocksize = 256
    );

    /**
     * Unpack a video stream.
     * @param decodedData Decoded data.
     * @param unpackedAttrs Unpacked attributes keyed by attribute name.
     * @param videoMeta Video metadata.
     * @param streamIndex Substream index.
     * @param blockIdx Block index; -1 processes all blocks.
     * @return Whether the operation succeeded.
     */
    bool unpackVideo(
        const std::vector<uint8_t>& decodedData,
        std::map<std::string, std::vector<int32_t>>& unpackedAttrs,
        const VideoMeta& videoMeta,
        const VideoFrameLayout& layout,
        int streamIndex,
        int blockIdx = -1,
        int chunkblocksize = 256
    );

    /**
     * Unpack an entropy stream.
     * @param decodedData Decoded data.
     * @param unpackedAttrs Unpacked attributes keyed by attribute name.
     * @param entropyMeta Entropy metadata.
     * @param streamIndex Substream index.
     * @param startIdx Starting point index.
     * @param endIdx Ending point index.
     * @return Whether the operation succeeded.
     */
    bool unpackEntropy(
        const std::vector<uint8_t>& decodedData,
        std::map<std::string, std::vector<int32_t>>& unpackedAttrs,
        const EntropyMeta& entropyMeta,
        int streamIndex,
        size_t startIdx = 0,
        size_t endIdx = 0
    );

    /**
     * Map an attribute type to its attribute name.
     */
    std::string attributeTypeToName(int attrType);

    /**
     * Extract data in block scan order.
     * @param srcData Source data.
     * @param dstData Destination int32_t buffer; output begins at position 0.
     * @param regionX,regionY Region starting coordinates.
     * @param regionW,regionH Region dimensions.
     * @param mapWidth Packing-map width.
     * @param channelNum Channel count.
     * @param blockSize Block size.
     * @param totalChannels Total destination-buffer channel count.
     * @param channelOffset Destination-buffer channel offset.
     * @param srcChannelNum Source-data channel count.
     * @param byteshift Bit-shift amount.
     * @param blockIdx Block index; -1 processes all blocks.
     */
    void extractBlockScan(
        const std::vector<uint8_t>& srcData,
        int32_t* dstData,
        int regionX, int regionY, int regionW, int regionH,
        int mapWidth, int channelNum, int blockSize,
        int totalChannels, int channelOffset, int srcChannelNum,
        int byteshift,
        int blockIdx = -1,
        int chunkblocksize = 256
    );

    /**
     * Extract data in row-first scan order.
     * @param srcData Source data.
     * @param dstData Destination int32_t buffer; output begins at position 0.
     * @param regionX,regionY Region starting coordinates.
     * @param regionW,regionH Region dimensions.
     * @param mapWidth Packing-map width.
     * @param channelNum Channel count.
     * @param totalChannels Total destination-buffer channel count.
     * @param channelOffset Destination-buffer channel offset.
     * @param srcChannelNum Source-data channel count.
     * @param byteshift Bit-shift amount.
     * @param rowIdx Row index; -1 processes all rows.
     */
    void extractRowFirstScan(
        const std::vector<uint8_t>& srcData,
        int32_t* dstData,
        int regionX, int regionY, int regionW, int regionH,
        int mapWidth, int channelNum,
        int totalChannels, int channelOffset, int srcChannelNum,
        int byteshift,
        int rowIdx = -1,
        int chunkblocksize = 256
    );

    // Drop all prepared layout plans.  Plans are scoped to a decoder prepare
    // lifecycle and must not be reused for another model.
    void clearPlans();

private:
    struct TextureRegionPlan {
        int channelOffset = 0;
        std::vector<uint32_t> sourceOffsets;
        std::vector<uint32_t> blockOrigins;
        std::vector<uint32_t> blockPattern;
    };

    struct TexturePlan {
        int regionWidth = 0;
        int regionHeight = 0;
        int blockSize = 0;
        int mapWidth = 0;
        int channelNum = 0;
        int scanType = 0;
        std::vector<TextureRegionPlan> regions;
    };

    // Cache keys are copied from metadata so plans remain isolated from any
    // subsequent model or metadata mutation.
    struct TexturePlanKey {
        int regionCount = 0;
        int regionWidth = 0;
        int regionHeight = 0;
        int blockSize = 0;
        int mapWidth = 0;
        int channelNum = 0;
        int scanType = 0;
        std::vector<int16_t> regionX;
        std::vector<int16_t> regionY;
        bool operator==(const TexturePlanKey& other) const {
            return regionCount == other.regionCount && regionWidth == other.regionWidth && regionHeight == other.regionHeight &&
                   blockSize == other.blockSize && mapWidth == other.mapWidth &&
                   channelNum == other.channelNum && scanType == other.scanType &&
                   regionX == other.regionX && regionY == other.regionY;
        }
    };

    bool buildTexturePlan(const TextureMeta& textureMeta, TexturePlanKey& key, TexturePlan& plan) const;

    mutable std::mutex planMutex_;
    bool hasTexturePlan_ = false;
    TexturePlanKey texturePlanKey_;
    TexturePlan texturePlan_;
};

#endif // UNPACKER_H
