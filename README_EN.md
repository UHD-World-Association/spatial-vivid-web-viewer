[Chinese version](README.md)

# UWA Spatial Vivid Web Renderer

This repository extends [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) into a WebGL reference renderer for UWA Spatial Vivid (3D Gaussian Splatting). The product code combines a Three.js/ES module frontend with a C++/Emscripten WASM decoder and provides UWA format parsing, reconstruction, compressed SH texture paths, and a browser demo.

## Device Requirements

The backend requires a Linux server for NPM compilation, service deployment, runtime execution, and expose the local service to the Internet.

The frontend requires a network-enabled smartphone, which accesses the public URL provided by the server through a web browser or WeChat to load and run the frontend service.

## Supported Inputs

- The upstream `.ply`, `.splat`, `.ksplat`, and `.spz` loaders remain available.
- The UWA path accepts UWA-specific `.glb` containers with GSBS payloads; it does not support arbitrary glTF/GLB files.
- The demo accepts local UWA `.glb` files. 

## Quick Start

When the frontend dependencies and complete WASM deployment artifacts are available,Download the dataset from this [link](https://theuwa.com/tech/SpatialVivid/dataset.zip), unzip it, and place it in the `demo/assets` directory. The examples and test assets used in this repository were trained by us using selected scenes/images from the following publicly available datasets: [Deep Blending Dataset](http://visual.cs.ucl.ac.uk/pubs/deepblending/) and [Mip-NeRF 360 Dataset](https://jonbarron.info/mipnerf360/)  run these commands from the repository root:

```bash
npm install
npm run build
npm run demo
```

Then open `http://localhost:8080/index.html`. See the [STARTUP_GUIDE_EN.md](STARTUP_GUIDE_EN.md) for preparing WASM from a clean clone, exact Windows/Linux commands, mobile LAN debugging, cache invalidation, and validation checklists.

## File Structure

The main file structure of the current project is as follows:

```
uwa/

│   │   ├── SplatMaterial.js
│   │   ├── SplatMaterial2D.js
│   │   ├── SplatMaterial3D.js
│   │   └── SplatScene.js
│   │
│   ├── splattree/
│   │   └── SplatTree.js         # Visible-region management and spatial organization
│   │
│   ├── worker/
│   │   ├── SortWorker.js        # Transparent Gaussian sorting Worker
│   │   ├── sorter.cpp
│   │   ├── sorter.wasm
│   │   └── sorter_*             # SIMD/non-SIMD and shared/non-shared variants
│   │
│   ├── raycaster/               # Ray casting
│   ├── ui/
│   │   ├── InfoPanel.js         # Parameter panel opened with the I key and render resolution display
│   │   ├── LoadingProgressBar.js
│   │   └── LoadingSpinner.js
│   ├── webxr/                   # AR/VR support
│   └── three-shim/              # Three.js WebGL capability compatibility layer
│
├── 3DGS_Render_glb_unpack/      # C++ decoder and Emscripten build project
│   ├── CMakeLists.txt
│   ├── WasmBridge.cpp           # Coordinator WASM interface
│   ├── ReconstructionBridge.cpp # Reconstruction WASM interface
│   ├── build_wasm.sh
│   ├── build_wasm_new.sh
│   ├── build_wasm_windows.ps1
│   │
│   ├── uwa_gsdecoder/
│   │   ├── gaussian_model/
│   │   │   ├── gs_decoder.cpp   # GSBS model-level decoding and preparation
│   │   │   ├── gs_data.cpp
│   │   │   └── reconstruction_kernel.cpp
│   │   ├── processor/
│   │   │   ├── stream.cpp       # GSBS bitstream parsing
│   │   │   ├── codec_decoder.cpp
│   │   │   ├── prediction.cpp
│   │   │   ├── quantizer.cpp
│   │   │   ├── transform.cpp
│   │   │   ├── unpacker.cpp
│   │   │   ├── texture_transcoder.cpp
│   │   │   └── platform/
│   │   │       ├── ffmpeg_video_decoder.cpp
│   │   │       ├── android_video_decoder.cpp
│   │   │       ├── apple_video_decoder.cpp
│   │   │       └── ohos_video_decoder.cpp
│   │   ├── test_codec0.cpp
│   │   └── test_decoder.cpp
│   │
│   └── thirdparty/
│       ├── astc-encoder
│       ├── bc7enc_rdo
│       ├── ffmpeg
│       ├── glm
│       ├── nlohmann
│       ├── zlib
│       └── zstd
│
├── util/
│   ├── server.js                # Local static server
│   ├── create-ksplat.js
│   └── import-base-64.js
│
├── emsdk/                       # Emscripten SDK directory/gitlink
├── build/                       # npm build outputs; not part of the main source code
└── node_modules/                # npm dependencies
```

The overall architecture can be divided into four main layers:

1. `demo/`: Handles local file selection, DPR input, and Viewer initialization.
2. `src/loaders/splatUWA/`: Handles UWA requests, capability-based strategy selection, Worker management, and WASM scheduling.
3. `3DGS_Render_glb_unpack/`: Handles C++ model decoding, video processing, texture decoding, and chunk-based reconstruction.
4. `src/splatmesh/` and `src/worker/`: Handle GPU resource construction, shading, and transparent Gaussian sorting.

## Validation Status

The repository includes JS unit tests, ESLint, and frontend builds, but it has no automated acceptance suite for the complete browser rendering path. It does not currently claim accepted first-frame time, FPS, VRAM savings, or a completed device/browser matrix. Those conclusions require reproducible measurements with fixed samples on target devices.

## Documentation

- [Detailed Chinese startup guide](%E5%90%AF%E5%8A%A8%E6%B5%81%E7%A8%8B.md): build, startup, and mobile debugging.
- [STARTUP_GUIDE_EN.md](STARTUP_GUIDE_EN.md): structurally equivalent English guide.