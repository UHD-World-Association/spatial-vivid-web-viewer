#include "platform_video_decoder.h"
#include <iostream>
#include <cstring>
#include <algorithm>
#include <fstream>
#include <chrono>
#include <nlohmann/json.hpp>
#include "../../gaussian_model/gs_decoder.h"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/dict.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

namespace {
using DiagnosticClock = std::chrono::steady_clock;

// One record per video substream, including failures. Timings are wall-clock
// envelopes on the decoder caller, not summed CPU time across FFmpeg threads.
struct FFmpegDiagnosticScope {
    DiagnosticClock::time_point start = DiagnosticClock::now();
    double initMs = 0, parserMs = 0, sendMs = 0, receiveMs = 0, frameProcessMs = 0, reserveMs = 0;
    nlohmann::json record = {{"schema", "uwa.ffmpeg.diagnostic.v1"}, {"status", "failed"}};
    ~FFmpegDiagnosticScope() noexcept {
        try {
            const double total = std::chrono::duration<double, std::milli>(DiagnosticClock::now() - start).count();
            record["totalMs"] = total;
            record["initMs"] = initMs;
            record["parserMs"] = parserMs;
            record["sendPacketMs"] = sendMs;
            record["receiveFrameMs"] = receiveMs;
            record["decodeCoreMs"] = sendMs + receiveMs;
            record["frameProcessMs"] = frameProcessMs;
            record["initialReserveMs"] = reserveMs;
            record["otherMs"] = std::max(0.0, total - initMs - parserMs - sendMs - receiveMs - frameProcessMs - reserveMs);
            auto& output = getTimingStats().ffmpegDiagnosticsJson;
            auto entries = nlohmann::json::parse(output);
            entries.push_back(record);
            output = entries.dump();
        } catch (...) {
            // Diagnostics must never change decode success or error handling.
        }
    }
};

template<typename F> auto measureFFmpeg(double& duration, F&& operation) {
    const auto start = DiagnosticClock::now();
    auto result = operation();
    duration += std::chrono::duration<double, std::milli>(DiagnosticClock::now() - start).count();
    return result;
}
}

/**
 * FFmpeg software video decoder.
 * Uses the FFmpeg library API for video decoding.
 * Supports H.264/AVC and H.265/HEVC.
 */
class FFmpegVideoDecoder : public IPlatformVideoDecoder {
public:
    FFmpegVideoDecoder() : codecCtx_(nullptr), parserCtx_(nullptr), frame_(nullptr), swsCtx_(nullptr) {}

    ~FFmpegVideoDecoder() override {
        cleanup();
    }

    bool decode(const std::vector<uint8_t>& encoded,
               std::vector<uint8_t>& decoded,
               int width, int height) override {
        VideoFrameLayout layout;
        return decodeToLayout(encoded, decoded, width, height, layout);
    }

    bool decodeToLayout(const std::vector<uint8_t>& encoded,
                        std::vector<uint8_t>& decoded,
                        int width, int height,
                        VideoFrameLayout& layout) override {
#ifdef USE_FFMPEG
        return decodeWithFFmpegLib(encoded, decoded, width, height, layout);
#else
        // Without FFmpeg, copy the data directly for tests only.
        std::cerr << "Warning: FFmpeg not enabled, returning raw data" << std::endl;
        decoded = encoded;
        layout = {};
        return false;
#endif
    }

    bool isHardwareAccelerated() const override {
        return false;
    }

    void reset() override {
        if (codecCtx_) {
            avcodec_flush_buffers(codecCtx_);
        }
    }

private:
#ifdef USE_FFMPEG
    AVCodecContext* codecCtx_;
    AVCodecParserContext* parserCtx_;
    AVFrame* frame_;
    SwsContext* swsCtx_;

    void cleanup() {
        if (swsCtx_) {
            sws_freeContext(swsCtx_);
            swsCtx_ = nullptr;
        }
        if (frame_) {
            av_frame_free(&frame_);
            frame_ = nullptr;
        }
        if (parserCtx_) {
            av_parser_close(parserCtx_);
            parserCtx_ = nullptr;
        }
        if (codecCtx_) {
            avcodec_free_context(&codecCtx_);
            codecCtx_ = nullptr;
        }
    }

    bool initDecoder() {
        // Select the decoder from codecId.
        const AVCodec* codec = nullptr;
        if (codecId == CODEC_ID_H264) {
            codec = avcodec_find_decoder(AV_CODEC_ID_H264);
        } else {
            codec = avcodec_find_decoder(AV_CODEC_ID_HEVC);
        }

        if (!codec) {
            std::cerr << "Error: Codec not found" << std::endl;
            return false;
        }

        // Create the decoder context.
        codecCtx_ = avcodec_alloc_context3(codec);
        if (!codecCtx_) {
            std::cerr << "Error: Could not allocate codec context" << std::endl;
            return false;
        }

#if defined(UWA_VIDEO_DECODER_THREADS) && UWA_VIDEO_DECODER_THREADS > 1
        codecCtx_->thread_count = UWA_VIDEO_DECODER_THREADS;
        codecCtx_->thread_type = FF_THREAD_SLICE;
#else
        // Keep the compatibility artifact's established single-threaded behavior.
        codecCtx_->thread_count = 1;
        codecCtx_->thread_type = 0;
#endif
        codecCtx_->flags |= AV_CODEC_FLAG_LOW_DELAY;

        AVDictionary* options = nullptr;
#if defined(UWA_VIDEO_DECODER_THREADS) && UWA_VIDEO_DECODER_THREADS > 1
        const std::string threadCount = std::to_string(UWA_VIDEO_DECODER_THREADS);
        av_dict_set(&options, "threads", threadCount.c_str(), 0);
        av_dict_set(&options, "thread_type", "slice", 0);
#else
        av_dict_set(&options, "threads", "1", 0);
        av_dict_set(&options, "thread_type", "0", 0);
#endif

        // Open the decoder.
        if (avcodec_open2(codecCtx_, codec, &options) < 0) {
            av_dict_free(&options);
            std::cerr << "Error: Could not open codec" << std::endl;
            return false;
        }
        av_dict_free(&options);
        std::cout << "[GSDecoder] FFmpeg video threads=" << codecCtx_->thread_count
                  << " active_thread_type=" << codecCtx_->active_thread_type << std::endl;

        // Create the bitstream parser.
        parserCtx_ = av_parser_init(codec->id);
        if (!parserCtx_) {
            std::cerr << "Error: Could not create parser" << std::endl;
            return false;
        }

        // Allocate a decoded frame.
        frame_ = av_frame_alloc();
        if (!frame_) {
            std::cerr << "Error: Could not allocate frame" << std::endl;
            return false;
        }

        return true;
    }

    bool decodeWithFFmpegLib(const std::vector<uint8_t>& encoded,
                            std::vector<uint8_t>& decoded,
                            int width, int height,
                            VideoFrameLayout& layout) {
        FFmpegDiagnosticScope diagnostic;
        auto& detail = diagnostic.record;
        detail["inputBytes"] = encoded.size();
        detail["ffmpegConfiguration"] = avcodec_configuration();
        detail["libavcodecVersion"] = avcodec_version();
        detail["codecId"] = codecId;
        detail["contextReused"] = codecCtx_ != nullptr;
#if defined(UWA_VIDEO_DECODER_THREADS)
        detail["configuredThreads"] = UWA_VIDEO_DECODER_THREADS;
#else
        detail["configuredThreads"] = 1;
#endif
#ifdef __wasm_simd128__
        detail["wrapperSimd128"] = true;
#else
        detail["wrapperSimd128"] = false;
#endif
#ifdef __EMSCRIPTEN_PTHREADS__
        detail["pthreadArtifact"] = true;
#else
        detail["pthreadArtifact"] = false;
#endif
#ifdef NDEBUG
        detail["configuration"] = "Release";
#else
        detail["configuration"] = "Debug";
#endif
        // Initialize the decoder if necessary.
        if (!codecCtx_) {
            if (!measureFFmpeg(diagnostic.initMs, [&]() { return initDecoder(); })) {
                decoded = encoded;
                return false;
            }
        }

        detail["actualThreadCount"] = codecCtx_->thread_count;
        detail["requestedThreadType"] = codecCtx_->thread_type;
        detail["activeThreadType"] = codecCtx_->active_thread_type;
        detail["threadTypeBits"] = {{"frame", FF_THREAD_FRAME}, {"slice", FF_THREAD_SLICE}};
        detail["frameCount"] = 0;
        detail["outputBytes"] = 0;
        detail["outputCapacityGrowthCount"] = 0;
        detail["frameFormats"] = nlohmann::json::array();
        decoded.clear();
        layout = {};
        if (width > 0 && height > 0) {
            const size_t lumaBytes = static_cast<size_t>(width) * static_cast<size_t>(height);
            measureFFmpeg(diagnostic.reserveMs, [&]() { decoded.reserve(lumaBytes + lumaBytes / 2); return true; });
        }
        size_t decodedFrameCount = 0;
        auto appendDecodedFrame = [&]() {
            const size_t previousSize = decoded.size();
            VideoFrameLayout frameLayout;
            const auto capacityBefore = decoded.capacity();
            const bool frameOk = measureFFmpeg(diagnostic.frameProcessMs, [&]() {
                return processFrame(decoded, previousSize, frameLayout);
            });
            if (decoded.capacity() != capacityBefore) {
                detail["outputCapacityGrowthCount"] = detail["outputCapacityGrowthCount"].get<unsigned>() + 1;
            }
            if (!frameOk) {
                decoded.resize(previousSize);
                return false;
            }
            if (decodedFrameCount == 0) {
                layout = frameLayout;
            } else if (layout.pixelFormat != frameLayout.pixelFormat ||
                       layout.width != frameLayout.width || layout.height != frameLayout.height) {
                std::cerr << "Error: Video pixel layout changed between decoded frames" << std::endl;
                decoded.resize(previousSize);
                return false;
            }
            if (decodedFrameCount == 0) {
                detail["frameWidth"] = frame_->width;
                detail["frameHeight"] = frame_->height;
                detail["linesizes"] = {frame_->linesize[0], frame_->linesize[1], frame_->linesize[2]};
            }
            const char* format = av_get_pix_fmt_name(static_cast<AVPixelFormat>(frame_->format));
            const std::string formatName = format ? format : "unknown";
            auto& formats = detail["frameFormats"];
            if (std::find(formats.begin(), formats.end(), formatName) == formats.end()) formats.push_back(formatName);
            decodedFrameCount++;
            detail["frameCount"] = decodedFrameCount;
            detail["outputBytes"] = decoded.size();
            layout.frameCount = static_cast<uint32_t>(decodedFrameCount);
            return true;
        };
        AVPacket* pkt = av_packet_alloc();
        if (!pkt) {
            std::cerr << "Error: Could not allocate video packet" << std::endl;
            cleanup();
            return false;
        }

        const uint8_t* data = encoded.data();
        size_t dataSize = encoded.size();

        while (dataSize > 0) {
            // Parse the input data.
            int ret = measureFFmpeg(diagnostic.parserMs, [&]() { return av_parser_parse2(parserCtx_, codecCtx_, &pkt->data, &pkt->size,
                                      data, dataSize, AV_NOPTS_VALUE, AV_NOPTS_VALUE, 0); });

            if (ret < 0) {
                std::cerr << "Error: Failed to parse data" << std::endl;
                av_packet_free(&pkt);
                cleanup();
                return false;
            }

            data += ret;
            dataSize -= ret;

            if (ret == 0 && pkt->size == 0) {
                std::cerr << "Error: FFmpeg parser made no progress" << std::endl;
                av_packet_free(&pkt);
                cleanup();
                return false;
            }

            if (pkt->size > 0) {
                // Send the packet to the decoder.
                ret = measureFFmpeg(diagnostic.sendMs, [&]() { return avcodec_send_packet(codecCtx_, pkt); });
                if (ret < 0) {
                    char errBuf[256];
                    av_strerror(ret, errBuf, sizeof(errBuf));
                    std::cerr << "Error: Failed to send packet to decoder, error: " << ret << " (" << errBuf << ")" << std::endl;
                    av_packet_free(&pkt);
                    cleanup();
                    return false;
                }

                // Receive a decoded frame.
                while (ret >= 0) {
                    ret = measureFFmpeg(diagnostic.receiveMs, [&]() { return avcodec_receive_frame(codecCtx_, frame_); });
                    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
                        break;
                    } else if (ret < 0) {
                        char errBuf[256];
                        av_strerror(ret, errBuf, sizeof(errBuf));
                        std::cerr << "Error: Failed to receive frame from decoder, error: " << ret << " (" << errBuf << ")" << std::endl;
                        av_packet_free(&pkt);
                        cleanup();
                        return false;
                    }

                    // Process the decoded frame.
                    if (!appendDecodedFrame()) {
                        av_packet_free(&pkt);
                        cleanup();
                        return false;
                    }

                    av_frame_unref(frame_);
                }
            }
        }

        // Flush the parser.
        int ret = measureFFmpeg(diagnostic.parserMs, [&]() { return av_parser_parse2(parserCtx_, codecCtx_, &pkt->data, &pkt->size,
                                  nullptr, 0, AV_NOPTS_VALUE, AV_NOPTS_VALUE, 0); });

        if (pkt->size > 0) {

            // Send the packet to the decoder.
            ret = measureFFmpeg(diagnostic.sendMs, [&]() { return avcodec_send_packet(codecCtx_, pkt); });
            if (ret < 0) {
                char errBuf[256];
                av_strerror(ret, errBuf, sizeof(errBuf));
                std::cerr << "Error: Failed to send packet to decoder, error: " << ret << " (" << errBuf << ")" << std::endl;
                av_packet_free(&pkt);
                cleanup();
                return false;
            }

            // Receive a decoded frame.
            while (ret >= 0) {
                ret = measureFFmpeg(diagnostic.receiveMs, [&]() { return avcodec_receive_frame(codecCtx_, frame_); });
                if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
                    break;
                } else if (ret < 0) {
                    char errBuf[256];
                    av_strerror(ret, errBuf, sizeof(errBuf));
                    std::cerr << "Error: Failed to receive frame from decoder, error: " << ret << " (" << errBuf << ")" << std::endl;
                    av_packet_free(&pkt);
                    cleanup();
                    return false;
                }

                // Process the decoded frame.
                if (!appendDecodedFrame()) {
                    av_packet_free(&pkt);
                    cleanup();
                    return false;
                }

                av_frame_unref(frame_);
            }
        }

        // Flush the decoder.
        ret = measureFFmpeg(diagnostic.sendMs, [&]() { return avcodec_send_packet(codecCtx_, nullptr); });
        while (ret >= 0) {
            ret = measureFFmpeg(diagnostic.receiveMs, [&]() { return avcodec_receive_frame(codecCtx_, frame_); });
            if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
                break;
            } else if (ret < 0) {
                char errBuf[256];
                av_strerror(ret, errBuf, sizeof(errBuf));
                std::cerr << "Error: Failed to receive frame from decoder during flush, error: " << ret << " (" << errBuf << ")" << std::endl;
                break;
            }

            // Process the decoded frame.
            if (!appendDecodedFrame()) {
                av_packet_free(&pkt);
                cleanup();
                return false;
            }

            av_frame_unref(frame_);
        }

        av_packet_free(&pkt);

        if (decodedFrameCount == 0) {
            std::cerr << "Error: No frames decoded" << std::endl;
            cleanup();
            return false;
        }

        size_t expectedBytes = 0;
        if (!videoFrameByteLength(layout, expectedBytes) || decoded.size() != expectedBytes) {
            std::cerr << "Error: FFmpeg produced an inconsistent compact video layout" << std::endl;
            cleanup();
            return false;
        }

        detail["status"] = "complete";
        return true;
    }

    bool processFrame(std::vector<uint8_t>& decoded,
                      size_t destinationOffset,
                      VideoFrameLayout& layout) {
        int decodedWidth = frame_->width;
        int decodedHeight = frame_->height;
        if (decodedWidth <= 0 || decodedHeight <= 0) return false;
        layout.width = static_cast<uint32_t>(decodedWidth);
        layout.height = static_cast<uint32_t>(decodedHeight);
        layout.frameCount = 1;

        // Select handling for the decoded YUV format.
        AVPixelFormat srcFormat = static_cast<AVPixelFormat>(frame_->format);

        // Return YUV420P directly, matching the original command-line implementation.
        if (srcFormat == AV_PIX_FMT_YUV420P || srcFormat == AV_PIX_FMT_YUVJ420P) {
            if ((decodedWidth & 1) != 0 || (decodedHeight & 1) != 0) return false;
            layout.pixelFormat = VideoPixelFormat::I420;
            // YUV420P: full-resolution Y plane and quarter-resolution U and V planes.
            int ySize = decodedWidth * decodedHeight;
            int uvWidth = decodedWidth / 2;
            int uvHeight = decodedHeight / 2;
            int uvSize = uvWidth * uvHeight;
            decoded.resize(destinationOffset + ySize + uvSize * 2);
            uint8_t* destination = decoded.data() + destinationOffset;

            // Copy the Y plane row by row, skipping padding bytes.
            for (int y = 0; y < decodedHeight; y++) {
                memcpy(destination + y * decodedWidth,
                       frame_->data[0] + y * frame_->linesize[0],
                       decodedWidth);
            }

            // Copy the U plane row by row, skipping padding bytes.
            for (int y = 0; y < uvHeight; y++) {
                memcpy(destination + ySize + y * uvWidth,
                       frame_->data[1] + y * frame_->linesize[1],
                       uvWidth);
            }

            // Copy the V plane row by row, skipping padding bytes.
            for (int y = 0; y < uvHeight; y++) {
                memcpy(destination + ySize + uvSize + y * uvWidth,
                       frame_->data[2] + y * frame_->linesize[2],
                       uvWidth);
            }
        }
        // Keep grayscale output as compact I400; Unpacker supplies neutral chroma when needed.
        else if (srcFormat == AV_PIX_FMT_GRAY8) {
            int ySize = decodedWidth * decodedHeight;
            layout.pixelFormat = VideoPixelFormat::I400;
            decoded.resize(destinationOffset + ySize);
            uint8_t* destination = decoded.data() + destinationOffset;

            // Copy the Y plane row by row, skipping padding bytes.
            for (int y = 0; y < decodedHeight; y++) {
                memcpy(destination + y * decodedWidth,
                       frame_->data[0] + y * frame_->linesize[0],
                       decodedWidth);
            }
        }
        // Convert YUV444P to the legacy ABI's per-pixel interleaved YUV444 layout.
        else if (srcFormat == AV_PIX_FMT_YUV444P || srcFormat == AV_PIX_FMT_YUVJ444P) {
            int ySize = decodedWidth * decodedHeight;
            layout.pixelFormat = VideoPixelFormat::YUV444_INTERLEAVED;
            decoded.resize(destinationOffset + ySize * 3);
            uint8_t* output = decoded.data() + destinationOffset;
            for (int y = 0; y < decodedHeight; y++) {
                const uint8_t* yRow = frame_->data[0] + y * frame_->linesize[0];
                const uint8_t* uRow = frame_->data[1] + y * frame_->linesize[1];
                const uint8_t* vRow = frame_->data[2] + y * frame_->linesize[2];
                for (int x = 0; x < decodedWidth; ++x) {
                    const size_t destination = (static_cast<size_t>(y) * decodedWidth + x) * 3;
                    output[destination] = yRow[x];
                    output[destination + 1] = uRow[x];
                    output[destination + 2] = vRow[x];
                }
            }
        }
        else {
            std::cerr << "Warning: Unsupported pixel format " << srcFormat
                     << ", attempting to convert to YUV420P" << std::endl;

            // Convert other pixel formats to YUV420P when possible.
            AVPixelFormat dstFormat = AV_PIX_FMT_YUV420P;
            if ((decodedWidth & 1) != 0 || (decodedHeight & 1) != 0) return false;
            layout.pixelFormat = VideoPixelFormat::I420;
            swsCtx_ = sws_getContext(
                decodedWidth, decodedHeight, srcFormat,
                decodedWidth, decodedHeight, dstFormat,
                SWS_BILINEAR, nullptr, nullptr, nullptr
            );

            if (swsCtx_) {
                AVFrame* yuv420Frame = av_frame_alloc();
                if (!yuv420Frame) {
                    sws_freeContext(swsCtx_);
                    swsCtx_ = nullptr;
                    return false;
                }
                yuv420Frame->format = dstFormat;
                yuv420Frame->width = decodedWidth;
                yuv420Frame->height = decodedHeight;

                if (av_frame_get_buffer(yuv420Frame, 0) >= 0) {
                    sws_scale(swsCtx_, frame_->data, frame_->linesize, 0, decodedHeight,
                             yuv420Frame->data, yuv420Frame->linesize);

                    int ySize = decodedWidth * decodedHeight;
                    int uvWidth = decodedWidth / 2;
                    int uvHeight = decodedHeight / 2;
                    int uvSize = uvWidth * uvHeight;
                    decoded.resize(destinationOffset + ySize + uvSize * 2);
                    uint8_t* destination = decoded.data() + destinationOffset;

                    // Copy the Y plane row by row, skipping padding bytes.
                    for (int y = 0; y < decodedHeight; y++) {
                        memcpy(destination + y * decodedWidth,
                               yuv420Frame->data[0] + y * yuv420Frame->linesize[0],
                               decodedWidth);
                    }

                    // Copy the U plane row by row, skipping padding bytes.
                    for (int y = 0; y < uvHeight; y++) {
                        memcpy(destination + ySize + y * uvWidth,
                               yuv420Frame->data[1] + y * yuv420Frame->linesize[1],
                               uvWidth);
                    }

                    // Copy the V plane row by row, skipping padding bytes.
                    for (int y = 0; y < uvHeight; y++) {
                        memcpy(destination + ySize + uvSize + y * uvWidth,
                               yuv420Frame->data[2] + y * yuv420Frame->linesize[2],
                               uvWidth);
                    }
                } else {
                    av_frame_free(&yuv420Frame);
                    sws_freeContext(swsCtx_);
                    swsCtx_ = nullptr;
                    return false;
                }
                av_frame_free(&yuv420Frame);
                sws_freeContext(swsCtx_);
                swsCtx_ = nullptr;
            } else {
                std::cerr << "Error: Could not convert pixel format" << std::endl;
                return false;
            }
        }

        size_t frameBytes = 0;
        return videoFrameByteLength(layout, frameBytes) &&
            decoded.size() == destinationOffset + frameBytes;
    }
#endif
};

// Register this implementation as the software decoder.
// The factory selects a hardware or software implementation for the target platform.
std::unique_ptr<IPlatformVideoDecoder> createFFmpegVideoDecoder() {
    return std::make_unique<FFmpegVideoDecoder>();
}
