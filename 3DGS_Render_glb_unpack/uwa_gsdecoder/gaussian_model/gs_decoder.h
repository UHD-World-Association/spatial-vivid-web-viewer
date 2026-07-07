#ifndef GS_DECODER_H
#define GS_DECODER_H

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>
#include <map>
#include <memory>
#include "../processor/stream.h"
#include "../processor/codec_decoder.h"
#include "../processor/unpacker.h"
#include "gs_data.h"
#include "reconstruction_kernel.h"

/**
 * Timing statistics structure.
 */
struct TimingStats {
    double readFileMs = 0;
    double parseStreamMs = 0;
    double decodeNonVideoSubstreamsMs = 0;
    double astcTextureDecodeMs = 0;
    double bcTextureEncodeMs = 0;
    uint64_t textureInputBytes = 0;
    uint64_t textureOutputBytes = 0;
    uint32_t rawVideoStreamCount = 0;
    uint64_t rawVideoInputBytes = 0;
    double rawVideoAdoptMs = 0;
    double decodeVideoFallbackMs = 0;
    std::string ffmpegDiagnosticsJson = "[]";
    double decodeSubstreamsMs = 0;
    double unpackMs = 0;
    double predictionMs = 0;
    double dequantizeMs = 0;
    double transformMs = 0;
    double nonlinearMs = 0;
    double outputCopyMs = 0;
    double packShardMs = 0;
    double pruneMs = 0;
    double totalMs = 0;

    // Detailed substream decode timing.
    std::map<std::string, double> substreamTimings;  // Attribute name -> decode time.

    void print() const;
};

// Return the global timing statistics.
TimingStats& getTimingStats();

// Attribute type enumeration.
enum class AttributeType {
    POSITION = 0,
    OPACITY = 1,
    SCALE = 2,
    ROTATION = 3,
    SH_DEG0_COEF0 = 4,  // features_dc
    SH_DEG1_COEF0 = 5,
    SH_DEG1_COEF1 = 6,
    SH_DEG1_COEF2 = 7,
    SH_DEG2_COEF0 = 8,
    SH_DEG2_COEF1 = 9,
    SH_DEG2_COEF2 = 10,
    SH_DEG2_COEF3 = 11,
    SH_DEG2_COEF4 = 12,
    SH_DEG3_COEF0 = 13,
    SH_DEG3_COEF1 = 14,
    SH_DEG3_COEF2 = 15,
    SH_DEG3_COEF3 = 16,
    SH_DEG3_COEF4 = 17,
    SH_DEG3_COEF5 = 18,
    SH_DEG3_COEF6 = 19,
    SH_DEG1_AND_HIGHER = 20,  // features_rest
    IMPORTANCE = 21
};

enum class TextureOutputMode : uint32_t {
    ASTC = 0,
    CPU = 1,
    BC7 = 2,
    BC3 = 3
};
static_assert(static_cast<uint32_t>(TextureOutputMode::ASTC) == 0 &&
              static_cast<uint32_t>(TextureOutputMode::CPU) == 1,
              "ASTC/CPU texture modes must remain compatible with the legacy WASM boolean ABI");

struct DecodeDescriptor {
    uint32_t protocolVersion = uwa::kShardProtocolVersion;
    uint32_t buildVersion = uwa::kShardBuildVersion;
    uint32_t pointCount = 0;
    uint32_t shDegree = 0;
    uint32_t blockSide = 0;
    uint32_t pointsPerBlock = 0;
    uint32_t blockCount = 0;
    TextureOutputMode textureOutputMode = TextureOutputMode::CPU;
    bool decodeFeaturesRest = false;
};

struct PendingVideoStreamDescriptor {
    uint32_t streamIndex = 0;
    uint32_t codecId = 0;
    uint32_t frameWidth = 0;
    uint32_t frameHeight = 0;
    uint32_t frameCount = 0;
};

/**
 * Gaussian Splatting decoder.
 * Coordinates the decoder and processing modules.
 */
class GSDecoder {
public:
    GSDecoder();
    ~GSDecoder();

    /**
     * Main file-based decode entry point.
     * @param binFile Input binary file path.
     * @param gsData Gaussian Splatting output data.
     * @return Whether the operation succeeded.
     */
    bool decode(const std::string& binFile, SplatData& gsData);

    /**
     * Decode from an in-memory binary buffer.
     * @param buffer Input binary-data buffer.
     * @param bufferSize Buffer size.
     * @param gsData Gaussian Splatting output data.
     * @return Whether the operation succeeded.
     */
    bool decodeFromMemory(const uint8_t* buffer, size_t bufferSize, SplatData& gsData,
                          TextureOutputMode textureOutputMode = TextureOutputMode::CPU);

    /**
     * Parse metadata and decode every compressed substream exactly once. This
     * stage intentionally does not allocate full-model reconstructed arrays.
     */
    bool prepareFromMemory(const uint8_t* buffer, size_t bufferSize,
                           TextureOutputMode textureOutputMode = TextureOutputMode::CPU);

    /**
     * Parse and validate a stream, adopt codec0 VIDEO payloads into owned raw
     * storage, then decode every non-video substream. Encoded VIDEO payloads
     * remain available for external decoding or the native fallback until
     * finishPreparedDecode() succeeds.
     */
    bool beginPrepareFromMemory(const uint8_t* buffer, size_t bufferSize,
                                TextureOutputMode textureOutputMode = TextureOutputMode::CPU);

    const std::vector<PendingVideoStreamDescriptor>& getPendingVideoStreams() const {
        return pendingVideoStreams_;
    }
    const std::vector<uint8_t>* getPendingVideoEncodedData(uint32_t streamIndex) const;
    const std::vector<uint8_t>* getDecodedVideoData(uint32_t streamIndex) const;
    const VideoFrameLayout* getDecodedVideoLayout(uint32_t streamIndex) const;

    bool injectDecodedVideo(uint32_t streamIndex,
                            const uint8_t* decoded,
                            size_t decodedSize,
                            VideoPixelFormat pixelFormat);
    bool decodePendingVideosWithFallback();
    bool finishPreparedDecode();

    const DecodeDescriptor& getDecodeDescriptor() const { return descriptor_; }
    const std::vector<uint8_t>& getReconstructionMetadataPacket() const { return reconstructionMetadataPacket_; }
    const SplatData& getPreparedAuxiliaryData() const { return preparedAuxiliaryData_; }
    const std::string& getLastError() const { return lastError_; }

    /**
     * Unpack complete reconstruction superblocks into a standalone binary
     * packet suitable for transfer to an ordinary Web Worker.
     */
    bool packShard(uint32_t startBlock, uint32_t blockCount, std::vector<uint8_t>& packet);

    void releasePreparedDecode();

    /**
     * Save as a PLY file.
     * @param plyFile Output PLY file path.
     * @param gsData Gaussian Splatting output data.
     * @return Whether the operation succeeded.
     */
    bool savePLY(const std::string& plyFile, const SplatData& gsData);

private:
    // Bitstream units.
    Unit metadataUnit;
    Unit substreamUnit;

    // Decoders.
    std::map<std::string, std::unique_ptr<CodecDecoder>> decoders;

    // Attribute processor.
    Unpacker unpacker;
    // Decoded attribute data.
    std::map<std::string, std::vector<uint8_t>> decodedStreams;
    std::map<std::string, VideoFrameLayout> decodedVideoLayouts_;
    DecodeDescriptor descriptor_;
    uwa::ReconstructionMetadata reconstructionMetadata_;
    std::vector<uint8_t> reconstructionMetadataPacket_;
    SplatData preparedAuxiliaryData_;
    std::vector<PendingVideoStreamDescriptor> pendingVideoStreams_;
    std::chrono::high_resolution_clock::time_point prepareStartedAt_;
    bool preparing_ = false;
    bool prepared_ = false;
    std::string lastError_;

    /**
     * Read the file.
     */
    bool readFile(const std::string& filename, std::vector<uint8_t>& data);

    /**
     * Decode the substreams.
     */
    bool decodeNonVideoSubstreams(SplatData& gsData, TextureOutputMode textureOutputMode);
    bool decodeVideoSubstreamWithFallback(const PendingVideoStreamDescriptor& pending);
    bool validateDecodedSubstream(int streamIndex, const std::vector<uint8_t>& decoded);

    /**
     * GPU path: retain the features_rest ASTC texture and per-point UVs to avoid CPU expansion of higher-order spherical harmonics.
     */
    bool captureAstcFeatureRestStream(const std::vector<uint8_t>& encoded,
                                      const TextureMeta& textureMeta,
                                      const QuantMeta& quantMeta,
                                      SplatData& gsData);
    bool transcodeAstcFeatureRestStream(const std::vector<uint8_t>& encoded,
                                        const TextureMeta& textureMeta,
                                        const QuantMeta& quantMeta,
                                        TextureOutputMode textureOutputMode,
                                        SplatData& gsData);

    /**
     * Prune invalid Gaussian points.
     * @param gsData Gaussian Splatting output data.
     * @return Whether the operation succeeded.
     */
    bool pruneInvalidGaussians(SplatData& gsData);

    /**
     * Configure the decoders.
     */
    bool setupDecoders();

    /**
     * Internal decode flow.
     */
    bool validatePreparedMetadata();
    bool buildReconstructionMetadata();
    void setError(const std::string& error);
};

#endif // GS_DECODER_H
