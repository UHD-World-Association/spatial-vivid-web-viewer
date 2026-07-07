#ifndef STREAM_H
#define STREAM_H

#include <vector>
#include <cstdint>
#include <cstring>
#include <string>
#include <memory>
#include <stdexcept>
#include <map>

// ==================== Metadata structures ====================

/**
 * Basic information.
 * Supports fast parsing and contains only the point count and position range.
 */
struct BasicInformation {
    uint32_t gsPointsNum;           // Point-cloud point count.
    int shDegree;                   // Spherical harmonics degree.
    float positionMinValue[3];      // Minimum position [x, y, z].
    float positionMaxValue[3];      // Maximum position [x, y, z].

    BasicInformation() : gsPointsNum(0), shDegree(0) {
        for (int i = 0; i < 3; i++) {
            positionMinValue[i] = 0.0f;
            positionMaxValue[i] = 1.0f;
        }
    }
};

/**
 * Prediction metadata.
 */
struct PredictionMeta {
    int predictionType;  // 0: None, 1: Minor, 2: MinorBlock
    int byteshift;
    int blocksize;       // Block size.

    PredictionMeta() : predictionType(0), byteshift(0), blocksize(16) {}
};

/**
 * Quantization metadata.
 */
struct QuantMeta {
    int quantType;  // 0: None, 1: Quantizer, 2: MinmaxQuantizer, 3: GroupMinmaxQuantizer
    int bitDepth;   // Quantization bit depth.
    std::vector<float> minVals;  // Minimum values.
    std::vector<float> maxVals;  // Maximum values.
    std::vector<int32_t> groupSize;  // Group sizes used by GroupMinmaxQuantizer.

    QuantMeta() : quantType(0), bitDepth(0) {}
};

/**
 * Transform metadata.
 */
struct TransformMeta {
    int globalTransformType;  // 0: None, 1: rsnorm, 2: rsnormimp
    std::map<std::string, int> transformMap;  // Attribute name -> transform type (0=None, 1=reduction, 2=imp).

    TransformMeta() : globalTransformType(0) {}
};

// ==================== Utility functions ====================

/**
 * Map an attribute type to its attribute name.
 */
inline std::string attributeTypeToName(int attrType) {
    switch (attrType) {
        case 0: return "means";
        case 1: return "opacity";
        case 2: return "scaling";
        case 3: return "rotation";
        case 4: return "features_dc";
        case 20: return "features_rest";
        case 21: return "importance";
        default:
            if (attrType >= 5 && attrType <= 19) {
                return "features_rest";  // SH coefficients
            }
            return "unknown";
    }
}

// Error-handling macros.
#define STREAM_ERROR(msg) do { \
    fprintf(stderr, "Stream Error: %s (File: %s, Line: %d)\n", msg, __FILE__, __LINE__); \
    return false; \
} while(0)

#define STREAM_ERROR_VAL(msg, val) do { \
    fprintf(stderr, "Stream Error: %s (Value: %d, File: %s, Line: %d)\n", msg, val, __FILE__, __LINE__); \
    return false; \
} while(0)

/**
 * Bitstream writer.
 * Bitstream writer with bulk-write support.
 */
class BitStreamWriter {
public:
    BitStreamWriter();
    ~BitStreamWriter();

    // Write a value using the specified number of bits.
    bool writeBits(uint32_t value, int numBits);

    // Align to a byte boundary by padding with zero bits.
    bool byteAlign();

    // Write one 8-bit unsigned integer.
    bool writeUint8(uint8_t value);

    // Write byte data.
    bool writeBytes(const uint8_t* data, size_t length);
    bool writeBytes(const std::vector<uint8_t>& data);

    // Write a 16-bit unsigned integer in big-endian order.
    bool writeUint16(uint16_t value);

    // Write a 32-bit unsigned integer in big-endian order.
    bool writeUint32(uint32_t value);

    // Write a 32-bit IEEE 754 floating-point value.
    bool writeFloat32(float value);

    // Write a one-bit Boolean value.
    bool writeBool(bool value);

    // Write a string.
    bool writeString(const std::string& s);

    // Return all written data as bytes.
    std::vector<uint8_t> getBytes();

    // Return the current bit count.
    size_t getBitCount() const { return bitCount; }

    // Clear the buffer.
    void clear();

private:
    std::vector<uint8_t> stream;
    uint8_t currentByte;
    int bitPosition;  // Bit position within the current byte (0-7).
    size_t bitCount;

    // Write the current byte to the stream and reset state.
    bool flushCurrentByte();
};

/**
 * Bitstream reader.
 */
class BitStreamReader {
public:
    BitStreamReader();
    ~BitStreamReader();

    // Set the data source.
    void setData(const uint8_t* data, size_t length);
    void setData(const std::vector<uint8_t>& data);

    // Read the specified number of bits.
    bool readBits(uint32_t& result, int numBits);

    // Align to a byte boundary by skipping the remaining bits in the current byte.
    bool byteAlign();

    // Read an 8-bit unsigned integer.
    bool readUint8(uint8_t& value);

    // Read a 16-bit unsigned integer.
    bool readUint16(uint16_t& value);

    // Read a 32-bit unsigned integer.
    bool readUint32(uint32_t& value);

    // Read a 32-bit unsigned integer in little-endian order.
    bool readUint32LE(uint32_t& value);

    // Read a 32-bit IEEE 754 floating-point value.
    bool readFloat32(float& value);

    // Read a 32-bit floating-point value in little-endian order.
    bool readFloat32LE(float& value);

    // Read the specified number of bytes.
    bool readBytes(std::vector<uint8_t>& result, size_t length);

    // Read a string of the specified length.
    bool readString(std::string& result, size_t length);

    // Return the number of remaining bits.
    size_t getRemainingBits() const;

    // Return the current bit position.
    size_t getCurrentBitPosition() const;

    // Skip the specified number of bits.
    bool skipBits(int numBits);

    // Preview bits without advancing the read position.
    bool peekBits(uint32_t& result, int numBits);

    // Return the current byte index.
    size_t getCurrentByteIndex() const { return currentByteIndex; }

private:
    const uint8_t* data;
    size_t dataLength;
    size_t currentByteIndex;
    int currentBitPos;  // Bit position within the current byte (0-7).

    // Ensure enough data remains to read.
    bool ensureDataAvailable(int numBits);
};

/**
 * Reconstruction information.
 */
class ReconstructionInformation {
public:
    ReconstructionInformation();
    ~ReconstructionInformation();

    // Initialize arrays.
    bool initialize();

    // Write values.
    bool write(BitStreamWriter& writer);

    // Read values.
    bool read(BitStreamReader& reader);

    // Member variables.
    uint8_t attributeType;
    uint8_t component;
    uint8_t quantizationType;
    uint8_t quantizationBitdepth;
    uint8_t predictionType;
    uint8_t byteshift;
    uint32_t blocksize;
    uint8_t transformationType;

    std::vector<float> quantizationMinValue;
    std::vector<float> quantizationMaxValue;

    uint32_t patchNum;
    std::vector<int32_t> patchSize;
    std::vector<float> patchQuantizationMinValue;
    std::vector<float> patchQuantizationMaxValue;
};

/**
 * Texture decode information.
 */
class TextureDecodeInformation {
public:
    TextureDecodeInformation();
    ~TextureDecodeInformation();

    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    uint8_t entropyDecodeType;
    uint8_t packingMapTextureCodecId;
};

/**
 * Texture packing information.
 */
class TexturePackingInformation {
public:
    TexturePackingInformation();
    ~TexturePackingInformation();

    bool initialize();
    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    uint16_t packingMapWidth;
    uint16_t packingMapHeight;
    uint16_t regionWidth;
    uint16_t regionHeight;
    uint8_t packingScaningType;
    uint8_t packingScaningBlockSize;
    uint8_t packingRegionCountMinus1;

    std::vector<int16_t> regionTopLeftX;
    std::vector<int16_t> regionTopLeftY;

    uint8_t textureChannelNum;
    uint8_t byteshift;
};

/**
 * Video packing information.
 */
class VideoPackingInformation {
public:
    VideoPackingInformation();
    ~VideoPackingInformation();

    bool initialize();
    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    uint16_t packingMapWidth;
    uint16_t packingMapHeight;
    uint16_t regionWidth;
    uint16_t regionHeight;
    uint16_t packingMapFrameNumMinus1;
    uint8_t packingScaningType;
    uint8_t packingScaningBlockSize;
    uint8_t packingRegionCountMinus1;

    std::vector<int8_t> regionFrameIndex;
    std::vector<int16_t> regionTopLeftX;
    std::vector<int16_t> regionTopLeftY;
    std::vector<int8_t> attributeType;
    std::vector<int8_t> attributeChannelOffset;
    std::vector<int8_t> attributeChannelNum;
    std::vector<int8_t> byteshift;
};

/**
 * Video decode information.
 */
class VideoDecodeInformation {
public:
    VideoDecodeInformation();
    ~VideoDecodeInformation();

    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    uint8_t packingMapVideoCodecId;
};

/**
 * Entropy metadata.
 */
class EntropyMeta {
public:
    EntropyMeta();
    ~EntropyMeta();

    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    uint8_t entropyDecodeType;
    uint8_t attributeType;
    uint8_t bitdepth;
    uint8_t byteshift;
};

/**
 * Texture metadata.
 */
class TextureMeta {
public:
    TextureMeta();
    ~TextureMeta();

    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    TextureDecodeInformation textureDecodeInformation;
    TexturePackingInformation texturePackingInformation;
    uint8_t attributeType;
};

/**
 * Video metadata.
 */
class VideoMeta {
public:
    VideoMeta();
    ~VideoMeta();

    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    VideoDecodeInformation videoDecodeInformation;
    VideoPackingInformation videoPackingInformation;
};

// Metadata type enumeration.
enum class SubBitstreamMetaType {
    ENTROPY,
    TEXTURE,
    VIDEO
};

/**
 * GSB metadata.
 */
class GsbsMetadata {
public:
    GsbsMetadata();
    ~GsbsMetadata();

    bool initialize();
    bool initialize2(uint32_t gsPointsNum, int subBitstreamNum, int shDegree, int gsSubsetNum);

    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    // Parse basic information quickly.
    bool readBasicInfo(BitStreamReader& reader, BasicInformation& basicInfo);

    // Member variables.
    uint8_t profileIdc;
    uint32_t gsPointsNum;
    int subBitstreamNum;
    int shDegree;
    int gsSubsetNum;

    std::vector<float> positionMinValue;
    std::vector<float> positionMaxValue;

    std::vector<uint32_t> subGsPointsNum;
    std::vector<uint32_t> subBitstreamSize;
    std::vector<uint8_t> gsSubsetId;
    std::vector<uint8_t> subBitstreamDecodeType;

    // Store heterogeneous metadata through union or base-class pointers.
    std::vector<std::shared_ptr<void>> subBitstreamMeta;
    std::vector<SubBitstreamMetaType> subBitstreamMetaType;

    std::vector<uint8_t> reconstructionCount;
    std::vector<std::vector<ReconstructionInformation>> reconstructionInformation;

    // ==================== Metadata extraction interface ====================

    /**
     * Return prediction metadata.
     * @return pair<{attrName: PredictionMeta}, blocksizeLCM>
     */
    std::pair<std::map<std::string, PredictionMeta>, int> getPredictionMeta() const;

    /**
     * Return quantization metadata.
     * @return {attrName: QuantMeta}
     */
    std::map<std::string, QuantMeta> getQuantMeta() const;

    /**
     * Return transform metadata.
     * @return TransformMeta
     */
    TransformMeta getTransformMeta() const;

    /**
     * Return texture metadata.
     * @param streamIndex Substream index.
     * @return TextureMeta pointer, or nullptr when absent.
     */
    std::shared_ptr<TextureMeta> getTextureMeta(int streamIndex) const;
};

/**
 * Substream.
 */
class GsbsSubBitstreams {
public:
    GsbsSubBitstreams();
    ~GsbsSubBitstreams();

    bool initialize(int subBitstreamNum);

    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    std::vector<std::vector<uint8_t>> gstcSubBitstreamData;
    int subBitstreamNum;
    std::vector<uint32_t> subBitstreamSize;
};

/**
 * Unit header.
 */
class UnitHeader {
public:
    UnitHeader(uint8_t unitType = 0);
    ~UnitHeader();

    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    uint8_t unitType;
    uint32_t reserved;
};

/**
 * Unit payload.
 */
class UnitPayload {
public:
    UnitPayload(uint8_t unitType = 0);
    ~UnitPayload();

    bool write(BitStreamWriter& writer);
    bool read(BitStreamReader& reader);

    uint8_t unitType;
    std::shared_ptr<GsbsMetadata> gsbsMetadata;
    std::shared_ptr<GsbsSubBitstreams> gsbsSubBitstreams;
};

/**
 * Unit.
 */
class Unit {
public:
    Unit(uint8_t unitType = 0);
    ~Unit();

    bool write();
    bool read();

    // Parse basic information quickly.
    bool readBasicInfo(BasicInformation& basicInfo);

    UnitHeader unitHeader;
    UnitPayload unitPayload;
    BitStreamWriter writer;
    BitStreamReader reader;
};

/**
 * Retrieve basic information quickly.
 * @param filePath Input file path.
 * @param basicInfo Parsed basic information.
 * @return Whether the operation succeeded.
 */
inline bool getBasicInfo(const std::string& filePath, BasicInformation& basicInfo) {
    // Read the file.
    FILE* file = fopen(filePath.c_str(), "rb");
    if (!file) {
        fprintf(stderr, "Error: Cannot open file %s\n", filePath.c_str());
        return false;
    }

    // Get the file size.
    fseek(file, 0, SEEK_END);
    long fileSize = ftell(file);
    fseek(file, 0, SEEK_SET);

    // Read the file contents.
    std::vector<uint8_t> data(fileSize);
    size_t readSize = fread(data.data(), 1, fileSize, file);
    fclose(file);

    if (readSize != static_cast<size_t>(fileSize)) {
        fprintf(stderr, "Error: Failed to read file\n");
        return false;
    }

    // Read meta_byte_size in big-endian order.
    if (data.size() < 4) {
        fprintf(stderr, "Error: File too small\n");
        return false;
    }

    const uint8_t* data_ptr = reinterpret_cast<const uint8_t*>(data.data());
    uint32_t metaByteSize = (static_cast<uint32_t>(data_ptr[0]) << 24) |
                            (static_cast<uint32_t>(data_ptr[1]) << 16) |
                            (static_cast<uint32_t>(data_ptr[2]) << 8)  |
                            (static_cast<uint32_t>(data_ptr[3]));

    // Create a Unit and parse the basic information.
    Unit unit(0);  // unit_type = 0 (metadata)
    unit.reader.setData(data.data() + 4, data.size() - 4);

    if (!unit.readBasicInfo(basicInfo)) {
        fprintf(stderr, "Error: Failed to read basic info\n");
        return false;
    }

    return true;
}

/**
 * Parse the GSB bitstream.
 * @param stream Bitstream data.
 * @param metadataUnit Output metadata unit.
 * @param substreamUnit Output substream unit.
 * @return Whether the operation succeeded.
 */
bool parseGsbsStream(
    const std::vector<uint8_t>& stream,
    Unit& metadataUnit,
    Unit& substreamUnit
);

#endif // STREAM_H
