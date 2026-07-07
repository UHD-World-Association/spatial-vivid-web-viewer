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
#define CGLTF_IMPLEMENTATION
#include <cstring>

#include <iostream>

#include <fstream>

#include "decoderUI.h"

#include "uwa_gsdecoder/gaussian_model/gs_decoder.h"

#include "nlohmann/json.hpp"

#include <algorithm>

#ifdef ANDROID
#include <android/log.h>
#define LOG_DEBUG(msg) __android_log_print(ANDROID_LOG_DEBUG, "GSDecoder", msg)
#else
#include <iostream>
#ifndef NDEBUG
#define LOG_DEBUG(msg) std::cout << "DEBUG: " << (msg) << std::endl
#else
#define LOG_DEBUG(msg) ((void)0)
#endif
#endif

#ifndef NDEBUG
#define UWA_DEBUG_OUT(expr) do { expr; } while (0)
#else
#define UWA_DEBUG_OUT(expr) do {} while (0)
#endif

static void clearGsAttributePointers(GSData& gsData)
{
    gsData.gsAttributeBitstream.posBitstream = nullptr;
    gsData.gsAttributeBitstream.opacityBitstream = nullptr;
    gsData.gsAttributeBitstream.scaleBitstream = nullptr;
    gsData.gsAttributeBitstream.rotationBitstream = nullptr;
    gsData.gsAttributeBitstream.colorBitstream = nullptr;
    gsData.gsAttributeBitstream.SHBitstream = nullptr;
    gsData.gsAttributeBitstream.astcRawStream = nullptr;
    gsData.gsAttributeBitstream.astcUVStream = nullptr;
}

static void bindOwnedSplatDataToGSData(DecodedDataHandle* handle, bool astcCpuDecode)
{
    if (!handle || !handle->ownedSplatData) {
        return;
    }

    auto& out = handle->gsData;
    const auto& in = *handle->ownedSplatData;

    out.GSpointnum = in.numPoints;
    out.SHdegree = in.shDegree;

    out.posBitstreamSize = in.means.size() * sizeof(float);
    out.opacityBitstreamSize = in.opacity.size() * sizeof(float);
    out.scaleBitstreamSize = in.scaling.size() * sizeof(float);
    out.rotationBitstreamSize = in.rotation.size() * sizeof(float);
    out.colorBitstreamSize = in.features_dc.size() * sizeof(float);

    out.gsAttributeBitstream.posBitstream = in.means.empty() ? nullptr : const_cast<float*>(in.means.data());
    out.gsAttributeBitstream.opacityBitstream = in.opacity.empty() ? nullptr : const_cast<float*>(in.opacity.data());
    out.gsAttributeBitstream.scaleBitstream = in.scaling.empty() ? nullptr : const_cast<float*>(in.scaling.data());
    out.gsAttributeBitstream.rotationBitstream = in.rotation.empty() ? nullptr : const_cast<float*>(in.rotation.data());
    out.gsAttributeBitstream.colorBitstream = in.features_dc.empty() ? nullptr : const_cast<float*>(in.features_dc.data());

    if (astcCpuDecode) {
        out.SHBitstreamSize = in.features_rest.size() * sizeof(float);
        out.gsAttributeBitstream.SHBitstream = in.features_rest.empty() ? nullptr : const_cast<float*>(in.features_rest.data());
        out.astcBitstreamSize = 0u;
        out.astcUVstreamSize = 0u;
        out.gsAttributeBitstream.astcRawStream = nullptr;
        out.gsAttributeBitstream.astcUVStream = nullptr;
        out.shnAstcMeta.astcMetas.clear();
        out.shnAstcMeta.textureNum = 0;
        out.shnAstcMeta.shnMin = 0.0f;
        out.shnAstcMeta.shnMax = 0.0f;
        return;
    }

    out.SHBitstreamSize = 0u;
    out.gsAttributeBitstream.SHBitstream = nullptr;
    out.astcBitstreamSize = in.astcRawStream.size();
    out.astcUVstreamSize = in.astcUV.size();
    out.gsAttributeBitstream.astcRawStream = in.astcRawStream.empty() ? nullptr : const_cast<uint8_t*>(in.astcRawStream.data());
    out.gsAttributeBitstream.astcUVStream = in.astcUV.empty() ? nullptr : const_cast<uint32_t*>(in.astcUV.data());
    out.shnAstcMeta.textureNum = in.astcTextureNum;
    out.shnAstcMeta.shnMin = in.shnMin;
    out.shnAstcMeta.shnMax = in.shnMax;
    out.shnAstcMeta.astcMetas.clear();
    out.shnAstcMeta.astcMetas.reserve(in.astcMetas.size());
    for (const auto& srcMeta : in.astcMetas) {
        out.shnAstcMeta.astcMetas.push_back({
            srcMeta.astcBlockSize,
            srcMeta.astcWidth,
            srcMeta.astcHeight,
            srcMeta.singleWidth,
            srcMeta.numPoints,
            srcMeta.streamSize
        });
    }
}

float clamp(float v, float min, float max) {
    float a = v;
    if (a < min) {
        a = min;
    }
    if (a > max) {
        a = max;
    }
    return a;
}

float sigmoid(float x) {
    return 1.0f / (1.0f + std::exp(-x));
}

float inverse_sigmoid(float y) {
    constexpr float eps = 1e-6f;
    y = clamp(y, eps, 1.0f - eps);
    return std::log(y / (1.0f - y));
}

int decodeCompressed3DGS(DecodeHandle* decoderHandle, const uint8_t* buffer, size_t buffer_size, bool astcCpuDecode)
{
    UWA_DEBUG_OUT(std::cout << "[decodeCompressed3DGS] input payload bytes=" << buffer_size
              << ", astcCpuDecode=" << (astcCpuDecode ? "true" : "false") << std::endl);

    DecodedDataHandle* handle = new DecodedDataHandle();
    if (!handle) return 0;
    clearGsAttributePointers(handle->gsData);
    handle->ownedSplatData = std::make_unique<SplatData>();

    GSDecoder decoder;
    UWA_DEBUG_OUT(std::cout << "[decodeCompressed3DGS] decodeFromMemory begin" << std::endl);
    const TextureOutputMode textureOutputMode = astcCpuDecode ?
        TextureOutputMode::CPU : TextureOutputMode::ASTC;
    if (!decoder.decodeFromMemory(buffer, buffer_size, *handle->ownedSplatData, textureOutputMode)) {
        std::cerr << "Error: uwa_gs_decoder decode failed" << std::endl;
        delete handle;
        return 0;
    }

    const auto& decoded = *handle->ownedSplatData;
    UWA_DEBUG_OUT(std::cout << "[decodeCompressed3DGS] decodeFromMemory done. points=" << decoded.numPoints
              << ", shDegree=" << decoded.shDegree
              << ", means=" << decoded.means.size()
              << ", opacity=" << decoded.opacity.size()
              << ", scaling=" << decoded.scaling.size()
              << ", rotation=" << decoded.rotation.size()
              << ", features_dc=" << decoded.features_dc.size()
              << ", features_rest=" << decoded.features_rest.size()
              << std::endl);

    TimingStats& timing = getTimingStats();
    timing.print();

    bindOwnedSplatDataToGSData(handle, astcCpuDecode);

    UWA_DEBUG_OUT(std::cout << "[decodeCompressed3DGS] SHBitstream copy skipped; ASTC GPU payload bytes="
              << handle->gsData.astcBitstreamSize
              << ", uvCount=" << handle->gsData.astcUVstreamSize
              << ", metas=" << handle->gsData.shnAstcMeta.astcMetas.size()
              << std::endl);

    *decoderHandle = handle;
    return 1;
}

int decodeUI(DecodeHandle* decoderHandle, const uint8_t* buffer, size_t buffer_size, bool astcCpuDecode)
{
    LOG_DEBUG("begin decodeUI!");
    UWA_DEBUG_OUT(std::cout << "[decodeUI] input GLB bytes=" << buffer_size
              << ", astcCpuDecode=" << (astcCpuDecode ? "true" : "false") << std::endl);
	DecodedDataHandle* handle = new DecodedDataHandle();
	if (!handle) return 0;
    clearGsAttributePointers(handle->gsData);
    // Initialize the decoder data.
    cgltf_data *data = NULL;
    cgltf_options options = {};
    // Parse the GLB data.
    cgltf_result result = cgltf_parse(&options, buffer, buffer_size, &data);
    UWA_DEBUG_OUT(std::cout << "[decodeUI] cgltf_parse result=" << result << std::endl);
    // Check the parse result.
    if (result != cgltf_result_success) {
        LOG_DEBUG("Error : parse the GLB file!");
        return 0;
    }

    // Check that the GLB contains a mesh and primitive.
    if (data->meshes_count == 0 || data->meshes[0].primitives_count == 0) {
        LOG_DEBUG("Error: No meshes or primitives found in the file!");
        cgltf_free(data);
        return 0;
    }
    // Get the GLB binary payload.
    char *glb_buffer = (char *)data->bin;
    if(data->meshes[0].primitives[0].has_UWA_primitive_3DGS_compression){
        cgltf_UWA_primitive_3DGS_compression gaussian_splatting = data->meshes[0].primitives[0].UWA_primitive_3DGS_compression;
        cgltf_buffer_view* compressed3DGS_bufferview = gaussian_splatting.buffer_view;
        cgltf_size compressed3DGS_index = cgltf_buffer_view_index(data, compressed3DGS_bufferview);
        size_t compressed3DGS_size = data->buffer_views[compressed3DGS_index].size;
        size_t compressed3DGS_start = data->buffer_views[compressed3DGS_index].offset;
	const uint8_t* compressed_3DGS_ptr = reinterpret_cast<const uint8_t*>(glb_buffer + compressed3DGS_start);
        UWA_DEBUG_OUT(std::cout << "Bitstream_3DGS bytelength=" << compressed3DGS_size << std::endl);

        GSDecoder decoder;
        handle->ownedSplatData = std::make_unique<SplatData>();
        UWA_DEBUG_OUT(std::cout << "[decodeUI] decodeFromMemory begin" << std::endl);
        const TextureOutputMode textureOutputMode = astcCpuDecode ?
            TextureOutputMode::CPU : TextureOutputMode::ASTC;
        if (!decoder.decodeFromMemory(compressed_3DGS_ptr, compressed3DGS_size,
                                      *handle->ownedSplatData, textureOutputMode)) {
            std::cerr << "Error: uwa_gs_decoder decode failed" << std::endl;
            delete handle;
            return 0;
        }
        const auto& decoded = *handle->ownedSplatData;
        UWA_DEBUG_OUT(std::cout << "[decodeUI] decodeFromMemory done. points=" << decoded.numPoints
                  << ", shDegree=" << decoded.shDegree
                  << ", means=" << decoded.means.size()
                  << ", opacity=" << decoded.opacity.size()
                  << ", scaling=" << decoded.scaling.size()
                  << ", rotation=" << decoded.rotation.size()
                  << ", features_dc=" << decoded.features_dc.size()
                  << ", features_rest=" << decoded.features_rest.size()
                  << std::endl);
        TimingStats& timing = getTimingStats();
        timing.print();
        bindOwnedSplatDataToGSData(handle, astcCpuDecode);
        UWA_DEBUG_OUT(std::cout << (astcCpuDecode ? "cpu decode finish!" : "gpu decode finish!") << std::endl);
    }
    else {
        handle->gsData.GSpointnum = data->meshes[0].primitives[0].attributes[0].data->count;
        // Get the attribute count.
        cgltf_size attributes_count = data->meshes[0].primitives[0].attributes_count;
        // Check that all required attributes are present.
        if (attributes_count < 5) {
            cgltf_free(data);
            return 0;
        }
        // Calculate the spherical harmonics parameter count.
        const int sh0_params_len = 5;
        int sh_params_len = attributes_count - sh0_params_len;
        // Calculate the spherical harmonics degree.
        handle->gsData.SHdegree = static_cast<int>(sqrt(sh_params_len + 1) - 1);

        // Locate all required attributes.
        cgltf_size position_index = 0;
        cgltf_size opacity_index = 0;
        cgltf_size scale_index = 0;
        cgltf_size rotation_index = 0;
        cgltf_size sh0_index = 0;
        std::vector<cgltf_size> shn_indices(sh_params_len, 0);

        // Find each required attribute index by name.
        for (cgltf_size i = 0; i < attributes_count; i++) {
            const char* attr_name = data->meshes[0].primitives[0].attributes[i].name;
            if (strcmp(attr_name, "POSITION") == 0 ||
                (strstr(attr_name, "POSITION") != NULL)) {
                position_index = i;
            }
            else if (strcmp(attr_name, "KHR_gaussian_splatting:OPACITY") == 0 ||
                    strcmp(attr_name, "OPACITY") == 0 ||
                    (strstr(attr_name, "OPACITY") != NULL)) {
                opacity_index = i;
            }
            else if (strcmp(attr_name, "KHR_gaussian_splatting:SCALE") == 0 ||
                    strcmp(attr_name, "SCALE") == 0 ||
                    (strstr(attr_name, "SCALE") != NULL)) {
                scale_index = i;
            }
            else if (strcmp(attr_name, "KHR_gaussian_splatting:ROTATION") == 0 ||
                    strcmp(attr_name, "ROTATION") == 0 ||
                    (strstr(attr_name, "ROTATION") != NULL)) {
                rotation_index = i;
            }
            else if (strcmp(attr_name, "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0") == 0 ||
                    strcmp(attr_name, "SH_DEGREE_0_COEF_0") == 0 ||
                    (strstr(attr_name, "SH_DEGREE_0") != NULL)) {
                sh0_index = i;
            }
            else {
                for (int l = 1; l <= handle->gsData.SHdegree; l++) {
                    for (int m = 0; m <= 2 * l; m++) {
                        char standard_name[100];
                        char prefixed_name[100];
                        // Standard name: SH_DEGREE_l_COEF_m.
                        snprintf(standard_name, sizeof(standard_name), "SH_DEGREE_%d_COEF_%d", l, m);
                        // Name with the KHR prefix.
                        snprintf(prefixed_name, sizeof(prefixed_name), "KHR_gaussian_splatting:SH_DEGREE_%d_COEF_%d", l, m);
                        if (strcmp(attr_name, standard_name) == 0 ||
                            strcmp(attr_name, prefixed_name) == 0) {
                            // Calculate the spherical harmonics coefficient index.
                            int idx = 0;
                            for (int ll = 0; ll < l; ll++) {
                                idx += (2 * ll + 1); // Total coefficient count for degrees before l.
                            }
                            idx += m-1; // Add m for the current degree, excluding degree zero.
                            shn_indices[idx] = i;
                        }
                    }
                }
            }
        }

        cgltf_accessor* position_accessor = data->meshes[0].primitives[0].attributes[position_index].data;
        cgltf_accessor* opacity_accessor = data->meshes[0].primitives[0].attributes[opacity_index].data;
        cgltf_accessor* scale_accessor = data->meshes[0].primitives[0].attributes[scale_index].data;
        cgltf_accessor* rotation_accessor = data->meshes[0].primitives[0].attributes[rotation_index].data;
        cgltf_accessor* color_accessor = data->meshes[0].primitives[0].attributes[sh0_index].data;

        cgltf_buffer_view *position_bufferView = position_accessor->buffer_view;
        cgltf_buffer_view *opacity_bufferView = opacity_accessor->buffer_view;
        cgltf_buffer_view *scale_bufferView = scale_accessor->buffer_view;
        cgltf_buffer_view *rotation_bufferView = rotation_accessor->buffer_view;
        cgltf_buffer_view *color_bufferView = color_accessor->buffer_view;
        cgltf_buffer_view **sh_bufferView = (cgltf_buffer_view **)malloc(sh_params_len * sizeof(cgltf_buffer_view));

        // Get the buffer view and accessor for each spherical harmonics coefficient.
        for (int i = 0; i < sh_params_len; i++) {
            sh_bufferView[i] = data->meshes[0].primitives[0].attributes[shn_indices[i]].data->buffer_view;
        }

        // Allocate position, color, opacity, scale, and rotation arrays.
        handle->gsData.gsAttributeBitstream.posBitstream = new float[handle->gsData.GSpointnum * 3];
        handle->gsData.gsAttributeBitstream.colorBitstream = new float[handle->gsData.GSpointnum * 3];
        handle->gsData.gsAttributeBitstream.opacityBitstream = new float[handle->gsData.GSpointnum];
        handle->gsData.gsAttributeBitstream.scaleBitstream = new float[handle->gsData.GSpointnum * 3];
        handle->gsData.gsAttributeBitstream.rotationBitstream = new float[handle->gsData.GSpointnum * 4];
        if (handle->gsData.SHdegree > 0) {
            handle->gsData.gsAttributeBitstream.SHBitstream = new float[handle->gsData.GSpointnum*sh_params_len*3];
        }

        handle->gsData.posBitstreamSize = handle->gsData.GSpointnum*3*sizeof(float);
        handle->gsData.colorBitstreamSize = handle->gsData.GSpointnum*3*sizeof(float);
        handle->gsData.opacityBitstreamSize = handle->gsData.GSpointnum*sizeof(float);
        handle->gsData.scaleBitstreamSize = handle->gsData.GSpointnum*3*sizeof(float);
        handle->gsData.rotationBitstreamSize = handle->gsData.GSpointnum*4*sizeof(float);
        handle->gsData.SHBitstreamSize = handle->gsData.GSpointnum*3*sh_params_len*sizeof(float);
        printf("[Debug] sh_params_len=%d \n",sh_params_len);
        printf("[Debug] handle->gsData.SHBitstreamSize=%zu \n", handle->gsData.SHBitstreamSize);
        // Get each attribute data pointer and stride.
        unsigned char* buffer_position = (unsigned char*)glb_buffer + position_bufferView->offset;
        unsigned char* buffer_color = (unsigned char*)glb_buffer + color_bufferView->offset;
        unsigned char* buffer_opacity = (unsigned char*)glb_buffer + opacity_bufferView->offset;
        unsigned char* buffer_scale = (unsigned char*)glb_buffer + scale_bufferView->offset;
        unsigned char* buffer_rotation = (unsigned char*)glb_buffer + rotation_bufferView->offset;
        size_t stride_position = position_bufferView->stride ? position_bufferView->stride : 12;
        size_t stride_color = color_bufferView->stride ? color_bufferView->stride : 12;
        size_t stride_opacity = opacity_bufferView->stride ? opacity_bufferView->stride : 4;
        size_t stride_scale = scale_bufferView->stride ? scale_bufferView->stride : 12;
        size_t stride_rotation = rotation_bufferView->stride ? rotation_bufferView->stride : 16;

        // Get each attribute offset relative to the start of its data block.
        size_t position_offset = position_accessor->offset;
        size_t opacity_offset = opacity_accessor->offset;
        size_t scale_offset = scale_accessor->offset;
        size_t rotation_offset = rotation_accessor->offset;
        size_t color_offset = color_accessor->offset;

        for (int i = 0; i < handle->gsData.GSpointnum; i++) {
                    // Extract position (three floats, 12 bytes).
                    unsigned char* pos_ptr = buffer_position + i * stride_position;
                    float* pos = (float*)(pos_ptr + position_offset);
                    handle->gsData.gsAttributeBitstream.posBitstream[i * 3 + 0] = pos[0];
                    handle->gsData.gsAttributeBitstream.posBitstream[i * 3 + 1] = pos[1];
                    handle->gsData.gsAttributeBitstream.posBitstream[i * 3 + 2] = pos[2];
                    // Extract rotation (four floats, 16 bytes).
                    unsigned char* rot_ptr = buffer_rotation + i * stride_rotation;
                    float* rot = (float*)(rot_ptr + rotation_offset);
                    handle->gsData.gsAttributeBitstream.rotationBitstream[i * 4 + 0] = rot[3]; //w
                    handle->gsData.gsAttributeBitstream.rotationBitstream[i * 4 + 1] = rot[0]; //x
                    handle->gsData.gsAttributeBitstream.rotationBitstream[i * 4 + 2] = rot[1]; //y
                    handle->gsData.gsAttributeBitstream.rotationBitstream[i * 4 + 3] = rot[2]; //z
                    // Extract scale (three floats, 12 bytes).
                    unsigned char* scl_ptr = buffer_scale + i * stride_scale;
                    float* scl = (float*)(scl_ptr + scale_offset);
                    handle->gsData.gsAttributeBitstream.scaleBitstream[i * 3 + 0] = scl[0];
                    handle->gsData.gsAttributeBitstream.scaleBitstream[i * 3 + 1] = scl[1];
                    handle->gsData.gsAttributeBitstream.scaleBitstream[i * 3 + 2] = scl[2];
                    // Extract diffuse color (three floats, 12 bytes).
                    unsigned char* col_ptr = buffer_color + i * stride_color;
                    float* col = (float*)(col_ptr + color_offset);
                    handle->gsData.gsAttributeBitstream.colorBitstream[i * 3 + 0] = col[0];
                    handle->gsData.gsAttributeBitstream.colorBitstream[i * 3 + 1] = col[1];
                    handle->gsData.gsAttributeBitstream.colorBitstream[i * 3 + 2] = col[2];

                    // Extract opacity (one float, 4 bytes).
                    unsigned char* op_ptr = buffer_opacity + i * stride_opacity;
                    float* op = (float*)(op_ptr + opacity_offset);
                    handle->gsData.gsAttributeBitstream.opacityBitstream[i] = op[0];

                    for (int j = 0; j < sh_params_len; j++) {
                        cgltf_accessor* sh_accessor = data->meshes[0].primitives[0].attributes[shn_indices[j]].data;
                        cgltf_buffer_view* sh_bufferView = sh_accessor->buffer_view;
                        size_t sh_offset = sh_accessor->offset;
                        unsigned char* buffer_sh = (unsigned char*)glb_buffer + sh_bufferView->offset;
                        size_t stride_sh = sh_bufferView->stride ? sh_bufferView->stride : 12;
                        unsigned char* sh_ptr = buffer_sh + i * stride_sh;
                        float* sh = (float*)(sh_ptr + sh_offset);
                        handle->gsData.gsAttributeBitstream.SHBitstream[j*handle->gsData.GSpointnum*3 + i*3] = sh[0];
                        handle->gsData.gsAttributeBitstream.SHBitstream[j*handle->gsData.GSpointnum*3 + i*3 + 1] = sh[1];
                        handle->gsData.gsAttributeBitstream.SHBitstream[j*handle->gsData.GSpointnum*3 + i*3 + 2] = sh[2];
                    }
        }
    }
    cgltf_free(data);
	*decoderHandle = handle;
    return 1;
}

GSData *getStructGSData(DecodeHandle handle)
{
    if (!handle) {
        return nullptr;
    }
    DecodedDataHandle *Decoder = (DecodedDataHandle*)(handle);
    return &Decoder->gsData;
}

ViewInfo *getStructViewInfo(DecodeHandle handle)
{
    if (!handle) {
        return nullptr;
    }
    DecodedDataHandle *Decoder = (DecodedDataHandle*)(handle);
    return &Decoder->viewInfo;
}

std::vector<CameraMotionParams> *getMotionParams(DecodeHandle handle)
{
    if (!handle) {
        return nullptr;
    }
    DecodedDataHandle *Decoder = (DecodedDataHandle*)(handle);
    return &Decoder->motionParams;
}

int destroyDecode(DecodeHandle handle)
{
    if (!handle) {
        return 0;
    }

    DecodedDataHandle *Decoder = (DecodedDataHandle*)(handle);
    const bool usesOwnedSplatData = Decoder->ownedSplatData != nullptr;

    if (!usesOwnedSplatData) {
        if (Decoder->gsData.gsAttributeBitstream.posBitstream) {
            delete[] Decoder->gsData.gsAttributeBitstream.posBitstream;
        }
        if (Decoder->gsData.gsAttributeBitstream.opacityBitstream) {
            delete[] Decoder->gsData.gsAttributeBitstream.opacityBitstream;
        }
        if (Decoder->gsData.gsAttributeBitstream.scaleBitstream) {
            delete[] Decoder->gsData.gsAttributeBitstream.scaleBitstream;
        }
        if (Decoder->gsData.gsAttributeBitstream.rotationBitstream) {
            delete[] Decoder->gsData.gsAttributeBitstream.rotationBitstream;
        }
        if (Decoder->gsData.gsAttributeBitstream.colorBitstream) {
            delete[] Decoder->gsData.gsAttributeBitstream.colorBitstream;
        }
        if (Decoder->gsData.gsAttributeBitstream.SHBitstream) {
            delete[] Decoder->gsData.gsAttributeBitstream.SHBitstream;
        }
        if (Decoder->gsData.gsAttributeBitstream.astcRawStream) {
            delete[] Decoder->gsData.gsAttributeBitstream.astcRawStream;
        }
        if (Decoder->gsData.gsAttributeBitstream.astcUVStream) {
            delete[] Decoder->gsData.gsAttributeBitstream.astcUVStream;
        }
    }

    // Reset all pointers.
    memset(&Decoder->gsData.gsAttributeBitstream, 0, sizeof(Decoder->gsData.gsAttributeBitstream));
    Decoder->ownedSplatData.reset();

    delete Decoder;

    return 1;
}
