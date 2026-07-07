#!/usr/bin/env bash
set -euo pipefail

CONFIGURATION="Release"
DISABLE_SIMD=0
DISABLE_LTO=0
INITIAL_MEMORY_MB=256
MAXIMUM_MEMORY_MB=1024
KERNEL_INITIAL_MEMORY_MB=32
KERNEL_MAXIMUM_MEMORY_MB=512
PTHREAD_POOL_SIZE="${PTHREAD_POOL_SIZE:-4}"
VIDEO_DECODER_THREADS="${UWA_VIDEO_DECODER_THREADS:-$PTHREAD_POOL_SIZE}"

usage() {
    cat <<'EOF'
Usage: ./build_wasm_new.sh [options]

Builds the compatibility coordinator, pthread coordinator, and reconstruction role:
  output/splat_uwa_wasm.{js,wasm}                coordinator
  output/splat_uwa_wasm_pthread.{js,wasm}        pthread coordinator
  output/splat_uwa_reconstruction_wasm.{js,wasm} reconstruction kernel

Options:
  --configuration Release|Debug   Build mode. Default: Release
  --initial-memory-mb N           Coordinator initial memory. Default: 256
  --maximum-memory-mb N           Coordinator maximum memory. Default: 1024
  --kernel-initial-memory-mb N    Kernel initial memory. Default: 32
  --kernel-maximum-memory-mb N    Kernel maximum memory. Default: 512
  --disable-simd                  Disable WASM SIMD128 in both roles
  --disable-lto                   Disable link-time optimization
  -h, --help                      Show this help

Environment:
  PTHREAD_POOL_SIZE=N             Pthread coordinator pool size. Default: 4
  UWA_VIDEO_DECODER_THREADS=N     FFmpeg slice threads. Default: pool size
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --configuration)
            CONFIGURATION="${2:-}"
            shift 2
            ;;
        --initial-memory-mb)
            INITIAL_MEMORY_MB="${2:-}"
            shift 2
            ;;
        --maximum-memory-mb)
            MAXIMUM_MEMORY_MB="${2:-}"
            shift 2
            ;;
        --kernel-initial-memory-mb)
            KERNEL_INITIAL_MEMORY_MB="${2:-}"
            shift 2
            ;;
        --kernel-maximum-memory-mb)
            KERNEL_MAXIMUM_MEMORY_MB="${2:-}"
            shift 2
            ;;
        --disable-simd)
            DISABLE_SIMD=1
            shift
            ;;
        --disable-lto)
            DISABLE_LTO=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "[ERROR] Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ "$CONFIGURATION" != "Release" && "$CONFIGURATION" != "Debug" ]]; then
    echo "[ERROR] --configuration must be Release or Debug" >&2
    exit 1
fi
if ! [[ "$PTHREAD_POOL_SIZE" =~ ^[1-9][0-9]*$ && "$VIDEO_DECODER_THREADS" =~ ^[1-9][0-9]*$ ]]; then
    echo "[ERROR] PTHREAD_POOL_SIZE and UWA_VIDEO_DECODER_THREADS must be positive integers" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

require_path() {
    if [[ ! -e "$1" ]]; then
        echo "[ERROR] Required path is missing: $1" >&2
        exit 1
    fi
}

if ! command -v em++ >/dev/null 2>&1; then
    echo "[ERROR] em++ not found. Source emsdk_env.sh before building." >&2
    exit 1
fi

REQUIRED_PATHS=(
    "thirdparty/glm"
    "thirdparty/astc-encoder/Source"
    "thirdparty/zstd/lib"
    "thirdparty/ffmpeg/include"
    "thirdparty/ffmpeg/lib/libavcodec.a"
    "thirdparty/ffmpeg/lib/libavutil.a"
    "thirdparty/ffmpeg/lib/libswscale.a"
)
for path in "${REQUIRED_PATHS[@]}"; do
    require_path "$path"
done

if [[ "$CONFIGURATION" == "Release" ]]; then
    OPTIMIZATION_FLAGS=("-O3" "-DNDEBUG" "-s" "ASSERTIONS=0")
else
    # The checked-in FFmpeg archive was already instrumented by its producing
    # toolchain; applying SAFE_HEAP again breaks wasm-opt on those objects.
    OPTIMIZATION_FLAGS=("-O0" "-g" "-s" "ASSERTIONS=2")
fi

COMMON_FLAGS=(
    "-std=c++17"
    "${OPTIMIZATION_FLAGS[@]}"
    "-DGLM_ENABLE_EXPERIMENTAL"
    "-DASTCENC_STATIC"
    "-DASTCENC_SSE=0"
    "-DASTCENC_AVX=0"
    "-DASTCENC_POPCNT=0"
    "-DASTCENC_F16C=0"
    "-DASTCENC_NEON=0"
    "-Wno-deprecated-declarations"
    "-Wno-c++20-extensions"
)
if [[ "$DISABLE_SIMD" -eq 0 ]]; then
    COMMON_FLAGS+=("-msimd128")
fi
if [[ "$DISABLE_LTO" -eq 0 ]]; then
    COMMON_FLAGS+=("-flto")
fi
C_FLAGS=("${COMMON_FLAGS[@]:1}")

INCLUDE_FLAGS=(
    "-I."
    "-I./thirdparty"
    "-I./thirdparty/glm"
    "-I./thirdparty/astc-encoder/Source"
    "-I./thirdparty/zstd/lib"
    "-I./thirdparty/ffmpeg/include"
    "-I./thirdparty/bc7enc_rdo"
    "-I./uwa_gsdecoder/processor"
    "-I./uwa_gsdecoder/processor/platform"
    "-I./uwa_gsdecoder/gaussian_model"
)

OUTPUT_DIR="output"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

ZSTD_OBJ="$OUTPUT_DIR/zstd_decoder.o"
ZSTD_PTHREAD_OBJ="$OUTPUT_DIR/zstd_decoder_pthread.o"
ZSTD_SOURCES=(
    "thirdparty/zstd/lib/common/debug.c"
    "thirdparty/zstd/lib/common/entropy_common.c"
    "thirdparty/zstd/lib/common/error_private.c"
    "thirdparty/zstd/lib/common/fse_decompress.c"
    "thirdparty/zstd/lib/common/xxhash.c"
    "thirdparty/zstd/lib/common/zstd_common.c"
    "thirdparty/zstd/lib/decompress/huf_decompress.c"
    "thirdparty/zstd/lib/decompress/zstd_ddict.c"
    "thirdparty/zstd/lib/decompress/zstd_decompress.c"
    "thirdparty/zstd/lib/decompress/zstd_decompress_block.c"
)

echo "[1/6] Compiling the single-threaded Zstd decoder..."
emcc "${ZSTD_SOURCES[@]}" "${C_FLAGS[@]}" "${INCLUDE_FLAGS[@]}" -r -o "$ZSTD_OBJ"

echo "[2/6] Compiling the pthread Zstd decoder..."
emcc "${ZSTD_SOURCES[@]}" "${C_FLAGS[@]}" "${INCLUDE_FLAGS[@]}" -pthread -r -o "$ZSTD_PTHREAD_OBJ"

mapfile -t ASTC_SOURCES < <(find thirdparty/astc-encoder/Source -maxdepth 1 -type f -name "*.cpp" ! -name "*astcenccli*" | sort)

COORDINATOR_SOURCES=(
    "WasmBridge.cpp"
    "uwa_gsdecoder/gaussian_model/gs_data.cpp"
    "uwa_gsdecoder/gaussian_model/gs_decoder.cpp"
    "uwa_gsdecoder/gaussian_model/reconstruction_kernel.cpp"
    "uwa_gsdecoder/processor/stream.cpp"
    "uwa_gsdecoder/processor/unpacker.cpp"
    "uwa_gsdecoder/processor/prediction.cpp"
    "uwa_gsdecoder/processor/quantizer.cpp"
    "uwa_gsdecoder/processor/transform.cpp"
    "uwa_gsdecoder/processor/codec_decoder.cpp"
    "uwa_gsdecoder/processor/texture_transcoder.cpp"
    "uwa_gsdecoder/processor/platform/platform_video_decoder_factory.cpp"
    "uwa_gsdecoder/processor/platform/ffmpeg_video_decoder.cpp"
    "thirdparty/bc7enc_rdo/bc7enc.cpp"
    "thirdparty/bc7enc_rdo/rgbcx.cpp"
)

LINK_FLAGS=(
    "-lembind"
    "-s" "MODULARIZE=1"
    "-s" "EXPORT_ES6=1"
    "-s" "ALLOW_MEMORY_GROWTH=1"
    "-s" "FILESYSTEM=0"
    "-s" "ENVIRONMENT=web,worker"
    "-s" "EXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU8,HEAPU32,getExceptionMessage"
    "-s" "EXPORTED_FUNCTIONS=_malloc,_free"
    "-s" "STACK_OVERFLOW_CHECK=1"
    "-s" "DISABLE_EXCEPTION_CATCHING=0"
    "-s" "MALLOC=emmalloc"
)

echo "[3/6] Linking the non-pthread coordinator..."
em++ \
    "${COORDINATOR_SOURCES[@]}" \
    "${ASTC_SOURCES[@]}" \
    "$ZSTD_OBJ" \
    "thirdparty/ffmpeg/lib/libavcodec.a" \
    "thirdparty/ffmpeg/lib/libswscale.a" \
    "thirdparty/ffmpeg/lib/libavutil.a" \
    "${COMMON_FLAGS[@]}" \
    "${INCLUDE_FLAGS[@]}" \
    "${LINK_FLAGS[@]}" \
    -DUSE_ZSTD -DUSE_ASTC -DUSE_FFMPEG -DUSE_BC_TEXTURE_ENCODERS \
    -s "EXPORT_NAME=createSplatUWAWasm" \
    -s "INITIAL_MEMORY=${INITIAL_MEMORY_MB}MB" \
    -s "MAXIMUM_MEMORY=${MAXIMUM_MEMORY_MB}MB" \
    -o "$OUTPUT_DIR/splat_uwa_wasm.js"

echo "[4/6] Linking the pthread coordinator (pool=$PTHREAD_POOL_SIZE, FFmpeg threads=$VIDEO_DECODER_THREADS)..."
em++ \
    "${COORDINATOR_SOURCES[@]}" \
    "${ASTC_SOURCES[@]}" \
    "$ZSTD_PTHREAD_OBJ" \
    "thirdparty/ffmpeg/lib/libavcodec.a" \
    "thirdparty/ffmpeg/lib/libswscale.a" \
    "thirdparty/ffmpeg/lib/libavutil.a" \
    "${COMMON_FLAGS[@]}" \
    "${INCLUDE_FLAGS[@]}" \
    "${LINK_FLAGS[@]}" \
    -pthread \
    -DUSE_ZSTD -DUSE_ASTC -DUSE_FFMPEG -DUSE_BC_TEXTURE_ENCODERS \
    -DUWA_VIDEO_DECODER_THREADS="$VIDEO_DECODER_THREADS" \
    -s "PTHREAD_POOL_SIZE=$PTHREAD_POOL_SIZE" \
    -s "EXPORT_NAME=createSplatUWAWasmPthread" \
    -s "INITIAL_MEMORY=${INITIAL_MEMORY_MB}MB" \
    -s "MAXIMUM_MEMORY=${MAXIMUM_MEMORY_MB}MB" \
    -o "$OUTPUT_DIR/splat_uwa_wasm_pthread.js"

KERNEL_SOURCES=(
    "ReconstructionBridge.cpp"
    "uwa_gsdecoder/gaussian_model/reconstruction_kernel.cpp"
    "uwa_gsdecoder/processor/prediction.cpp"
    "uwa_gsdecoder/processor/quantizer.cpp"
    "uwa_gsdecoder/processor/transform.cpp"
)

echo "[5/6] Linking the non-pthread reconstruction kernel..."
em++ \
    "${KERNEL_SOURCES[@]}" \
    "${COMMON_FLAGS[@]}" \
    "${INCLUDE_FLAGS[@]}" \
    "${LINK_FLAGS[@]}" \
    -s "EXPORT_NAME=createSplatUWAReconstructionWasm" \
    -s "INITIAL_MEMORY=${KERNEL_INITIAL_MEMORY_MB}MB" \
    -s "MAXIMUM_MEMORY=${KERNEL_MAXIMUM_MEMORY_MB}MB" \
    -o "$OUTPUT_DIR/splat_uwa_reconstruction_wasm.js"

echo "[6/6] Auditing generated artifacts..."
if grep -En "SharedArrayBuffer|Atomics\\.|pthread_create|PThread\\." \
    "$OUTPUT_DIR/splat_uwa_wasm.js" "$OUTPUT_DIR/splat_uwa_reconstruction_wasm.js"; then
    echo "[ERROR] Thread/shared-memory runtime detected in generated JavaScript" >&2
    exit 1
fi
if strings "$OUTPUT_DIR/splat_uwa_wasm.wasm" "$OUTPUT_DIR/splat_uwa_reconstruction_wasm.wasm" | \
    grep -En "pthread_create|SharedArrayBuffer"; then
    echo "[ERROR] Thread/shared-memory symbol detected in generated WebAssembly" >&2
    exit 1
fi
if ! grep -Eq "SharedArrayBuffer|Atomics\\.|pthread_create|PThread\\." \
    "$OUTPUT_DIR/splat_uwa_wasm_pthread.js" >/dev/null; then
    echo "[ERROR] Pthread runtime was not detected in the threaded coordinator" >&2
    exit 1
fi

echo "[SUCCESS] Built both coordinators and the non-pthread reconstruction kernel in $OUTPUT_DIR"
