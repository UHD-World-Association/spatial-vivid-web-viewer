#ifndef GS_DATA_H
#define GS_DATA_H

#include <vector>
#include <cstdint>
#include <string>
#include <map>

/**
 * Gaussian Splatting data structure.
 * Stores decoded Gaussian Splatting data.
 */
class SplatData {
public:
    struct AstcMeta {
        uint32_t astcBlockSize = 0;
        uint32_t astcWidth = 0;
        uint32_t astcHeight = 0;
        uint32_t singleWidth = 0;
        uint32_t numPoints = 0;
        uint32_t streamSize = 0;
    };

    SplatData();
    ~SplatData();

    // Attribute data.
    std::vector<float> means;        // Positions [N, 3].
    std::vector<float> opacity;      // Opacity [N, 1].
    std::vector<float> scaling;      // Scales [N, 3].
    std::vector<float> rotation;     // Rotations [N, 4].
    std::vector<float> features_dc;  // DC spherical harmonics coefficients [N, 1, 3].
    std::vector<float> features_rest; // Higher-order spherical harmonics coefficients [N, (sh_degree+1)^2-1, 3].
    std::vector<uint8_t> astcRawStream; // ASTC-compressed texture data for the GPU path, excluding the 16-byte ASTC header.
    std::vector<uint32_t> astcUV;       // ASTC sampling UV for each splat [N, 2].
    std::vector<AstcMeta> astcMetas;

    // Metadata.
    int numPoints;      // Point count.
    int shDegree;       // Spherical harmonics degree.
    uint32_t astcTextureNum;
    float shnMin;
    float shnMax;
    std::vector<float> shnMins;
    std::vector<float> shnMaxs;

    /**
     * Clears all stored data.
     */
    void clear();

    /**
     * Returns attribute data by name.
     */
    std::vector<float>& getAttribute(const std::string& name);
    const std::vector<float>& getAttribute(const std::string& name) const;

    /**
     * Sets attribute data by name.
     */
    void setAttribute(const std::string& name, const std::vector<float>& data);

    /**
     * Checks whether an attribute exists.
     */
    bool hasAttribute(const std::string& name) const;

    /**
     * Save as a PLY file.
     */
    bool savePLY(const std::string& plyPath) const;

private:
    std::map<std::string, std::vector<float>*> attributeMap;

    void initAttributeMap();
};

#endif // GS_DATA_H
