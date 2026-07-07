cmake_minimum_required(VERSION 3.15)
project(GSDecoder)

# Use the C++17 standard.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Enable GLM experimental extensions.
add_definitions(-DGLM_ENABLE_EXPERIMENTAL)

# Configure third-party libraries required by the decoder.
set(ASTCENC_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/astc-encoder")
if(NOT EXISTS "${ASTCENC_SOURCE_DIR}")
    message(FATAL_ERROR "astc-encoder source directory not found at: ${ASTCENC_SOURCE_DIR}")
endif()
set(ASTCENC_LIB_NAME "astcenc-native-static")
set(ISA_NATIVE ON CACHE BOOL "Build astcenc using the native SIMD backend" FORCE)
set(DECOMPRESSOR OFF CACHE BOOL "Build the full astcenc library for legacy CPU decoding" FORCE)
if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()
set(CLI OFF CACHE BOOL "Disable the astcenc command-line tool" FORCE)
add_subdirectory(${ASTCENC_SOURCE_DIR} ${ASTCENC_LIB_NAME})
find_package(ZLIB REQUIRED)

# Configure the Zstd library.
set(ZSTD_BUILD_SHARED OFF CACHE BOOL "Build zstd shared library")
set(ZSTD_BUILD_STATIC ON CACHE BOOL "Build zstd static library")
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "Build zstd programs")
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/zstd/build/cmake zstd)

# Locate FFmpeg.
find_package(PkgConfig QUIET)
if(PkgConfig_FOUND)
    pkg_check_modules(FFMPEG_PKG QUIET libavcodec libavutil libswscale)
    if(FFMPEG_PKG_FOUND)
        set(FFMPEG_LIBRARIES ${FFMPEG_PKG_LIBRARIES})
        set(FFMPEG_INCLUDE_DIR ${FFMPEG_PKG_INCLUDE_DIRS})
        set(FFMPEG_LIBRARY_DIRS ${FFMPEG_PKG_LIBRARY_DIRS})
        set(FFMPEG_FOUND TRUE)
        set(FFMPEG_SOURCE "system (pkg-config)")
    endif()
endif()
if(NOT FFMPEG_FOUND)
    find_library(FFMPEG_AVCODEC NAMES avcodec)
    find_library(FFMPEG_AVUTIL NAMES avutil)
    find_library(FFMPEG_SWSCALE NAMES swscale)

    if(FFMPEG_AVCODEC AND FFMPEG_AVUTIL AND FFMPEG_SWSCALE)
        find_path(FFMPEG_INCLUDE_DIR NAMES libavcodec/avcodec.h)
        if(FFMPEG_INCLUDE_DIR)
            set(FFMPEG_LIBRARIES ${FFMPEG_AVCODEC} ${FFMPEG_AVUTIL} ${FFMPEG_SWSCALE})
            set(FFMPEG_FOUND TRUE)
            set(FFMPEG_SOURCE "system")
        endif()
    endif()
endif()
if(FFMPEG_FOUND)
    message(STATUS "FFmpeg found (${FFMPEG_SOURCE}):")
    message(STATUS "  libraries: ${FFMPEG_LIBRARIES}")
    message(STATUS "  include: ${FFMPEG_INCLUDE_DIR}")
else()
    message(WARNING "FFmpeg not found!")
    message(WARNING "Please do one of the following:")
    message(WARNING "  1. Place FFmpeg libraries in: ${FFMPEG_PREBUILT_DIR}")
    message(WARNING "  2. Set FFMPEG_ROOT environment variable")
    message(WARNING "  3. Install FFmpeg via conda/miniconda")
    message(WARNING "  4. Install FFmpeg system-wide")
endif()

add_definitions(-DUSE_ZSTD)
add_definitions(-DUSE_ASTC)
add_definitions(-DUSE_FFMPEG)
add_definitions(-DUSE_BC_TEXTURE_ENCODERS)

# Collect decoder source files.
set(DECODER_SOURCES
        uwa_gsdecoder/processor/stream.cpp
        uwa_gsdecoder/processor/unpacker.cpp
        uwa_gsdecoder/processor/prediction.cpp
        uwa_gsdecoder/processor/quantizer.cpp
        uwa_gsdecoder/processor/transform.cpp
        uwa_gsdecoder/processor/codec_decoder.cpp
        uwa_gsdecoder/processor/texture_transcoder.cpp
        uwa_gsdecoder/processor/platform/platform_video_decoder_factory.cpp
        uwa_gsdecoder/processor/platform/ffmpeg_video_decoder.cpp
        uwa_gsdecoder/gaussian_model/gs_data.cpp
        uwa_gsdecoder/gaussian_model/gs_decoder.cpp
        uwa_gsdecoder/gaussian_model/reconstruction_kernel.cpp
        thirdparty/bc7enc_rdo/bc7enc.cpp
        thirdparty/bc7enc_rdo/rgbcx.cpp
)
add_library(uwa_gsdecoder STATIC ${DECODER_SOURCES})

# Configure include directories for uwa_gsdecoder.
target_include_directories(uwa_gsdecoder PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/uwa_gsdecoder/processor
    ${CMAKE_CURRENT_SOURCE_DIR}/uwa_gsdecoder/processor/platform
    ${CMAKE_CURRENT_SOURCE_DIR}/uwa_gsdecoder/gaussian_model
    ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty
    ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/glm
    ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/nlohmann
    ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/zstd/lib
    ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/bc7enc_rdo
    ${ASTCENC_SOURCE_DIR}/Source
    ${FFMPEG_INCLUDE_DIR}
)

# Link dependencies into uwa_gsdecoder.
target_link_libraries(uwa_gsdecoder PUBLIC
    ${ZLIB_LIBRARIES}
    ${ASTCENC_LIB_NAME}
    ${FFMPEG_LIBRARIES}
    libzstd_static
)

# Add the executable target.
add_executable(GSDecoder
    main.cpp
    decoderUI.cpp
)


# Add the project and third-party include directories.
target_include_directories(GSDecoder PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/uwa_gsdecoder/processor
    ${CMAKE_CURRENT_SOURCE_DIR}/uwa_gsdecoder/processor/platform
    ${CMAKE_CURRENT_SOURCE_DIR}/uwa_gsdecoder/gaussian_model
    ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty
    ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/glm  # GLM is vendored under thirdparty.
    ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/nlohmann  # nlohmann/json is vendored under thirdparty.
    ${CMAKE_CURRENT_SOURCE_DIR}/thirdparty/zstd/lib
    ${ASTCENC_SOURCE_DIR}/Source
)

target_link_libraries(${CMAKE_PROJECT_NAME}
        PRIVATE
        uwa_gsdecoder
        ${FFMPEG_LIBRARIES}
)

enable_testing()
add_executable(uwa_codec0_tests
    uwa_gsdecoder/test_codec0.cpp
)
target_link_libraries(uwa_codec0_tests PRIVATE uwa_gsdecoder)
add_test(NAME uwa_codec0_tests COMMAND uwa_codec0_tests)

# Enable compiler warnings.
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(GSDecoder PRIVATE -Wall -Wextra -pedantic)
        target_compile_options(uwa_gsdecoder PRIVATE -Wall -Wextra)

    # Linux performance optimizations.
    if(CMAKE_SYSTEM_NAME MATCHES "Linux")
        # Detect the CPU architecture.
        include(CheckCXXSourceCompiles)
        set(CMAKE_REQUIRED_FLAGS "-march=native")
        check_cxx_source_compiles("int main() { return 0; }" SUPPORTS_MARCH_NATIVE)

        if(SUPPORTS_MARCH_NATIVE)
            message(STATUS "Using -march=native for CPU-specific optimizations")
            target_compile_options(uwa_gsdecoder PRIVATE -march=native)
            target_compile_options(GSDecoder PRIVATE -march=native)
        else()
            message(STATUS "Using generic optimizations (-mtune=generic)")
            target_compile_options(uwa_gsdecoder PRIVATE -mtune=generic)
            target_compile_options(GSDecoder PRIVATE -mtune=generic)
        endif()

        # Release-mode optimization options.
        if(CMAKE_BUILD_TYPE MATCHES "Release")
            # High-level optimizations.
            target_compile_options(uwa_gsdecoder PRIVATE
                -O3                    # Highest optimization level.
                -DNDEBUG               # Disable assertions.
                -ffast-math            # Fast-math optimization; may affect numerical precision.
                -funroll-loops         # Loop unrolling.
                -fomit-frame-pointer   # Omit the frame pointer.
                -ftree-vectorize       # Automatic vectorization.
                -finline-functions     # Function inlining.
            )
            target_compile_options(GSDecoder PRIVATE
                -O3
                -DNDEBUG
                -ffast-math
                -funroll-loops
                -fomit-frame-pointer
            )

            # Link-time optimization (LTO).
            include(CheckCXXCompilerFlag)
            check_cxx_compiler_flag("-flto" SUPPORTS_LTO)
            if(SUPPORTS_LTO)
                message(STATUS "Enabling Link Time Optimization (LTO)")
                target_compile_options(uwa_gsdecoder PRIVATE -flto)
                target_compile_options(GSDecoder PRIVATE -flto)
                target_link_options(uwa_gsdecoder PRIVATE -flto)
                target_link_options(GSDecoder PRIVATE -flto)
            endif()

            message(STATUS "Release optimizations enabled: -O3 -march=native -ffast-math -funroll-loops")
        else()
            # Retain debug symbols in Debug builds.
            target_compile_options(uwa_gsdecoder PRIVATE -g -O0)
            target_compile_options(GSDecoder PRIVATE -g -O0)
        endif()

        # Enable OpenMP when available.
        find_package(OpenMP QUIET)
        if(OpenMP_CXX_FOUND)
            message(STATUS "OpenMP found, enabling parallel execution")
            target_link_libraries(uwa_gsdecoder PUBLIC OpenMP::OpenMP_CXX)
            target_link_libraries(GSDecoder PRIVATE OpenMP::OpenMP_CXX)
        endif()
    endif()
endif()

# Configure the executable output directory.
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)
