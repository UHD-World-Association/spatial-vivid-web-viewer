[Chinese version](%E5%90%AF%E5%8A%A8%E6%B5%81%E7%A8%8B.md)

# UWA Web Renderer Build, Startup, and Mobile Debugging Guide

This guide follows the current source code, build scripts, and demo. Every relative path starts at the repository root; no local clone name or reference-repository location is assumed. The values below are implementation defaults and configurable settings, not target-device performance or compatibility acceptance results.

## 1. Environment and Dependencies

### 1.1 Frontend

Install Node.js and npm. After a new clone or a `package-lock.json` change, install dependencies from the repository root:

```bash
npm install
```

`npm run demo` serves only `build/demo`; it does not rebuild that directory from source. Run the applicable frontend build before using the server to verify new source or WASM artifacts.

### 1.2 Submodules and Direct WASM Dependencies

Initialize the mapped submodules:

```bash
git submodule update --init --recursive
```

`.gitmodules` maps `astc-encoder`, `bc7enc_rdo`, `glm`, `zlib`, and `zstd`. The `nlohmann` headers are tracked directly under `3DGS_Render_glb_unpack/thirdparty/nlohmann/`. The repository also has an `emsdk` gitlink without a `.gitmodules` mapping, so a recursive clone/update may report an error for that path. Install Emscripten SDK separately instead of assuming that gitlink prepares the toolchain.

`build_wasm_new.sh` and `build_wasm_windows.ps1` directly check these paths:

```text
3DGS_Render_glb_unpack/thirdparty/glm/
3DGS_Render_glb_unpack/thirdparty/astc-encoder/Source/
3DGS_Render_glb_unpack/thirdparty/zstd/lib/
3DGS_Render_glb_unpack/thirdparty/ffmpeg/include/
3DGS_Render_glb_unpack/thirdparty/ffmpeg/lib/libavcodec.a
3DGS_Render_glb_unpack/thirdparty/ffmpeg/lib/libavutil.a
3DGS_Render_glb_unpack/thirdparty/ffmpeg/lib/libswscale.a
```

The two current WASM scripts also compile the repository's `bc7enc_rdo`, zstd, and decoder sources. `nlohmann` and zlib belong to the native CMake or other tool paths; they are not direct prerequisites of the current `build_wasm_new.sh` or `build_wasm_windows.ps1` flow. FFmpeg must be a header and static-library set that Emscripten can link; installing only a desktop FFmpeg command-line program does not satisfy this build.

### 1.3 Deployment Artifacts and Git State

The complete UWA runtime needs three JS/WASM pairs, or six primary artifacts:

```text
splat_uwa_wasm.js
splat_uwa_wasm.wasm
splat_uwa_wasm_pthread.js
splat_uwa_wasm_pthread.wasm
splat_uwa_reconstruction_wasm.js
splat_uwa_reconstruction_wasm.wasm
```

If Emscripten also emits `splat_uwa_wasm_pthread.worker.js`, copy it as well. Git currently tracks the pthread coordinator `.js/.wasm` pair. The ordinary coordinator, reconstruction artifacts, and `output/` are ignored. A clean clone is therefore not a complete runtime merely because it contains the pthread pair; build or otherwise provide all six primary artifacts.

## 2. Linux Build

### 2.1 Convenience Entry Point

`build_demo.sh` runs the WASM build, copies all primary artifacts and the optional pthread worker JS, and then runs `npm run build`. Its first line is currently a maintainer-specific path:

```bash
source ~/mylibs/emsdk/emsdk_env.sh
```

Change that line to the actual `emsdk_env.sh` location on the build machine, then run from the repository root:

```bash
npm install
bash build_demo.sh
```

### 2.2 Recommended Manual Route

The manual route avoids editing the convenience script:

```bash
source /path/to/emsdk/emsdk_env.sh

cd 3DGS_Render_glb_unpack
bash build_wasm_new.sh

cp output/splat_uwa_wasm.js ../src/loaders/splatUWA/
cp output/splat_uwa_wasm.wasm ../src/loaders/splatUWA/
cp output/splat_uwa_wasm_pthread.js ../src/loaders/splatUWA/
cp output/splat_uwa_wasm_pthread.wasm ../src/loaders/splatUWA/
if [[ -f output/splat_uwa_wasm_pthread.worker.js ]]; then
    cp output/splat_uwa_wasm_pthread.worker.js ../src/loaders/splatUWA/
fi
cp output/splat_uwa_reconstruction_wasm.js ../src/loaders/splatUWA/
cp output/splat_uwa_reconstruction_wasm.wasm ../src/loaders/splatUWA/

cd ..
npm run build
```

The Linux script defaults to `Release`, coordinator memory of `256 MB` initial / `1024 MB` maximum, reconstruction-kernel memory of `32 MB` initial / `512 MB` maximum, and a pthread pool of `4`. `UWA_VIDEO_DECODER_THREADS` defaults to `PTHREAD_POOL_SIZE`. These are script defaults, configurable through `build_wasm_new.sh --help`, `PTHREAD_POOL_SIZE`, and `UWA_VIDEO_DECODER_THREADS`; they are not mobile-device recommendations.

## 3. Start the Demo and Capability Probe

After the frontend build, start the server from the repository root:

```bash
npm run demo
```

The server listens on `0.0.0.0:8080` and sends COOP/COEP headers. Local URLs are:

```text
http://localhost:8080/index.html
http://localhost:8080/browser.html
```

When the phone and host are on the same LAN or hotspot, substitute the host's actual LAN address:

```text
http://<host-LAN-IP>:8080/index.html
http://<host-LAN-IP>:8080/browser.html
```

`browser.html` probes WebGL2, the project shader, ASTC upload, WASM SIMD, Workers, transferable ArrayBuffer, and related capabilities. It does not load a model and is not a complete rendering acceptance test.

## 4. Current Runtime Paths

### 4.1 Worker Topology

- The coordinator always uses a fixed pool of `2` reconstruction Web Workers. This is distinct from the Emscripten pthread pool.
- When `crossOriginIsolated === true` and `SharedArrayBuffer` is available, the loader prefers the pthread coordinator.
- When isolation is unavailable, or pthread JS import/compile/instantiation or its artifacts fail, the coordinator uses the single-thread WASM fallback.
- The included `util/server.js` sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Other servers need equivalent configuration; rely on the page's actual reported state.

### 4.2 Compressed SH Textures

The automatic policy is:

```text
ASTC extension + ASTC 4x4 TEXTURE_2D_ARRAY upload canary passes
  -> ASTC GPU
otherwise, browser BC3 upload canary + WASM BC3 encoder are both available
  -> BC3 GPU
otherwise
  -> CPU SH
```

BC7 transcoding and an enum exist internally, but the current coordinator capability mask does not publish BC7. Do not describe it as a released feature. The demo's "Enable BC compressed-texture path" checkbox is on by default. When enabled, it permits the BC candidates above. Turning it off excludes only BC3/BC7, not ASTC, so the chain becomes `ASTC -> CPU` or CPU only. A toggle disposes the old decoder session and repeats probing and warm-up.

### 4.3 Video

- Codec ID `0` is raw YUV444P in `T,3,H,W` order. After exact-length validation it uses passthrough and does not enter WebCodecs or FFmpeg.
- Only HEVC Main, 8-bit, 4:2:0 input is eligible for WebCodecs, and output must pass I420/NV12 planar-layout validation.
- WebCodecs incompatibility, failure, timeout, or invalid layout falls back to WASM FFmpeg. H.264 currently uses the FFmpeg fallback as well.
- This describes software routing and is not evidence of accepted target-device hardware decoding.

## 5. Demo Behavior and Timing Boundaries

### 5.1 Files and URLs

The demo's local-file flow loads UWA `.glb`. It accepts UWA-specific GLB/GSBS, not arbitrary glTF/GLB. A `.glb` URL is recognized as `SceneFormat.SplatUWA`, but the outer format guard in `Viewer.downloadSplatSceneToSplatBuffer()` currently makes the UWA URL branch unreachable. This guide records that known limitation; it does not fix it.

### 5.2 Render DPR, Window, and Screenshots

- The View panel's manual Render DPR defaults to `4` and becomes the Three renderer's fixed pixel ratio. There is no application-level maximum render-size cap and no runtime Render DPR setter.
- Browser DPR and manual Render DPR are separate. Browser DPR does not size the renderer; it is used for screenshot output dimensions.
- InfoPanel reports the CSS logical `Render window` and WebGL drawing-buffer `Render resolution`.
- Screenshot capture runs at the tail of the next complete `render()`. It produces an opaque black-background PNG with each output axis equal to `round(canvas CSS rect * Browser DPR)` and smoothly resamples the intrinsic WebGL canvas bitmap. It excludes DOM such as InfoPanel and is not an OS compositor or whole-browser screen capture.

### 5.3 First Frame and Timing JSON

The first-frame origin is the demo's View click / `firstFrameStartTimeMs`. The endpoint marker occurs after `renderer.render(splatMesh, camera)` returns for the first frame that actually contains splats. Helper/control-plane passes and that frame's screenshot tail occur after this marker. Early first-frame display does not replace final correct sorting or the complete visible-region update, which may continue after the marker.

Timing JSON retains raw endpoints, environment information, and staged records for file read/download, Worker wait, WASM prepare, video, unpack, shard reconstruction, merge/prune, SplatBuffer, GPU texture upload, and the first rendered frame. Warm-up stages can run in parallel. An elapsed interval may overlap other work and must not be treated as pure download time or as an additive wall-clock duration.

## 6. Cache and Mobile Remote Debugging

Changing only the `index.html` query string does not reliably invalidate separately addressed Worker, JavaScript, and WASM resources. When verifying new artifacts, use one or more browser-appropriate methods:

- Clear site data and Service Worker caches for the origin, if present.
- Enable Disable cache in DevTools and keep DevTools attached.
- Use a fresh browser profile or private session, noting that a private session still caches within that session.
- Deploy genuinely versioned Worker/JS/WASM asset URLs.

Android Chrome can attach through `chrome://inspect/#devices`. Refreshes, navigation, process restarts, or multiple same-origin tabs can leave DevTools attached to an older page. Recheck the URL, `crossOriginIsolated`, resource responses, and current target instead of trusting an already-open inspect window. Use the corresponding remote-debug tooling on Safari/iOS or other browsers and verify the actual page and asset versions there as well.

## 7. Validation Workflow

### 7.1 Automated Checks

```bash
node --test src/loaders/splatUWA/__tests__/*.test.js
npm run build
npm run lint
```

`npm run lint` ends with `|| true`, so a successful process exit does not mean ESLint reported no diagnostics; inspect its output. `npm run build` regenerates `build/`, so check Git status before and after to avoid mistaking unrelated generated output for source changes.

### 7.2 Browser and Mobile Manual Checklist

- Run `browser.html` first and record actual WebGL2, ASTC/BC, SIMD, Worker, transferable ArrayBuffer, and cross-origin-isolation results.
- With a fixed UWA sample, test first/repeated local-file loads, cancellation, timeout, dispose, and repeated warm-up.
- Cover ASTC GPU, the currently published BC3 GPU path, and CPU SH fallback; compare point attributes, SH, UVs, pruning, sorting, and image output.
- Cover codec0 raw passthrough, a valid HEVC WebCodecs success path, and FFmpeg fallback.
- Confirm final sorting, interaction, and visible-region completion after the first rendered frame.
- Check Render window/Render resolution, manual Render DPR, Browser DPR, and screenshot size/black-background/DOM-exclusion semantics.
- Check console exceptions, Worker/WASM/GPU resource lifetime, and persistent growth across repeated loads.
- Record sample, device, OS, browser version, build mode, thread/memory configuration, cache/network conditions, and raw data from multiple runs.

The presence of a source path, a passing unit test, or a successful desktop build does not replace target-device acceptance.

## 8. Troubleshooting

### `emcc` / `em++` Not Found

Reactivate Emscripten in the current shell, then run `command -v em++` on Linux or `Get-Command "em++"` in PowerShell. Confirm that the SDK path and script parameter identify the same installation.

### Missing FFmpeg or Third-Party Path

Check the exact path named by the error against the submodules, FFmpeg `include/`, and the three static libraries. Do not infer that the WASM static libraries are ready merely because a system FFmpeg executable exists.

### Pthread Was Not Selected

Check all six primary artifacts together with page `crossOriginIsolated`, `SharedArrayBuffer`, COOP/COEP response headers, and pthread import/instantiation diagnostics. The single-thread fallback is controlled behavior; without evidence, do not attribute it to a device model.

### Memory Allocation, `std::bad_alloc`, or Page Termination

These symptoms can arise in different stages from mismatched assets, damaged input, concurrency settings, or actual memory pressure. Preserve the full console, Timing JSON, capability-probe result, sample, and environment details. Identify the failing stage, then change one parameter at a time on the same device. Without that evidence, do not assert a specific OOM cause or offer a universal thread/memory recommendation.

### The Phone Still Runs Old Assets

Copy every coordinator/pthread/reconstruction artifact again and rebuild the frontend. Then clear site data, disable cache, use a fresh profile, or deploy truly versioned asset URLs. Do not treat changing only `index.html?v=...` as evidence that Worker/JS/WASM resources were invalidated.