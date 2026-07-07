[英文版 / English version](README_EN.md)

# UWA Spatial Vivid Web 渲染器

本仓库是基于 [GaussianSplats3D](https://github.com/mkkellogg/GaussianSplats3D) 扩展的 UWA Spatial Vivid（3D Gaussian Splatting）WebGL 参考渲染器。产品代码由 Three.js / ES module 前端和 C++ / Emscripten WASM 解码器组成，提供 UWA 格式的解析、重建、压缩 SH 纹理路径和浏览器 Demo。

## 设备需求

后端需配备一台 Linux 服务器，用于完成项目的 NPM 编译、服务部署与运行，将本地服务转发至公网。

前端需准备一台 **具备网络连接能力的智能手机**，通过浏览器或微信等客户端访问服务器提供的公网地址，以加载并运行前端服务。

## 支持的输入

- 保留上游 `.ply`、`.splat`、`.ksplat` 和 `.spz` 加载能力。
- UWA 路径支持包含 GSBS 载荷的 UWA 专用 `.glb`；不支持任意 glTF/GLB 文件。
- 支持从本地选择 UWA `.glb`。

## 快速开始

已具备完整前端依赖和所需 WASM 部署产物时，下载数据集于此[链接](https://theuwa.com/tech/SpatialVivid/dataset.zip)，解压后放置于demo/assets下。本仓库中使用的示例和测试资源，是由我们利用以下公开数据集中的精选场景或图像训练而成的：[Deep Blending](http://visual.cs.ucl.ac.uk/pubs/deepblending/)与[Mip-NeRF 360](https://jonbarron.info/mipnerf360/)

在仓库根目录执行：

```bash
npm install
npm run build
npm run demo
```

然后打开 `http://localhost:8080/index.html`。 准备 WASM、Windows/Linux 命令、局域网手机调试、缓存清理和验证清单请见[启动流程.md](%E5%90%AF%E5%8A%A8%E6%B5%81%E7%A8%8B.md)。

## 文件结构

当前项目主要文件结构如下：

```
uwa/
├── package.json                 # npm 脚本、依赖和发布文件配置
├── package-lock.json
├── rollup.config.js             # Rollup 打包配置
├── build_demo.sh                # Demo 构建脚本
├── browser.html                 # 浏览器入口页面
├── README.md
├── README_EN.md                 # UWA Web/WASM 构建与启动说明
├── 启动流程.md
├── LICENSE
│
├── demo/                        # 浏览器 Demo 页面
│   ├── index.html               # 本地文件选择、DPR 输入、Viewer 创建入口
│   ├── bonsai.html
│   ├── garden.html
│   ├── stump.html
│   ├── truck.html
│   ├── dropin.html
│   ├── dynamic_dropin.html
│   ├── dynamic_scenes.html
│   ├── vr.html
│   ├── js/
│   │   └── util.js
│   └── assets/images/           # Demo 图片资源
│
├── src/                         # JavaScript 渲染器主源码
│   ├── index.js                 # 库公共导出入口
│   ├── Viewer.js                # 场景、相机、渲染循环、排序和 DPR 管理
│   ├── DropInViewer.js
│   ├── SceneHelper.js
│   ├── OrbitControls.js
│   ├── Util.js
│   ├── Constants.js
│   │
│   ├── loaders/                 # 文件加载与 SplatBuffer 构造
│   │   ├── SceneFormat.js
│   │   ├── SplatBuffer.js
│   │   ├── SplatBufferGenerator.js
│   │   ├── UncompressedSplatArray.js
│   │   ├── ply/                 # PLY 格式解析
│   │   ├── splat/               # SPLAT 格式解析
│   │   ├── ksplat/              # KSPLAT 格式解析
│   │   ├── spz/                 # SPZ 格式解析
│   │   │
│   │   └── splatUWA/            # UWA Web/WASM 加载与解码核心
│   │       ├── SplatUWALoader.js
│   │       │                   # 主线程请求管理、策略传递和 SplatBuffer 构造
│   │       ├── TextureStrategy.js
│   │       │                   # ASTC、BC3、BC7、CPU 策略与能力探测
│   │       ├── SphericalHarmonicsLayout.js
│   │       ├── WebCodecsVideoDecoder.js
│   │       ├── WebCodecsCapabilityCanary.js
│   │       │
│   │       ├── SplatDecoderBootstrap.worker.js
│   │       │                   # 协调 Worker 启动引导
│   │       ├── SplatDecoder.worker.js
│   │       │                   # 容器提取、Coordinator 调度、策略回退和合并
│   │       ├── SplatReconstruction.worker.js
│   │       │                   # 分片重建 Worker
│   │       │
│   │       ├── splat_uwa_wasm.js
│   │       ├── splat_uwa_wasm.wasm
│   │       │                   # 单线程 Coordinator WASM
│   │       ├── splat_uwa_wasm_pthread.js
│   │       ├── splat_uwa_wasm_pthread.wasm
│   │       │                   # pthread Coordinator WASM
│   │       ├── splat_uwa_reconstruction_wasm.js
│   │       ├── splat_uwa_reconstruction_wasm.wasm
│   │       │                   # Reconstruction WASM
│   │       │
│   │       └── __tests__/
│   │           ├── TextureStrategy.test.js
│   │           ├── WebCodecsVideoDecoder.test.js
│   │           ├── SplatDecoderVideoPath.test.js
│   │           ├── CompressedTextureLayout.test.js
│   │           └── SphericalHarmonicsLayout.test.js
│   │
│   ├── splatmesh/               # 高斯数据到 GPU 渲染资源
│   │   ├── SplatMesh.js         # 数据纹理、压缩纹理和场景组合
│   │   ├── SplatGeometry.js
│   │   ├── SplatMaterial.js
│   │   ├── SplatMaterial2D.js
│   │   ├── SplatMaterial3D.js
│   │   └── SplatScene.js
│   │
│   ├── splattree/
│   │   └── SplatTree.js         # 可见区域与空间组织
│   │
│   ├── worker/
│   │   ├── SortWorker.js        # 透明高斯排序 Worker
│   │   ├── sorter.cpp
│   │   ├── sorter.wasm
│   │   └── sorter_*             # SIMD、非 SIMD、共享/非共享版本
│   │
│   ├── raycaster/               # 射线检测
│   ├── ui/
│   │   ├── InfoPanel.js         # I 键参数面板和渲染分辨率
│   │   ├── LoadingProgressBar.js
│   │   └── LoadingSpinner.js
│   ├── webxr/                   # AR/VR 支持
│   └── three-shim/              # Three.js WebGL 能力兼容层
│
├── 3DGS_Render_glb_unpack/       # C++ 解码器和 Emscripten 构建工程
│   ├── CMakeLists.txt
│   ├── WasmBridge.cpp            # Coordinator WASM 接口
│   ├── ReconstructionBridge.cpp  # Reconstruction WASM 接口
│   ├── build_wasm.sh
│   ├── build_wasm_new.sh
│   ├── build_wasm_windows.ps1
│   │
│   ├── uwa_gsdecoder/
│   │   ├── gaussian_model/
│   │   │   ├── gs_decoder.cpp   # GSBS 模型级解码与准备
│   │   │   ├── gs_data.cpp
│   │   │   └── reconstruction_kernel.cpp
│   │   ├── processor/
│   │   │   ├── stream.cpp       # GSBS 码流解析
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
│   ├── server.js                 # 本地静态服务器
│   ├── create-ksplat.js
│   └── import-base-64.js
│
├── emsdk/                        # Emscripten SDK 目录/gitlink
├── build/                        # npm build 生成物，不属于主要源码
└── node_modules/                 # npm 依赖
```

整体可分为四层：

1. `demo/`：用户选择文件、输入 DPR 并启动 Viewer。
2. `src/loaders/splatUWA/`：负责 UWA 请求、能力策略、Worker 和 WASM 调度。
3. `3DGS_Render_glb_unpack/`：负责 C++ 模型解码、视频处理、纹理解码和分片重建。
4. `src/splatmesh/`、`src/worker/`：负责 GPU 资源建立、着色和透明高斯排序。

## 文档

- [启动流程.md](%E5%90%AF%E5%8A%A8%E6%B5%81%E7%A8%8B.md)：详细中文构建、启动与手机调试指南。
- [STARTUP_GUIDE_EN.md](STARTUP_GUIDE_EN.md)：与中文指南结构等价的英文版。