#include <emscripten/bind.h>

#include <cstdint>
#include <string>

#include "uwa_gsdecoder/gaussian_model/reconstruction_kernel.h"

using namespace emscripten;

namespace {

struct KernelResult {
    bool success = false;
    uint32_t protocolVersion = uwa::kShardProtocolVersion;
    uint32_t buildVersion = uwa::kShardBuildVersion;
    uint32_t startBlock = 0;
    uint32_t blockCount = 0;
    uint32_t startPoint = 0;
    uint32_t pointCount = 0;
    uintptr_t positionsPtr = 0;
    uintptr_t scalesPtr = 0;
    uintptr_t rotationsPtr = 0;
    uintptr_t colorsPtr = 0;
    uintptr_t validityPtr = 0;
    uintptr_t featuresRestPtr = 0;
    uint32_t featuresRestCount = 0;
    double packetParseMs = 0.0;
    double predictionMs = 0.0;
    double dequantizeMs = 0.0;
    double transformMs = 0.0;
    double nonlinearMs = 0.0;
    double outputCopyMs = 0.0;
    double totalMs = 0.0;
};

class SplatUWAReconstructionWasm {
public:
    bool initialize(uintptr_t metadataPtr, size_t metadataSize) {
        metadata_ = uwa::ReconstructionMetadata();
        result_.clear();
        lastError_.clear();
        if (metadataPtr == 0 || metadataSize == 0) {
            lastError_ = "Kernel received empty reconstruction metadata";
            return false;
        }
        return uwa::deserializeReconstructionMetadata(
            reinterpret_cast<const uint8_t*>(metadataPtr), metadataSize, metadata_, lastError_);
    }

    KernelResult reconstruct(uintptr_t packetPtr, size_t packetSize) {
        KernelResult output;
        if (metadata_.attributes.empty()) {
            lastError_ = "Kernel has not been initialized for a model";
            return output;
        }
        if (!uwa::reconstructPackedShard(metadata_, reinterpret_cast<const uint8_t*>(packetPtr),
                                         packetSize, result_, lastError_)) {
            return output;
        }

        output.success = true;
        output.startBlock = result_.startBlock;
        output.blockCount = result_.blockCount;
        output.startPoint = result_.startPoint;
        output.pointCount = result_.pointCount;
        output.positionsPtr = reinterpret_cast<uintptr_t>(result_.positions.data());
        output.scalesPtr = reinterpret_cast<uintptr_t>(result_.scales.data());
        output.rotationsPtr = reinterpret_cast<uintptr_t>(result_.rotations.data());
        output.colorsPtr = reinterpret_cast<uintptr_t>(result_.colors.data());
        output.validityPtr = reinterpret_cast<uintptr_t>(result_.validity.data());
        output.featuresRestPtr = reinterpret_cast<uintptr_t>(result_.featuresRest.data());
        output.featuresRestCount = static_cast<uint32_t>(result_.featuresRest.size());
        output.packetParseMs = result_.timings.packetParseMs;
        output.predictionMs = result_.timings.predictionMs;
        output.dequantizeMs = result_.timings.dequantizeMs;
        output.transformMs = result_.timings.transformMs;
        output.nonlinearMs = result_.timings.nonlinearMs;
        output.outputCopyMs = result_.timings.outputCopyMs;
        output.totalMs = result_.timings.totalMs;
        return output;
    }

    void releaseResult() { result_.clear(); }

    void dispose() {
        metadata_ = uwa::ReconstructionMetadata();
        result_.clear();
        lastError_.clear();
    }

    std::string getLastError() const { return lastError_; }

private:
    uwa::ReconstructionMetadata metadata_;
    uwa::ReconstructionResult result_;
    std::string lastError_;
};

} // namespace

EMSCRIPTEN_BINDINGS(splat_uwa_reconstruction_module) {
    value_object<KernelResult>("KernelResult")
        .field("success", &KernelResult::success)
        .field("protocolVersion", &KernelResult::protocolVersion)
        .field("buildVersion", &KernelResult::buildVersion)
        .field("startBlock", &KernelResult::startBlock)
        .field("blockCount", &KernelResult::blockCount)
        .field("startPoint", &KernelResult::startPoint)
        .field("pointCount", &KernelResult::pointCount)
        .field("positionsPtr", &KernelResult::positionsPtr)
        .field("scalesPtr", &KernelResult::scalesPtr)
        .field("rotationsPtr", &KernelResult::rotationsPtr)
        .field("colorsPtr", &KernelResult::colorsPtr)
        .field("validityPtr", &KernelResult::validityPtr)
        .field("featuresRestPtr", &KernelResult::featuresRestPtr)
        .field("featuresRestCount", &KernelResult::featuresRestCount)
        .field("packetParseMs", &KernelResult::packetParseMs)
        .field("predictionMs", &KernelResult::predictionMs)
        .field("dequantizeMs", &KernelResult::dequantizeMs)
        .field("transformMs", &KernelResult::transformMs)
        .field("nonlinearMs", &KernelResult::nonlinearMs)
        .field("outputCopyMs", &KernelResult::outputCopyMs)
        .field("totalMs", &KernelResult::totalMs);

    class_<SplatUWAReconstructionWasm>("SplatUWAReconstructionWasm")
        .constructor<>()
        .function("initialize", &SplatUWAReconstructionWasm::initialize)
        .function("reconstruct", &SplatUWAReconstructionWasm::reconstruct)
        .function("releaseResult", &SplatUWAReconstructionWasm::releaseResult)
        .function("dispose", &SplatUWAReconstructionWasm::dispose)
        .function("getLastError", &SplatUWAReconstructionWasm::getLastError);
}
