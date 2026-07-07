#include <iostream>
#include <vector>
#include <string>
#include <chrono>
#include <iomanip>
#include "processor/stream.h"
#include "gaussian_model/gs_decoder.h"
#include "gaussian_model/gs_data.h"

/**
 * Simple timing recorder.
 */
class Timer {
public:
    Timer() : totalMs(0) {}

    void start() {
        startTime = std::chrono::high_resolution_clock::now();
    }

    double stop() {
        auto endTime = std::chrono::high_resolution_clock::now();
        double ms = std::chrono::duration<double, std::milli>(endTime - startTime).count();
        totalMs += ms;
        return ms;
    }

    double getTotalMs() const { return totalMs; }
    void reset() { totalMs = 0; }

private:
    std::chrono::high_resolution_clock::time_point startTime;
    double totalMs;
};

int main(int argc, char* argv[]) {
    std::cout << "========================================" << std::endl;
    std::cout << "  GSDecoder Test Program" << std::endl;
    std::cout << "========================================" << std::endl;

    if (argc < 2) {
        std::cout << "Usage: " << argv[0] << " <bin_file> [ply_file]" << std::endl;
        std::cout << "Using default file: ../GSCompressed_r00.bin" << std::endl;
    }

    std::string binFile = (argc >= 2) ? argv[1] : "../GSCompressed_r00.bin";
    std::string plyFile = (argc >= 3) ? argv[2] : "output.ply";

    Timer totalTimer;
    totalTimer.start();

    // Run the full GSDecoder decode test.
    GSDecoder decoder;
    SplatData gsData;

    std::cout << "\nInput file: " << binFile << std::endl;
    std::cout << "Starting decode..." << std::endl;

    bool gsDecoderTest = decoder.decode(binFile, gsData);

    double decodeTime = totalTimer.stop();

    // Save as a PLY file.
    bool plySaveTest = false;
    double savePlyMs = 0;
    if (gsDecoderTest) {
        Timer plyTimer;
        plyTimer.start();
        std::cout << "\nSaving to PLY: " << plyFile << std::endl;
        plySaveTest = decoder.savePLY(plyFile, gsData);
        savePlyMs = plyTimer.stop();
    }

    double totalTime = totalTimer.getTotalMs();

    // Print data statistics.
    if (gsDecoderTest) {
        std::cout << "\n========== Data Statistics ==========" << std::endl;
        std::cout << "Number of points: " << gsData.numPoints << std::endl;
        std::cout << "SH degree: " << gsData.shDegree << std::endl;

        if (!gsData.means.empty()) {
            std::cout << "  Means: " << gsData.means.size() / 3 << " points" << std::endl;
        }
        if (!gsData.opacity.empty()) {
            std::cout << "  Opacity: " << gsData.opacity.size() << " values" << std::endl;
            float minOpacity = gsData.opacity[0];
            float maxOpacity = gsData.opacity[0];
            for (size_t i = 1; i < gsData.opacity.size(); i++) {
                if (gsData.opacity[i] < minOpacity) minOpacity = gsData.opacity[i];
                if (gsData.opacity[i] > maxOpacity) maxOpacity = gsData.opacity[i];
            }
            std::cout << "  Opacity range: [" << minOpacity << ", " << maxOpacity << "]" << std::endl;
        }
        if (!gsData.scaling.empty()) {
            std::cout << "  Scaling: " << gsData.scaling.size() / 3 << " points" << std::endl;
        }
        if (!gsData.rotation.empty()) {
            std::cout << "  Rotation: " << gsData.rotation.size() / 4 << " points" << std::endl;
        }
        if (!gsData.features_dc.empty()) {
            std::cout << "  Features DC: " << gsData.features_dc.size() / 3 << " points" << std::endl;
        }
        if (!gsData.features_rest.empty()) {
            std::cout << "  Features Rest: " << gsData.features_rest.size() / 3 << " components" << std::endl;
        }
    }

    // Print timing statistics.
    TimingStats& timing = getTimingStats();
    timing.print();

    // Print the PLY save time.
    std::cout << std::fixed << std::setprecision(2);
    std::cout << "  Save PLY:         " << std::setw(10) << savePlyMs << " ms" << std::endl;
    std::cout << "  ========================================" << std::endl;
    std::cout << "  Total:            " << std::setw(10) << totalTime + savePlyMs << " ms" << std::endl;

    // Print the summary.
    std::cout << "\n========================================" << std::endl;
    std::cout << "  Test Summary" << std::endl;
    std::cout << "========================================" << std::endl;
    std::cout << "GSDecoder Full Test: " << (gsDecoderTest ? "PASS" : "FAIL") << std::endl;
    std::cout << "PLY Save Test: " << (plySaveTest ? "PASS" : "FAIL") << std::endl;
    std::cout << "========================================" << std::endl;

    if (gsDecoderTest && plySaveTest) {
        std::cout << "\nAll tests PASSED!" << std::endl;
    } else {
        std::cout << "\nSome tests FAILED!" << std::endl;
    }

    return (gsDecoderTest && plySaveTest) ? 0 : 1;
}
