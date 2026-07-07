#ifndef TRANSFORM_H
#define TRANSFORM_H

#include <vector>
#include <cstdint>
#include <string>
#include <map>
#include "stream.h"

/**
 * Inverse transformer.
 * Restores transformed data to the original Gaussian Splatting representation.
 */
class Transform {
public:
    Transform();
    ~Transform();

    /**
     * Apply inverse transforms to multiple attributes.
     * @param transformedAttrs Transformed attribute data.
     * @param gsData Gaussian Splatting data.
     * @param meta Transform metadata.
     * @return Whether the operation succeeded.
     */
    bool deprocess(const std::map<std::string, std::vector<float>>& transformedAttrs,
                  std::map<std::string, std::vector<float>>& gsData,
                  const TransformMeta& meta);

private:
    bool deprocessQuatReduction(const std::vector<float>& transformed,
                               std::vector<float>& original);

    bool deprocessImportance(const std::vector<float>& transformed,
                            std::vector<float>& original,
                            const std::vector<float>& importance);
};

#endif // TRANSFORM_H
