#ifndef QUANTIZER_H
#define QUANTIZER_H

#include <vector>
#include <cstdint>
#include <string>
#include <map>
#include "stream.h"

/**
 * Dequantizer.
 * Restores quantized data to its original floating-point representation.
 */
class Quantizer {
public:
    Quantizer();
    ~Quantizer();

    /**
     * Dequantize multiple attributes.
     * @param quantizedAttrs Quantized attribute data keyed by attribute name.
     * @param dequantizedAttrs Output floating-point data keyed by attribute name.
     * @param metaMap Quantization metadata keyed by attribute name.
     * @param blockIdx Block index for GroupMinMax; -1 processes the full model.
     * @return Whether the operation succeeded.
     */
    bool dequantize(std::map<std::string, std::vector<int32_t>>& quantizedAttrs,
                   std::map<std::string, std::vector<float>>& dequantizedAttrs,
                   const std::map<std::string, QuantMeta>& metaMap,
                   int blockIdx = -1, int pointsPerBlock = 256);

private:
    bool dequantizeNone(const std::vector<int32_t>& quantizedData,
                       std::vector<float>& dequantizedData);

    bool dequantizeStandard(const std::vector<int32_t>& quantizedData,
                           std::vector<float>& dequantizedData,
                           const QuantMeta& meta);

    bool dequantizeMinMax(const std::vector<int32_t>& quantizedData,
                         std::vector<float>& dequantizedData,
                         const QuantMeta& meta);

    bool dequantizeGroupMinMax(const std::vector<int32_t>& quantizedData,
                              std::vector<float>& dequantizedData,
                              const QuantMeta& meta,
                              int blockIdx, int pointsPerBlock);
};

#endif // QUANTIZER_H
