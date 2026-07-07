#include "gs_data.h"
#include <fstream>
#include <stdexcept>

SplatData::SplatData()
    : numPoints(0)
    , shDegree(0)
    , astcTextureNum(0)
    , shnMin(0.0f)
    , shnMax(0.0f)
{
    initAttributeMap();
}

SplatData::~SplatData() {
}

void SplatData::clear() {
    means.clear();
    opacity.clear();
    scaling.clear();
    rotation.clear();
    features_dc.clear();
    features_rest.clear();
    astcRawStream.clear();
    astcUV.clear();
    astcMetas.clear();
    numPoints = 0;
    astcTextureNum = 0;
    shnMin = 0.0f;
    shnMax = 0.0f;
    shnMins.clear();
    shnMaxs.clear();
}

std::vector<float>& SplatData::getAttribute(const std::string& name) {
    if (attributeMap.find(name) != attributeMap.end()) {
        return *attributeMap[name];
    }
    throw std::runtime_error("Attribute not found: " + name);
}

const std::vector<float>& SplatData::getAttribute(const std::string& name) const {
    if (attributeMap.find(name) != attributeMap.end()) {
        return *attributeMap.at(name);
    }
    throw std::runtime_error("Attribute not found: " + name);
}

void SplatData::setAttribute(const std::string& name, const std::vector<float>& data) {
    if (attributeMap.find(name) != attributeMap.end()) {
        *attributeMap[name] = data;
    } else {
        throw std::runtime_error("Attribute not found: " + name);
    }
}

bool SplatData::hasAttribute(const std::string& name) const {
    return attributeMap.find(name) != attributeMap.end();
}

bool SplatData::savePLY(const std::string& plyPath) const {
    // TODO: Implement PLY file output.
    // Python reference: gaussian.save_ply(ply_path).

    std::ofstream file(plyPath, std::ios::binary);
    if (!file.is_open()) {
        return false;
    }

    // Write the PLY header.
    file << "ply\n";
    file << "format binary_little_endian 1.0\n";
    file << "element vertex " << numPoints << "\n";

    // Write the property declarations.
    file << "property float x\n";
    file << "property float y\n";
    file << "property float z\n";
    file << "property float nx\n";
    file << "property float ny\n";
    file << "property float nz\n";

    // TODO: Add the remaining properties.

    file << "end_header\n";

    // TODO: Write the binary payload.

    file.close();
    return true;
}

void SplatData::initAttributeMap() {
    attributeMap["means"] = &means;
    attributeMap["opacity"] = &opacity;
    attributeMap["scaling"] = &scaling;
    attributeMap["rotation"] = &rotation;
    attributeMap["features_dc"] = &features_dc;
    attributeMap["features_rest"] = &features_rest;
}
