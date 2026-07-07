#include "transform.h"
#include <cmath>
#include <iostream>

Transform::Transform() {
}

Transform::~Transform() {
}

static void euler_to_quaternion_inplace(std::vector<float>& data, size_t num_points) {
    int numChannels = (data.size() / num_points >= 4) ? 4 : 3;

    for (size_t i = 0; i < num_points; i++) {
        float roll = data[i * numChannels + 0];
        float pitch = data[i * numChannels + 1];
        float yaw = data[i * numChannels + 2];

        float cr = std::cos(roll * 0.5f);
        float sr = std::sin(roll * 0.5f);
        float cp = std::cos(pitch * 0.5f);
        float sp = std::sin(pitch * 0.5f);
        float cy = std::cos(yaw * 0.5f);
        float sy = std::sin(yaw * 0.5f);

        float w = cr * cp * cy + sr * sp * sy;
        float x = sr * cp * cy - cr * sp * sy;
        float y = cr * sp * cy + sr * cp * sy;
        float z = cr * cp * sy - sr * sp * cy;

        data[i * 4 + 0] = w;
        data[i * 4 + 1] = x;
        data[i * 4 + 2] = y;
        data[i * 4 + 3] = z;
    }
}

bool Transform::deprocess(const std::map<std::string, std::vector<float>>& transformedAttrs,
                         std::map<std::string, std::vector<float>>& gsData,
                         const TransformMeta& meta) {
    std::vector<float> importance;
    if (transformedAttrs.find("importance") != transformedAttrs.end()) {
        importance = transformedAttrs.at("importance");
    }

    for (const auto& [attrName, data] : transformedAttrs) {
        if (attrName == "importance") {
            gsData[attrName] = data;
            continue;
        }

        int transformType = 0;
        if (meta.transformMap.find(attrName) != meta.transformMap.end()) {
            transformType = meta.transformMap.at(attrName);
        }

        std::vector<float> originalData;

        switch (transformType) {
            case 0:  // None
                gsData[attrName] = data;
                break;

            case 1:  // Reduction
                if (attrName == "rotation") {
                    if (!deprocessQuatReduction(data, originalData)) {
                        return false;
                    }
                    gsData[attrName] = std::move(originalData);
                } else {
                    gsData[attrName] = data;
                }
                break;

            case 2:  // Importance
                if (!importance.empty()) {
                    if (!deprocessImportance(data, originalData, importance)) {
                        return false;
                    }
                    gsData[attrName] = std::move(originalData);
                } else {
                    gsData[attrName] = data;
                }
                break;

            default:
                gsData[attrName] = data;
                break;
        }
    }

    return true;
}

bool Transform::deprocessQuatReduction(const std::vector<float>& transformed,
                                      std::vector<float>& original) {
    int numChannels = (transformed.size() % 4 == 0) ? 4 : 3;
    size_t num_points = transformed.size() / numChannels;

    original.resize(num_points * 4);

    for (size_t i = 0; i < num_points; i++) {
        original[i * 4 + 0] = transformed[i * numChannels + 0];
        original[i * 4 + 1] = transformed[i * numChannels + 1];
        original[i * 4 + 2] = transformed[i * numChannels + 2];
        original[i * 4 + 3] = 0;
    }

    euler_to_quaternion_inplace(original, num_points);
    return true;
}

bool Transform::deprocessImportance(const std::vector<float>& transformed,
                                   std::vector<float>& original,
                                   const std::vector<float>& importance) {
    if (importance.empty()) {
        original = transformed;
        return true;
    }

    size_t num_points = importance.size();
    size_t components_per_point = transformed.size() / num_points;

    original.resize(transformed.size());

    for (size_t i = 0; i < num_points; i++) {
        float factor = std::max(importance[i], 1e-6f);
        for (size_t c = 0; c < components_per_point; c++) {
            original[i * components_per_point + c] = transformed[i * components_per_point + c] / factor;
        }
    }

    return true;
}
