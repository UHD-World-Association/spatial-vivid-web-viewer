#include "decoderUI.h"
#include <iostream>
#include <cstring>
#include <fstream>
#include <vector>
#include <cstdint>

int main() {

    std::ifstream file("/data/l00936475/projects/3DGS_glTF_Render/3DGS_Render_glb_unpack/build/encoded.glb", std::ios::binary);
    if (!file.is_open()) {
        throw std::runtime_error("Failed to open file");
    }
    std::vector<uint8_t> buffer(std::istreambuf_iterator<char>(file), {});

    DecodeHandle decoderHandle;

    // Call decode function
    int result = decodeUI(&decoderHandle, buffer.data(), buffer.size(), true);
    if (!result) {
        std::cerr << "Decode failed" << std::endl;
        return 1;
    }

    // Check if decode result is valid
    GSData *gsData = getStructGSData(decoderHandle);
    if (gsData) {
        std::cout << "=== GSData Information ===" << std::endl;
        std::cout << "Point count: " << gsData->GSpointnum << std::endl;
        std::cout << "SH degree: " << gsData->SHdegree << std::endl;
        std::cout << "Position data size: " << gsData->posBitstreamSize << " bytes, pos[0,1,2]="<<gsData->gsAttributeBitstream.posBitstream[0]<<", "  << gsData->gsAttributeBitstream.posBitstream[1]<<", " <<gsData->gsAttributeBitstream.posBitstream[2]<<std::endl;
        std::cout << "Opacity data size: " << gsData->opacityBitstreamSize << " bytes, opacity="<<gsData->gsAttributeBitstream.opacityBitstream[0]<<std::endl;
        std::cout << "Scale data size: " << gsData->scaleBitstreamSize << " bytes, scale[0,1,2]="<<gsData->gsAttributeBitstream.scaleBitstream[0]<<", "  << gsData->gsAttributeBitstream.scaleBitstream[1]<<", " <<gsData->gsAttributeBitstream.scaleBitstream[2]<<std::endl;
        std::cout << "Rotation data size: " << gsData->rotationBitstreamSize << " bytes, pos[0,1,2]="<<gsData->gsAttributeBitstream.rotationBitstream[0]<<", "  << gsData->gsAttributeBitstream.rotationBitstream[1]<<", " <<gsData->gsAttributeBitstream.rotationBitstream[2]<<std::endl;
        std::cout << "Color data size: " << gsData->colorBitstreamSize  << " bytes, pos[0,1,2]="<<gsData->gsAttributeBitstream.colorBitstream[0]<<", "  << gsData->gsAttributeBitstream.colorBitstream[1]<<", " <<gsData->gsAttributeBitstream.colorBitstream[2]<<std::endl;
        std::cout << "SH data size: " << gsData->SHBitstreamSize  << " bytes, SH[0,1,2]="<<gsData->gsAttributeBitstream.SHBitstream[0]<<", "  << gsData->gsAttributeBitstream.SHBitstream[1]<<", " <<gsData->gsAttributeBitstream.SHBitstream[2]<<std::endl;
        // std::cout << "SH data size: " << gsData->SHBitstreamSize << " astcstream size " << gsData->astcBitstreamSize << " astc texture num " << gsData->shnAstcMeta.textureNum << " astc uv size " << gsData->astcUVstreamSize << " raw stream test " << static_cast<uint32_t>(gsData->gsAttributeBitstream.astcRawStream[0]) << " uv test " << gsData->gsAttributeBitstream.astcUVStream[0] << gsData->gsAttributeBitstream.astcUVStream[1] << gsData->gsAttributeBitstream.astcUVStream[2] << gsData->gsAttributeBitstream.astcUVStream[3] << " shnmin " << gsData->shnAstcMeta.shnMin << std::endl;
        // std::cout << std::endl;
    }
    std::cout << "result = " << result << std::endl;


    ViewInfo *viewinfo = getStructViewInfo(decoderHandle);
    if (viewinfo) {
        std::cout << "=== ViewInfo Information ===" << std::endl;
        std::cout << "yfov: " << viewinfo->yfov << std::endl;
        // Output initialPositionLookAt
        std::cout << "Initial position look at: ("
                  << viewinfo->initialPositionLookAt.x << ", "
                  << viewinfo->initialPositionLookAt.y << ", "
                  << viewinfo->initialPositionLookAt.z << ")" << std::endl;

        // Output target
        std::cout << "Target position: ("
                  << viewinfo->target.x << ", "
                  << viewinfo->target.y << ", "
                  << viewinfo->target.z << ")" << std::endl;

        // Output initialRotationLookAt (quaternion)
        std::cout << "Initial rotation (quaternion): ("
                  << viewinfo->initialRotationLookAt.x << ", "
                  << viewinfo->initialRotationLookAt.y << ", "
                  << viewinfo->initialRotationLookAt.z << ", "
                  << viewinfo->initialRotationLookAt.w << ")" << std::endl;

        // Output longitudeRange
        std::cout << "Longitude range: ["
                  << viewinfo->longitudeRange.x << ", "
                  << viewinfo->longitudeRange.y << "]" << std::endl;

        // Output latitudeRange
        std::cout << "Latitude range: ["
                  << viewinfo->latitudeRange.x << ", "
                  << viewinfo->latitudeRange.y << "]" << std::endl;

        // Output distanceRange
        std::cout << "Distance range: ["
                  << viewinfo->distanceRange.x << ", "
                  << viewinfo->distanceRange.y << "]" << std::endl;

        // Output boundingBoxMin
        std::cout << "Bounding box min: ("
                  << viewinfo->boundingBoxMin.x << ", "
                  << viewinfo->boundingBoxMin.y << ", "
                  << viewinfo->boundingBoxMin.z << ")" << std::endl;

        // Output boundingBoxMax
        std::cout << "Bounding box max: ("
                  << viewinfo->boundingBoxMax.x << ", "
                  << viewinfo->boundingBoxMax.y << ", "
                  << viewinfo->boundingBoxMax.z << ")" << std::endl;

        std::cout << std::endl;
    } else {
        std::cout << "ViewInfo is null" << std::endl;
    }

    std::vector<CameraMotionParams>* motionparams = getMotionParams(decoderHandle);
    if (motionparams) {
        std::cout << "=== motion params ===" << std::endl;
        int frameCount = std::min(3, static_cast<int>(motionparams->size()));
        for (int i = 0; i < frameCount; i++) {
            const CameraMotionParams& frame = (*motionparams)[i];
            std::cout << "Frame " << frame.id << ":" << std::endl;
            std::cout << "  YFOV: " << frame.yfov << " degrees" << std::endl;
            std::cout << "  Position: (" << frame.position.x << ", "
                    << frame.position.y << ", " << frame.position.z << ")" << std::endl;
            std::cout << "  Rotation: (" << frame.rotation.x << ", "
                    << frame.rotation.y << ", " << frame.rotation.z << ", "
                    << frame.rotation.w << ")" << std::endl;
            std::cout << std::endl;
        }

    } else {
        std::cout << "motion params are null" << std::endl;
    }

    // Destroy memory after use
    destroyDecode(decoderHandle);

    return 0;
}