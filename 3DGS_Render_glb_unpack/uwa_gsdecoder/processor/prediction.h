#ifndef PREDICTION_H
#define PREDICTION_H

#include <vector>
#include <cstdint>
#include <string>
#include <map>
#include "stream.h"

/**
 * Prediction processor.
 * Handles predictive coding for attributes.
 */
class Prediction {
public:
    Prediction();
    ~Prediction();

    /**
     * Apply inverse prediction to multiple attributes.
     * @param quantizedAttrs Quantized attribute data keyed by attribute name.
     * @param metaMap Prediction metadata keyed by attribute name.
     * @return Whether the operation succeeded.
     */
    bool deprocess(std::map<std::string, std::vector<int32_t>>& quantizedAttrs,
                  const std::map<std::string, PredictionMeta>& metaMap);

private:
    /**
     * Reverse Minor prediction.
     */
    bool deprocessMinor(std::vector<int32_t>& data, int byteshift, int numChannels);

    /**
     * Reverse MinorBlock prediction.
     */
    bool deprocessMinorBlock(std::vector<int32_t>& data, int byteshift, int blockSize, int numChannels);

    // Reusable work buffer to avoid repeated allocation.
    std::vector<int32_t> x_h_buffer_;
    std::vector<int32_t> x_l_buffer_;
};

#endif // PREDICTION_H
