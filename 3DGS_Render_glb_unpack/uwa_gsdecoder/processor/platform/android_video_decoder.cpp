#include "platform_video_decoder.h"
#include <iostream>
#include <cstring>
#include <thread>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <chrono>

#ifdef __ANDROID__
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>
#include <android/log.h>

#define LOG_TAG "GSDecoder"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// Decode timeout: two seconds.
constexpr int64_t DECODE_TIMEOUT_MS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Shared state for asynchronous callbacks on API 28 and later.
// ─────────────────────────────────────────────────────────────────────────────
struct AsyncDecodeContext {
    AMediaCodec* codec = nullptr;

    // Input-side state.
    std::mutex              in_mtx;
    std::condition_variable in_cv;
    int32_t                 in_index = -1;   // Available input-buffer index.

    // Output-side state.
    std::mutex              out_mtx;
    std::condition_variable out_cv;
    int32_t                 out_index = -1;
    AMediaCodecBufferInfo   out_info  = {};
    std::atomic<bool>       output_ready{false};
    std::atomic<bool>       codec_error{false};
};

// ─────────────────────────────────────────────────────────────────────────────
// Asynchronous callbacks run on MediaCodec threads and must return quickly.
// ─────────────────────────────────────────────────────────────────────────────
#if __ANDROID_API__ >= 28
static void on_async_input_available(AMediaCodec* /*codec*/, void* userdata, int32_t index) {
    auto* ctx = static_cast<AsyncDecodeContext*>(userdata);
    {
        std::lock_guard<std::mutex> lk(ctx->in_mtx);
        ctx->in_index = index;
    }
    ctx->in_cv.notify_one();
}

static void on_async_output_available(AMediaCodec* /*codec*/, void* userdata,
                                      int32_t index, AMediaCodecBufferInfo* info) {
    auto* ctx = static_cast<AsyncDecodeContext*>(userdata);
    // Skip codec-configuration packets.
    if (info->flags & AMEDIACODEC_BUFFER_FLAG_CODEC_CONFIG) {
        AMediaCodec_releaseOutputBuffer(ctx->codec, static_cast<size_t>(index), false);
        return;
    }
    {
        std::lock_guard<std::mutex> lk(ctx->out_mtx);
        ctx->out_index = index;
        ctx->out_info  = *info;
    }
    ctx->output_ready.store(true, std::memory_order_release);
    ctx->out_cv.notify_one();
}

static void on_async_format_changed(AMediaCodec* /*codec*/, void* userdata, AMediaFormat* format) {
    // Format changes are expected; update cached format information here.
    LOGI("Async format changed");
}

static void on_async_error(AMediaCodec* /*codec*/, void* userdata,
                           media_status_t error, int32_t /*action*/, const char* detail) {
    LOGE("Codec async error: %d  %s", error, detail ? detail : "");
    auto* ctx = static_cast<AsyncDecodeContext*>(userdata);
    ctx->codec_error.store(true, std::memory_order_release);
    ctx->in_cv.notify_all();
    ctx->out_cv.notify_all();
}
#endif

/**
 * Android MediaCodec hardware video decoder.
 * Uses the Android NDK MediaCodec API for hardware H.264/AVC and H.265/HEVC decoding.
 * Prefers asynchronous callbacks on API 28 and later and uses synchronous mode on older versions.
 */
class AndroidVideoDecoder : public IPlatformVideoDecoder {
public:
    AndroidVideoDecoder()
            : codec(nullptr)
            , width(0)
            , height(0)
            , configured(false)
            , useAsyncMode(false)
            , lastOutputPixelFormat(VideoPixelFormat::I420)
    {
#if __ANDROID_API__ >= 28
        useAsyncMode = true;  // Use asynchronous mode by default on API 28 and later.
#endif
    }

    ~AndroidVideoDecoder() override {
        reset();
    }

    bool decode(const std::vector<uint8_t>& encoded,
                std::vector<uint8_t>& decoded,
                int width, int height) override {
        LOGI("decode() called: encoded.size()=%zu, width=%d, height=%d", encoded.size(), width, height);

        try {
            // Reconfigure when the dimensions or codec change.
            if (this->width != width || this->height != height || !configured) {
                LOGI("Reconfiguring codec: old=%dx%d, new=%dx%d, configured=%d",
                     this->width, this->height, width, height, configured);
                this->width = width;
                this->height = height;
                if (!configureCodec()) {
                    LOGE("Failed to configure codec");
                    return false;
                }
                LOGI("Codec reconfigured successfully");
            }

            LOGI("Calling decodeFrame()...");
            // Decode the input data.
            bool result = decodeFrame(encoded, decoded);
            LOGI("decodeFrame() returned: %s", result ? "true" : "false");
            return result;
        } catch (const std::exception& e) {
            LOGE("Hardware decode exception: %s", e.what());
            return false;
        } catch (...) {
            LOGE("Hardware decode unknown exception");
            return false;
        }
    }

    bool decodeToLayout(const std::vector<uint8_t>& encoded,
                        std::vector<uint8_t>& decoded,
                        int width, int height,
                        VideoFrameLayout& layout) override {
        if (!decode(encoded, decoded, width, height)) return false;
        layout = {
            lastOutputPixelFormat,
            static_cast<uint32_t>(width),
            static_cast<uint32_t>(height),
            1
        };
        size_t expectedBytes = 0;
        return videoFrameByteLength(layout, expectedBytes) && decoded.size() == expectedBytes;
    }

    bool isHardwareAccelerated() const override {
        return true;
    }

    void reset() override {
        if (codec) {
            AMediaCodec_stop(codec);
            AMediaCodec_delete(codec);
            codec = nullptr;
        }
        configured = false;
        formatCached = false;  // Reset the format cache.
        cachedStride = 0;
        cachedSliceHeight = 0;
        cachedColorFormat = 0;
        useAsyncMode = false;
#if __ANDROID_API__ >= 28
        useAsyncMode = true;
#endif
        // Reset asynchronous state field by field because mutexes are not copyable.
        asyncCtx.codec = nullptr;
        asyncCtx.in_index = -1;
        asyncCtx.out_index = -1;
        asyncCtx.out_info = {};
        asyncCtx.output_ready.store(false, std::memory_order_release);
        asyncCtx.codec_error.store(false, std::memory_order_release);
    }

private:
    AMediaCodec* codec;
    int width;
    int height;
    bool configured;
    bool useAsyncMode;  // Whether asynchronous mode is enabled on API 28 and later.
    VideoPixelFormat lastOutputPixelFormat;

    // Asynchronous-mode context.
    AsyncDecodeContext asyncCtx;

    // Cache format information to avoid querying it for every frame.
    int cachedStride = 0;
    int cachedSliceHeight = 0;
    int cachedColorFormat = 0;
    bool formatCached = false;

    /**
     * Configures the MediaCodec decoder.
     * Prefers asynchronous mode on API 28 and later and uses synchronous mode for compatibility with older versions.
     */
    bool configureCodec() {
        // Release the previous codec instance.
        if (codec) {
            AMediaCodec_stop(codec);
            AMediaCodec_delete(codec);
            codec = nullptr;
        }

        // Select the decoder MIME type from codecId.
        const char* mimeType;
        if (codecId == CODEC_ID_H264) {
            mimeType = "video/avc";  // H.264/AVC
        } else {
            mimeType = "video/hevc";  // H.265/HEVC
        }

        // Create the decoder.
        codec = AMediaCodec_createDecoderByType(mimeType);
        if (!codec) {
            LOGE("Failed to create %s decoder", mimeType);
            return false;
        }

        // Create the video format.
        AMediaFormat* format = AMediaFormat_new();
        AMediaFormat_setString(format, AMEDIAFORMAT_KEY_MIME, mimeType);
        AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_WIDTH, width);
        AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_HEIGHT, height);
        AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_COLOR_FORMAT, 0x13);  // COLOR_FormatYUV420Planar

        // Low-latency mode on API 30 and later prevents the decoder from retaining extra frames.
#if __ANDROID_API__ >= 30
        AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_LOW_LATENCY, 1);
        LOGI("Low latency mode enabled (API 30+)");
#endif

        LOGI("Configuring codec: %dx%d, color_format=YUV420Planar, async=%d",
             width, height, useAsyncMode);

        // ── Register asynchronous callbacks before configure on API 28 and later ──
        if (useAsyncMode) {
#if __ANDROID_API__ >= 28
            asyncCtx.codec = codec;
            AMediaCodecOnAsyncNotifyCallback asyncCallbacks = {
                .onAsyncInputAvailable  = on_async_input_available,
                .onAsyncOutputAvailable = on_async_output_available,
                .onAsyncFormatChanged   = on_async_format_changed,
                .onAsyncError           = on_async_error,
            };
            media_status_t status = AMediaCodec_setAsyncNotifyCallback(codec, asyncCallbacks, &asyncCtx);
            if (status != AMEDIA_OK) {
                LOGE("Failed to set async callback: %d, fallback to sync mode", status);
                useAsyncMode = false;
            } else {
                LOGI("Async mode enabled (API 28+)");
            }
#endif
        }

        // Configure without a Surface to produce ByteBuffer output with minimal latency.
        media_status_t status = AMediaCodec_configure(codec, format, nullptr, nullptr, 0);
        AMediaFormat_delete(format);

        if (status != AMEDIA_OK) {
            LOGE("Failed to configure codec: %d", status);
            AMediaCodec_delete(codec);
            codec = nullptr;
            return false;
        }

        // Start the decoder.
        status = AMediaCodec_start(codec);
        if (status != AMEDIA_OK) {
            LOGE("Failed to start codec: %d", status);
            AMediaCodec_delete(codec);
            codec = nullptr;
            return false;
        }

        configured = true;
        LOGI("MediaCodec configured: %dx%d, codec: %s, mode: %s",
             width, height, mimeType, useAsyncMode ? "async" : "sync");
        return true;
    }

    /**
     * Decodes one frame.
     * Asynchronous mode waits for callbacks through condition_variable.
     * Synchronous mode waits with dequeue operations and timeouts.
     */
    bool decodeFrame(const std::vector<uint8_t>& encoded,
                     std::vector<uint8_t>& decoded) {
        if (!codec) {
            LOGE("Codec not initialized");
            return false;
        }

        const auto deadline = std::chrono::steady_clock::now()
                            + std::chrono::milliseconds(DECODE_TIMEOUT_MS);

        // ── Asynchronous mode on API 28 and later ──
        if (useAsyncMode) {
#if __ANDROID_API__ >= 28
            // Reset asynchronous state.
            asyncCtx.in_index = -1;
            asyncCtx.out_index = -1;
            asyncCtx.output_ready.store(false, std::memory_order_release);
            asyncCtx.codec_error.store(false, std::memory_order_release);

            // 1. Wait for an input buffer.
            int32_t inputIndex = -1;
            {
                std::unique_lock<std::mutex> lk(asyncCtx.in_mtx);
                bool got = asyncCtx.in_cv.wait_until(lk, deadline, [&]{
                    return asyncCtx.in_index >= 0 || asyncCtx.codec_error.load();
                });
                if (!got || asyncCtx.codec_error.load()) {
                    LOGE("Timed out or error waiting for input buffer");
                    return false;
                }
                inputIndex = asyncCtx.in_index;
                asyncCtx.in_index = -1;
            }

            // 2. Acquire an input buffer and fill it.
            size_t inputCapacity = 0;
            uint8_t* inputBuffer = AMediaCodec_getInputBuffer(
                    codec, static_cast<size_t>(inputIndex), &inputCapacity);
            if (!inputBuffer || inputCapacity < encoded.size()) {
                LOGE("Input buffer invalid or too small: capacity=%zu need=%zu",
                     inputCapacity, encoded.size());
                return false;
            }

            size_t copySize = std::min(encoded.size(), inputCapacity);
            std::memcpy(inputBuffer, encoded.data(), copySize);

            // 3. Submit the frame with the EOS flag to force immediate output.
            media_status_t status = AMediaCodec_queueInputBuffer(
                    codec,
                    static_cast<size_t>(inputIndex),
                    0, copySize,
                    0,  // presentationTimeUs
                    AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM
            );
            if (status != AMEDIA_OK) {
                LOGE("Failed to queue input buffer: %d", status);
                return false;
            }
            LOGI("Async: Queued input buffer with EOS flag");

            // 4. Wait for an output buffer.
            int32_t outputIndex = -1;
            AMediaCodecBufferInfo outputInfo = {};
            {
                std::unique_lock<std::mutex> lk(asyncCtx.out_mtx);
                bool got = asyncCtx.out_cv.wait_until(lk, deadline, [&]{
                    return asyncCtx.output_ready.load(std::memory_order_acquire)
                        || asyncCtx.codec_error.load();
                });
                if (!got || asyncCtx.codec_error.load()) {
                    LOGE("Timed out or error waiting for output buffer");
                    return false;
                }
                outputIndex = asyncCtx.out_index;
                outputInfo = asyncCtx.out_info;
            }

            LOGI("Async: Got output buffer index: %d, size: %d, offset: %d, flags: %d",
                 outputIndex, outputInfo.size, outputInfo.offset, outputInfo.flags);

            // 5. Retrieve the output data.
            size_t outputSize = 0;
            uint8_t* outputBuffer = AMediaCodec_getOutputBuffer(
                    codec, static_cast<size_t>(outputIndex), &outputSize);
            if (!outputBuffer) {
                LOGE("Failed to get output buffer pointer");
                AMediaCodec_releaseOutputBuffer(codec, static_cast<size_t>(outputIndex), false);
                return false;
            }

            if (outputInfo.offset < 0 || outputInfo.size < 0 ||
                static_cast<size_t>(outputInfo.offset) > outputSize ||
                static_cast<size_t>(outputInfo.size) >
                    outputSize - static_cast<size_t>(outputInfo.offset)) {
                LOGE("Invalid output buffer range: offset=%d, size=%d, capacity=%zu",
                     outputInfo.offset, outputInfo.size, outputSize);
                AMediaCodec_releaseOutputBuffer(codec, static_cast<size_t>(outputIndex), false);
                return false;
            }

            // 6. Extract the YUV data.
            if (!extractYUVData(outputBuffer + outputInfo.offset, decoded, outputInfo.size)) {
                LOGE("Failed to extract YUV data");
                AMediaCodec_releaseOutputBuffer(codec, static_cast<size_t>(outputIndex), false);
                return false;
            }

            // 7. Release the output buffer.
            AMediaCodec_releaseOutputBuffer(codec, static_cast<size_t>(outputIndex), false);

            LOGI("Async: Decoded frame: %zu bytes", decoded.size());
            return true;
#endif
        }

        // ── Synchronous mode for compatibility with older versions ──
        // 1. Dequeue an input-buffer index with a two-second timeout.
        ssize_t inputIndex = AMediaCodec_dequeueInputBuffer(codec, DECODE_TIMEOUT_MS * 1000);
        if (inputIndex < 0) {
            LOGE("Failed to get input buffer: %zd", inputIndex);
            return false;
        }

        // 2. Acquire the input buffer.
        size_t inputSize;
        uint8_t* inputBuffer = AMediaCodec_getInputBuffer(codec, inputIndex, &inputSize);
        if (!inputBuffer) {
            LOGE("Failed to get input buffer pointer");
            return false;
        }

        // 3. Fill the input buffer.
        size_t copySize = (encoded.size() < inputSize) ? encoded.size() : inputSize;
        memcpy(inputBuffer, encoded.data(), copySize);

        // 4. Queue the input buffer with the EOS flag to force immediate output.
        media_status_t status = AMediaCodec_queueInputBuffer(
                codec, inputIndex, 0, copySize,
                0,  // presentationTimeUs
                AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM
        );
        if (status != AMEDIA_OK) {
            LOGE("Failed to queue input buffer: %d", status);
            return false;
        }
        LOGI("Sync: Queued input buffer with EOS flag");

        // 5. Dequeue an output buffer with a two-second timeout.
        AMediaCodecBufferInfo info;
        ssize_t outputIndex;

        outputIndex = AMediaCodec_dequeueOutputBuffer(codec, &info, DECODE_TIMEOUT_MS * 1000);

        if (outputIndex == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
            LOGI("Output format changed");
            outputIndex = AMediaCodec_dequeueOutputBuffer(codec, &info, DECODE_TIMEOUT_MS * 1000);
        } else if (outputIndex == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED) {
            LOGI("Output buffers changed");
            outputIndex = AMediaCodec_dequeueOutputBuffer(codec, &info, DECODE_TIMEOUT_MS * 1000);
        } else if (outputIndex < 0) {
            LOGE("Failed to dequeue output buffer: %zd", outputIndex);
            return false;
        }

        LOGI("Sync: Got output buffer index: %zd, size: %d, offset: %d, flags: %d",
             outputIndex, info.size, info.offset, info.flags);

        // 6. Retrieve the output data.
        size_t outputSize;
        uint8_t* outputBuffer = AMediaCodec_getOutputBuffer(codec, outputIndex, &outputSize);
        if (!outputBuffer) {
            LOGE("Failed to get output buffer pointer");
            AMediaCodec_releaseOutputBuffer(codec, outputIndex, false);
            return false;
        }

        if (info.offset < 0 || info.size < 0 ||
            static_cast<size_t>(info.offset) > outputSize ||
            static_cast<size_t>(info.size) > outputSize - static_cast<size_t>(info.offset)) {
            LOGE("Invalid output buffer range: offset=%d, size=%d, capacity=%zu",
                 info.offset, info.size, outputSize);
            AMediaCodec_releaseOutputBuffer(codec, outputIndex, false);
            return false;
        }

        // 7. Extract the YUV data.
        if (!extractYUVData(outputBuffer + info.offset, decoded, info.size)) {
            LOGE("Failed to extract YUV data");
            AMediaCodec_releaseOutputBuffer(codec, outputIndex, false);
            return false;
        }

        // 8. Release the output buffer.
        AMediaCodec_releaseOutputBuffer(codec, outputIndex, false);

        LOGI("Sync: Decoded frame: %zu bytes", decoded.size());
        return true;
    }

    /**
     * Extracts tightly packed YUV data from MediaCodec output.
     * Optimized to reduce memory copies by using direct pointer operations.
     */
    bool extractYUVData(const uint8_t* srcData, std::vector<uint8_t>& dstData, size_t srcSize) {
        // Query output-format information only initially or after a format change.
        if (!formatCached) {
            AMediaFormat* format = AMediaCodec_getOutputFormat(codec);
            if (!format) {
                LOGE("Failed to get output format");
                return false;
            }

            AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_STRIDE, &cachedStride);
            AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_COLOR_FORMAT, &cachedColorFormat);

            // AMEDIAFORMAT_KEY_SLICE_HEIGHT is available only on Android 28 and later.
#if __ANDROID_API__ >= 28
            AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_SLICE_HEIGHT, &cachedSliceHeight);
#endif

            AMediaFormat_delete(format);
            formatCached = true;

            LOGI("Cached format: stride=%d, sliceHeight=%d, colorFormat=%d",
                 cachedStride, cachedSliceHeight, cachedColorFormat);
        }

        // Use the cached format information.
        int stride = cachedStride;
        int sliceHeight = cachedSliceHeight;

        // Use default stride and slice height when the format does not report them.
        if (stride <= 0) stride = width;
        if (sliceHeight <= 0) sliceHeight = height;

        // Calculate the Y-plane size.
        int ySize = width * height;

        if ((width & 1) != 0 || (height & 1) != 0 || srcSize < static_cast<size_t>(width)) {
            LOGE("Unsupported odd or truncated YUV420 output");
            return false;
        }

        // MediaCodec color formats are part of the output contract. I420 and
        // NV12 have identical byte sizes, so a size-based guess is unsafe.
        constexpr int COLOR_FORMAT_YUV420_PLANAR = 0x13;
        constexpr int COLOR_FORMAT_YUV420_SEMIPLANAR = 0x15;
        const bool isPlanar420 = cachedColorFormat == COLOR_FORMAT_YUV420_PLANAR;
        const bool isSemiPlanar420 = cachedColorFormat == COLOR_FORMAT_YUV420_SEMIPLANAR;
        if (!isPlanar420 && !isSemiPlanar420) {
            LOGE("Unsupported or ambiguous MediaCodec color format: %d", cachedColorFormat);
            return false;
        }

        const int uvWidth = width / 2;
        const int uvHeight = height / 2;
        const int uvPlaneStride = stride / 2;
        const int uvSliceHeight = sliceHeight / 2;
        if (stride < width || sliceHeight < height || (stride & 1) != 0 ||
            (sliceHeight & 1) != 0 || uvPlaneStride < uvWidth) {
            LOGE("Invalid MediaCodec YUV420 stride or slice height");
            return false;
        }
        const size_t yPlaneSize = static_cast<size_t>(sliceHeight) * static_cast<size_t>(stride);
        const size_t lastRequiredByte = isSemiPlanar420 ?
            yPlaneSize + static_cast<size_t>(uvHeight - 1) * stride + width :
            yPlaneSize + static_cast<size_t>(uvSliceHeight) * uvPlaneStride +
                static_cast<size_t>(uvHeight - 1) * uvPlaneStride + uvWidth;
        if (lastRequiredByte > srcSize) {
            LOGE("MediaCodec output is shorter than its declared plane layout");
            return false;
        }

        LOGI("Video format: %s (stride=%d, sliceHeight=%d, srcSize=%zu)",
             isSemiPlanar420 ? "NV12" : "I420",
             stride, sliceHeight, srcSize);

        const int uvSize = uvWidth * uvHeight;
        int totalSize = ySize + uvSize * 2;
        dstData.resize(totalSize);
        lastOutputPixelFormat = VideoPixelFormat::I420;

        uint8_t* dst = dstData.data();
        const uint8_t* src = srcData;
        const int numThreads = std::thread::hardware_concurrency();

        // Extract the Y plane in parallel.
        if (stride == width) {
            // Fast path: copy once when there is no padding.
            memcpy(dst, src, ySize);
        } else {
            // With padding, copy rows in parallel.
            if (numThreads > 1 && height > 64) {
                std::vector<std::thread> threads;
                int rowsPerThread = height / numThreads;
                for (int t = 0; t < numThreads; t++) {
                    int startY = t * rowsPerThread;
                    int endY = (t == numThreads - 1) ? height : (t + 1) * rowsPerThread;
                    threads.emplace_back([dst, src, this, stride, startY, endY]() {
                        for (int y = startY; y < endY; y++) {
                            memcpy(dst + y * width, src + y * stride, width);
                        }
                    });
                }
                for (auto& t : threads) t.join();
            } else {
                for (int y = 0; y < height; y++) {
                    memcpy(dst + y * width, src + y * stride, width);
                }
            }
        }

        // Extract the U and V planes in parallel.
        {
            const uint8_t* uvPlane = src + yPlaneSize;
            uint8_t* dstU = dst + ySize;
            uint8_t* dstV = dst + ySize + uvSize;

            // Distinguish interleaved NV12 from planar I420.
            bool isNV12 = isSemiPlanar420;

            if (isNV12) {
                // Convert NV12 interleaved UVUVUV data into separate U and V planes.
                int uvStride = stride;

                // Convert NV12 chroma in parallel.
                if (numThreads > 1 && uvHeight > 32) {
                    std::vector<std::thread> threads;
                    int rowsPerThread = uvHeight / numThreads;
                    for (int t = 0; t < numThreads; t++) {
                        int startY = t * rowsPerThread;
                        int endY = (t == numThreads - 1) ? uvHeight : (t + 1) * rowsPerThread;
                        threads.emplace_back([uvPlane, dstU, dstV, uvWidth, uvStride, startY, endY]() {
                            for (int y = startY; y < endY; y++) {
                                const uint8_t* srcRow = uvPlane + y * uvStride;
                                uint8_t* dstURow = dstU + y * uvWidth;
                                uint8_t* dstVRow = dstV + y * uvWidth;

                                for (int x = 0; x < uvWidth; x++) {
                                    dstURow[x] = srcRow[x * 2];      // U
                                    dstVRow[x] = srcRow[x * 2 + 1];  // V
                                }
                            }
                        });
                    }
                    for (auto& t : threads) t.join();
                } else {
                    for (int y = 0; y < uvHeight; y++) {
                        const uint8_t* srcRow = uvPlane + y * uvStride;
                        uint8_t* dstURow = dstU + y * uvWidth;
                        uint8_t* dstVRow = dstV + y * uvWidth;

                        for (int x = 0; x < uvWidth; x++) {
                            dstURow[x] = srcRow[x * 2];      // U
                            dstVRow[x] = srcRow[x * 2 + 1];  // V
                        }
                    }
                }
            } else {
                // For I420 or YUV444, copy the planar data directly.
                const uint8_t* uPlane = uvPlane;
                const uint8_t* vPlane = uvPlane + uvSliceHeight * uvPlaneStride;

                if (uvPlaneStride == uvWidth) {
                    // Copy once when there is no padding.
                    memcpy(dstU, uPlane, uvSize);
                    memcpy(dstV, vPlane, uvSize);
                } else {
                    // With padding, copy rows in parallel.
                    if (numThreads > 1 && uvHeight > 32) {
                        std::vector<std::thread> threads;
                        int rowsPerThread = uvHeight / numThreads;
                        for (int t = 0; t < numThreads; t++) {
                            int startY = t * rowsPerThread;
                            int endY = (t == numThreads - 1) ? uvHeight : (t + 1) * rowsPerThread;
                            threads.emplace_back([uPlane, vPlane, dstU, dstV, uvWidth, uvPlaneStride, startY, endY]() {
                                for (int y = startY; y < endY; y++) {
                                    memcpy(dstU + y * uvWidth, uPlane + y * uvPlaneStride, uvWidth);
                                    memcpy(dstV + y * uvWidth, vPlane + y * uvPlaneStride, uvWidth);
                                }
                            });
                        }
                        for (auto& t : threads) t.join();
                    } else {
                        for (int y = 0; y < uvHeight; y++) {
                            memcpy(dstU + y * uvWidth, uPlane + y * uvPlaneStride, uvWidth);
                            memcpy(dstV + y * uvWidth, vPlane + y * uvPlaneStride, uvWidth);
                        }
                    }
                }
            }
        }

        LOGI("Extracted YUV data: Y=%d, U=%d, V=%d, total=%d bytes",
             ySize, uvSize, uvSize, totalSize);
        return true;
    }
};

std::unique_ptr<IPlatformVideoDecoder> createAndroidVideoDecoder() {
    return std::make_unique<AndroidVideoDecoder>();
}

#else
// Stub implementation for non-Android platforms.
std::unique_ptr<IPlatformVideoDecoder> createAndroidVideoDecoder() {
    return nullptr;
}
#endif
