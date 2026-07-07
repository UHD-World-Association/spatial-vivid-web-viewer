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
#include <string>
#include <vector>
#include <fstream>
#include <iostream>
#include <cstdint>
#include <string_view>
#include <thread>
#include <cmath>
#include <iomanip>

#include <cstring>
#include <filesystem>
#include <zlib.h>
#include <zstd.h>

#include "gsdecoder.h"

#include "astcenc.h"
#include "uwa_gsdecoder/processor/stream.h"

struct decompression_workload
{
    astcenc_context* context;
    const uint8_t* data;
    size_t data_len;
    astcenc_image* image_out;
    astcenc_swizzle swizzle;
    astcenc_error error;
};

static void decompression_function(int thread_id, decompression_workload& work) {
    work.error = astcenc_decompress_image(
        work.context, work.data, work.data_len, work.image_out, &work.swizzle, thread_id
    );
}
bool gsdecoder::parseASTCData(std::vector<uint8_t>& data, size_t offset, const gsdecoder::UWAGSAttributeMeta& attribute_info, gsdecoder::GSData& gsData) {
    // 1. Initialize the metadata.
    gsData.shnAstcMeta.textureNum = static_cast<uint32_t>(attribute_info.attribute2DTexNum);
    gsData.shnAstcMeta.astcMetas.resize(static_cast<uint32_t>(attribute_info.attribute2DTexNum));

    // 2. Use size_t to prevent overflow; astcoffset is relative to data.
    size_t astcoffset = offset;
    size_t dataSize = data.size();

    // Debug log: inspect the initial state.
    std::cout << "[ASTC Debug] Data Size: " << dataSize << ", Initial Offset: " << astcoffset
              << ", TexNum: " << (int)attribute_info.attribute2DTexNum << std::endl;

    for (uint ii = 0u; ii < static_cast<uint32_t>(attribute_info.attribute2DTexNum); ii++) {

        // --- Bounds check 1: ASTC header (16 bytes) ---
        if (astcoffset + 16 > dataSize) {
            std::cerr << "[Error] parseASTCData: Offset out of bounds reading Header! "
                      << "Offset: " << astcoffset << ", Size: " << dataSize << std::endl;
            return false; // Alternatively, throw std::runtime_error.
        }

        std::vector<uint8_t> astcHeadData;
        astcHeadData.assign(data.data() + astcoffset, data.data() + astcoffset + 16u);
        const AstcHeader* astcHeader = reinterpret_cast<const AstcHeader*>(astcHeadData.data());

        // Populate the ASTC metadata.
        gsData.shnAstcMeta.astcMetas[ii].astcBlockSize = static_cast<uint32_t>(astcHeader->blockdimX);
        gsData.shnAstcMeta.astcMetas[ii].astcWidth = static_cast<uint32_t>((astcHeader->xsize[2u] << 16u) | (astcHeader->xsize[1] << 8u) | astcHeader->xsize[0]);
        gsData.shnAstcMeta.astcMetas[ii].astcHeight = static_cast<uint32_t>((astcHeader->ysize[2u] << 16u) | (astcHeader->ysize[1] << 8u) | astcHeader->ysize[0]);
        gsData.shnAstcMeta.astcMetas[ii].singleWidth = static_cast<uint32_t>(attribute_info.attribute2DSingleWidth);
        gsData.shnAstcMeta.astcMetas[ii].numPoints = static_cast<uint32_t>(gsData.shnAstcMeta.astcMetas[ii].singleWidth * gsData.shnAstcMeta.astcMetas[ii].astcHeight);

        size_t currentTexSize = static_cast<size_t>(attribute_info.attribute2DTexSizes[ii]);
        gsData.shnAstcMeta.astcMetas[ii].streamSize = static_cast<uint32_t>(currentTexSize - 16u);

        // --- Bounds check 2: body data ---
        // Read the texture data following the header.
        size_t bodyStart = astcoffset + 16u;
        size_t bodyEnd = astcoffset + currentTexSize;

        if (bodyEnd > dataSize) {
            std::cerr << "[Error] parseASTCData: Offset out of bounds reading Body! "
                      << "BodyEnd: " << bodyEnd << ", Size: " << dataSize
                      << ", TexIndex: " << ii << std::endl;
            return false;
        }

        // Append the data after validating its bounds.
        gsData.astcRawStream.insert(
            gsData.astcRawStream.end(),
            data.data() + bodyStart,
            data.data() + bodyEnd
        );

        astcoffset += currentTexSize;
    }

    gsData.shnAstcMeta.shnMin = attribute_info.quantMinValue[0];
    gsData.shnAstcMeta.shnMax = attribute_info.quantMaxValue[0];

    // calculate astcuv
    // Require metadata for at least one texture to avoid division by zero.
    if (gsData.shnAstcMeta.astcMetas.empty()) {
         std::cerr << "[Error] parseASTCData: No ASTC metas found!" << std::endl;
         return false;
    }

    const auto& meta0 = gsData.shnAstcMeta.astcMetas[0u];
    // Prevent division by zero.
    if (meta0.astcBlockSize == 0) {
        std::cerr << "[Error] parseASTCData: Invalid BlockSize 0!" << std::endl;
        return false;
    }

    uint32_t block_size_sq = meta0.astcBlockSize * meta0.astcBlockSize;
    uint32_t blocks_per_row = meta0.singleWidth / meta0.astcBlockSize;

    if (blocks_per_row == 0) blocks_per_row = 1; // Guard against an invalid zero value.

    for (uint32_t ii = 0u; ii < meta0.numPoints; ii++){
        uint32_t block_id = ii / block_size_sq;
        uint32_t block_offset_x = (block_id % blocks_per_row) * meta0.astcBlockSize;
        uint32_t block_offset_y = (block_id / blocks_per_row) * meta0.astcBlockSize;

        uint32_t in_block_idx = ii - block_id * block_size_sq;
        uint32_t in_block_x = in_block_idx % meta0.astcBlockSize;
        uint32_t in_block_y = in_block_idx / meta0.astcBlockSize;

        uint32_t u = block_offset_x + in_block_x;
        uint32_t v = block_offset_y + in_block_y;

        gsData.gsVertex.astcUV.push_back(u);
        gsData.gsVertex.astcUV.push_back(v);
    }

    return true;
}

bool gsdecoder::decodeASTC(std::vector<uint8_t>& data, size_t offset, size_t size, std::vector<uint8_t>& imageBuffer, const gsdecoder::UWAGSAttributeMeta& attribute_info, size_t numPoints, unsigned int thread_count) {
    gsdecoder::AstcMeta astcMeta;
    std::vector<uint8_t> astcHeadData;
    astcHeadData.assign(data.data() + offset, data.data() + offset + 16u);
    const AstcHeader* astcHeader = reinterpret_cast<const AstcHeader*>(astcHeadData.data());
    astcMeta.astcBlockSize = static_cast<uint32_t>(astcHeader->blockdimX);
    astcMeta.astcWidth = static_cast<uint32_t>((astcHeader->xsize[2u] << 16u) | (astcHeader->xsize[1] << 8u) | astcHeader->xsize[0]);
    astcMeta.astcHeight = static_cast<uint32_t>((astcHeader->ysize[2u] << 16u) | (astcHeader->ysize[1] << 8u) | astcHeader->ysize[0]);
    astcMeta.singleWidth = static_cast<uint32_t>(attribute_info.attribute2DSingleWidth);
    astcMeta.numPoints = static_cast<uint32_t>(astcMeta.singleWidth * astcMeta.astcHeight);

    static const astcenc_swizzle swizzle {
            ASTCENC_SWZ_R, ASTCENC_SWZ_G, ASTCENC_SWZ_B, ASTCENC_SWZ_A
    };
    unsigned int flags = 0u;
    astcenc_profile profile = ASTCENC_PRF_LDR;
    float quality = ASTCENC_PRE_MEDIUM;
    astcenc_image image {};
    astcenc_config config;
    astcenc_error status;
    astcenc_context* context;
    image.data_type = ASTCENC_TYPE_U8;
    image.dim_x = astcMeta.astcWidth;
    image.dim_y = astcMeta.astcHeight;
    image.dim_z = 1;
    imageBuffer.resize(image.dim_x*image.dim_y*3u);

    status = astcenc_config_init(profile, astcMeta.astcBlockSize, astcMeta.astcBlockSize, 1, quality, flags, &config);
    if (status != ASTCENC_SUCCESS) {
        return false;
    }

    status = astcenc_context_alloc(&config, thread_count, &context);
    if (status != ASTCENC_SUCCESS) {
        return false;
    }

    std::vector<uint8_t> emptyBuffer(1);
    std::vector<uint8_t> colorBuffer(image.dim_x*image.dim_y*4);
    image.data = reinterpret_cast<void**>(emptyBuffer.data());
    image.data[0] = colorBuffer.data();
    decompression_workload work;
    work.context = context;
    work.data = data.data() + 16 + offset;
    work.data_len = size - 16;
    work.image_out = &image;
    work.swizzle = swizzle;
    work.error = ASTCENC_SUCCESS;

    std::vector<std::thread> threads;
    for (uint8_t i = 0; i < thread_count; i++) {
        threads.emplace_back(decompression_function, i, std::ref(work));
    }

    for (std::thread& t : threads) {
        if (t.joinable()) {
            t.join();
        }
    }

    if (work.error != ASTCENC_SUCCESS) {
        throw std::runtime_error(
            std::string("Decompress failed: ") + astcenc_get_error_string(work.error)
        );
    }

    astcenc_context_free(context);
    uint8_t* pixel_data = static_cast<uint8_t*>(image.data[0]);

    // Process pixel data across multiple threads.
    int td = std::thread::hardware_concurrency();
    int pixel_threads = std::min(td, (int)image.dim_y);
    std::vector<std::thread> pixel_workers;
    int rows_per_thread = ((int)image.dim_y + pixel_threads - 1) / pixel_threads;

    auto processRows2 = [&](int start_row, int end_row) {
        for (int y = start_row; y < end_row; y++) {
            int src_offset = y * (int)image.dim_x * 4u;
            int dest_row = y;
            for (int x = 0; x < (int)image.dim_x; x++) {
                const uint blockSides = astcMeta.singleWidth / astcMeta.astcBlockSize;
                const uint blockOffsetx = x % astcMeta.singleWidth / astcMeta.astcBlockSize;
                const uint blockOffsety = dest_row / astcMeta.astcBlockSize;
                const uint blockOffset = (blockOffsety * blockSides + blockOffsetx) * (astcMeta.astcBlockSize * astcMeta.astcBlockSize);
                const uint inBlockOffsetx = x % astcMeta.singleWidth - blockOffsetx * astcMeta.astcBlockSize;
                const uint inBlockOffsety = dest_row - blockOffsety * astcMeta.astcBlockSize;
                const uint inNum = inBlockOffsety * astcMeta.astcBlockSize + inBlockOffsetx;
                for (int c = 0; c < 3; c++) {
                    imageBuffer[(blockOffset + inNum + x / astcMeta.singleWidth * astcMeta.numPoints) * 3 + c] =
                        pixel_data[src_offset + x * 4 + c];
                }
            }
        }
    };

    for (int t = 0; t < pixel_threads; t++) {
        int start_row = t * rows_per_thread;
        int end_row = std::min(start_row + rows_per_thread, (int)image.dim_y);
        if (start_row < end_row) {
            pixel_workers.emplace_back(processRows2, start_row, end_row);
        }
    }

    // Wait for pixel processing to finish.
    for (auto& thread : pixel_workers) {
        thread.join();
    }
    colorBuffer.clear();

    return true;
}

int gsdecoder::decompress_zlib(const unsigned char* compressed_data, size_t compressed_size, unsigned char* decompressed_data, size_t decompressed_size) {
    z_stream stream;
    int ret;

    // Initialize the zlib stream structure.
    stream.zalloc = Z_NULL;
    stream.zfree = Z_NULL;
    stream.opaque = Z_NULL;
    stream.next_in = const_cast<Bytef *>(compressed_data);
    stream.avail_in = static_cast<uInt>(compressed_size);
    stream.next_out = decompressed_data;
    stream.avail_out = static_cast<uInt>(decompressed_size);

    // Initialize decompression.
    ret = inflateInit(&stream);
    if (ret != Z_OK) {
        return ret;
    }

    // Perform decompression.
    ret = inflate(&stream, Z_FINISH);
    if (ret != Z_STREAM_END) {
        inflateEnd(&stream);
        return (ret == Z_OK) ? Z_BUF_ERROR : ret;
    }

    // Verify that decompression filled the output buffer completely.
    if (stream.total_out != decompressed_size) {
        inflateEnd(&stream);
        return Z_BUF_ERROR;
    }

    inflateEnd(&stream);
    return Z_OK;
}

void gsdecoder::assignValues(float* arr, float v0, float v1, float v2, float v3) {
    arr[0] = v0;
    arr[1] = v1;
    arr[2] = v2;
    arr[3] = v3;
};

float gsdecoder::parse_float(const uint8_t* data_stream, size_t& pointer) {
    float value;
    memcpy(&value, &data_stream[pointer], sizeof(float));
    pointer += sizeof(float);
    return value;
}

// Parse a single patch
gsdecoder::UWAGSPatchMeta gsdecoder::parseUWAGSPatch(const uint8_t* data_stream, size_t size, size_t& pointer, const gsdecoder::UWAGSAttributeMeta& attribute_info) {
    gsdecoder::UWAGSPatchMeta patch_meta;

    if (attribute_info.patchGlobalEnableIndexFlag == 1) {
        memcpy(&patch_meta.patchIndex, &data_stream[pointer], sizeof(uint32_t));
        pointer += sizeof(uint32_t);
    }

    if (attribute_info.patchGlobalEnableSizeFlag == 1) {
        memcpy(&patch_meta.patchSize, &data_stream[pointer], sizeof(uint32_t));
        pointer += sizeof(uint32_t);
    }

    if (attribute_info.attributeQuantizationFlag == 1) {
        if (attribute_info.patchGlobalEnableQuantBitFlag == 1) {
            patch_meta.patchQuantBits = data_stream[pointer];
            pointer += sizeof(uint8_t);
        }

        if (attribute_info.patchGlobalEnableQuantMinMaxFlag == 1) {
            patch_meta.patchQuantMinValue.resize(attribute_info.componentsCount);
            for (size_t i = 0; i < attribute_info.componentsCount; ++i) {
                patch_meta.patchQuantMinValue[i] = gsdecoder::parse_float(data_stream, pointer);
            }

            patch_meta.patchQuantMaxValue.resize(attribute_info.componentsCount);
            for (size_t i = 0; i < attribute_info.componentsCount; ++i) {
                patch_meta.patchQuantMaxValue[i] = gsdecoder::parse_float(data_stream, pointer);
            }
        }
    }

    return patch_meta;
}

// Parse an attribute meta
gsdecoder::UWAGSAttributeMeta gsdecoder::parseUWAGSAttributeMeta(const uint8_t* data_stream, size_t size, size_t& pointer) {
    gsdecoder::UWAGSAttributeMeta attr_meta;

    uint8_t tmp;
    memcpy(&attr_meta.attributeType, &data_stream[pointer], sizeof(uint32_t));
    pointer += sizeof(uint32_t);

    attr_meta.componentsCount = data_stream[pointer++];
    attr_meta.uncompressedDataType = data_stream[pointer++];

    tmp = data_stream[pointer++];
    attr_meta.attributeQuantizationFlag = (tmp >> 4) & 0xF;
    attr_meta.attributeEncoderScheme = tmp & 0xF;

    if (attr_meta.attributeQuantizationFlag == 1) {
        attr_meta.quantizationBits = data_stream[pointer++];

        attr_meta.quantMinValue.resize(attr_meta.componentsCount);
        for (size_t i = 0; i < attr_meta.componentsCount; ++i) {
            attr_meta.quantMinValue[i] = gsdecoder::parse_float(data_stream, pointer);
        }

        attr_meta.quantMaxValue.resize(attr_meta.componentsCount);
        for (size_t i = 0; i < attr_meta.componentsCount; ++i) {
            attr_meta.quantMaxValue[i] = gsdecoder::parse_float(data_stream, pointer);
        }
    }

    if (attr_meta.attributeEncoderScheme == 1) {
        attr_meta.attributeIndexType = data_stream[pointer++];
        memcpy(&attr_meta.attributeCodebookLength, &data_stream[pointer], sizeof(uint32_t));
        pointer += sizeof(uint32_t);
    }

    if (attr_meta.attributeEncoderScheme == 2) {
        // Parse the fields in the first 10 bytes.
        attr_meta.attribute2DmimeType = data_stream[pointer];
        pointer += 1;

        attr_meta.attribute2DSingleHeight =
            static_cast<uint16_t>(data_stream[pointer]) |
            (static_cast<uint16_t>(data_stream[pointer + 1]) << 8);
        pointer += 2;

        attr_meta.attribute2DSingleWidth =
            static_cast<uint16_t>(data_stream[pointer]) |
            (static_cast<uint16_t>(data_stream[pointer + 1]) << 8);
        pointer += 2;

        attr_meta.attribute2DSingleAlign = data_stream[pointer++];
        attr_meta.attribute2DConcat = data_stream[pointer++];
        attr_meta.attribute2DConcatMaxInWidth = data_stream[pointer++];
        attr_meta.attribute2DConcatMaxInHeight = data_stream[pointer++];
        attr_meta.attribute2DTexNum = data_stream[pointer++];

        // Parse the variable-length texture-size array.
        attr_meta.attribute2DTexSizes.resize(attr_meta.attribute2DTexNum);
        for (uint8_t i = 0; i < attr_meta.attribute2DTexNum; ++i) {
            uint32_t texSize =
                static_cast<uint32_t>(data_stream[pointer]) |
                (static_cast<uint32_t>(data_stream[pointer + 1]) << 8) |
                (static_cast<uint32_t>(data_stream[pointer + 2]) << 16) |
                (static_cast<uint32_t>(data_stream[pointer + 3]) << 24);

            attr_meta.attribute2DTexSizes[i] = static_cast<size_t>(texSize);
            pointer += 4;
        }
    }

    memcpy(&attr_meta.byteOffset, &data_stream[pointer], sizeof(uint32_t));
    pointer += sizeof(uint32_t);

    memcpy(&attr_meta.byteLength, &data_stream[pointer], sizeof(uint32_t));
    pointer += sizeof(uint32_t);

    memcpy(&attr_meta.uncompressedByteLength, &data_stream[pointer], sizeof(uint32_t));
    pointer += sizeof(uint32_t);

    memcpy(&attr_meta.patchNum, &data_stream[pointer], sizeof(uint32_t));
    pointer += sizeof(uint32_t);

    if (attr_meta.patchNum > 1) {
        uint16_t flags;
        memcpy(&flags, &data_stream[pointer], sizeof(uint16_t));
        pointer += sizeof(uint16_t);

        attr_meta.patchGlobalEnableIndexFlag = (flags >> 15) & 0x1;
        attr_meta.patchGlobalEnableSizeFlag = (flags >> 14) & 0x1;
        attr_meta.patchGlobalEnableQuantBitFlag = (flags >> 13) & 0x1;
        attr_meta.patchGlobalEnableQuantMinMaxFlag = (flags >> 12) & 0x1;
        attr_meta.patchGlobalEnable2DmapingFlag = (flags >> 11) & 0x1;

        if (attr_meta.patchGlobalEnableSizeFlag == 0) {
            memcpy(&attr_meta.lastPatchSize, &data_stream[pointer], sizeof(uint32_t));
            pointer += sizeof(uint32_t);
        }

        for (size_t i = 0; i < attr_meta.patchNum; ++i) {
            attr_meta.patchMetas.push_back(gsdecoder::parseUWAGSPatch(data_stream, size, pointer, attr_meta));
        }
    }

    return attr_meta;
}

size_t gsdecoder::get_data_type_size(uint8_t data_type) {
    switch (data_type) {
        case 1: return sizeof(int8_t);
        case 2: return sizeof(uint8_t);
        case 3: return sizeof(int16_t);
        case 4: return sizeof(uint16_t);
        case 5: return sizeof(float); // float16 is not directly supported in C++, so we use float
        case 6: return sizeof(int32_t);
        case 7: return sizeof(uint32_t);
        case 8: return sizeof(float);
        case 9: return sizeof(int64_t);
        case 10: return sizeof(uint64_t);
        case 11: return sizeof(double);
        default: throw std::runtime_error("Unsupported data type");
    }
}

bool gsdecoder::decode_attribute(std::vector<uint8_t>& attribute_stream,
    const gsdecoder::UWAGSAttributeMeta& attribute_info, std::vector<float>& decoded_data, gsdecoder::GSData& gsData,
    size_t idx, size_t numGS, std::vector<uint8_t>& images)
{
    // Check if the quantization flag is supported
    if (attribute_info.attributeQuantizationFlag > 1) {
        std::cout << "unsorpported quantization type!" << std::endl;
        return false;
    }

    // If no quantization, directly read the data
    if (attribute_info.attributeQuantizationFlag == 0) {
        if (attribute_info.attributeEncoderScheme != 0) {
            std::cout << "Non-quantized data must have encoder scheme 0" << std::endl;
            return false;
        }

        size_t data_type_size = gsdecoder::get_data_type_size(attribute_info.uncompressedDataType);

        size_t offset = attribute_info.byteOffset + (idx * attribute_info.componentsCount) * data_type_size;

        if (attribute_info.uncompressedDataType == 8) { // float32
            memcpy(decoded_data.data(), &attribute_stream[offset], sizeof(float) * attribute_info.componentsCount);
        } else {
            // Without quantization, only float32 data is supported.
            std::cout << "Unsupported uncompressed dataType!" << std::endl;
            return false;
        }
    }

    if (attribute_info.attributeEncoderScheme == 1) {
        // Vector quantization decoding
        if (attribute_info.attributeIndexType != 7) {
            std::cout << "Only uint32_t indices are supported" << std::endl;
            return false;
        }

        size_t index_size = sizeof(uint32_t);

        // Parse indices
        uint32_t indices;
        memcpy(&indices, &attribute_stream[attribute_info.byteOffset + idx * index_size], sizeof(uint32_t));

        // Parse quantized data
        size_t quantized_data_offset = attribute_info.byteOffset + numGS * index_size;
        size_t quantized_data_size = sizeof(uint8_t); // Assume 8-bit quantization

        for (size_t j = 0; j < attribute_info.componentsCount; ++j) {
            size_t offset = quantized_data_offset + (indices * attribute_info.componentsCount + j) * quantized_data_size;
            decoded_data[j] = static_cast<float>(static_cast<uint8_t>(attribute_stream[offset])) / 255.0f; // Normalize to [0, 1]
        }
    } else if (attribute_info.attributeEncoderScheme == 0) {
        // Simple quantization decoding
        size_t quantized_data_size = (attribute_info.quantizationBits > 8) ? sizeof(uint16_t) : sizeof(uint8_t);

        for (size_t j = 0; j < attribute_info.componentsCount; ++j) {
            size_t offset = attribute_info.byteOffset + (idx * attribute_info.componentsCount + j) * quantized_data_size;
            uint16_t quantized_value = 0;

            if (quantized_data_size == sizeof(uint16_t)) {
                memcpy(&quantized_value, &attribute_stream[offset], sizeof(uint16_t));
            } else {
                uint8_t byte_value;
                memcpy(&byte_value, &attribute_stream[offset], sizeof(uint8_t));
                quantized_value = byte_value;
            }

            float normalized_value = static_cast<float>(quantized_value) / ((1 << attribute_info.quantizationBits) - 1);
            decoded_data[j] = normalized_value;
        }
    } else if (attribute_info.attributeEncoderScheme == 2) {
        if (images.size()>0) {
            float quantScale = static_cast<float>((1 << attribute_info.quantizationBits) - 1);
            for (size_t j = 0; j < attribute_info.componentsCount; ++j) {
                decoded_data[j] = images[(idx + (j / 3u) * numGS) * 3u + j % 3u] / quantScale;
            }
        } else {
            for (size_t j = 0; j < attribute_info.componentsCount; ++j) {
                decoded_data[j] = -1 * attribute_info.quantMinValue[j] / (attribute_info.quantMaxValue[j] - attribute_info.quantMinValue[j]);
            }
        }
    } else {
        std::cout << "Unsupported encoder scheme" << std::endl;
        return false;
    }

    // Inverse quantization
    if (attribute_info.patchNum == 1) {
        for (size_t j = 0; j < attribute_info.componentsCount; ++j) {
            decoded_data[j] =
                decoded_data[j] * (attribute_info.quantMaxValue[j] - attribute_info.quantMinValue[j]) +
                attribute_info.quantMinValue[j];
        }
    } else {
        if (attribute_info.patchGlobalEnableSizeFlag == 0) {
            size_t chunk_size = static_cast<size_t>(std::round(static_cast<double>(numGS - attribute_info.lastPatchSize) / (attribute_info.patchNum - 1)));
            const auto& patch = attribute_info.patchMetas[idx / chunk_size];
            for (size_t j = 0; j < attribute_info.componentsCount; ++j) {
                decoded_data[j] = decoded_data[j] * (patch.patchQuantMaxValue[j] - patch.patchQuantMinValue[j]) +
                            patch.patchQuantMinValue[j];
            }
        } else {
            std::cout << "Unsupported Patch Size Mode!" << std::endl;
            return false;
        }
    }

    // Write the data to gsdecoder::GSData!
    switch (attribute_info.attributeType) {
        case 0: { // Positions
            for (int j = 0; j < 3; j++) {
                gsData.gsVertex.position[idx*3u+j] = decoded_data[j];
            }
            break;
        }
        case 1: { // Rotation
            for (int j = 0; j < 4; j++) {
                gsData.gsVertex.rotation[idx*4u+j] = decoded_data[j];
            }
            break;
        }
        case 2: { // Scale
            for (int j = 0; j < 3; j++) {
                gsData.gsVertex.scaling[idx*3u+j] = decoded_data[j];
            }
            break;
        }
        case 3: { // DC and Opacity
            // Extract DC and Opacity
            memcpy(&gsData.gsVertex.color[idx*3u], decoded_data.data(), sizeof(float) * (attribute_info.componentsCount - 1));
            float op = decoded_data[attribute_info.componentsCount - 1];

            // Clamp opacity values
            if (op < 0.001f) { op = 0.001f;
            }
            if (op > 0.999f) { op = 0.999f;
            }

            // Apply inverse sigmoid activation
            op = log(op / (1.0f - op));
            gsData.gsVertex.opacity[idx] = op;
            break;
        }

        case 4: { // shn
            // Extract DC and Opacity
            for (size_t j = 0; j < attribute_info.componentsCount / 3; j++) {
                memcpy(&gsData.gsVertex.shn[(idx+j*numGS)*3u], decoded_data.data()+j*3u, sizeof(float) * 3u);
            }
            break;
        }

        default:
            throw std::runtime_error("Wrong Attribute Type");
    }

    return true;
}

bool gsdecoder::parseGSCompressedUWA(const uint8_t* data_stream, size_t size, gsdecoder::GSData& gsData, bool astcCpuDecode) {
    gsdecoder::UWAGSHeader& header = gsData.uwa_header;
    size_t pointer = sizeof(gsdecoder::UWAGSMetas);

    // Validate the magic number.
    const std::string magic_bytes = UWA_MAGIG_NUMBER;
    if (!std::equal(magic_bytes.begin(), magic_bytes.end(), reinterpret_cast<const char*>(data_stream))) {
        std::cerr << "Magic number error" << std::endl;
        return false;
    }

    // Read the UWAGSMetas header.
    if (size < sizeof(gsdecoder::UWAGSMetas)) {
        return false;
    }
    std::memcpy(&header.uwaMetas, data_stream, sizeof(gsdecoder::UWAGSMetas));

    std::cout << "Load compressed 3DGS data: Number = " << header.uwaMetas.numPoints
              << "; Attributes = " << static_cast<int>(header.uwaMetas.numAttribute) << "\n";

    // Parse the attribute metadata.
    int max_component_count = 3;
    gsData.sh_degree = 0u;
    size_t sh_components = 0u;
    for (uint8_t i = 0; i < header.uwaMetas.numAttribute; ++i) {
        header.attributeMetas.push_back(gsdecoder::parseUWAGSAttributeMeta(data_stream, size, pointer));
        if (header.attributeMetas[i].componentsCount > max_component_count) {
            max_component_count = header.attributeMetas[i].componentsCount;
        }
        if (header.attributeMetas[i].attributeType == 4) {
            gsData.sh_degree = static_cast<size_t>(std::sqrt(static_cast<double>(header.attributeMetas[i].componentsCount) / 3.0 + 1.0)) - 1;
            sh_components = header.attributeMetas[i].componentsCount;
        }
    }

    // Decode the attributes.
    std::vector<uint8_t>& attribute_datas = gsData.attribute_datas;
    if (header.uwaMetas.superCompressionScheme == 1) {
        size_t avail_size = header.uwaMetas.totalByteLength;
        attribute_datas.resize(avail_size);
        gsdecoder::decompress_zlib(
            static_cast<const unsigned char*>(data_stream + pointer), size - pointer,
            attribute_datas.data(), avail_size);
    } else {
        attribute_datas.assign(data_stream + pointer, data_stream + size);
    }

    // Decode the ASTC data.
    std::vector<uint8_t> images;
    if (astcCpuDecode && gsData.sh_degree > 0) {
        size_t shIdx = 0u;
        for (size_t aid = 0; aid < header.attributeMetas.size(); aid++) {
            if ((header.attributeMetas[aid].attributeEncoderScheme == 2) &&
                (header.attributeMetas[aid].attributeType == 4u)) {
                shIdx = aid;
            }
        }
        const gsdecoder::UWAGSAttributeMeta attribute_info = header.attributeMetas[shIdx];

        size_t offset = attribute_info.byteOffset;
        for (uint ii = 0u; ii < attribute_info.attribute2DTexNum; ii++) {
            std::vector<uint8_t> imageBuffer;
            gsdecoder::decodeASTC(attribute_datas, offset, attribute_info.attribute2DTexSizes[ii], imageBuffer, attribute_info, header.uwaMetas.numPoints, 1);
            offset += attribute_info.attribute2DTexSizes[ii];
            images.insert(images.end(), imageBuffer.begin(), imageBuffer.end());
            imageBuffer.clear();
        }
        gsData.gsVertex.shn.resize(sh_components * header.uwaMetas.numPoints);
    } else if (!astcCpuDecode && gsData.sh_degree > 0 ) {
        size_t shIdx = 0u;
        for (size_t aid = 0; aid < header.attributeMetas.size(); aid++) {
            if ((header.attributeMetas[aid].attributeEncoderScheme == 2) &&
                (header.attributeMetas[aid].attributeType == 4u)) {
                shIdx = aid;
            }
        }
        const gsdecoder::UWAGSAttributeMeta attribute_info = header.attributeMetas[shIdx];
        size_t offset = attribute_info.byteOffset;
        gsData.gsVertex.shn.resize(1);
        gsData.gsVertex.shn[0] = 0.0f;
        std::cout << "Warning: ASTC decoding is skipped. shn data will be set to 0." << std::endl;
        gsdecoder::parseASTCData(attribute_datas, offset, attribute_info, gsData);
    }

    // Initialize the vertex arrays.
    gsData.gsVertex.position.resize(3u * header.uwaMetas.numPoints);
    gsData.gsVertex.scaling.resize(3u * header.uwaMetas.numPoints);
    gsData.gsVertex.rotation.resize(4u * header.uwaMetas.numPoints);
    gsData.gsVertex.opacity.resize(header.uwaMetas.numPoints);
    gsData.gsVertex.color.resize(3u * header.uwaMetas.numPoints);

    // Process the metadata for each attribute.
    auto processChunk = [&](const size_t startIdx, const size_t endIdx) {
        std::vector<float> decoded_data(max_component_count);
        for (size_t ii = startIdx; ii < endIdx; ii++) {
            for (const auto& attr_meta : header.attributeMetas) {
                if (attr_meta.attributeType == 4 && astcCpuDecode == false) continue;
                gsdecoder::decode_attribute(attribute_datas, attr_meta, decoded_data, gsData, ii, header.uwaMetas.numPoints, images);
            }
        }
    };

    size_t hw_threads = std::thread::hardware_concurrency();
    if (hw_threads == 0) { hw_threads = 4;
    }
    size_t max_workers = (hw_threads > 1) ? (hw_threads - 1) : 1;
    size_t numThreads = std::max<size_t>(4, max_workers);

    std::vector<std::thread> threads;
    const size_t chunkSize = (header.uwaMetas.numPoints + numThreads - 1) / numThreads;

    for (size_t ii = 0; ii < numThreads; ii++) {
        const size_t start = ii * chunkSize;
        const size_t end = (ii == numThreads - 1) ? header.uwaMetas.numPoints : start + chunkSize;
        threads.emplace_back(processChunk, start, end);
    }

    for (auto& thread : threads) {
        thread.join();
    }

    return true;
}

bool gsdecoder::isGSCompressed(const uint8_t* data_stream, size_t size) {
    bool status = false;

    const std::vector<uint8_t> ply_magic_bytes = {'p', 'l', 'y'};
    const std::string uwa_format_magic_str = UWA_MAGIG_NUMBER;
    const std::vector<uint8_t> uwa_format_magic_bytes(
        uwa_format_magic_str.begin(), uwa_format_magic_str.end());

    if (size >= uwa_format_magic_bytes.size() &&
                std::equal(uwa_format_magic_bytes.begin(), uwa_format_magic_bytes.end(), data_stream)) {
        status = true;
    }
    return status;
}

bool gsdecoder::isGSCompressed(std::string path) {
    // Open the input file.
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
        std::cerr << "Failed to open file: " << path << std::endl;
        return false;
    }

    // Get the input file size.
    size_t fileSize = file.tellg();
    file.seekg(0, std::ios::beg);

    // Allocate a buffer and read the file contents.
    std::vector<uint8_t> fileData(fileSize);
    if (!file.read(reinterpret_cast<char*>(fileData.data()), fileSize)) {
        std::cerr << "Failed to read file!" << std::endl;
        return false;
    }

    return gsdecoder::isGSCompressed(const_cast<uint8_t*>(fileData.data()), fileSize);
}

bool gsdecoder::parseBasicInfo(const uint8_t* fileData, size_t size, gsdecoder::GSBasicInfo& info) {
    const std::vector<uint8_t> ply_magic_bytes = {'p', 'l', 'y'};
    const std::string uwa_format_magic_str = UWA_MAGIG_NUMBER;
    const std::vector<uint8_t> uwa_format_magic_bytes(
        uwa_format_magic_str.begin(), uwa_format_magic_str.end());

    if (size >= uwa_format_magic_bytes.size() &&
                std::equal(uwa_format_magic_bytes.begin(), uwa_format_magic_bytes.end(), fileData)) {
        size_t pointer = sizeof(gsdecoder::UWAGSMetas);

        gsdecoder::UWAGSHeader header;
        const std::string magic_bytes = UWA_MAGIG_NUMBER;
        if (!std::equal(magic_bytes.begin(), magic_bytes.end(), fileData)) {
            return false;
        }
        if (size >= sizeof(gsdecoder::UWAGSMetas)) {
            std::memcpy(&header.uwaMetas, fileData, sizeof(gsdecoder::UWAGSMetas));
        } else {
            return false;
        }

        std::cout << "Load compressed 3DGS data: Number = " << header.uwaMetas.numPoints
                << "; Attributes = " << static_cast<int>(header.uwaMetas.numAttribute) << "\n";

        // Parse attribute metas
        for (uint8_t i = 0; i < header.uwaMetas.numAttribute; ++i) {
            header.attributeMetas.push_back(gsdecoder::parseUWAGSAttributeMeta(fileData, size, pointer));
            if (header.attributeMetas[i].attributeType == 0) {
                info.minPosition[0] = header.attributeMetas[i].quantMinValue[0];
                info.minPosition[1] = header.attributeMetas[i].quantMinValue[1];
                info.minPosition[2] = header.attributeMetas[i].quantMinValue[2];

                info.maxPosition[0] = header.attributeMetas[i].quantMaxValue[0];
                info.maxPosition[1] = header.attributeMetas[i].quantMaxValue[1];
                info.maxPosition[2] = header.attributeMetas[i].quantMaxValue[2];
            }

            if (header.attributeMetas[i].attributeType == 4) {
                info.sh_degree = static_cast<size_t>(std::sqrt(static_cast<double>(header.attributeMetas[i].componentsCount) / 3.0 + 1.0)) - 1;
            }
        }
        info.numGS = header.uwaMetas.numPoints;
    }

    return true;
}

bool gsdecoder::parseBasicInfoV1(const uint8_t* fileData, size_t size, gsdecoder::GSBasicInfo& info) {
    uint32_t magic;
    std::memcpy(&magic, fileData, 4);
    std::vector<uint8_t> data;
    size_t decompressedSize = 0u;
    if (magic == 0xFD2FB528) {  // ZSTD magic number (little-endian)

        // Decompress with ZSTD.
        decompressedSize = ZSTD_getFrameContentSize(fileData, size);
        if (decompressedSize == ZSTD_CONTENTSIZE_ERROR || decompressedSize == ZSTD_CONTENTSIZE_UNKNOWN) {
            std::cerr << "  Error: Cannot determine decompressed size" << std::endl;
            return false;
        }

        data.resize(decompressedSize);

        size_t result = ZSTD_decompress(data.data(), data.size(),
                                        fileData, size);

        if (ZSTD_isError(result)) {
            std::cerr << "  Error: ZSTD decompression failed: " << ZSTD_getErrorName(result) << std::endl;
            return false;
        }
    }

    BasicInformation basicInfo;
    uint32_t metaByteSize;
    std::memcpy(&metaByteSize, data.data(), 4);

    // Create a Unit and parse the basic information.
    Unit unit(0);  // unit_type = 0 (metadata)
    unit.reader.setData(data.data() + 4, decompressedSize - 4);

    if (!unit.readBasicInfo(basicInfo)) {
        fprintf(stderr, "Error: Failed to read basic info\n");
        return false;
    }

    info.minPosition[0] = basicInfo.positionMinValue[0];
    info.minPosition[1] = basicInfo.positionMinValue[1];
    info.minPosition[2] = basicInfo.positionMinValue[2];

    info.maxPosition[0] = basicInfo.positionMaxValue[0];
    info.maxPosition[1] = basicInfo.positionMaxValue[1];
    info.maxPosition[2] = basicInfo.positionMaxValue[2];
    info.sh_degree = basicInfo.shDegree;
    info.numGS = basicInfo.gsPointsNum;
    return true;
}

bool gsdecoder::parseBasicInfo(std::string path, GSBasicInfo& info) {
    // Open the input file.
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
        std::cerr << "Failed to open file: " << path << std::endl;
    }

    // Get the input file size.
    size_t fileSize = file.tellg();
    file.seekg(0, std::ios::beg);

    // Allocate a buffer and read the file contents.
    std::vector<uint8_t> fileData(fileSize);
    if (!file.read(reinterpret_cast<char*>(fileData.data()), fileSize)) {
        std::cerr << "Failed to read file!" << std::endl;
    }

    return gsdecoder::parseBasicInfo(const_cast<uint8_t*>(fileData.data()), fileSize, info);
}

bool  gsdecoder::parseGSCompressed(std::string path, gsdecoder::GSData& gsData, bool astcCpuDecode) {
    // Open the input file.
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
        std::cerr << "Failed to open file: " << path << std::endl;
        return false;
    }

    // Get the input file size.
    size_t fileSize = file.tellg();
    file.seekg(0, std::ios::beg);

    // Allocate a buffer and read the file contents.
    std::vector<uint8_t> fileData(fileSize);
    if (!file.read(reinterpret_cast<char*>(fileData.data()), fileSize)) {
        std::cerr << "Failed to read file!" << std::endl;
        return false;
    }

    return gsdecoder::parseGSCompressed(const_cast<uint8_t*>(fileData.data()), fileSize, gsData, astcCpuDecode);
}

bool  gsdecoder::parseGSCompressed(const uint8_t* fileData, size_t buffersize, gsdecoder::GSData& gsData, bool astcCpuDecode) {
    // Define the magic bytes for UWA formats
    const std::string uwa_format_magic_str = UWA_MAGIG_NUMBER;
    const std::vector<uint8_t> uwa_format_magic_bytes(
        uwa_format_magic_str.begin(), uwa_format_magic_str.end());

    if (buffersize >= uwa_format_magic_bytes.size() &&
                std::equal(uwa_format_magic_bytes.begin(), uwa_format_magic_bytes.end(), fileData)) {
        std::cout << "Parse compressed UWA format gs" << std::endl;
        const std::string cacheDir = "";
        return gsdecoder::parseGSCompressedUWA(fileData, buffersize, gsData, astcCpuDecode);
    }

    return false;
}
