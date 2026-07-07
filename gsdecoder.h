/*
 * MIT License
 *
 * Copyright (c) UWA
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
#ifndef _GSDECODER_HPP
#define _GSDECODER_HPP
#define UWA_MAGIG_NUMBER "gsct"

#include <string>
#include <vector>
#include <cstdint>

namespace gsdecoder {

struct AstcHeader {
    uint8_t magic[4];  // Magic number should be { 0x5CA1AB13 }
    uint8_t blockdimX;
    uint8_t blockdimY;
    uint8_t blockdimZ;
    uint8_t xsize[3u];
    uint8_t ysize[3u];
    uint8_t zsize[3u];
};
struct AstcMeta {
    uint32_t astcBlockSize;
    uint32_t astcWidth;
    uint32_t astcHeight;
    uint32_t singleWidth;
    uint32_t numPoints;
    uint32_t streamSize;
};

struct ShnAstcMeta {
    std::vector<AstcMeta> astcMetas;
    uint32_t textureNum;
    float shnMin;
    float shnMax;
};

struct ChunkData {
    float min_x;
    float min_y;
    float min_z;
    float max_x;
    float max_y;
    float max_z;
    float min_scale_x;
    float min_scale_y;
    float min_scale_z;
    float max_scale_x;
    float max_scale_y;
    float max_scale_z;
};

struct PackedData {
    uint32_t packed_position;
    uint32_t packed_rotation;
    uint32_t packed_scale;
    uint32_t packed_color;
};

struct PlyProperty {
    std::string type;
    std::string name;
};

struct UWAGSPatchMeta {
    size_t patchIndex = 0;
    size_t patchSize = 0;
    uint8_t patchQuantBits = 0;
    std::vector<float> patchQuantMinValue;
    std::vector<float> patchQuantMaxValue;
};

struct UWAGSAttributeMeta {
    size_t attributeType = 0;
    uint8_t componentsCount = 0;
    uint8_t uncompressedDataType = 0;
    uint8_t attributeQuantizationFlag = 0;
    uint8_t attributeEncoderScheme = 0;
    uint8_t quantizationBits = 0;
    std::vector<float> quantMinValue;
    std::vector<float> quantMaxValue;
    uint8_t attributeIndexType = 0;
    size_t attributeCodebookLength = 0;
    size_t byteOffset = 0;
    size_t byteLength = 0;
    size_t uncompressedByteLength = 0;
    size_t patchNum = 0;
    uint8_t patchGlobalEnableIndexFlag = 0;
    uint8_t patchGlobalEnableSizeFlag = 0;
    uint8_t patchGlobalEnableQuantBitFlag = 0;
    uint8_t patchGlobalEnableQuantMinMaxFlag = 0;
    uint8_t patchGlobalEnable2DmapingFlag = 0;
    size_t lastPatchSize = 0;
    // 2D
    uint8_t attribute2DmimeType = 0;
    uint16_t attribute2DSingleWidth = 0;
    uint16_t attribute2DSingleHeight = 0;
    uint8_t attribute2DSingleAlign = 0;
    uint8_t attribute2DConcat = 0;
    uint8_t attribute2DConcatMaxInWidth = 0;
    uint8_t attribute2DConcatMaxInHeight = 0;
    uint8_t attribute2DTexNum = 0;
    std::vector<size_t> attribute2DTexSizes;

    std::vector<UWAGSPatchMeta> patchMetas;
};

#pragma pack(push, 1)
struct UWAGSMetas {
    uint8_t magicBytes[4];
    uint8_t version[3];
    uint32_t totalByteLength = 0;
    uint8_t superCompressionScheme = 0;
    uint32_t reserved;
    uint32_t numPoints = 0;
    uint8_t numAttribute = 0;
};
#pragma pack(pop)

struct UWAGSHeader {
    UWAGSMetas uwaMetas{};
    std::vector<UWAGSAttributeMeta> attributeMetas;
};

struct GsVertexData {
    std::vector<float> position;
    std::vector<float> scaling;
    std::vector<float> rotation;
    std::vector<float> opacity;
    std::vector<float> color;
    std::vector<float> shn;
    std::vector<uint32_t> astcUV;
};

struct GSData {
    GsVertexData gsVertex;
    int sh_degree = 0;
    UWAGSHeader uwa_header;
    std::vector<uint8_t> attribute_datas;  // compressed data stream!
    std::vector<uint8_t> astcRawStream;
    ShnAstcMeta shnAstcMeta;
};

struct GSBasicInfo {
    float minPosition[3];
    float maxPosition[3];
    size_t numGS;
    size_t sh_degree;
};

int decompress_zlib(const unsigned char *compressed_data, size_t compressed_size, unsigned char *decompressed_data,
                    size_t decompressed_size);

void assignValues(float *arr, float v0, float v1, float v2, float v3);

float parse_float(const uint8_t *data_stream, size_t &pointer);

// Parse a single patch
UWAGSPatchMeta parseUWAGSPatch(const uint8_t *data_stream, size_t size, size_t &pointer,
                               const UWAGSAttributeMeta &attribute_info);

// Parse an attribute meta
UWAGSAttributeMeta parseUWAGSAttributeMeta(const uint8_t *data_stream, size_t size, size_t &pointer);

// Helper function to map data type sizes
size_t get_data_type_size(uint8_t data_type);

bool decode_attribute(std::vector<uint8_t> &attribute_stream, const UWAGSAttributeMeta &attribute_info,
                      std::vector<float> &decoded_data, GSData &gsData, size_t idx, size_t numGS,
                      std::vector<uint8_t> &images);

bool parseGSCompressedUWA(const uint8_t *data_stream, size_t size, GSData &gsData, bool astcCpuDecode);

bool isGSCompressed(const uint8_t *data_stream, size_t size);
bool isGSCompressed(std::string path);
// judge if the model is compressed

bool parseBasicInfo(const uint8_t *fileData, size_t size, GSBasicInfo &info);
bool parseBasicInfoV1(const uint8_t *fileData, size_t size, GSBasicInfo &info);
bool parseBasicInfo(std::string path, GSBasicInfo &info);
// get the basic information without decoding the whole model
// the information is saved in GSBasicInfo struct.

bool parseGSCompressed(const uint8_t *fileData, size_t size, GSData &gsData, bool astcCpuDecode);
bool parseGSCompressed(std::string path, GSData &gsData, bool astcCpuDecode);
bool decodeASTC(std::vector<uint8_t> &data, size_t offset, size_t size, std::vector<uint8_t> &imageBuffer,
                const UWAGSAttributeMeta &attribute_info, size_t numPoints, unsigned int thread_count);
bool parseASTCData(std::vector<uint8_t> &data, size_t offset, const gsdecoder::UWAGSAttributeMeta &attribute_info, GSData &gsData);
// decoding the whole model and save the data to gsData object!

}
#endif
