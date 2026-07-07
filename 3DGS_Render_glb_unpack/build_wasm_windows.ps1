param(
    [ValidateSet("Release", "Debug")]
    [string]$Configuration = "Release",

    [switch]$DisableSimd,
    [switch]$DisableLto,

    [string]$EmsdkPath = $env:EMSDK,

    [int]$InitialMemoryMB = 256,
    [int]$MaximumMemoryMB = 1024,
    [int]$KernelInitialMemoryMB = 32,
    [int]$KernelMaximumMemoryMB = 512,
    [int]$PthreadPoolSize = 4,
    [int]$VideoDecoderThreads = 0
)

$ErrorActionPreference = "Stop"
$coordinatorRspFile = "coordinator_sources.rsp"
$kernelRspFile = "kernel_sources.rsp"

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE."
    }
}

function Convert-ToRspPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        $fullPath = [System.IO.Path]::GetFullPath($Path)
    }
    else {
        $fullPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Path))
    }
    $basePath = [System.IO.Path]::GetFullPath((Get-Location).Path)
    if (-not $basePath.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $basePath += [System.IO.Path]::DirectorySeparatorChar
    }

    if ($fullPath.StartsWith($basePath, [System.StringComparison]::OrdinalIgnoreCase)) {
        $relativePath = $fullPath.Substring($basePath.Length)
    }
    else {
        $relativePath = $fullPath
    }

    return $relativePath.Replace("\", "/")
}

Push-Location $PSScriptRoot
try {
    if ($VideoDecoderThreads -eq 0) {
        $VideoDecoderThreads = $PthreadPoolSize
    }
    if ($PthreadPoolSize -le 0 -or $VideoDecoderThreads -le 0) {
        throw "PthreadPoolSize and VideoDecoderThreads must be positive integers."
    }
    Write-Host "[INFO] Checking for Emscripten..."
    $emccCommand = Get-Command emcc -ErrorAction SilentlyContinue
    if (-not $emccCommand) {
        $candidateEmsdkPaths = @(
            $EmsdkPath
            (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\emsdk") -ErrorAction SilentlyContinue)
        ) | Where-Object { $_ }

        foreach ($candidate in $candidateEmsdkPaths) {
            $emscriptenPath = Join-Path $candidate "upstream\emscripten"
            $emccExe = Join-Path $emscriptenPath "emcc.bat"
            if (Test-Path -LiteralPath $emccExe) {
                $env:EMSDK = $candidate
                $env:PATH = "$candidate;$emscriptenPath;$env:PATH"
                $emccCommand = Get-Command emcc -ErrorAction SilentlyContinue
                break
            }
        }
    }

    $emxxCommand = Get-Command "em++" -ErrorAction SilentlyContinue
    if (-not $emccCommand -or -not $emxxCommand) {
        throw "emcc/em++ not found. Source emsdk_env.ps1 or pass -EmsdkPath."
    }
    Write-Host "[INFO] emcc: $($emccCommand.Source)"

    $requiredPaths = @(
        "thirdparty/glm"
        "thirdparty/astc-encoder/Source"
        "thirdparty/zstd/lib"
        "thirdparty/ffmpeg/include"
        "thirdparty/ffmpeg/lib/libavcodec.a"
        "thirdparty/ffmpeg/lib/libavutil.a"
        "thirdparty/ffmpeg/lib/libswscale.a"
        "uwa_gsdecoder/processor"
        "uwa_gsdecoder/processor/platform"
        "uwa_gsdecoder/gaussian_model"
    )
    foreach ($path in $requiredPaths) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Required path is missing: $path."
        }
    }

    if ($Configuration -eq "Release") {
        $optimizationFlags = @("-O3", "-DNDEBUG", "-s", "ASSERTIONS=0")
    }
    else {
        $optimizationFlags = @("-O0", "-g", "-s", "ASSERTIONS=2")
    }

    $sharedFlags = $optimizationFlags + @(
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
    if (-not $DisableSimd) {
        $sharedFlags += "-msimd128"
        Write-Host "[INFO] SIMD128 enabled"
    }
    if (-not $DisableLto) {
        $sharedFlags += "-flto"
        Write-Host "[INFO] LTO enabled"
    }
    $cxxFlags = @("-std=c++17") + $sharedFlags
    $cFlags = $sharedFlags

    $includeFlags = @(
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

    $outputDir = "output"
    if (Test-Path -LiteralPath $outputDir) {
        Remove-Item -LiteralPath $outputDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $outputDir | Out-Null

    $zstdObj = Join-Path $outputDir "zstd_decoder.o"
    $zstdSources = @(
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
    Write-Host "[STEP 1/6] Compiling the single-threaded Zstd decoder..."
    Invoke-CheckedCommand -Command emcc -Arguments (
        $zstdSources + $cFlags + $includeFlags + @("-r", "-o", $zstdObj)
    )
    $zstdPthreadObj = Join-Path $outputDir "zstd_decoder_pthread.o"
    Write-Host "[STEP 2/6] Compiling the pthread Zstd decoder..."
    Invoke-CheckedCommand -Command emcc -Arguments (
        $zstdSources + $cFlags + $includeFlags + @("-pthread", "-r", "-o", $zstdPthreadObj)
    )

    $astcSources = Get-ChildItem -LiteralPath "thirdparty/astc-encoder/Source" -File -Filter "*.cpp" |
        Where-Object { $_.Name -notlike "*astcenccli*" } |
        Sort-Object FullName |
        ForEach-Object { Convert-ToRspPath $_.FullName }
    $coordinatorSources = @(
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
    Set-Content -LiteralPath $coordinatorRspFile -Value ($coordinatorSources + $astcSources) -Encoding ASCII

    $linkFlags = @(
        "-lembind"
        "-s", "MODULARIZE=1"
        "-s", "EXPORT_ES6=1"
        "-s", "ALLOW_MEMORY_GROWTH=1"
        "-s", "FILESYSTEM=0"
        "-s", "ENVIRONMENT=web,worker"
        "-s", "EXPORTED_RUNTIME_METHODS=HEAPF32,HEAPU8,HEAPU32,getExceptionMessage"
        "-s", "EXPORTED_FUNCTIONS=_malloc,_free"
        "-s", "STACK_OVERFLOW_CHECK=1"
        "-s", "DISABLE_EXCEPTION_CATCHING=0"
        "-s", "MALLOC=emmalloc"
    )

    $coordinatorOutput = Join-Path $outputDir "splat_uwa_wasm.js"
    Write-Host "[STEP 3/6] Linking the non-pthread coordinator..."
    $coordinatorArgs = @(
        "@$coordinatorRspFile"
        $zstdObj
        "thirdparty/ffmpeg/lib/libavcodec.a"
        "thirdparty/ffmpeg/lib/libswscale.a"
        "thirdparty/ffmpeg/lib/libavutil.a"
    ) + $cxxFlags + $includeFlags + $linkFlags + @(
        "-DUSE_ZSTD", "-DUSE_ASTC", "-DUSE_FFMPEG", "-DUSE_BC_TEXTURE_ENCODERS"
        "-s", "EXPORT_NAME=createSplatUWAWasm"
        "-s", "INITIAL_MEMORY=${InitialMemoryMB}MB"
        "-s", "MAXIMUM_MEMORY=${MaximumMemoryMB}MB"
        "-o", $coordinatorOutput
    )
    Invoke-CheckedCommand -Command "em++" -Arguments $coordinatorArgs

    $pthreadCoordinatorOutput = Join-Path $outputDir "splat_uwa_wasm_pthread.js"
    Write-Host "[STEP 4/6] Linking the pthread coordinator (pool=$PthreadPoolSize, FFmpeg threads=$VideoDecoderThreads)..."
    $pthreadCoordinatorArgs = @(
        "@$coordinatorRspFile"
        $zstdPthreadObj
        "thirdparty/ffmpeg/lib/libavcodec.a"
        "thirdparty/ffmpeg/lib/libswscale.a"
        "thirdparty/ffmpeg/lib/libavutil.a"
    ) + $cxxFlags + $includeFlags + $linkFlags + @(
        "-pthread"
        "-DUSE_ZSTD", "-DUSE_ASTC", "-DUSE_FFMPEG", "-DUSE_BC_TEXTURE_ENCODERS"
        "-DUWA_VIDEO_DECODER_THREADS=$VideoDecoderThreads"
        "-s", "PTHREAD_POOL_SIZE=$PthreadPoolSize"
        "-s", "EXPORT_NAME=createSplatUWAWasmPthread"
        "-s", "INITIAL_MEMORY=${InitialMemoryMB}MB"
        "-s", "MAXIMUM_MEMORY=${MaximumMemoryMB}MB"
        "-o", $pthreadCoordinatorOutput
    )
    Invoke-CheckedCommand -Command "em++" -Arguments $pthreadCoordinatorArgs

    $kernelSources = @(
        "ReconstructionBridge.cpp"
        "uwa_gsdecoder/gaussian_model/reconstruction_kernel.cpp"
        "uwa_gsdecoder/processor/prediction.cpp"
        "uwa_gsdecoder/processor/quantizer.cpp"
        "uwa_gsdecoder/processor/transform.cpp"
    )
    Set-Content -LiteralPath $kernelRspFile -Value $kernelSources -Encoding ASCII
    $kernelOutput = Join-Path $outputDir "splat_uwa_reconstruction_wasm.js"
    Write-Host "[STEP 5/6] Linking the non-pthread reconstruction kernel..."
    $kernelArgs = @("@$kernelRspFile") + $cxxFlags + $includeFlags + $linkFlags + @(
        "-s", "EXPORT_NAME=createSplatUWAReconstructionWasm"
        "-s", "INITIAL_MEMORY=${KernelInitialMemoryMB}MB"
        "-s", "MAXIMUM_MEMORY=${KernelMaximumMemoryMB}MB"
        "-o", $kernelOutput
    )
    Invoke-CheckedCommand -Command "em++" -Arguments $kernelArgs

    Write-Host "[STEP 6/6] Auditing generated artifacts..."
    $threadPattern = 'SharedArrayBuffer|Atomics\.|pthread_create|PThread\.'
    foreach ($jsArtifact in @($coordinatorOutput, $kernelOutput)) {
        if (Select-String -LiteralPath $jsArtifact -Pattern $threadPattern -Quiet) {
            throw "Thread/shared-memory runtime detected in $jsArtifact."
        }
    }
    foreach ($wasmArtifact in @(
        (Join-Path $outputDir "splat_uwa_wasm.wasm"),
        (Join-Path $outputDir "splat_uwa_reconstruction_wasm.wasm")
    )) {
        $artifactText = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($wasmArtifact))
        if ($artifactText -match 'pthread_create|SharedArrayBuffer') {
            throw "Thread/shared-memory symbol detected in $wasmArtifact."
        }
    }

    if (-not (Select-String -LiteralPath $pthreadCoordinatorOutput -Pattern $threadPattern -Quiet)) {
        throw "Pthread runtime was not detected in $pthreadCoordinatorOutput."
    }

    Write-Host "[SUCCESS] Built both coordinators and the non-pthread reconstruction kernel in $outputDir."
}
finally {
    foreach ($rspFile in @($coordinatorRspFile, $kernelRspFile)) {
        if (Test-Path -LiteralPath $rspFile) {
            Remove-Item -LiteralPath $rspFile -Force
        }
    }
    Pop-Location
}
