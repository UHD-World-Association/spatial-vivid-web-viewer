import * as THREE from 'three';
import { SplatMaterial3D } from './SplatMaterial3D.js';
import { SplatMaterial2D } from './SplatMaterial2D.js';
import { getCompressedTextureSampleAddress } from './SplatMaterial.js';
import { SplatGeometry } from './SplatGeometry.js';
import { SplatScene } from './SplatScene.js';
import { SplatTree } from '../splattree/SplatTree.js';
import { WebGLExtensions } from '../three-shim/WebGLExtensions.js';
import { WebGLCapabilities } from '../three-shim/WebGLCapabilities.js';
import { uintEncodedFloat, rgbaArrayToInteger } from '../Util.js';
import { Constants } from '../Constants.js';
import { SceneRevealMode } from '../SceneRevealMode.js';
import { SplatRenderMode } from '../SplatRenderMode.js';
import { LogLevel } from '../LogLevel.js';
import { clamp, getSphericalHarmonicsComponentCountForDegree } from '../Util.js';
import { UwaPostprocessSplatBuffer } from '../loaders/splatUWA/postprocess/UwaPostprocess.js';

const dummyGeometry = new THREE.BufferGeometry();
const dummyMaterial = new THREE.MeshBasicMaterial();

const COVARIANCES_ELEMENTS_PER_SPLAT = 6;
const CENTER_COLORS_ELEMENTS_PER_SPLAT = 4;

const COVARIANCES_ELEMENTS_PER_TEXEL_STORED = 4;
const COVARIANCES_ELEMENTS_PER_TEXEL_ALLOCATED = 4;
const COVARIANCES_ELEMENTS_PER_TEXEL_COMPRESSED_STORED = 6;
const COVARIANCES_ELEMENTS_PER_TEXEL_COMPRESSED_ALLOCATED = 8;
const SCALES_ROTATIONS_ELEMENTS_PER_TEXEL = 4;
const CENTER_COLORS_ELEMENTS_PER_TEXEL = 4;
const SCENE_INDEXES_ELEMENTS_PER_TEXEL = 1;

const SCENE_FADEIN_RATE_FAST = 0.012;
const SCENE_FADEIN_RATE_GRADUAL = 0.003;

const VISIBLE_REGION_EXPANSION_DELTA = 1;
const EMPTY_UINT32_ARRAY = new Uint32Array(0);

const ASTC_FORMATS = {
    '4x4': THREE.RGBA_ASTC_4x4_Format,
    '5x5': THREE.RGBA_ASTC_5x5_Format,
    '6x6': THREE.RGBA_ASTC_6x6_Format,
    '8x8': THREE.RGBA_ASTC_8x8_Format,
    '10x10': THREE.RGBA_ASTC_10x10_Format,
    '12x12': THREE.RGBA_ASTC_12x12_Format
};

function compressedTextureThreeFormat(format, blockWidth, blockHeight) {
    if (format === 'astc') return ASTC_FORMATS[`${blockWidth}x${blockHeight}`];
    if (blockWidth !== 4 || blockHeight !== 4) return undefined;
    if (format === 'bc7') return THREE.RGBA_BPTC_Format;
    if (format === 'bc3') return THREE.RGBA_S3TC_DXT5_Format;
    return undefined;
}

function validateCompressedTexturePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('Compressed texture payload is missing.');
    const { format, raw, metas } = payload;
    const width = Number(payload.width ?? metas?.[1]);
    const height = Number(payload.height ?? metas?.[2]);
    const layers = Number(payload.layers ?? (metas ? metas.length / 6 : 0));
    const blockWidth = Number(payload.blockWidth ?? metas?.[0]);
    const blockHeight = Number(payload.blockHeight ?? metas?.[0]);
    const singleWidth = Number(payload.singleWidth ?? metas?.[3]);
    const regionPixelCount = Number(payload.regionPixelCount ?? metas?.[4]);
    const singleHeight = Number(payload.singleHeight ?? regionPixelCount / singleWidth);
    const threeFormat = compressedTextureThreeFormat(format, blockWidth, blockHeight);

    if (!(raw instanceof Uint8Array) || raw.byteLength === 0) {
        throw new Error(`Compressed texture payload ${format || 'unknown'} has no byte data.`);
    }
    if (![width, height, layers, blockWidth, blockHeight, singleWidth, singleHeight,
        regionPixelCount].every(Number.isInteger) ||
        width <= 0 || height <= 0 || layers <= 0 || blockWidth <= 0 || blockHeight <= 0 || singleWidth <= 0 ||
        singleHeight <= 0 || regionPixelCount !== singleWidth * singleHeight ||
        singleWidth > width || singleHeight > height || width > 16384 || height > 16384 || layers !== 1 || !threeFormat ||
        !Number.isFinite(payload.shnMin) || !Number.isFinite(payload.shnMax) || payload.shnMax < payload.shnMin) {
        throw new Error(`Compressed texture payload ${format || 'unknown'} has invalid format or dimensions.`);
    }
    if (metas && (metas.length !== layers * 6 ||
        payload.textureNum !== undefined && payload.textureNum !== layers)) {
        throw new Error(`Compressed texture payload ${format} has inconsistent layer metadata.`);
    }
    if (metas) {
        let metadataBytes = 0;
        for (let layer = 0; layer < layers; layer++) {
            const offset = layer * 6;
            if (metas[offset] !== blockWidth || metas[offset + 1] !== width ||
                metas[offset + 2] !== height || metas[offset + 3] !== singleWidth ||
                metas[offset + 4] !== regionPixelCount) {
                throw new Error(`Compressed texture payload ${format} has incompatible array-layer metadata.`);
            }
            metadataBytes += metas[offset + 5];
        }
        if (metadataBytes !== raw.byteLength) {
            throw new Error(`Compressed texture payload ${format} stream sizes do not match its byte data.`);
        }
    }

    const expectedRawSize = Math.ceil(width / blockWidth) * Math.ceil(height / blockHeight) * 16 * layers;
    if (raw.byteLength !== expectedRawSize) {
        throw new Error(
            `Compressed texture payload ${format} has ${raw.byteLength} bytes; expected ${expectedRawSize}.`
        );
    }
    if (payload.uvs instanceof Uint32Array && payload.uvs.length >= 2) {
        const shDegree = Math.max(1, Math.min(3, Number(payload.shDegree) || 1));
        const coefficientCount = getSphericalHarmonicsComponentCountForDegree(shDegree) / 3;
        const lastAddress = getCompressedTextureSampleAddress(
            payload.uvs[0], payload.uvs[1], coefficientCount - 1,
            singleWidth, singleHeight, width
        );
        if (lastAddress.x >= width || lastAddress.y >= height || lastAddress.layer !== 0) {
            throw new Error(`Compressed texture payload ${format} cannot address its SH regions.`);
        }
    }
    return {
        format, raw, width, height, layers, blockWidth, blockHeight,
        singleWidth, singleHeight, threeFormat
    };
}

function absoluteNowMs() {
    try {
        const timeOrigin = performance.timeOrigin;
        const now = performance.now();
        const absolute = timeOrigin + now;
        if (Number.isFinite(timeOrigin) && Number.isFinite(now) && Number.isFinite(absolute)) return absolute;
    } catch (_) {}
    return Date.now();
}

function absoluteFromPerformanceMs(value) {
    try {
        const timeOrigin = performance.timeOrigin;
        if (Number.isFinite(timeOrigin) && Number.isFinite(value)) return timeOrigin + value;
    } catch (_) {}
    return undefined;
}

function addProcessingTimelineEvent(processingProfile, id, startAbsMs, endAbsMs) {
    if (!processingProfile || !Number.isFinite(startAbsMs) || !Number.isFinite(endAbsMs) || endAbsMs < startAbsMs) return;
    let events = processingProfile.__timelineEvents;
    if (!Array.isArray(events)) {
        events = [];
        try {
            Object.defineProperty(processingProfile, '__timelineEvents', {
                value: events,
                enumerable: false,
                configurable: true
            });
        } catch (_) {
            processingProfile.__timelineEvents = events;
        }
    }
    events.push({
        id: `mesh.${id}`,
        lane: 'main.mesh',
        task: id,
        startAbsMs,
        endAbsMs,
        durationMs: endAbsMs - startAbsMs,
        source: 'SplatMesh.js',
        evidence: 'measured'
    });
}

const recordProcessingDuration = (processingProfile, key, startTime) => {
    if (!processingProfile) return;
    const endTime = performance.now();
    const elapsedMs = endTime - startTime;
    processingProfile[key] = (processingProfile[key] || 0) + elapsedMs;
    addProcessingTimelineEvent(processingProfile, key,
        absoluteFromPerformanceMs(startTime), absoluteFromPerformanceMs(endTime) ?? absoluteNowMs());
};

// Based on my own observations across multiple devices, OSes and browsers, using textures that have one dimension
// greater than 4096 while the other is greater than or equal to 4096 causes issues (Essentially any texture larger
// than 4096 x 4096 (16777216) texels). Specifically it seems all texture data beyond the 4096 x 4096 texel boundary
// is corrupted, while data below that boundary is usable. In these cases the texture has been valid in the eyes of
// both Three.js and WebGL, and the texel format (RG, RGBA, etc.) has not mattered. More investigation will be needed,
// but for now the work-around is to split the spherical harmonics into three textures (one for each color channel).
const MAX_TEXTURE_TEXELS = 16777216;

function computeDataTextureSize(elementsPerTexel, elementsPerSplat, maxSplatCount, previewBuild = false,
                                allowOverMaxTextureSize = false) {
    if (!Number.isFinite(elementsPerTexel) || elementsPerTexel <= 0 ||
        !Number.isFinite(elementsPerSplat) || elementsPerSplat <= 0 ||
        !Number.isSafeInteger(maxSplatCount) || maxSplatCount < 0) {
        throw new RangeError('Invalid data texture size inputs.');
    }
    const width = previewBuild ? 1024 : 4096;
    const requiredElements = maxSplatCount * elementsPerSplat;
    if (!Number.isFinite(requiredElements) || requiredElements < 0 || requiredElements > Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Data texture size exceeds numeric precision.');
    }
    const requiredTexels = Math.ceil(requiredElements / elementsPerTexel);
    let height = 1;
    while (width * height < requiredTexels) {
        if (!allowOverMaxTextureSize && width * height >= MAX_TEXTURE_TEXELS) {
            throw new RangeError('Data texture size exceeds MAX_TEXTURE_TEXELS.');
        }
        height *= 2;
    }
    if (!allowOverMaxTextureSize && width * height > MAX_TEXTURE_TEXELS) {
        throw new RangeError('Data texture size exceeds MAX_TEXTURE_TEXELS.');
    }
    return new THREE.Vector2(width, height);
}

/**
 * SplatMesh: Container for one or more splat scenes, abstracting them into a single unified container for
 * splat data. Additionally contains data structures and code to make the splat data renderable as a Three.js mesh.
 */
export class SplatMesh extends THREE.Mesh {

    constructor(splatRenderMode = SplatRenderMode.ThreeD, dynamicMode = false, enableOptionalEffects = false,
                halfPrecisionCovariancesOnGPU = false, devicePixelRatio = 1, enableDistancesComputationOnGPU = true,
                integerBasedDistancesComputation = false, antialiased = false, maxScreenSpaceSplatSize = 324, logLevel = LogLevel.None,
                sphericalHarmonicsDegree = 0, sceneFadeInRateMultiplier = 1.0, kernel2DSize = 0.18,
                minimumGaussianContribution = 1 / 1024, useDirectScaleRotationCovariance = true) {
        super(dummyGeometry, dummyMaterial);

        // Reference to a Three.js renderer
        this.renderer = undefined;

        // Determine how the splats are rendered
        this.splatRenderMode = splatRenderMode;

        // When 'dynamicMode' is true, scenes are assumed to be non-static. Dynamic scenes are handled differently
        // and certain optimizations cannot be made for them. Additionally, by default, all splat data retrieved from
        // this splat mesh will not have their scene transform applied to them if the splat mesh is dynamic. That
        // can be overriden via parameters to the individual functions that are used to retrieve splat data.
        this.dynamicMode = dynamicMode;

        // When true, allows for usage of extra properties and attributes during rendering for effects such as opacity adjustment.
        // Default is false for performance reasons. These properties are separate from transform properties (scale, rotation, position)
        // that are enabled by the 'dynamicScene' parameter.
        this.enableOptionalEffects = enableOptionalEffects;

        // Use 16-bit floating point values when storing splat covariance data in textures, instead of 32-bit
        this.halfPrecisionCovariancesOnGPU = halfPrecisionCovariancesOnGPU;

        // Ratio of the resolution in physical pixels to the resolution in CSS pixels for the current display device
        this.devicePixelRatio = devicePixelRatio;

        // Use a transform feedback to calculate splat distances from the camera
        this.enableDistancesComputationOnGPU = enableDistancesComputationOnGPU;

        // Use a faster integer-based approach for calculating splat distances from the camera
        this.integerBasedDistancesComputation = integerBasedDistancesComputation;

        // When true, will perform additional steps during rendering to address artifacts caused by the rendering of gaussians at a
        // substantially different resolution than that at which they were rendered during training. This will only work correctly
        // for models that were trained using a process that utilizes this compensation calculation. For more details:
        // https://github.com/nerfstudio-project/gsplat/pull/117
        // https://github.com/graphdeco-inria/gaussian-splatting/issues/294#issuecomment-1772688093
        this.antialiased = antialiased;

        // The size of the 2D kernel used for splat rendering
        // This will adjust the 2D kernel size after the projection
        this.kernel2DSize = kernel2DSize;

        // Minimum alpha contribution retained by the 3D gaussian shader. The 2D splat path intentionally ignores it.
        const requestedMinimumContribution = Number(minimumGaussianContribution);
        this.minimumGaussianContribution = Number.isFinite(requestedMinimumContribution) ?
            clamp(requestedMinimumContribution, 0, 1) : (1 / 1024);

        // Online scale/rotation covariance is the default for UWA direct
        // results. Pass false to use the experimental covariance texture path.
        this.useDirectScaleRotationCovariance = useDirectScaleRotationCovariance !== false;

        // Specify the maximum clip space splat size, can help deal with large splats that get too unwieldy
        this.maxScreenSpaceSplatSize = maxScreenSpaceSplatSize;

        // The verbosity of console logging
        this.logLevel = logLevel;

        // Degree 0 means no spherical harmonics
        this.sphericalHarmonicsDegree = sphericalHarmonicsDegree;
        this.minSphericalHarmonicsDegree = 0;

        this.sceneFadeInRateMultiplier = sceneFadeInRateMultiplier;

        // The individual splat scenes stored in this splat mesh, each containing their own transform
        this.scenes = [];

        // Special octree tailored to SplatMesh instances
        this.splatTree = null;
        this.baseSplatTree = null;

        // Cache textures and the intermediate data used to populate them
        this.splatDataTextures = {};
        this.generatedDataTextureBytes = {};

        this.distancesTransformFeedback = {
            'id': null,
            'vertexShader': null,
            'fragmentShader': null,
            'program': null,
            'centersBuffer': null,
            'sceneIndexesBuffer': null,
            'outDistancesBuffer': null,
            'centersLoc': -1,
            'modelViewProjLoc': -1,
            'sceneIndexesLoc': -1,
            'transformsLocs': []
        };

        this.globalSplatIndexToLocalSplatIndexMap = [];
        this.globalSplatIndexToSceneIndexMap = [];
        // A single scene whose global offset is zero has an implicit identity
        // mapping. Keep this explicit so empty map arrays cannot be confused
        // with an uninitialized or disposed mesh.
        this.implicitSingleSceneIndexMap = false;

        this.lastBuildSplatCount = 0;
        this.lastBuildScenes = [];
        this.lastBuildMaxSplatCount = 0;
        this.lastBuildSceneCount = 0;
        this.firstRenderTime = -1;
        this.finalBuild = false;

        this.webGLUtils = null;

        this.boundingBox = new THREE.Box3();
        this.calculatedSceneCenter = new THREE.Vector3();
        this.maxSplatDistanceFromSceneCenter = 0;
        this.visibleRegionBufferRadius = 0;
        this.visibleRegionRadius = 0;
        this.visibleRegionFadeStartRadius = 0;
        this.visibleRegionChanging = false;

        this.splatScale = 1.0;
        this.pointCloudModeEnabled = false;

        this.useCompressedTexture = false;
        // Compatibility alias retained for integrations that inspect this flag.
        this.useASTC = false;

        // A material retained after an early shader compile.  It is consumed by
        // the first build whose complete shader variant key matches exactly.
        this.precompiledMaterial = null;
        this.precompiledMaterialKey = null;

        this.disposed = false;
        this.lastRenderer = null;
        this.visible = false;
    }

    static computeDataTextureSize(elementsPerTexel, elementsPerSplat, maxSplatCount, previewBuild = false,
                                  allowOverMaxTextureSize = false) {
        return computeDataTextureSize(elementsPerTexel, elementsPerSplat, maxSplatCount,
                                      previewBuild, allowOverMaxTextureSize);
    }

    /**
     * Build a container for each scene managed by this splat mesh based on an instance of SplatBuffer, along with optional
     * transform data (position, scale, rotation) passed to the splat mesh during the build process.
     * @param {Array<THREE.Matrix4>} splatBuffers SplatBuffer instances containing splats for each scene
     * @param {Array<object>} sceneOptions Array of options objects: {
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     * }
     * @return {Array<THREE.Matrix4>}
     */
    static buildScenes(parentObject, splatBuffers, sceneOptions) {
        const scenes = [];
        scenes.length = splatBuffers.length;
        for (let i = 0; i < splatBuffers.length; i++) {
            const splatBuffer = splatBuffers[i];
            const options = sceneOptions[i] || {};
            let positionArray = options['position'] || [0, 0, 0];
            let rotationArray = options['rotation'] || [0, 0, 0, 1];
            let scaleArray = options['scale'] || [1, 1, 1];
            const position = new THREE.Vector3().fromArray(positionArray);
            const rotation = new THREE.Quaternion().fromArray(rotationArray);
            const scale = new THREE.Vector3().fromArray(scaleArray);
            const scene = SplatMesh.createScene(splatBuffer, position, rotation, scale,
                                                options.splatAlphaRemovalThreshold || 1, options.opacity, options.visible);
            parentObject.add(scene);
            scenes[i] = scene;
        }
        return scenes;
    }

    static createScene(splatBuffer, position, rotation, scale, minimumAlpha, opacity = 1.0, visible = true) {
        return new SplatScene(splatBuffer, position, rotation, scale, minimumAlpha, opacity, visible);
    }

    buildFromUwaPostprocessResult(result, sceneOptions = [{}], finalBuild = true,
                                  keepSceneTransforms = true, onSplatTreeIndexesUpload,
                                  onSplatTreeConstruction, preserveVisibleRegion = true,
                                  processingProfile = null) {
        if (!result?.isUwaPostprocessResult && !(result instanceof UwaPostprocessSplatBuffer)) {
            throw new Error('Invalid UWA postprocess result.');
        }
        const buffer = result instanceof UwaPostprocessSplatBuffer ? result : new UwaPostprocessSplatBuffer(result);
        return this.build([buffer], sceneOptions, keepSceneTransforms, finalBuild,
                          onSplatTreeIndexesUpload, onSplatTreeConstruction,
                          preserveVisibleRegion, processingProfile);
    }

    /** Build directly from a UWA postprocess result without allocating an adapter object. */
    buildFromUwaGpuData(result, sceneOptions = [{}], finalBuild = true,
                        keepSceneTransforms = true, onSplatTreeIndexesUpload,
                        onSplatTreeConstruction, preserveVisibleRegion = true,
                        processingProfile = null) {
        if (!result?.isUwaPostprocessResult) throw new Error('Invalid UWA postprocess GPU data result.');
        const directResult = UwaPostprocessSplatBuffer.attachResult(result);
        if (processingProfile) {
            processingProfile.uwaGpuDataDirect = true;
            processingProfile.uwaGpuBackend = result.backend || 'cpu';
        }
        return this.build([directResult], sceneOptions, keepSceneTransforms, finalBuild,
                          onSplatTreeIndexesUpload, onSplatTreeConstruction,
                          preserveVisibleRegion, processingProfile, result);
    }

    /**
     * Build data structures that map global splat indexes (based on a unified index across all splat buffers) to
     * local data within a single scene.
     * @param {Array<SplatBuffer>} splatBuffers Instances of SplatBuffer off which to build the maps
     * @return {object}
     */
    static buildSplatIndexMaps(splatBuffers) {
        if (splatBuffers.length === 1) {
            return {
                localSplatIndexMap: [],
                sceneIndexMap: [],
                implicitSingleSceneIndexMap: true
            };
        }
        const localSplatIndexMap = [];
        const sceneIndexMap = [];
        let totalSplatCount = 0;
        for (let s = 0; s < splatBuffers.length; s++) {
            const splatBuffer = splatBuffers[s];
            const maxSplatCount = splatBuffer.getMaxSplatCount();
            for (let i = 0; i < maxSplatCount; i++) {
                localSplatIndexMap[totalSplatCount] = i;
                sceneIndexMap[totalSplatCount] = s;
                totalSplatCount++;
            }
        }
        return {
            localSplatIndexMap,
            sceneIndexMap,
            implicitSingleSceneIndexMap: false
        };
    }

    /**
     * Build an instance of SplatTree (a specialized octree) for the given splat mesh.
     * @param {Array<number>} minAlphas Array of minimum splat slphas for each scene
     * @param {function} onSplatTreeIndexesUpload Function to be called when the upload of splat centers to the splat tree
     *                                            builder worker starts and finishes.
     * @param {function} onSplatTreeConstruction Function to be called when the conversion of the local splat tree from
     *                                           the format produced by the splat tree builder worker starts and ends.
     * @return {SplatTree}
     */
     buildSplatTree = function(minAlphas = [], onSplatTreeIndexesUpload, onSplatTreeConstruction) {
        return new Promise((resolve) => {
            this.disposeSplatTree();
            // TODO: expose SplatTree constructor parameters (maximumDepth and maxCentersPerNode) so that they can
            // be configured on a per-scene basis
            this.baseSplatTree = new SplatTree(8, 1000);
            const buildStartTime = performance.now();
            const splatColor = new THREE.Vector4();
            this.baseSplatTree.processSplatMesh(this, (splatIndex) => {
                this.getSplatColor(splatIndex, splatColor);
                const sceneIndex = this.getSceneIndexForSplat(splatIndex);
                const minAlpha = minAlphas[sceneIndex] || 1;
                return splatColor.w >= minAlpha;
            }, onSplatTreeIndexesUpload, onSplatTreeConstruction)
            .then(() => {
                const buildTime = performance.now() - buildStartTime;
                if (this.logLevel >= LogLevel.Info) console.log('SplatTree build: ' + buildTime + ' ms');
                if (this.disposed) {
                    resolve();
                } else {

                    this.splatTree = this.baseSplatTree;
                    this.baseSplatTree = null;

                    let leavesWithVertices = 0;
                    let avgSplatCount = 0;
                    let maxSplatCount = 0;
                    let nodeCount = 0;

                    this.splatTree.visitLeaves((node) => {
                        const nodeSplatCount = node.data.indexes.length;
                        if (nodeSplatCount > 0) {
                            avgSplatCount += nodeSplatCount;
                            maxSplatCount = Math.max(maxSplatCount, nodeSplatCount);
                            nodeCount++;
                            leavesWithVertices++;
                        }
                    });
                    if (this.logLevel >= LogLevel.Info) {
                        console.log(`SplatTree leaves: ${this.splatTree.countLeaves()}`);
                        console.log(`SplatTree leaves with splats:${leavesWithVertices}`);
                        avgSplatCount = avgSplatCount / nodeCount;
                        console.log(`Avg splat count per node: ${avgSplatCount}`);
                        console.log(`Total splat count: ${this.getSplatCount()}`);
                    }
                    resolve();
                }
            });
        });
    };

    /**
     * Construct this instance of SplatMesh.
     * @param {Array<SplatBuffer>} splatBuffers The base splat data, instances of SplatBuffer
     * @param {Array<object>} sceneOptions Dynamic options for each scene {
     *
     *         splatAlphaRemovalThreshold: Ignore any splats with an alpha less than the specified
     *                                     value (valid range: 0 - 255), defaults to 1
     *
     *         position (Array<number>):   Position of the scene, acts as an offset from its default position, defaults to [0, 0, 0]
     *
     *         rotation (Array<number>):   Rotation of the scene represented as a quaternion, defaults to [0, 0, 0, 1]
     *
     *         scale (Array<number>):      Scene's scale, defaults to [1, 1, 1]
     *
     * }
     * @param {boolean} keepSceneTransforms For a scene that already exists and is being overwritten, this flag
     *                                      says to keep the transform from the existing scene.
     * @param {boolean} finalBuild Will the splat mesh be in its final state after this build?
     * @param {function} onSplatTreeIndexesUpload Function to be called when the upload of splat centers to the splat tree
     *                                            builder worker starts and finishes.
     * @param {function} onSplatTreeConstruction Function to be called when the conversion of the local splat tree from
     *                                           the format produced by the splat tree builder worker starts and ends.
     * @return {object} Object containing info about the splats that are updated
     */
    build(splatBuffers, sceneOptions, keepSceneTransforms = true, finalBuild = false,
          onSplatTreeIndexesUpload, onSplatTreeConstruction, preserveVisibleRegion = true, processingProfile = null,
          uwaGpuData = null) {

        const buildStartTime = performance.now();

        this.sceneOptions = sceneOptions;
        this.finalBuild = finalBuild;

        const compressedTexturePayloads = splatBuffers.map((buffer) =>
            buffer.compressedTextureData || buffer.astcData || null
        );
        this.useCompressedTexture = splatBuffers.some(b => b.hasCompressedTexture || b.hasAstc);
        if (this.useCompressedTexture && compressedTexturePayloads.some((payload) => !payload)) {
            throw new Error('Compressed-texture scenes cannot be mixed with uncompressed scenes in one SplatMesh.');
        }
        if (this.useCompressedTexture &&
            compressedTexturePayloads.some((payload) => payload !== compressedTexturePayloads[0])) {
            throw new Error('A SplatMesh cannot combine scenes backed by different compressed texture payloads.');
        }
        this.useASTC = this.useCompressedTexture;

        const maxSplatCount = SplatMesh.getTotalMaxSplatCountForSplatBuffers(splatBuffers);

        const scenesStartTime = performance.now();
        const newScenes = SplatMesh.buildScenes(this, splatBuffers, sceneOptions);
        recordProcessingDuration(processingProfile, 'meshBuildScenesMs', scenesStartTime);
        if (keepSceneTransforms) {
            for (let i = 0; i < this.scenes.length && i < newScenes.length; i++) {
                const newScene = newScenes[i];
                const existingScene = this.getScene(i);
                newScene.copyTransformData(existingScene);
            }
        }
        this.scenes = newScenes;

        let minSphericalHarmonicsDegree = 3;
        for (let splatBuffer of splatBuffers) {
            let bufferDegree = splatBuffer.getMinSphericalHarmonicsDegree();

            const compressedTextureData = splatBuffer.compressedTextureData || splatBuffer.astcData;
            if (compressedTextureData?.shDegree !== undefined) {
                bufferDegree = compressedTextureData.shDegree;
            }
            if (bufferDegree < minSphericalHarmonicsDegree) {
                minSphericalHarmonicsDegree = bufferDegree;
            }
        }
        this.minSphericalHarmonicsDegree = Math.min(minSphericalHarmonicsDegree, this.sphericalHarmonicsDegree);
        let splatBuffersChanged = false;
        if (splatBuffers.length !== this.lastBuildScenes.length) {
            splatBuffersChanged = true;
        } else {
            for (let i = 0; i < splatBuffers.length; i++) {
                const splatBuffer = splatBuffers[i];
                if (splatBuffer !== this.lastBuildScenes[i].splatBuffer) {
                    splatBuffersChanged = true;
                    break;
                }
            }
        }

        let isUpdateBuild = true;
        if (this.scenes.length !== 1 ||
            this.lastBuildSceneCount !== this.scenes.length ||
            this.lastBuildMaxSplatCount !== maxSplatCount ||
            splatBuffersChanged) {
                isUpdateBuild = false;
       }

       if (!isUpdateBuild) {
            this.boundingBox = new THREE.Box3();
            if (!preserveVisibleRegion) {
                this.maxSplatDistanceFromSceneCenter = 0;
                this.visibleRegionBufferRadius = 0;
                this.visibleRegionRadius = 0;
                this.visibleRegionFadeStartRadius = 0;
                this.firstRenderTime = -1;
            }
            this.lastBuildScenes = [];
            this.lastBuildSplatCount = 0;
            this.lastBuildMaxSplatCount = 0;
            this.disposeMeshData();
            const geometryMaterialStartTime = performance.now();
            this.geometry = SplatGeometry.build(maxSplatCount);
            const covarianceFromScaleRotation = !!uwaGpuData && this.useDirectScaleRotationCovariance;
            const materialKey = this.getMaterialVariantKey({
                useCompressedTexture: this.useCompressedTexture,
                covariancesFromScaleRotation: covarianceFromScaleRotation,
                minSphericalHarmonicsDegree: this.minSphericalHarmonicsDegree
            });
            const retainedMaterial = this.takePrecompiledMaterial(materialKey);
            if (this.splatRenderMode === SplatRenderMode.ThreeD) {
                this.material = retainedMaterial || SplatMaterial3D.build(
                    this.dynamicMode, this.enableOptionalEffects, this.antialiased,
                    this.maxScreenSpaceSplatSize, this.splatScale, this.pointCloudModeEnabled,
                    this.minSphericalHarmonicsDegree, this.kernel2DSize, this.useCompressedTexture,
                    covarianceFromScaleRotation, this.minimumGaussianContribution);
            } else {
                this.material = retainedMaterial || SplatMaterial2D.build(
                    this.dynamicMode, this.enableOptionalEffects,
                    this.splatScale, this.pointCloudModeEnabled, this.minSphericalHarmonicsDegree);
            }

            recordProcessingDuration(processingProfile, 'meshBuildGeometryMaterialMs', geometryMaterialStartTime);
            const indexMapsStartTime = performance.now();
            const indexMaps = SplatMesh.buildSplatIndexMaps(splatBuffers);
            recordProcessingDuration(processingProfile, 'meshBuildIndexMapsMs', indexMapsStartTime);
            this.globalSplatIndexToLocalSplatIndexMap = indexMaps.localSplatIndexMap;
            this.globalSplatIndexToSceneIndexMap = indexMaps.sceneIndexMap;
            this.implicitSingleSceneIndexMap = indexMaps.implicitSingleSceneIndexMap;
        }

        const splatBufferSplatCount = this.getSplatCount(true);
        if (this.enableDistancesComputationOnGPU) this.setupDistancesComputationTransformFeedback();
        this._uwaGpuDataDirect = uwaGpuData;
        let dataUpdateResults;
        try {
            dataUpdateResults = this.refreshGPUDataFromSplatBuffers(isUpdateBuild, processingProfile);
        } finally {
            this._uwaGpuDataDirect = null;
        }

        for (let i = 0; i < this.scenes.length; i++) {
            this.lastBuildScenes[i] = this.scenes[i];
        }
        this.lastBuildSplatCount = splatBufferSplatCount;
        this.lastBuildMaxSplatCount = this.getMaxSplatCount();
        this.lastBuildSceneCount = this.scenes.length;

        let splatTreePromise = null;
        if (finalBuild && this.scenes.length > 0) {
            const splatTreeStartTime = performance.now();
            splatTreePromise = this.buildSplatTree(sceneOptions.map(options => options.splatAlphaRemovalThreshold || 1),
                                                   onSplatTreeIndexesUpload, onSplatTreeConstruction)
            .then(() => {
                recordProcessingDuration(processingProfile, 'splatTreeAsyncMs', splatTreeStartTime);
                if (this.onSplatTreeReadyCallback) this.onSplatTreeReadyCallback(this.splatTree);
                this.onSplatTreeReadyCallback = null;
            });
        }

        this.visible = (this.scenes.length > 0);

        if (processingProfile) {
            const buildEndTime = performance.now();
            processingProfile.meshBuildTotalMs = buildEndTime - buildStartTime;
            addProcessingTimelineEvent(processingProfile, 'meshBuildTotal',
                absoluteFromPerformanceMs(buildStartTime), absoluteFromPerformanceMs(buildEndTime) ?? absoluteNowMs());
            processingProfile.meshRebuild = !isUpdateBuild;
            processingProfile.meshSplatCount = splatBufferSplatCount;
            processingProfile.meshMaxSplatCount = this.getMaxSplatCount();
            processingProfile.splatTreeAsyncStarted = !!(finalBuild && this.scenes.length > 0);
            dataUpdateResults.processingProfile = processingProfile;
        }
        dataUpdateResults.splatTreePromise = splatTreePromise;

        return dataUpdateResults;
    }

    /**
     * Return the complete shader variant key used by the material builders.
     * Callers must provide the final minimum SH degree when precompiling.
     */
    getMaterialVariantKey(options = {}) {
        const minSphericalHarmonicsDegree = Number.isInteger(options.minSphericalHarmonicsDegree) ?
            Math.max(0, Math.min(3, options.minSphericalHarmonicsDegree)) : this.minSphericalHarmonicsDegree;
        const requestedMinimumContribution = Number(options.minimumGaussianContribution ?? this.minimumGaussianContribution);
        const minimumGaussianContribution = Number.isFinite(requestedMinimumContribution) ?
            Math.min(Math.max(requestedMinimumContribution, 0), 1) : (1 / 1024);
        return JSON.stringify([
            this.splatRenderMode,
            !!this.dynamicMode,
            !!this.enableOptionalEffects,
            !!this.antialiased,
            Number(this.maxScreenSpaceSplatSize),
            Number(this.splatScale),
            !!this.pointCloudModeEnabled,
            minSphericalHarmonicsDegree,
            Number(this.kernel2DSize),
            !!(options.useCompressedTexture ?? this.useCompressedTexture),
            !!(options.covariancesFromScaleRotation ?? this.useDirectScaleRotationCovariance),
            minimumGaussianContribution
        ]);
    }

    /**
     * Compile a material variant against a temporary one-instance mesh. The
     * geometry is discarded while the material is retained for the matching
     * full data build.
     */
    precompileMaterial(options = {}) {
        if (!this.renderer || !this.renderer.compile || !this.renderer.getContext || !options.camera) return false;
        if (options.renderMode !== undefined && options.renderMode !== this.splatRenderMode) return false;
        if (!Number.isInteger(options.minSphericalHarmonicsDegree)) return false;

        const key = this.getMaterialVariantKey(options);
        if (this.precompiledMaterial && this.precompiledMaterialKey === key) return true;
        this.clearPrecompiledMaterial();

        const useCompressedTexture = !!(options.useCompressedTexture ?? false);
        const covariancesFromScaleRotation = !!(options.covariancesFromScaleRotation ??
            this.useDirectScaleRotationCovariance);
        if (this.splatRenderMode === SplatRenderMode.ThreeD &&
            (covariancesFromScaleRotation && !useCompressedTexture)) return false;

        const material = this.splatRenderMode === SplatRenderMode.ThreeD ?
            SplatMaterial3D.build(this.dynamicMode, this.enableOptionalEffects, this.antialiased,
                                  this.maxScreenSpaceSplatSize, this.splatScale, this.pointCloudModeEnabled,
                                  Number(options.minSphericalHarmonicsDegree), this.kernel2DSize,
                                  useCompressedTexture, covariancesFromScaleRotation,
                                  this.minimumGaussianContribution) :
            SplatMaterial2D.build(this.dynamicMode, this.enableOptionalEffects,
                                  this.splatScale, this.pointCloudModeEnabled,
                                  Number(options.minSphericalHarmonicsDegree));
        const geometry = SplatGeometry.build(1);
        geometry.instanceCount = 1;
        geometry.getAttribute('splatIndex').setX(0, 0);
        const temporaryScene = new THREE.Scene();
        const temporaryMesh = new THREE.Mesh(geometry, material);
        temporaryMesh.frustumCulled = false;
        temporaryScene.add(temporaryMesh);
        try {
            this.renderer.compile(temporaryScene, options.camera);
            this.precompiledMaterial = material;
            this.precompiledMaterialKey = key;
            return true;
        } catch (error) {
            material.dispose();
            throw error;
        } finally {
            temporaryScene.remove(temporaryMesh);
            geometry.dispose();
        }
    }

    takePrecompiledMaterial(key) {
        if (!this.precompiledMaterial) return null;
        if (this.precompiledMaterialKey !== key) {
            this.clearPrecompiledMaterial();
            return null;
        }
        const material = this.precompiledMaterial;
        this.precompiledMaterial = null;
        this.precompiledMaterialKey = null;
        return material;
    }

    clearPrecompiledMaterial() {
        if (this.precompiledMaterial) this.precompiledMaterial.dispose();
        this.precompiledMaterial = null;
        this.precompiledMaterialKey = null;
    }

    freeIntermediateSplatData() {

        const deleteTextureData = (texture) => {
            delete texture.source.data;
            delete texture.image;
            texture.onUpdate = null;
        };

        delete this.splatDataTextures.baseData.covariances;
        delete this.splatDataTextures.baseData.centers;
        delete this.splatDataTextures.baseData.colors;
        delete this.splatDataTextures.baseData.sphericalHarmonics;

        delete this.splatDataTextures.centerColors.data;
        if (this.splatDataTextures.covariances) {
            delete this.splatDataTextures.covariances.data;
        }
        if (this.splatDataTextures.sphericalHarmonics) {
            delete this.splatDataTextures.sphericalHarmonics.data;
        }
        if (this.splatDataTextures.sceneIndexes) {
            delete this.splatDataTextures.sceneIndexes.data;
        }
        if (this.splatDataTextures.compressedTexture) {
            delete this.splatDataTextures.compressedTexture.data;
        }
        if (this.splatDataTextures.compressedTextureUV) {
            delete this.splatDataTextures.compressedTextureUV.data;
        }
        if (this.splatDataTextures.scaleRotations) {
            delete this.splatDataTextures.scaleRotations.data;
        }

        this.splatDataTextures.centerColors.texture.needsUpdate = true;
        this.splatDataTextures.centerColors.texture.onUpdate = () => {
            deleteTextureData(this.splatDataTextures.centerColors.texture);
        };

        if (this.splatDataTextures.covariances) {
            this.splatDataTextures.covariances.texture.needsUpdate = true;
            this.splatDataTextures.covariances.texture.onUpdate = () => {
                deleteTextureData(this.splatDataTextures.covariances.texture);
            };
        }

        if (this.splatDataTextures.scaleRotations) {
            this.splatDataTextures.scaleRotations.texture.needsUpdate = true;
            this.splatDataTextures.scaleRotations.texture.onUpdate = () => {
                deleteTextureData(this.splatDataTextures.scaleRotations.texture);
            };
        }

        if (this.splatDataTextures.sphericalHarmonics) {
            if (this.splatDataTextures.sphericalHarmonics.texture) {
                this.splatDataTextures.sphericalHarmonics.texture.needsUpdate = true;
                this.splatDataTextures.sphericalHarmonics.texture.onUpdate = () => {
                    deleteTextureData(this.splatDataTextures.sphericalHarmonics.texture);
                };
            } else {
                this.splatDataTextures.sphericalHarmonics.textures.forEach((texture) => {
                    texture.needsUpdate = true;
                    texture.onUpdate = () => {
                        deleteTextureData(texture);
                    };
                });
            }
        }
        if (this.splatDataTextures.sceneIndexes) {
            this.splatDataTextures.sceneIndexes.texture.needsUpdate = true;
            this.splatDataTextures.sceneIndexes.texture.onUpdate = () => {
                deleteTextureData(this.splatDataTextures.sceneIndexes.texture);
            };
        }
        if (this.splatDataTextures.compressedTexture) {
            const textureDescriptor = this.splatDataTextures.compressedTexture;
            const compressedTexture = textureDescriptor.texture;
            compressedTexture.needsUpdate = true;
            compressedTexture.onUpdate = () => {
                console.log(
                    `[SplatUWA Timing] Compressed texture upload: ` +
                    `${(performance.now() - textureDescriptor.uploadQueuedAt).toFixed(2)} ms, ` +
                    `bytes=${textureDescriptor.byteLength}`
                );
                deleteTextureData(compressedTexture);
            };
        }
        if (this.splatDataTextures.compressedTextureUV) {
            const compressedTextureUV = this.splatDataTextures.compressedTextureUV.texture;
            compressedTextureUV.needsUpdate = true;
            compressedTextureUV.onUpdate = () => {
                deleteTextureData(compressedTextureUV);
            };
        }
    }
    /**
     * Dispose all resources held by the splat mesh
     */
    dispose() {
        this.clearPrecompiledMaterial();
        this.disposeMeshData();
        this.disposeTextures();
        this.disposeSplatTree();
        if (this.enableDistancesComputationOnGPU) {
            if (this.computeDistancesOnGPUSyncTimeout) {
                clearTimeout(this.computeDistancesOnGPUSyncTimeout);
                this.computeDistancesOnGPUSyncTimeout = null;
            }
            this.disposeDistancesComputationGPUResources();
        }
        this.scenes = [];
        this.distancesTransformFeedback = {
            'id': null,
            'vertexShader': null,
            'fragmentShader': null,
            'program': null,
            'centersBuffer': null,
            'sceneIndexesBuffer': null,
            'outDistancesBuffer': null,
            'centersLoc': -1,
            'modelViewProjLoc': -1,
            'sceneIndexesLoc': -1,
            'transformsLocs': []
        };
        this.renderer = null;

        this.globalSplatIndexToLocalSplatIndexMap = [];
        this.globalSplatIndexToSceneIndexMap = [];
        this.implicitSingleSceneIndexMap = false;

        this.lastBuildSplatCount = 0;
        this.lastBuildScenes = [];
        this.lastBuildMaxSplatCount = 0;
        this.lastBuildSceneCount = 0;
        this.firstRenderTime = -1;
        this.finalBuild = false;

        this.webGLUtils = null;

        this.boundingBox = new THREE.Box3();
        this.calculatedSceneCenter = new THREE.Vector3();
        this.maxSplatDistanceFromSceneCenter = 0;
        this.visibleRegionBufferRadius = 0;
        this.visibleRegionRadius = 0;
        this.visibleRegionFadeStartRadius = 0;
        this.visibleRegionChanging = false;

        this.splatScale = 1.0;
        this.pointCloudModeEnabled = false;
        this.generatedDataTextureBytes = {};

        this.disposed = true;
        this.lastRenderer = null;
        this.visible = false;
    }

    /**
     * Dispose of only the Three.js mesh resources (geometry, material, and texture)
     */
    disposeMeshData() {
        if (this.geometry && this.geometry !== dummyGeometry) {
            this.geometry.dispose();
            this.geometry = null;
        }
        if (this.material) {
            this.material.dispose();
            this.material = null;
        }
    }

    disposeTextures() {
        for (let textureKey in this.splatDataTextures) {
            if (this.splatDataTextures.hasOwnProperty(textureKey)) {
                const textureContainer = this.splatDataTextures[textureKey];
                if (textureContainer?.texture) {
                    textureContainer.texture.dispose();
                    textureContainer.texture = null;
                }
            }
        }
        this.splatDataTextures = null;
    }

    disposeSplatTree() {
        if (this.splatTree) {
            this.splatTree.dispose();
            this.splatTree = null;
        }
        if (this.baseSplatTree) {
            this.baseSplatTree.dispose();
            this.baseSplatTree = null;
        }
    }

    getSplatTree() {
        return this.splatTree;
    }

    onSplatTreeReady(callback) {
        this.onSplatTreeReadyCallback = callback;
    }

    /**
     * Get copies of data that are necessary for splat distance computation: splat center positions and splat
     * scene indexes (necessary for applying dynamic scene transformations during distance computation)
     * @param {*} start The index at which to start copying data
     * @param {*} end  The index at which to stop copying data
     * @return {object}
     */
    getDataForDistancesComputation(start, end) {
        const centers = this.getCentersForDistancesComputation(start, end, true);
        const sceneIndexes = this.dynamicMode ? this.getSceneIndexes(start, end) : EMPTY_UINT32_ARRAY;
        return {
            centers,
            sceneIndexes
        };
    }

    getCentersForDistancesComputation(start, end, padFour = false) {
        const baseCenters = this.splatDataTextures?.baseData?.centers;
        if (!baseCenters) {
            return this.integerBasedDistancesComputation ?
                   this.getIntegerCenters(start, end, padFour) :
                   this.getFloatCenters(start, end, padFour);
        }

        const splatCount = end - start + 1;
        const componentCount = padFour ? 4 : 3;
        const sourceBase = start * 3;

        if (this.integerBasedDistancesComputation) {
            const integerCenters = new Int32Array(splatCount * componentCount);
            let srcOffset = sourceBase;
            let dstOffset = 0;
            for (let i = 0; i < splatCount; i++) {
                integerCenters[dstOffset++] = Math.round(baseCenters[srcOffset++] * 1000.0);
                integerCenters[dstOffset++] = Math.round(baseCenters[srcOffset++] * 1000.0);
                integerCenters[dstOffset++] = Math.round(baseCenters[srcOffset++] * 1000.0);
                if (padFour) integerCenters[dstOffset++] = 1000;
            }
            return integerCenters;
        }

        if (!padFour) return baseCenters.slice(sourceBase, sourceBase + splatCount * 3);

        const paddedFloatCenters = new Float32Array(splatCount * 4);
        let srcOffset = sourceBase;
        let dstOffset = 0;
        for (let i = 0; i < splatCount; i++) {
            paddedFloatCenters[dstOffset++] = baseCenters[srcOffset++];
            paddedFloatCenters[dstOffset++] = baseCenters[srcOffset++];
            paddedFloatCenters[dstOffset++] = baseCenters[srcOffset++];
            paddedFloatCenters[dstOffset++] = 1.0;
        }
        return paddedFloatCenters;
    }

    /**
     * Refresh data textures and GPU buffers with splat data from the splat buffers belonging to this mesh.
     * @param {boolean} sinceLastBuildOnly Specify whether or not to only update for splats that have been added since the last build.
     * @return {object}
     */
    refreshGPUDataFromSplatBuffers(sinceLastBuildOnly, processingProfile = null) {
        const refreshStartTime = performance.now();
        const splatCount = this.getSplatCount(true);
        this.refreshDataTexturesFromSplatBuffers(sinceLastBuildOnly, processingProfile);
        const updateStart = sinceLastBuildOnly ? this.lastBuildSplatCount : 0;
        if (processingProfile?.deferSortDataPrep && !this.enableDistancesComputationOnGPU) {
            recordProcessingDuration(processingProfile, 'meshRefreshGpuDataMs', refreshStartTime);
            return {
                'from': updateStart,
                'to': splatCount - 1,
                'count': splatCount - updateStart,
                'centers': null,
                'sceneIndexes': null,
                'deferredSortDataPrep': true
            };
        }
        const distanceDataStartTime = performance.now();
        const { centers, sceneIndexes } = this.getDataForDistancesComputation(updateStart, splatCount - 1);
        recordProcessingDuration(processingProfile, 'meshSortDataPrepMs', distanceDataStartTime);
        if (this.enableDistancesComputationOnGPU) {
            const gpuBufferRefreshStartTime = performance.now();
            this.refreshGPUBuffersForDistancesComputation(centers, sceneIndexes, sinceLastBuildOnly);
            recordProcessingDuration(processingProfile, 'meshGpuDistanceBufferUploadMs', gpuBufferRefreshStartTime);
        }
        recordProcessingDuration(processingProfile, 'meshRefreshGpuDataMs', refreshStartTime);
        return {
            'from': updateStart,
            'to': splatCount - 1,
            'count': splatCount - updateStart,
            'centers': centers,
            'sceneIndexes': sceneIndexes,
            'deferredSortDataPrep': false
        };
    }

    /**
     * Update the GPU buffers that are used for computing splat distances on the GPU.
     * @param {Array<number>} centers Splat center positions
     * @param {Array<number>} sceneIndexes Indexes of the scene to which each splat belongs
     * @param {boolean} sinceLastBuildOnly Specify whether or not to only update for splats that have been added since the last build.
     */
    refreshGPUBuffersForDistancesComputation(centers, sceneIndexes, sinceLastBuildOnly = false) {
        const offset = sinceLastBuildOnly ? this.lastBuildSplatCount : 0;
        this.updateGPUCentersBufferForDistancesComputation(sinceLastBuildOnly, centers, offset);
        this.updateGPUTransformIndexesBufferForDistancesComputation(sinceLastBuildOnly, sceneIndexes, offset);
    }

    /**
     * Refresh data textures with data from the splat buffers for this mesh.
     * @param {boolean} sinceLastBuildOnly Specify whether or not to only update for splats that have been added since the last build.
     */
    refreshDataTexturesFromSplatBuffers(sinceLastBuildOnly, processingProfile = null) {
        const refreshStartTime = performance.now();
        const splatCount = this.getSplatCount(true);
        const fromSplat = this.lastBuildSplatCount;
        const toSplat = splatCount - 1;
        const deferVisibleRegionUpdate = !!processingProfile?.deferVisibleRegion && !sinceLastBuildOnly;

        const directResult = !sinceLastBuildOnly ? this._uwaGpuDataDirect : null;
        const directInstallStartedAt = directResult ? performance.now() : 0;
        if (!sinceLastBuildOnly) {
            const setupStartTime = performance.now();
            this.setupDataTextures(directResult, !!processingProfile?.preview, processingProfile);
            recordProcessingDuration(processingProfile, 'meshSetupDataTexturesMs', setupStartTime);
            this.updateBaseDataFromSplatBuffers(0, splatCount-1, processingProfile);
        } else {

            this.updateBaseDataFromSplatBuffers(fromSplat, toSplat, processingProfile);
        }

        if (directResult && processingProfile) {
            processingProfile.uwaGpuDataDirect = true;
            const directInstallEndedAt = performance.now();
            processingProfile.uwaGpuDirectInstallMs = directInstallEndedAt - directInstallStartedAt;
            addProcessingTimelineEvent(processingProfile, 'uwaGpuDirectInstall',
                absoluteFromPerformanceMs(directInstallStartedAt),
                absoluteFromPerformanceMs(directInstallEndedAt) ?? absoluteNowMs());
            processingProfile.uwaGpuCovarianceSource = this.useDirectScaleRotationCovariance ?
                'scale-rotation-shader' : 'covariance-texture';
            processingProfile.uwaPostprocessBackend = directResult.backend;
            processingProfile.uwaSourceArrayBytes = directResult.uwaPostprocessTimings?.sourceArrayBytes;
            processingProfile.uwaOutputArrayBytes = directResult.uwaPostprocessTimings?.outputArrayBytes;
            processingProfile.uwaCompactionDroppedCount = directResult.uwaPostprocessTimings?.compactionDroppedCount;
            processingProfile.uwaGpuInputPackMs = directResult.uwaPostprocessTimings?.gpuInputPackMs;
            processingProfile.workerGpuTexturePackMs = directResult.uwaPostprocessTimings?.workerGpuTexturePackMs;
        }

        this.updateDataTexturesFromBaseData(fromSplat, toSplat, processingProfile);
        if (deferVisibleRegionUpdate) {
            const visibleRegionPrimeStartTime = performance.now();
            this.prepareVisibleRegionForImmediateRender();
            recordProcessingDuration(processingProfile, 'meshPrimeVisibleRegionMs', visibleRegionPrimeStartTime);
        } else {
            const visibleRegionStartTime = performance.now();
            this.updateVisibleRegion(sinceLastBuildOnly);
            recordProcessingDuration(processingProfile, 'meshUpdateVisibleRegionMs', visibleRegionStartTime);
        }
        recordProcessingDuration(processingProfile, 'meshRefreshDataTexturesTotalMs', refreshStartTime);
    }

    setupDataTextures(directResult = null, previewBuild = false, processingProfile = null) {
        const maxSplatCount = this.getMaxSplatCount();
        const splatCount = this.getSplatCount(true);

        this.disposeTextures();
        const generatedDataTextureBytes = {};
        const recordGeneratedDataTexture = (name, data) => {
            generatedDataTextureBytes[name] = (generatedDataTextureBytes[name] || 0) + (data?.byteLength || 0);
        };
        const getDataTextureSize = (elementsPerTexel, elementsPerSplat) =>
            SplatMesh.computeDataTextureSize(elementsPerTexel, elementsPerSplat, maxSplatCount, previewBuild);

        const getCovariancesElementsPertexelStored = (compressionLevel) => {
            return compressionLevel >= 1 ? COVARIANCES_ELEMENTS_PER_TEXEL_COMPRESSED_STORED : COVARIANCES_ELEMENTS_PER_TEXEL_STORED;
        };

        const getCovariancesInitialTextureSpecs = (compressionLevel, allowOverMaxTextureSize = false) => {
            const elementsPerTexelStored = getCovariancesElementsPertexelStored(compressionLevel);
            const texSize = SplatMesh.computeDataTextureSize(elementsPerTexelStored, 6, maxSplatCount,
                                                            previewBuild, allowOverMaxTextureSize);
            return {elementsPerTexelStored, texSize};
        };

        let covarianceCompressionLevel = this.getTargetCovarianceCompressionLevel();
        const scaleRotationCompressionLevel = 0;
        const shCompressionLevel = this.getTargetSphericalHarmonicsCompressionLevel();
        const useDirectScaleRotationCovariance = !!(directResult &&
            this.splatRenderMode === SplatRenderMode.ThreeD && this.useDirectScaleRotationCovariance);
        this._uwaGpuRotationsAreWxyz = useDirectScaleRotationCovariance;

        let covariances;
        let scales;
        let rotations;
        if (this.splatRenderMode === SplatRenderMode.ThreeD && !useDirectScaleRotationCovariance) {
            const initialCovTexSpecs = getCovariancesInitialTextureSpecs(covarianceCompressionLevel, true);
            if (initialCovTexSpecs.texSize.x * initialCovTexSpecs.texSize.y > MAX_TEXTURE_TEXELS && covarianceCompressionLevel === 0) {
                covarianceCompressionLevel = 1;
            }
            covariances = directResult?.covariances || new Float32Array(maxSplatCount * COVARIANCES_ELEMENTS_PER_SPLAT);
        } else {
            scales = directResult?.scales || new Float32Array(maxSplatCount * 3);
            rotations = directResult?.rotations || new Float32Array(maxSplatCount * 4);
        }

        const centers = directResult?.positions || new Float32Array(maxSplatCount * 3);
        const colors = directResult?.colors || new Uint8Array(maxSplatCount * 4);

        let SphericalHarmonicsArrayType = Float32Array;
        if (shCompressionLevel === 1) SphericalHarmonicsArrayType = Uint16Array;
        else if (shCompressionLevel === 2) SphericalHarmonicsArrayType = Uint8Array;
        const shComponentCount = getSphericalHarmonicsComponentCountForDegree(this.minSphericalHarmonicsDegree);
        const shData = this.minSphericalHarmonicsDegree ? new SphericalHarmonicsArrayType(maxSplatCount * shComponentCount) : undefined;

        // set up centers/colors data texture
        const centersColsTexSize = getDataTextureSize(CENTER_COLORS_ELEMENTS_PER_TEXEL, 4);
        const centerColorsArrayLength = centersColsTexSize.x * centersColsTexSize.y * CENTER_COLORS_ELEMENTS_PER_TEXEL;
        const directGpuCenterColors = directResult?.gpuCenterColors;
        const useDirectPaddedCenterColors = directGpuCenterColors instanceof Uint32Array &&
            directGpuCenterColors.length === centerColorsArrayLength;
        const paddedCentersCols = useDirectPaddedCenterColors ? directGpuCenterColors : new Uint32Array(centerColorsArrayLength);
        recordGeneratedDataTexture('centerColors', paddedCentersCols);
        if (!directResult) SplatMesh.updateCenterColorsPaddedData(0, splatCount - 1, centers, colors, paddedCentersCols);

        const centersColsTex = new THREE.DataTexture(paddedCentersCols, centersColsTexSize.x, centersColsTexSize.y,
                                                     THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
        centersColsTex.internalFormat = 'RGBA32UI';
        centersColsTex.needsUpdate = true;
        this.material.uniforms.centersColorsTexture.value = centersColsTex;
        this.material.uniforms.centersColorsTextureSize.value.copy(centersColsTexSize);
        this.material.uniformsNeedUpdate = true;

        this.splatDataTextures = {
            'baseData': {
                'covariances': covariances,
                'scales': scales,
                'rotations': rotations,
                'centers': centers,
                'colors': colors,
                'sphericalHarmonics': shData
            },
            'centerColors': {
                'data': paddedCentersCols,
                'texture': centersColsTex,
                'size': centersColsTexSize,
                'gpuCenterColors': directResult?.gpuCenterColors || null,
                'directPadded': useDirectPaddedCenterColors
            }
        };

        if (directResult?.compressedTextureData?.uvs) {
            this.splatDataTextures.baseData.compressedTextureUVs = directResult.compressedTextureData.uvs;
        }

        if (this.splatRenderMode === SplatRenderMode.ThreeD && !useDirectScaleRotationCovariance) {
            // set up covariances data texture

            const covTexSpecs = getCovariancesInitialTextureSpecs(covarianceCompressionLevel);
            const covariancesElementsPerTexelStored = covTexSpecs.elementsPerTexelStored;
            const covTexSize = covTexSpecs.texSize;

            let CovariancesDataType = covarianceCompressionLevel >= 1 ? Uint32Array : Float32Array;
            const covariancesElementsPerTexelAllocated = covarianceCompressionLevel >= 1 ?
                                                         COVARIANCES_ELEMENTS_PER_TEXEL_COMPRESSED_ALLOCATED :
                                                         COVARIANCES_ELEMENTS_PER_TEXEL_ALLOCATED;
            const covariancesTextureData = new CovariancesDataType(covTexSize.x * covTexSize.y * covariancesElementsPerTexelAllocated);
            recordGeneratedDataTexture('covariances', covariancesTextureData);

            if (covarianceCompressionLevel === 0 && !directResult) {
                covariancesTextureData.set(covariances);
            } else if (!directResult) {
                SplatMesh.updatePaddedCompressedCovariancesTextureData(covariances, covariancesTextureData, 0, 0, covariances.length);
            }

            let covTex;
            if (covarianceCompressionLevel >= 1) {
                covTex = new THREE.DataTexture(covariancesTextureData, covTexSize.x, covTexSize.y,
                                               THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
                covTex.internalFormat = 'RGBA32UI';
                this.material.uniforms.covariancesTextureHalfFloat.value = covTex;
            } else {
                covTex = new THREE.DataTexture(covariancesTextureData, covTexSize.x, covTexSize.y, THREE.RGBAFormat, THREE.FloatType);
                this.material.uniforms.covariancesTexture.value = covTex;

                // For some reason a usampler2D needs to have a valid texture attached or WebGL complains
                const dummyTex = new THREE.DataTexture(new Uint32Array(32), 2, 2, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
                dummyTex.internalFormat = 'RGBA32UI';
                this.material.uniforms.covariancesTextureHalfFloat.value = dummyTex;
                dummyTex.needsUpdate = true;
            }
            covTex.needsUpdate = true;

            this.material.uniforms.covariancesAreHalfFloat.value = (covarianceCompressionLevel >= 1) ? 1 : 0;
            this.material.uniforms.covariancesTextureSize.value.copy(covTexSize);

            this.splatDataTextures['covariances'] = {
                'data': covariancesTextureData,
                'texture': covTex,
                'size': covTexSize,
                'compressionLevel': covarianceCompressionLevel,
                'elementsPerTexelStored': covariancesElementsPerTexelStored,
                'elementsPerTexelAllocated': covariancesElementsPerTexelAllocated
            };
        } else {
            // set up scale & rotations data texture
            const elementsPerSplat = 6;
            const scaleRotationsTexSize = getDataTextureSize(SCALES_ROTATIONS_ELEMENTS_PER_TEXEL, elementsPerSplat);
            let ScaleRotationsDataType = scaleRotationCompressionLevel >= 1 ? Uint16Array : Float32Array;
            let scaleRotationsTextureType = scaleRotationCompressionLevel >= 1 ? THREE.HalfFloatType : THREE.FloatType;
            const scaleRotationsArrayLength = scaleRotationsTexSize.x * scaleRotationsTexSize.y *
                SCALES_ROTATIONS_ELEMENTS_PER_TEXEL;
            const directGpuScaleRotations = directResult?.gpuScaleRotations;
            const useDirectPaddedScaleRotations = ScaleRotationsDataType === Float32Array &&
                directGpuScaleRotations instanceof Float32Array && directGpuScaleRotations.length === scaleRotationsArrayLength;
            const paddedScaleRotations = useDirectPaddedScaleRotations ? directGpuScaleRotations :
                new ScaleRotationsDataType(scaleRotationsArrayLength);
            recordGeneratedDataTexture('scaleRotations', paddedScaleRotations);

            // Direct data is installed once by updateDataTexturesFromBaseData()
            // immediately after texture setup. Avoid packing the same array here.
            if (!directResult) {
                SplatMesh.updateScaleRotationsPaddedData(0, splatCount - 1, scales, rotations, paddedScaleRotations);
            }

            const scaleRotationsTex = new THREE.DataTexture(paddedScaleRotations, scaleRotationsTexSize.x, scaleRotationsTexSize.y,
                                                            THREE.RGBAFormat, scaleRotationsTextureType);
            scaleRotationsTex.needsUpdate = true;
            this.material.uniforms.scaleRotationsTexture.value = scaleRotationsTex;
            this.material.uniforms.scaleRotationsTextureSize.value.copy(scaleRotationsTexSize);

            this.splatDataTextures['scaleRotations'] = {
                'data': paddedScaleRotations,
                'texture': scaleRotationsTex,
                'size': scaleRotationsTexSize,
                'compressionLevel': scaleRotationCompressionLevel,
                'gpuScaleRotations': directResult?.gpuScaleRotations || null,
                'directPadded': useDirectPaddedScaleRotations
            };
            if (useDirectScaleRotationCovariance) {
                this.material.uniforms.covariancesFromScaleRotation.value = 1;
                // The inactive covariance samplers still need compatible WebGL
                // textures on some drivers even though the shader branch ignores them.
                const dummyCovarianceTexture = new THREE.DataTexture(new Float32Array(16), 2, 2,
                                                                       THREE.RGBAFormat, THREE.FloatType);
                dummyCovarianceTexture.needsUpdate = true;
                const dummyHalfCovarianceTexture = new THREE.DataTexture(new Uint32Array(16), 2, 2,
                                                                          THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
                dummyHalfCovarianceTexture.internalFormat = 'RGBA32UI';
                dummyHalfCovarianceTexture.needsUpdate = true;
                this.material.uniforms.covariancesTexture.value = dummyCovarianceTexture;
                this.material.uniforms.covariancesTextureHalfFloat.value = dummyHalfCovarianceTexture;
                this.splatDataTextures.covariancesDummy = { texture: dummyCovarianceTexture };
                this.splatDataTextures.covariancesHalfDummy = { texture: dummyHalfCovarianceTexture };
            }
        }
        if (this.useCompressedTexture) {
            const splatBuffer = this.scenes[0].splatBuffer;
            let payload = splatBuffer.compressedTextureData || splatBuffer.astcData;
            if (payload && !payload.format && splatBuffer.astcData === payload) {
                payload = { ...payload, format: 'astc' };
            }
            if (!payload) throw new Error('SplatMesh is missing its compressed texture payload.');
            {
                const descriptor = validateCompressedTexturePayload(payload);
                const { format, raw, width, height, layers, singleWidth, singleHeight, threeFormat } = descriptor;
                const { shnMin, shnMax } = payload;
                const uploadQueuedAt = performance.now();
                console.log(
                    `[Compressed Texture Upload] Format: ${format}, Width: ${width}, Height: ${height}, ` +
                    `Layers: ${layers}, RawSize: ${raw.byteLength}`
                );

                const compressedTexture = new THREE.CompressedArrayTexture(
                    [{ data: raw, width, height, depth: layers }],
                    width,
                    height,
                    layers,
                    threeFormat
                );
                compressedTexture.minFilter = THREE.LinearFilter;
                compressedTexture.magFilter = THREE.LinearFilter;

                compressedTexture.wrapS = THREE.ClampToEdgeWrapping;
                compressedTexture.wrapT = THREE.ClampToEdgeWrapping;
                compressedTexture.needsUpdate = true;

                this.material.uniforms.astcTextures.value = compressedTexture;
                this.material.uniforms.astcSingleWidth.value = singleWidth;
                this.material.uniforms.astcSingleHeight.value = singleHeight;
                this.material.uniforms.astcTextureWidth.value = width;
                this.splatDataTextures['compressedTexture'] = {
                    'data': raw,
                    'texture': compressedTexture,
                    'size': new THREE.Vector3(width, height, layers),
                    'format': format,
                    'uploadQueuedAt': uploadQueuedAt,
                    'byteLength': raw.byteLength
                };

                // Set the dequantization parameters (minimum and range).
                const range = new THREE.Vector3(shnMax - shnMin, shnMax - shnMin, shnMax - shnMin);
                const min = new THREE.Vector3(shnMin, shnMin, shnMin);
                this.material.uniforms.astcQuantRange.value.copy(range);
                this.material.uniforms.astcQuantMin.value.copy(min);
                const quantMins = this.material.uniforms.astcQuantMins?.value;
                const quantRanges = this.material.uniforms.astcQuantRanges?.value;
                if (quantMins && quantRanges && payload.shnMins?.length >= 45 && payload.shnMaxs?.length >= 45) {
                    for (let coefficient = 0; coefficient < 15; coefficient++) {
                        const base = coefficient * 3;
                        const minValue = new THREE.Vector3(payload.shnMins[base], payload.shnMins[base + 1], payload.shnMins[base + 2]);
                        const maxValue = new THREE.Vector3(payload.shnMaxs[base], payload.shnMaxs[base + 1], payload.shnMaxs[base + 2]);
                        quantMins[coefficient].copy(minValue);
                        quantRanges[coefficient].copy(maxValue).sub(minValue);
                    }
                } else if (quantMins && quantRanges) {
                    for (let coefficient = 0; coefficient < 15; coefficient++) {
                        quantMins[coefficient].copy(min);
                        quantRanges[coefficient].copy(range);
                    }
                }

                // 4. Create the UV lookup texture (RG32UI).
                const shElementsPerTexel = 4; // Four RGBA channels.

                // This must be 4 because each splat occupies one complete RGBA texel.
                // Even though U and V use only R and G, a stride of 4 prevents allocating a half-sized texture.
                const paddedSHComponentCount = 4;

                let uvTexSize = getDataTextureSize(shElementsPerTexel, paddedSHComponentCount);

                const uvArrayLength = uvTexSize.x * uvTexSize.y * 4;
                const directGpuCompressedTextureUV = directResult?.gpuCompressedTextureUV;
                const useDirectPaddedCompressedTextureUV = directGpuCompressedTextureUV instanceof Uint32Array &&
                    directGpuCompressedTextureUV.length === uvArrayLength;
                const paddedUVArray = useDirectPaddedCompressedTextureUV ? directGpuCompressedTextureUV :
                    new Uint32Array(uvArrayLength);
                recordGeneratedDataTexture('compressedTextureUV', paddedUVArray);

                const astcUVTexture = new THREE.DataTexture(
                    paddedUVArray, uvTexSize.x, uvTexSize.y, THREE.RGBAIntegerFormat, THREE.UnsignedIntType
                );
                astcUVTexture.internalFormat = 'RGBA32UI';

                astcUVTexture.minFilter = THREE.NearestFilter;
                astcUVTexture.magFilter = THREE.NearestFilter;

                astcUVTexture.needsUpdate = true;

                this.material.uniforms.astcUVTexture.value = astcUVTexture;
                this.material.uniforms.astcUVTextureSize.value.copy(uvTexSize);

                this.splatDataTextures['compressedTextureUV'] = {
                    'data': paddedUVArray,
                    'texture': astcUVTexture,
                    'size': uvTexSize,
                    'elementsPerTexel': 4,
                    'gpuCompressedTextureUV': directResult?.gpuCompressedTextureUV || null,
                    'directPadded': useDirectPaddedCompressedTextureUV
                };

                this.splatDataTextures['sphericalHarmonics'] = null;
            }
        } else {
            if (shData) {
                const shTextureType = shCompressionLevel === 2 ? THREE.UnsignedByteType : THREE.HalfFloatType;

                let paddedSHComponentCount = shComponentCount;
                if (paddedSHComponentCount % 2 !== 0) paddedSHComponentCount++;
                const shElementsPerTexel = 4;
                const texelFormat = shElementsPerTexel === 4 ? THREE.RGBAFormat : THREE.RGFormat;
                let shTexSize = SplatMesh.computeDataTextureSize(shElementsPerTexel, paddedSHComponentCount,
                                                                maxSplatCount, previewBuild, true);

                // Use one texture for all spherical harmonics data
                if (shTexSize.x * shTexSize.y <= MAX_TEXTURE_TEXELS) {
                    const paddedSHArraySize = shTexSize.x * shTexSize.y * shElementsPerTexel;
                    const paddedSHArray = new SphericalHarmonicsArrayType(paddedSHArraySize);
                    recordGeneratedDataTexture('sphericalHarmonics', paddedSHArray);
                    for (let c = 0; c < splatCount; c++) {
                        const srcBase = shComponentCount * c;
                        const destBase = paddedSHComponentCount * c;
                        for (let i = 0; i < shComponentCount; i++) {
                            paddedSHArray[destBase + i] = shData[srcBase + i];
                        }
                    }

                    const shTexture = new THREE.DataTexture(paddedSHArray, shTexSize.x, shTexSize.y, texelFormat, shTextureType);
                    shTexture.needsUpdate = true;
                    this.material.uniforms.sphericalHarmonicsTexture.value = shTexture;
                    this.splatDataTextures['sphericalHarmonics'] = {
                        'componentCount': shComponentCount,
                        'paddedComponentCount': paddedSHComponentCount,
                        'data': paddedSHArray,
                        'textureCount': 1,
                        'texture': shTexture,
                        'size': shTexSize,
                        'compressionLevel': shCompressionLevel,
                        'elementsPerTexel': shElementsPerTexel
                    };
                // Use three textures for spherical harmonics data, one per color channel
                } else {
                    const shComponentCountPerChannel = shComponentCount / 3;
                    paddedSHComponentCount = shComponentCountPerChannel;
                    if (paddedSHComponentCount % 2 !== 0) paddedSHComponentCount++;
                    shTexSize = getDataTextureSize(shElementsPerTexel, paddedSHComponentCount);

                    const paddedSHArraySize = shTexSize.x * shTexSize.y * shElementsPerTexel;
                    const textureUniforms = [this.material.uniforms.sphericalHarmonicsTextureR,
                                             this.material.uniforms.sphericalHarmonicsTextureG,
                                             this.material.uniforms.sphericalHarmonicsTextureB];
                    const paddedSHArrays = [];
                    const shTextures = [];
                    for (let t = 0; t < 3; t++) {
                        const paddedSHArray = new SphericalHarmonicsArrayType(paddedSHArraySize);
                        recordGeneratedDataTexture('sphericalHarmonics', paddedSHArray);
                        paddedSHArrays.push(paddedSHArray);
                        for (let c = 0; c < splatCount; c++) {
                            const srcBase = shComponentCount * c;
                            const destBase = paddedSHComponentCount * c;
                            if (shComponentCountPerChannel >= 3) {
                                for (let i = 0; i < 3; i++) paddedSHArray[destBase + i] = shData[srcBase + t * 3 + i];
                                if (shComponentCountPerChannel >= 8) {
                                    for (let i = 0; i < 5; i++) paddedSHArray[destBase + 3 + i] = shData[srcBase + 9 + t * 5 + i];
                                    if (shComponentCountPerChannel >= 15) {
                                        for (let i = 0; i < 7; i++) paddedSHArray[destBase + 8 + i] = shData[srcBase + 24 + t * 7 + i];
                                    }
                                }
                            }
                        }

                        const shTexture = new THREE.DataTexture(paddedSHArray, shTexSize.x, shTexSize.y, texelFormat, shTextureType);
                        shTextures.push(shTexture);
                        shTexture.needsUpdate = true;
                        textureUniforms[t].value = shTexture;
                    }

                    this.material.uniforms.sphericalHarmonicsMultiTextureMode.value = 1;
                    this.splatDataTextures['sphericalHarmonics'] = {
                        'componentCount': shComponentCount,
                        'componentCountPerChannel': shComponentCountPerChannel,
                        'paddedComponentCount': paddedSHComponentCount,
                        'data': paddedSHArrays,
                        'textureCount': 3,
                        'textures': shTextures,
                        'size': shTexSize,
                        'compressionLevel': shCompressionLevel,
                        'elementsPerTexel': shElementsPerTexel
                    };
                }

                this.material.uniforms.sphericalHarmonicsTextureSize.value.copy(shTexSize);
                this.material.uniforms.sphericalHarmonics8BitMode.value = shCompressionLevel === 2 ? 1 : 0;
                for (let s = 0; s < this.scenes.length; s++) {
                    const splatBuffer = this.scenes[s].splatBuffer;
                    this.material.uniforms.sphericalHarmonics8BitCompressionRangeMin.value[s] =
                        splatBuffer.minSphericalHarmonicsCoeff;
                    this.material.uniforms.sphericalHarmonics8BitCompressionRangeMax.value[s] =
                        splatBuffer.maxSphericalHarmonicsCoeff;
                }
                this.material.uniformsNeedUpdate = true;
            }
        }


        // A one-scene build always resolves sceneIndex to zero in the shader,
        // so bind one valid R32UI texel instead of uploading a redundant
        // million-entry zero texture. A later multi-scene build recreates the
        // full texture from its explicit index map.
        const sceneIndexesTexSize = this.implicitSingleSceneIndexMap ?
            new THREE.Vector2(1, 1) : getDataTextureSize(SCENE_INDEXES_ELEMENTS_PER_TEXEL, 1);
        const paddedTransformIndexes = new Uint32Array(sceneIndexesTexSize.x *
                                                       sceneIndexesTexSize.y * SCENE_INDEXES_ELEMENTS_PER_TEXEL);
        recordGeneratedDataTexture('sceneIndexes', paddedTransformIndexes);
        if (!this.implicitSingleSceneIndexMap) {
            for (let c = 0; c < splatCount; c++) paddedTransformIndexes[c] = this.globalSplatIndexToSceneIndexMap[c];
        }
        const sceneIndexesTexture = new THREE.DataTexture(paddedTransformIndexes, sceneIndexesTexSize.x, sceneIndexesTexSize.y,
                                                          THREE.RedIntegerFormat, THREE.UnsignedIntType);
        sceneIndexesTexture.internalFormat = 'R32UI';
        sceneIndexesTexture.needsUpdate = true;
        this.material.uniforms.sceneIndexesTexture.value = sceneIndexesTexture;
        this.material.uniforms.sceneIndexesTextureSize.value.copy(sceneIndexesTexSize);
        this.material.uniformsNeedUpdate = true;
        this.splatDataTextures['sceneIndexes'] = {
            'data': paddedTransformIndexes,
            'texture': sceneIndexesTexture,
            'size': sceneIndexesTexSize
        };
        this.material.uniforms.sceneCount.value = this.scenes.length;

        this.generatedDataTextureBytes = generatedDataTextureBytes;
        if (processingProfile) {
            processingProfile.generatedDataTextureBytes = Object.values(generatedDataTextureBytes)
                .reduce((total, bytes) => total + bytes, 0);
            processingProfile.generatedDataTextureByteBreakdown = { ...generatedDataTextureBytes };
        }
    }

    updateBaseDataFromSplatBuffers(fromSplat, toSplat, processingProfile = null) {
        console.log(`[updateBaseDataFromSplatBuffers] srcFrome:${fromSplat}, srcEnd:${toSplat}`);
        const updateBaseDataStartTime = performance.now();
        const directResult = this._uwaGpuDataDirect;
        if (directResult && this.scenes.length === 1) {
            const baseData = this.splatDataTextures.baseData;
            baseData.centers = directResult.positions;
            baseData.colors = directResult.colors;
            if (baseData.covariances && directResult.covariances) baseData.covariances = directResult.covariances;
            if (baseData.scales && directResult.scales) baseData.scales = directResult.scales;
            if (baseData.rotations && directResult.rotations) baseData.rotations = directResult.rotations;
            if (directResult.compressedTextureData?.uvs) {
                baseData.compressedTextureUVs = directResult.compressedTextureData.uvs;
            }

            // ASTC/BC direct postprocess results intentionally omit CPU covariance
            // arrays. Populate the covariance texture source from their scale and
            // quaternion arrays before the texture upload phase. The explicit
            // scale/rotation fallback leaves this path disabled and keeps its
            // existing online shader route intact.
            if (baseData.covariances && !this.useDirectScaleRotationCovariance && this.useCompressedTexture) {
                const covarianceTextureDesc = this.splatDataTextures.covariances;
                const covarianceCompressionLevel = covarianceTextureDesc?.compressionLevel ?? 0;
                this.fillDirectCompressedTextureDataArrays(
                    fromSplat, toSplat, covarianceCompressionLevel, 0
                );
            }
            recordProcessingDuration(processingProfile, 'meshUpdateBaseDataMs', updateBaseDataStartTime);
            return;
        }
        const covarancesTextureDesc = this.splatDataTextures['covariances'];
        const covarianceCompressionLevel = covarancesTextureDesc ? covarancesTextureDesc.compressionLevel : undefined;
        const scaleRotationsTextureDesc = this.splatDataTextures['scaleRotations'];
        const scaleRotationCompressionLevel = scaleRotationsTextureDesc ? scaleRotationsTextureDesc.compressionLevel : undefined;
        const shITextureDesc = this.splatDataTextures['sphericalHarmonics'];
        const shCompressionLevel = shITextureDesc ? shITextureDesc.compressionLevel : 0;

        // Select the SH data destination.
        // In ASTC mode, fillSplatDataArrays must not process SH, so use null.
        // Otherwise, preserve the existing path and target the sphericalHarmonics array.
        let shDataTarget = this.useCompressedTexture ? null : this.splatDataTextures.baseData.sphericalHarmonics;

        // In ASTC mode, ensure baseData has storage for UV coordinates.
        if (this.useCompressedTexture) {
            if (!this.splatDataTextures.baseData.compressedTextureUVs) {
                const maxSplatCount = this.getMaxSplatCount();
                this.splatDataTextures.baseData.compressedTextureUVs = new Uint32Array(maxSplatCount * 2);
            }
        }

        const directStartTime = performance.now();
        const directCompressedTextureUsed = this.useCompressedTexture && this.fillDirectCompressedTextureDataArrays(
            fromSplat, toSplat, covarianceCompressionLevel, scaleRotationCompressionLevel
        );
        if (directCompressedTextureUsed) {
            recordProcessingDuration(processingProfile, 'meshDirectCompressedTextureDataMs', directStartTime);
            recordProcessingDuration(processingProfile, 'meshUpdateBaseDataMs', updateBaseDataStartTime);
            return;
        }

        // Invoke the common fill function.
        // The sixth argument is now shDataTarget, which may be null.
        const fillBaseDataStartTime = performance.now();
        this.fillSplatDataArrays(
            this.splatDataTextures.baseData.covariances,
            this.splatDataTextures.baseData.scales,
            this.splatDataTextures.baseData.rotations,
            this.splatDataTextures.baseData.centers,
            this.splatDataTextures.baseData.colors,
            shDataTarget, // Pass null in ASTC mode.
            undefined,
            covarianceCompressionLevel,
            scaleRotationCompressionLevel,
            shCompressionLevel,
            fromSplat,
            toSplat,
            fromSplat
        );
        recordProcessingDuration(processingProfile, 'meshFillBaseArraysMs', fillBaseDataStartTime);

        // Extract UV data explicitly in ASTC mode.
        if (this.useCompressedTexture) {
            const fillAstcUvStartTime = performance.now();
            this.fillSplatCompressedTextureUVs(
                this.splatDataTextures.baseData.compressedTextureUVs,
                fromSplat,
                toSplat,
                fromSplat
            );
            recordProcessingDuration(processingProfile, 'meshFillAstcUvsMs', fillAstcUvStartTime);
        }
        recordProcessingDuration(processingProfile, 'meshUpdateBaseDataMs', updateBaseDataStartTime);
    }

    updateDataTexturesFromBaseData(fromSplat, toSplat, processingProfile = null) {
        const updateTexturesStartTime = performance.now();
        const covarancesTextureDesc = this.splatDataTextures['covariances'];
        const covarianceCompressionLevel = covarancesTextureDesc ? covarancesTextureDesc.compressionLevel : undefined;
        const scaleRotationsTextureDesc = this.splatDataTextures['scaleRotations'];
        const scaleRotationCompressionLevel = scaleRotationsTextureDesc ? scaleRotationsTextureDesc.compressionLevel : undefined;
        const shTextureDesc = this.splatDataTextures['sphericalHarmonics'];
        const shCompressionLevel = shTextureDesc ? shTextureDesc.compressionLevel : 0;

        // Update center & color data texture
        const centerColorsTextureStartTime = performance.now();
        const centerColorsTextureDescriptor = this.splatDataTextures['centerColors'];
        const paddedCenterColors = centerColorsTextureDescriptor.data;
        const centerColorsTexture = centerColorsTextureDescriptor.texture;
        const splatCount = this.getSplatCount(true);
        const directGpuCenterColors = centerColorsTextureDescriptor.gpuCenterColors;
        const directCenterColorsIsFullRange = fromSplat === 0 && toSplat === splatCount - 1;
        const useDirectPaddedCenterColors = directCenterColorsIsFullRange &&
            centerColorsTextureDescriptor.directPadded && directGpuCenterColors === paddedCenterColors;
        const useDirectCompactCenterColors = directCenterColorsIsFullRange &&
            !useDirectPaddedCenterColors && directGpuCenterColors instanceof Uint32Array &&
            directGpuCenterColors.length === splatCount * 4;
        if (useDirectPaddedCenterColors) {
            // The worker array is already the complete texture backing store.
        } else if (useDirectCompactCenterColors) {
            paddedCenterColors.set(directGpuCenterColors.subarray(0, splatCount * 4), 0);
        } else {
            SplatMesh.updateCenterColorsPaddedData(fromSplat, toSplat, this.splatDataTextures.baseData.centers,
                                                   this.splatDataTextures.baseData.colors, paddedCenterColors);
        }
        const centerColorsTextureProps = this.renderer ? this.renderer.properties.get(centerColorsTexture) : null;
        if (!centerColorsTextureProps || !centerColorsTextureProps.__webglTexture) {
            centerColorsTexture.needsUpdate = true;
        } else {
            this.updateDataTexture(paddedCenterColors, centerColorsTextureDescriptor.texture, centerColorsTextureDescriptor.size,
                                   centerColorsTextureProps, CENTER_COLORS_ELEMENTS_PER_TEXEL, CENTER_COLORS_ELEMENTS_PER_SPLAT, 4,
                                   fromSplat, toSplat);
        }
        recordProcessingDuration(processingProfile, 'meshUpdateCenterColorsTextureMs', centerColorsTextureStartTime);

        // update covariance data texture
        if (covarancesTextureDesc) {
            const covariancesTextureStartTime = performance.now();
            const covariancesTexture = covarancesTextureDesc.texture;
            const covarancesStartElement = fromSplat * COVARIANCES_ELEMENTS_PER_SPLAT;
            const covariancesEndElement = toSplat * COVARIANCES_ELEMENTS_PER_SPLAT;

            if (covarianceCompressionLevel === 0) {
                covarancesTextureDesc.data.set(
                    this.splatDataTextures.baseData.covariances.subarray(covarancesStartElement, covariancesEndElement + 1),
                    covarancesStartElement
                );
            } else {
                SplatMesh.updatePaddedCompressedCovariancesTextureData(this.splatDataTextures.baseData.covariances,
                                                                       covarancesTextureDesc.data,
                                                                       fromSplat * covarancesTextureDesc.elementsPerTexelAllocated,
                                                                       covarancesStartElement, covariancesEndElement);
            }

            const covariancesTextureProps = this.renderer ? this.renderer.properties.get(covariancesTexture) : null;
            if (!covariancesTextureProps || !covariancesTextureProps.__webglTexture) {
                covariancesTexture.needsUpdate = true;
            } else {
                if (covarianceCompressionLevel === 0) {
                    this.updateDataTexture(covarancesTextureDesc.data, covarancesTextureDesc.texture, covarancesTextureDesc.size,
                                           covariancesTextureProps, covarancesTextureDesc.elementsPerTexelStored,
                                           COVARIANCES_ELEMENTS_PER_SPLAT, 4, fromSplat, toSplat);
                } else {
                    this.updateDataTexture(covarancesTextureDesc.data, covarancesTextureDesc.texture, covarancesTextureDesc.size,
                                           covariancesTextureProps, covarancesTextureDesc.elementsPerTexelAllocated,
                                           covarancesTextureDesc.elementsPerTexelAllocated, 2, fromSplat, toSplat);
                }
            }
            recordProcessingDuration(processingProfile, 'meshUpdateCovariancesTextureMs', covariancesTextureStartTime);
        }

        // update scale and rotation data texture
        if (scaleRotationsTextureDesc) {
            const scaleRotationsTextureStartTime = performance.now();
            const paddedScaleRotations = scaleRotationsTextureDesc.data;
            const scaleRotationsTexture = scaleRotationsTextureDesc.texture;
            const elementsPerSplat = 6;
            const bytesPerElement = scaleRotationCompressionLevel === 0 ? 4 : 2;

            if (this._uwaGpuRotationsAreWxyz) {
                const packedScaleRotations = scaleRotationsTextureDesc.gpuScaleRotations;
                const directScaleIsFullRange = fromSplat === 0 && toSplat === this.getSplatCount(true) - 1;
                const useDirectPaddedScaleRotations = directScaleIsFullRange && scaleRotationsTextureDesc.directPadded &&
                    packedScaleRotations === paddedScaleRotations;
                const useDirectCompactScaleRotations = directScaleIsFullRange && !useDirectPaddedScaleRotations &&
                    packedScaleRotations instanceof Float32Array &&
                    packedScaleRotations.length === this.getSplatCount(true) * elementsPerSplat;
                if (useDirectPaddedScaleRotations) {
                    // The worker array is already the complete texture backing store.
                } else if (useDirectCompactScaleRotations) {
                    const start = fromSplat * elementsPerSplat;
                    const end = (toSplat + 1) * elementsPerSplat;
                    paddedScaleRotations.set(packedScaleRotations.subarray(start, end), start);
                } else {
                    SplatMesh.updateDirectScaleRotationsPaddedData(fromSplat, toSplat,
                                                                   this.splatDataTextures.baseData.scales,
                                                                   this.splatDataTextures.baseData.rotations,
                                                                   paddedScaleRotations);
                }
            } else {
                SplatMesh.updateScaleRotationsPaddedData(fromSplat, toSplat,
                                                         this.splatDataTextures.baseData.scales,
                                                         this.splatDataTextures.baseData.rotations,
                                                         paddedScaleRotations);
            }
            const scaleRotationsTextureProps = this.renderer ? this.renderer.properties.get(scaleRotationsTexture) : null;
            if (!scaleRotationsTextureProps || !scaleRotationsTextureProps.__webglTexture) {
                scaleRotationsTexture.needsUpdate = true;
            } else {
                this.updateDataTexture(paddedScaleRotations, scaleRotationsTextureDesc.texture, scaleRotationsTextureDesc.size,
                                       scaleRotationsTextureProps, SCALES_ROTATIONS_ELEMENTS_PER_TEXEL, elementsPerSplat, bytesPerElement,
                                       fromSplat, toSplat);
            }
            recordProcessingDuration(processingProfile, 'meshUpdateScaleRotationsTextureMs', scaleRotationsTextureStartTime);
        }

        if (this.useCompressedTexture) {
            const uvTexDesc = this.splatDataTextures['compressedTextureUV'];
            if (uvTexDesc) {
                const astcUvTextureStartTime = performance.now();
                const paddedUVArray = uvTexDesc.data; // RGBA array created by setupDataTextures.
                const sourceUVs = this.splatDataTextures.baseData.compressedTextureUVs;

                // Expand compact U,V pairs into the padded four-element RGBA array.
                // The WebGL texture upload requires this alignment.
                const directGpuCompressedTextureUV = uvTexDesc.gpuCompressedTextureUV;
                const directUvIsFullRange = fromSplat === 0 && toSplat === splatCount - 1;
                const useDirectPaddedCompressedTextureUV = directUvIsFullRange && uvTexDesc.directPadded &&
                    directGpuCompressedTextureUV === paddedUVArray;
                const useDirectCompactCompressedTextureUV = directUvIsFullRange &&
                    !useDirectPaddedCompressedTextureUV && directGpuCompressedTextureUV instanceof Uint32Array &&
                    directGpuCompressedTextureUV.length === splatCount * 4;
                if (useDirectPaddedCompressedTextureUV) {
                    // The worker array is already the complete texture backing store.
                } else if (useDirectCompactCompressedTextureUV) {
                    paddedUVArray.set(directGpuCompressedTextureUV.subarray(0, splatCount * 4), 0);
                } else {
                    for (let c = fromSplat; c <= toSplat; c++) {
                        const srcIdx = c * 2;
                        const destIdx = c * 4; // Texture is RGBA32UI
                        paddedUVArray[destIdx] = sourceUVs[srcIdx]; // R = U
                        paddedUVArray[destIdx + 1] = sourceUVs[srcIdx + 1]; // G = V
                        paddedUVArray[destIdx + 2] = 0;
                        paddedUVArray[destIdx + 3] = 0;
                    }
                }

                const uvTexture = uvTexDesc.texture;
                const uvTextureProps = this.renderer ? this.renderer.properties.get(uvTexture) : null;

                if (!uvTextureProps || !uvTextureProps.__webglTexture) {
                    uvTexture.needsUpdate = true;
                } else {
                    // Reuse updateDataTexture.
                    this.updateDataTexture(paddedUVArray, uvTexture, uvTexDesc.size,
                        uvTextureProps, uvTexDesc.elementsPerTexel, // 4
                        4, // elementsPerSplat (RGBA)
                        4, // bytesPerElement (Uint32 = 4 bytes)
                        fromSplat, toSplat);
                }
                recordProcessingDuration(processingProfile, 'meshUpdateAstcUvTextureMs', astcUvTextureStartTime);
            }
        } else {
            // update spherical harmonics data texture
            const shData = this.splatDataTextures.baseData.sphericalHarmonics;
            if (shData) {
                const sphericalHarmonicsTextureStartTime = performance.now();
                let shBytesPerElement = 4;
                if (shCompressionLevel === 1) shBytesPerElement = 2;
                else if (shCompressionLevel === 2) shBytesPerElement = 1;

                const updateTexture = (shTexture, shTextureSize, elementsPerTexel, paddedSHArray, paddedSHComponentCount) => {
                    const shTextureProps = this.renderer ? this.renderer.properties.get(shTexture) : null;
                    if (!shTextureProps || !shTextureProps.__webglTexture) {
                        shTexture.needsUpdate = true;
                    } else {
                        this.updateDataTexture(paddedSHArray, shTexture, shTextureSize, shTextureProps, elementsPerTexel,
                            paddedSHComponentCount, shBytesPerElement, fromSplat, toSplat);
                    }
                };

                const shComponentCount = shTextureDesc.componentCount;
                const paddedSHComponentCount = shTextureDesc.paddedComponentCount;

                // Update for the case of a single texture for all spherical harmonics data
                if (shTextureDesc.textureCount === 1) {
                    const paddedSHArray = shTextureDesc.data;
                    for (let c = fromSplat; c <= toSplat; c++) {
                        const srcBase = shComponentCount * c;
                        const destBase = paddedSHComponentCount * c;
                        for (let i = 0; i < shComponentCount; i++) {
                            paddedSHArray[destBase + i] = shData[srcBase + i];
                        }
                    }
                    updateTexture(shTextureDesc.texture, shTextureDesc.size,
                        shTextureDesc.elementsPerTexel, paddedSHArray, paddedSHComponentCount);
                    // Update for the case of spherical harmonics data split among three textures, one for each color channel
                } else {
                    const shComponentCountPerChannel = shTextureDesc.componentCountPerChannel;
                    for (let t = 0; t < 3; t++) {
                        const paddedSHArray = shTextureDesc.data[t];
                        for (let c = fromSplat; c <= toSplat; c++) {
                            const srcBase = shComponentCount * c;
                            const destBase = paddedSHComponentCount * c;
                            if (shComponentCountPerChannel >= 3) {
                                for (let i = 0; i < 3; i++) paddedSHArray[destBase + i] = shData[srcBase + t * 3 + i];
                                if (shComponentCountPerChannel >= 8) {
                                    for (let i = 0; i < 5; i++) paddedSHArray[destBase + 3 + i] = shData[srcBase + 9 + t * 5 + i];
                                    if (shComponentCountPerChannel >= 15) {
                                        for (let i = 0; i < 7; i++) paddedSHArray[destBase + 8 + i] = shData[srcBase + 24 + t * 7 + i];
                                    }
                                }
                            }
                        }
                        updateTexture(shTextureDesc.textures[t], shTextureDesc.size,
                            shTextureDesc.elementsPerTexel, paddedSHArray, paddedSHComponentCount);
                    }
                }
                recordProcessingDuration(processingProfile, 'meshUpdateSphericalHarmonicsTextureMs', sphericalHarmonicsTextureStartTime);
            }
        }

        // update scene index & transform data
        const sceneIndexesTextureStartTime = performance.now();
        const sceneIndexesTexDesc = this.splatDataTextures['sceneIndexes'];
        if (!this.implicitSingleSceneIndexMap) {
            const paddedSceneIndexes = sceneIndexesTexDesc.data;
            for (let c = this.lastBuildSplatCount; c <= toSplat; c++) {
                paddedSceneIndexes[c] = this.globalSplatIndexToSceneIndexMap[c];
            }
            const sceneIndexesTexture = sceneIndexesTexDesc.texture;
            const sceneIndexesTextureProps = this.renderer ? this.renderer.properties.get(sceneIndexesTexture) : null;
            if (!sceneIndexesTextureProps || !sceneIndexesTextureProps.__webglTexture) {
                sceneIndexesTexture.needsUpdate = true;
            } else {
                this.updateDataTexture(paddedSceneIndexes, sceneIndexesTexDesc.texture, sceneIndexesTexDesc.size,
                                       sceneIndexesTextureProps, 1, 1, 1, this.lastBuildSplatCount, toSplat);
            }
        }
        recordProcessingDuration(processingProfile, 'meshUpdateSceneIndexesTextureMs', sceneIndexesTextureStartTime);
        recordProcessingDuration(processingProfile, 'meshUpdateDataTexturesMs', updateTexturesStartTime);
    }

    getTargetCovarianceCompressionLevel() {
        return this.halfPrecisionCovariancesOnGPU ? 1 : 0;
    }

    getTargetSphericalHarmonicsCompressionLevel() {
        return Math.max(1, this.getMaximumSplatBufferCompressionLevel());
    }

    getMaximumSplatBufferCompressionLevel() {
        let maxCompressionLevel;
        for (let i = 0; i < this.scenes.length; i++) {
            const scene = this.getScene(i);
            const splatBuffer = scene.splatBuffer;
            if (i === 0 || splatBuffer.compressionLevel > maxCompressionLevel) {
                maxCompressionLevel = splatBuffer.compressionLevel;
            }
        }
        return maxCompressionLevel;
    }

    getMinimumSplatBufferCompressionLevel() {
        let minCompressionLevel;
        for (let i = 0; i < this.scenes.length; i++) {
            const scene = this.getScene(i);
            const splatBuffer = scene.splatBuffer;
            if (i === 0 || splatBuffer.compressionLevel < minCompressionLevel) {
                minCompressionLevel = splatBuffer.compressionLevel;
            }
        }
        return minCompressionLevel;
    }

    static computeTextureUpdateRegion(startSplat, endSplat, textureWidth, elementsPerTexel, elementsPerSplat) {
        const texelsPerSplat = elementsPerSplat / elementsPerTexel;

        const startSplatTexels = startSplat * texelsPerSplat;
        const startRow = Math.floor(startSplatTexels / textureWidth);
        const startRowElement = startRow * textureWidth * elementsPerTexel;

        const endSplatTexels = endSplat * texelsPerSplat;
        const endRow = Math.floor(endSplatTexels / textureWidth);
        const endRowEndElement = endRow * textureWidth * elementsPerTexel + (textureWidth * elementsPerTexel);

        return {
            'dataStart': startRowElement,
            'dataEnd': endRowEndElement,
            'startRow': startRow,
            'endRow': endRow
        };
    }

    updateDataTexture(paddedData, texture, textureSize, textureProps, elementsPerTexel, elementsPerSplat, bytesPerElement, from, to) {
        const gl = this.renderer.getContext();
        const updateRegion = SplatMesh.computeTextureUpdateRegion(from, to, textureSize.x, elementsPerTexel, elementsPerSplat);
        const updateElementCount = updateRegion.dataEnd - updateRegion.dataStart;
        const updateDataView = new paddedData.constructor(paddedData.buffer,
                                                          updateRegion.dataStart * bytesPerElement, updateElementCount);
        const updateHeight = updateRegion.endRow - updateRegion.startRow + 1;
        const glType = this.webGLUtils.convert(texture.type);
        const glFormat = this.webGLUtils.convert(texture.format, texture.colorSpace);
        const currentTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.bindTexture(gl.TEXTURE_2D, textureProps.__webglTexture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, updateRegion.startRow,
                         textureSize.x, updateHeight, glFormat, glType, updateDataView);
        gl.bindTexture(gl.TEXTURE_2D, currentTexture);
    }

    static updatePaddedCompressedCovariancesTextureData(sourceData, textureData, textureDataStartIndex, fromElement, toElement) {
        let textureDataView = new DataView(textureData.buffer);
        let textureDataIndex = textureDataStartIndex;
        let sequentialCount = 0;
        for (let i = fromElement; i <= toElement; i+=2) {
            textureDataView.setUint16(textureDataIndex * 2, sourceData[i], true);
            textureDataView.setUint16(textureDataIndex * 2 + 2, sourceData[i + 1], true);
            textureDataIndex += 2;
            sequentialCount++;
            if (sequentialCount >= 3) {
                textureDataIndex += 2;
                sequentialCount = 0;
            }
        }
    }

    static updateCenterColorsPaddedData(from, to, centers, colors, paddedCenterColors) {
        for (let c = from; c <= to; c++) {
            const colorsBase = c * 4;
            const centersBase = c * 3;
            const centerColorsBase = c * 4;
            paddedCenterColors[centerColorsBase] = rgbaArrayToInteger(colors, colorsBase);
            paddedCenterColors[centerColorsBase + 1] = uintEncodedFloat(centers[centersBase]);
            paddedCenterColors[centerColorsBase + 2] = uintEncodedFloat(centers[centersBase + 1]);
            paddedCenterColors[centerColorsBase + 3] = uintEncodedFloat(centers[centersBase + 2]);
        }
    }

    static updateScaleRotationsPaddedData(from, to, scales, rotations, paddedScaleRotations) {
        const combinedSize = 6;
        for (let c = from; c <= to; c++) {
            const scaleBase = c * 3;
            const rotationBase = c * 4;
            const scaleRotationsBase = c * combinedSize;

            paddedScaleRotations[scaleRotationsBase] = scales[scaleBase];
            paddedScaleRotations[scaleRotationsBase + 1] = scales[scaleBase + 1];
            paddedScaleRotations[scaleRotationsBase + 2] = scales[scaleBase + 2];

            paddedScaleRotations[scaleRotationsBase + 3] = rotations[rotationBase];
            paddedScaleRotations[scaleRotationsBase + 4] = rotations[rotationBase + 1];
            paddedScaleRotations[scaleRotationsBase + 5] = rotations[rotationBase + 2];
        }
    }

    // UWA reconstruction stores quaternions as w,x,y,z. The regular SplatBuffer
    // path stores x,y,z,w in its scale/rotation texture, so convert the direct
    // result explicitly while keeping the compact result layout unchanged.
    static updateDirectScaleRotationsPaddedData(from, to, scales, rotations, paddedScaleRotations) {
        for (let c = from; c <= to; c++) {
            const scaleBase = c * 3;
            const rotationBase = c * 4;
            const textureBase = c * 6;
            paddedScaleRotations[textureBase] = scales[scaleBase];
            paddedScaleRotations[textureBase + 1] = scales[scaleBase + 1];
            paddedScaleRotations[textureBase + 2] = scales[scaleBase + 2];
            paddedScaleRotations[textureBase + 3] = rotations[rotationBase + 1];
            paddedScaleRotations[textureBase + 4] = rotations[rotationBase + 2];
            paddedScaleRotations[textureBase + 5] = rotations[rotationBase + 3];
        }
    }

    prepareVisibleRegionForImmediateRender() {
        if (this.scenes.length > 0) {
            const avgCenter = new THREE.Vector3();
            this.scenes.forEach((scene) => {
                avgCenter.add(scene.splatBuffer.sceneCenter);
            });
            avgCenter.multiplyScalar(1.0 / this.scenes.length);
            this.calculatedSceneCenter.copy(avgCenter);
        }

        this.material.uniforms.sceneCenter.value.copy(this.calculatedSceneCenter);
        this.material.uniforms.visibleRegionFadeStartRadius.value = this.visibleRegionFadeStartRadius;
        this.material.uniforms.visibleRegionRadius.value = this.visibleRegionRadius;
        this.material.uniforms.firstRenderTime.value = this.firstRenderTime;
        this.material.uniforms.currentTime.value = performance.now();
        this.material.uniforms.fadeInComplete.value = 1;
        this.material.uniformsNeedUpdate = true;
        this.visibleRegionChanging = false;
    }

    updateVisibleRegion(sinceLastBuildOnly, sceneRevealMode = SceneRevealMode.Default) {
        const splatCount = this.getSplatCount(true);
        const tempCenter = new THREE.Vector3();
        if (!sinceLastBuildOnly) {
            const avgCenter = new THREE.Vector3();
            this.scenes.forEach((scene) => {
                avgCenter.add(scene.splatBuffer.sceneCenter);
            });
            avgCenter.multiplyScalar(1.0 / this.scenes.length);
            this.calculatedSceneCenter.copy(avgCenter);
            this.material.uniforms.sceneCenter.value.copy(this.calculatedSceneCenter);
            this.material.uniformsNeedUpdate = true;
        }

        const startSplatFormMaxDistanceCalc = sinceLastBuildOnly ? this.lastBuildSplatCount : 0;
        for (let i = startSplatFormMaxDistanceCalc; i < splatCount; i++) {
            this.getSplatCenter(i, tempCenter, true);
            const distFromCSceneCenter = tempCenter.sub(this.calculatedSceneCenter).length();
            if (distFromCSceneCenter > this.maxSplatDistanceFromSceneCenter) this.maxSplatDistanceFromSceneCenter = distFromCSceneCenter;
        }

        if (this.maxSplatDistanceFromSceneCenter - this.visibleRegionBufferRadius > VISIBLE_REGION_EXPANSION_DELTA) {
            this.visibleRegionBufferRadius = this.maxSplatDistanceFromSceneCenter;
            this.visibleRegionRadius = Math.max(this.visibleRegionBufferRadius - VISIBLE_REGION_EXPANSION_DELTA, 0.0);
        }
        if (this.finalBuild) this.visibleRegionRadius = this.visibleRegionBufferRadius = this.maxSplatDistanceFromSceneCenter;
        this.updateVisibleRegionFadeDistance(sceneRevealMode);
    }

    updateVisibleRegionFadeDistance(sceneRevealMode = SceneRevealMode.Default) {
        const fastFadeRate = SCENE_FADEIN_RATE_FAST * this.sceneFadeInRateMultiplier;
        const gradualFadeRate = SCENE_FADEIN_RATE_GRADUAL * this.sceneFadeInRateMultiplier;
        const defaultFadeInRate = this.finalBuild ? fastFadeRate : gradualFadeRate;
        const fadeInRate = sceneRevealMode === SceneRevealMode.Default ? defaultFadeInRate : gradualFadeRate;
        this.visibleRegionFadeStartRadius = (this.visibleRegionRadius - this.visibleRegionFadeStartRadius) *
                                             fadeInRate + this.visibleRegionFadeStartRadius;
        const fadeInPercentage = (this.visibleRegionBufferRadius > 0) ?
                                 (this.visibleRegionFadeStartRadius / this.visibleRegionBufferRadius) : 0;
        const fadeInComplete = fadeInPercentage > 0.99;
        const shaderFadeInComplete = (fadeInComplete || sceneRevealMode === SceneRevealMode.Instant) ? 1 : 0;

        this.material.uniforms.visibleRegionFadeStartRadius.value = this.visibleRegionFadeStartRadius;
        this.material.uniforms.visibleRegionRadius.value = this.visibleRegionRadius;
        this.material.uniforms.firstRenderTime.value = this.firstRenderTime;
        this.material.uniforms.currentTime.value = performance.now();
        this.material.uniforms.fadeInComplete.value = shaderFadeInComplete;
        this.material.uniformsNeedUpdate = true;
        this.visibleRegionChanging = !shaderFadeInComplete;
    }

    /**
     * Set the indexes of splats that should be rendered; should be sorted in desired render order.
     * @param {Uint32Array} globalIndexes Sorted index list of splats to be rendered
     * @param {number} renderSplatCount Total number of splats to be rendered. Necessary because we may not want to render
     *                                  every splat.
     */
    updateRenderIndexes(globalIndexes, renderSplatCount) {
        const geometry = this.geometry;
        geometry.attributes.splatIndex.set(globalIndexes);
        geometry.attributes.splatIndex.needsUpdate = true;
        if (renderSplatCount > 0 && this.firstRenderTime === -1) this.firstRenderTime = performance.now();
        geometry.instanceCount = renderSplatCount;
        geometry.setDrawRange(0, renderSplatCount);
    }

    /**
     * Update the transforms for each scene in this splat mesh from their individual components (position,
     * quaternion, and scale)
     */
    updateTransforms() {
        for (let i = 0; i < this.scenes.length; i++) {
            const scene = this.getScene(i);
            scene.updateTransform(this.dynamicMode);
        }
    }

    updateUniforms = function() {

        const viewport = new THREE.Vector2();

        return function(renderDimensions, cameraFocalLengthX, cameraFocalLengthY,
                        orthographicMode, orthographicZoom, inverseFocalAdjustment) {
            const splatCount = this.getSplatCount();
            if (splatCount > 0) {
                viewport.set(renderDimensions.x * this.devicePixelRatio,
                             renderDimensions.y * this.devicePixelRatio);
                this.material.uniforms.viewport.value.copy(viewport);
                this.material.uniforms.basisViewport.value.set(1.0 / viewport.x, 1.0 / viewport.y);
                this.material.uniforms.focal.value.set(cameraFocalLengthX, cameraFocalLengthY);
                this.material.uniforms.orthographicMode.value = orthographicMode ? 1 : 0;
                this.material.uniforms.orthoZoom.value = orthographicZoom;
                this.material.uniforms.inverseFocalAdjustment.value = inverseFocalAdjustment;
                if (this.dynamicMode) {
                    for (let i = 0; i < this.scenes.length; i++) {
                        this.material.uniforms.transforms.value[i].copy(this.getScene(i).transform);
                    }
                }
                if (this.enableOptionalEffects) {
                    for (let i = 0; i < this.scenes.length; i++) {
                        this.material.uniforms.sceneOpacity.value[i] = clamp(this.getScene(i).opacity, 0.0, 1.0);
                        this.material.uniforms.sceneVisibility.value[i] = this.getScene(i).visible ? 1 : 0;
                        this.material.uniformsNeedUpdate = true;
                    }
                }
                this.material.uniformsNeedUpdate = true;
            }
        };

    }();

    setSplatScale(splatScale = 1) {
        this.splatScale = splatScale;
        this.material.uniforms.splatScale.value = splatScale;
        this.material.uniformsNeedUpdate = true;
    }

    getSplatScale() {
        return this.splatScale;
    }

    setPointCloudModeEnabled(enabled) {
        this.pointCloudModeEnabled = enabled;
        this.material.uniforms.pointCloudModeEnabled.value = enabled ? 1 : 0;
        this.material.uniformsNeedUpdate = true;
    }

    getPointCloudModeEnabled() {
        return this.pointCloudModeEnabled;
    }

    getSplatDataTextures() {
        return this.splatDataTextures;
    }

    getSplatCount(includeSinceLastBuild = false) {
        if (!includeSinceLastBuild) return this.lastBuildSplatCount;
        else return SplatMesh.getTotalSplatCountForScenes(this.scenes);
    }

    static getTotalSplatCountForScenes(scenes) {
        let totalSplatCount = 0;
        for (let scene of scenes) {
            if (scene && scene.splatBuffer) totalSplatCount += scene.splatBuffer.getSplatCount();
        }
        return totalSplatCount;
    }

    static getTotalSplatCountForSplatBuffers(splatBuffers) {
        let totalSplatCount = 0;
        for (let splatBuffer of splatBuffers) totalSplatCount += splatBuffer.getSplatCount();
        return totalSplatCount;
    }

    getMaxSplatCount() {
        return SplatMesh.getTotalMaxSplatCountForScenes(this.scenes);
    }

    static getTotalMaxSplatCountForScenes(scenes) {
        let totalSplatCount = 0;
        for (let scene of scenes) {
            if (scene && scene.splatBuffer) totalSplatCount += scene.splatBuffer.getMaxSplatCount();
        }
        return totalSplatCount;
    }

    static getTotalMaxSplatCountForSplatBuffers(splatBuffers) {
        let totalSplatCount = 0;
        for (let splatBuffer of splatBuffers) totalSplatCount += splatBuffer.getMaxSplatCount();
        return totalSplatCount;
    }

    disposeDistancesComputationGPUResources() {

        if (!this.renderer) return;

        const gl = this.renderer.getContext();

        if (this.distancesTransformFeedback.vao) {
            gl.deleteVertexArray(this.distancesTransformFeedback.vao);
            this.distancesTransformFeedback.vao = null;
        }
        if (this.distancesTransformFeedback.program) {
            gl.deleteProgram(this.distancesTransformFeedback.program);
            gl.deleteShader(this.distancesTransformFeedback.vertexShader);
            gl.deleteShader(this.distancesTransformFeedback.fragmentShader);
            this.distancesTransformFeedback.program = null;
            this.distancesTransformFeedback.vertexShader = null;
            this.distancesTransformFeedback.fragmentShader = null;
        }
        this.disposeDistancesComputationGPUBufferResources();
        if (this.distancesTransformFeedback.id) {
            gl.deleteTransformFeedback(this.distancesTransformFeedback.id);
            this.distancesTransformFeedback.id = null;
        }
    }

    disposeDistancesComputationGPUBufferResources() {

        if (!this.renderer) return;

        const gl = this.renderer.getContext();

        if (this.distancesTransformFeedback.centersBuffer) {
            this.distancesTransformFeedback.centersBuffer = null;
            gl.deleteBuffer(this.distancesTransformFeedback.centersBuffer);
        }
        if (this.distancesTransformFeedback.outDistancesBuffer) {
            gl.deleteBuffer(this.distancesTransformFeedback.outDistancesBuffer);
            this.distancesTransformFeedback.outDistancesBuffer = null;
        }
    }

    /**
     * Set the Three.js renderer used by this splat mesh
     * @param {THREE.WebGLRenderer} renderer Instance of THREE.WebGLRenderer
     */
    setRenderer(renderer) {
        if (renderer !== this.renderer) {
            if (this.renderer && this.precompiledMaterial) this.clearPrecompiledMaterial();
            this.renderer = renderer;
            const gl = this.renderer.getContext();
            const extensions = new WebGLExtensions(gl);
            const capabilities = new WebGLCapabilities(gl, extensions, {});
            extensions.init(capabilities);
            this.webGLUtils = new THREE.WebGLUtils(gl, extensions, capabilities);
            if (this.enableDistancesComputationOnGPU && this.getSplatCount() > 0) {
                this.setupDistancesComputationTransformFeedback();
                const { centers, sceneIndexes } = this.getDataForDistancesComputation(0, this.getSplatCount() - 1);
                this.refreshGPUBuffersForDistancesComputation(centers, sceneIndexes);
            }
        }
    }

    setupDistancesComputationTransformFeedback = function() {

        let currentMaxSplatCount;

        return function() {
            const maxSplatCount = this.getMaxSplatCount();

            if (!this.renderer) return;

            const rebuildGPUObjects = (this.lastRenderer !== this.renderer);
            const rebuildBuffers = currentMaxSplatCount !== maxSplatCount;

            if (!rebuildGPUObjects && !rebuildBuffers) return;

            if (rebuildGPUObjects) {
                this.disposeDistancesComputationGPUResources();
            } else if (rebuildBuffers) {
                this.disposeDistancesComputationGPUBufferResources();
            }

            const gl = this.renderer.getContext();

            const createShader = (gl, type, source) => {
                const shader = gl.createShader(type);
                if (!shader) {
                    console.error('Fatal error: gl could not create a shader object.');
                    return null;
                }

                gl.shaderSource(shader, source);
                gl.compileShader(shader);

                const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
                if (!compiled) {
                    let typeName = 'unknown';
                    if (type === gl.VERTEX_SHADER) typeName = 'vertex shader';
                    else if (type === gl.FRAGMENT_SHADER) typeName = 'fragement shader';
                    const errors = gl.getShaderInfoLog(shader);
                    console.error('Failed to compile ' + typeName + ' with these errors:' + errors);
                    gl.deleteShader(shader);
                    return null;
                }

                return shader;
            };

            let vsSource;
            if (this.integerBasedDistancesComputation) {
                vsSource =
                `#version 300 es
                in ivec4 center;
                flat out int distance;`;
                if (this.dynamicMode) {
                    vsSource += `
                        in uint sceneIndex;
                        uniform ivec4 transforms[${Constants.MaxScenes}];
                        void main(void) {
                            ivec4 transform = transforms[sceneIndex];
                            distance = center.x * transform.x + center.y * transform.y + center.z * transform.z + transform.w * center.w;
                        }
                    `;
                } else {
                    vsSource += `
                        uniform ivec3 modelViewProj;
                        void main(void) {
                            distance = center.x * modelViewProj.x + center.y * modelViewProj.y + center.z * modelViewProj.z;
                        }
                    `;
                }
            } else {
                vsSource =
                `#version 300 es
                in vec4 center;
                flat out float distance;`;
                if (this.dynamicMode) {
                    vsSource += `
                        in uint sceneIndex;
                        uniform mat4 transforms[${Constants.MaxScenes}];
                        void main(void) {
                            vec4 transformedCenter = transforms[sceneIndex] * vec4(center.xyz, 1.0);
                            distance = transformedCenter.z;
                        }
                    `;
                } else {
                    vsSource += `
                        uniform vec3 modelViewProj;
                        void main(void) {
                            distance = center.x * modelViewProj.x + center.y * modelViewProj.y + center.z * modelViewProj.z;
                        }
                    `;
                }
            }

            const fsSource =
            `#version 300 es
                precision lowp float;
                out vec4 fragColor;
                void main(){}
            `;

            const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
            const currentProgram = gl.getParameter(gl.CURRENT_PROGRAM);
            const currentProgramDeleted = currentProgram ? gl.getProgramParameter(currentProgram, gl.DELETE_STATUS) : false;

            if (rebuildGPUObjects) {
                this.distancesTransformFeedback.vao = gl.createVertexArray();
            }

            gl.bindVertexArray(this.distancesTransformFeedback.vao);

            if (rebuildGPUObjects) {
                const program = gl.createProgram();
                const vertexShader = createShader(gl, gl.VERTEX_SHADER, vsSource);
                const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
                if (!vertexShader || !fragmentShader) {
                    throw new Error('Could not compile shaders for distances computation on GPU.');
                }
                gl.attachShader(program, vertexShader);
                gl.attachShader(program, fragmentShader);
                gl.transformFeedbackVaryings(program, ['distance'], gl.SEPARATE_ATTRIBS);
                gl.linkProgram(program);

                const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
                if (!linked) {
                    const error = gl.getProgramInfoLog(program);
                    console.error('Fatal error: Failed to link program: ' + error);
                    gl.deleteProgram(program);
                    gl.deleteShader(fragmentShader);
                    gl.deleteShader(vertexShader);
                    throw new Error('Could not link shaders for distances computation on GPU.');
                }

                this.distancesTransformFeedback.program = program;
                this.distancesTransformFeedback.vertexShader = vertexShader;
                this.distancesTransformFeedback.vertexShader = fragmentShader;
            }

            gl.useProgram(this.distancesTransformFeedback.program);

            this.distancesTransformFeedback.centersLoc =
                gl.getAttribLocation(this.distancesTransformFeedback.program, 'center');
            if (this.dynamicMode) {
                this.distancesTransformFeedback.sceneIndexesLoc =
                    gl.getAttribLocation(this.distancesTransformFeedback.program, 'sceneIndex');
                for (let i = 0; i < this.scenes.length; i++) {
                    this.distancesTransformFeedback.transformsLocs[i] =
                        gl.getUniformLocation(this.distancesTransformFeedback.program, `transforms[${i}]`);
                }
            } else {
                this.distancesTransformFeedback.modelViewProjLoc =
                    gl.getUniformLocation(this.distancesTransformFeedback.program, 'modelViewProj');
            }

            if (rebuildGPUObjects || rebuildBuffers) {
                this.distancesTransformFeedback.centersBuffer = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.centersBuffer);
                gl.enableVertexAttribArray(this.distancesTransformFeedback.centersLoc);
                if (this.integerBasedDistancesComputation) {
                    gl.vertexAttribIPointer(this.distancesTransformFeedback.centersLoc, 4, gl.INT, 0, 0);
                } else {
                    gl.vertexAttribPointer(this.distancesTransformFeedback.centersLoc, 4, gl.FLOAT, false, 0, 0);
                }

                if (this.dynamicMode) {
                    this.distancesTransformFeedback.sceneIndexesBuffer = gl.createBuffer();
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.sceneIndexesBuffer);
                    gl.enableVertexAttribArray(this.distancesTransformFeedback.sceneIndexesLoc);
                    gl.vertexAttribIPointer(this.distancesTransformFeedback.sceneIndexesLoc, 1, gl.UNSIGNED_INT, 0, 0);
                }
            }

            if (rebuildGPUObjects || rebuildBuffers) {
                this.distancesTransformFeedback.outDistancesBuffer = gl.createBuffer();
            }
            gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.outDistancesBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, maxSplatCount * 4, gl.STATIC_READ);

            if (rebuildGPUObjects) {
                this.distancesTransformFeedback.id = gl.createTransformFeedback();
            }
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.distancesTransformFeedback.id);
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.distancesTransformFeedback.outDistancesBuffer);

            if (currentProgram && currentProgramDeleted !== true) gl.useProgram(currentProgram);
            if (currentVao) gl.bindVertexArray(currentVao);

            this.lastRenderer = this.renderer;
            currentMaxSplatCount = maxSplatCount;
        };

    }();

    /**
     * Refresh GPU buffers used for computing splat distances with centers data from the scenes for this mesh.
     * @param {boolean} isUpdate Specify whether or not to update the GPU buffer or to initialize & fill
     * @param {Array<number>} centers The splat centers data
     * @param {number} offsetSplats Offset in the GPU buffer at which to start updating data, specified in splats
     */
    updateGPUCentersBufferForDistancesComputation(isUpdate, centers, offsetSplats) {

        if (!this.renderer) return;

        const gl = this.renderer.getContext();

        const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        gl.bindVertexArray(this.distancesTransformFeedback.vao);

        const ArrayType = this.integerBasedDistancesComputation ? Uint32Array : Float32Array;
        const attributeBytesPerCenter = 16;
        const subBufferOffset = offsetSplats * attributeBytesPerCenter;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.centersBuffer);

        if (isUpdate) {
            gl.bufferSubData(gl.ARRAY_BUFFER, subBufferOffset, centers);
        } else {
            const maxArray = new ArrayType(this.getMaxSplatCount() * attributeBytesPerCenter);
            maxArray.set(centers);
            gl.bufferData(gl.ARRAY_BUFFER, maxArray, gl.STATIC_DRAW);
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        if (currentVao) gl.bindVertexArray(currentVao);
    }

    /**
     * Refresh GPU buffers used for pre-computing splat distances with centers data from the scenes for this mesh.
     * @param {boolean} isUpdate Specify whether or not to update the GPU buffer or to initialize & fill
     * @param {Array<number>} sceneIndexes The splat scene indexes
     * @param {number} offsetSplats Offset in the GPU buffer at which to start updating data, specified in splats
     */
    updateGPUTransformIndexesBufferForDistancesComputation(isUpdate, sceneIndexes, offsetSplats) {

        if (!this.renderer || !this.dynamicMode) return;

        const gl = this.renderer.getContext();

        const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
        gl.bindVertexArray(this.distancesTransformFeedback.vao);

        const subBufferOffset = offsetSplats * 4;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.sceneIndexesBuffer);

        if (isUpdate) {
            gl.bufferSubData(gl.ARRAY_BUFFER, subBufferOffset, sceneIndexes);
        } else {
            const maxArray = new Uint32Array(this.getMaxSplatCount() * 4);
            maxArray.set(sceneIndexes);
            gl.bufferData(gl.ARRAY_BUFFER, maxArray, gl.STATIC_DRAW);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        if (currentVao) gl.bindVertexArray(currentVao);
    }

    /**
     * Get a typed array containing a mapping from global splat indexes to their scene index.
     * @param {number} start Starting splat index to store
     * @param {number} end Ending splat index to store
     * @return {Uint32Array}
     */
    getSceneIndexes(start, end) {

        const fillCount = end - start + 1;
        const sceneIndexes = new Uint32Array(fillCount);
        if (this.implicitSingleSceneIndexMap) return sceneIndexes;
        for (let i = 0; i < fillCount; i++) {
            sceneIndexes[i] = this.globalSplatIndexToSceneIndexMap[start + i];
        }

        return sceneIndexes;
    }

    /**
     * Fill 'array' with the transforms for each scene in this splat mesh.
     * @param {Array} array Empty array to be filled with scene transforms. If not empty, contents will be overwritten.
     */
    fillTransformsArray = function() {

        const tempArray = [];

        return function(array) {
            if (tempArray.length !== array.length) tempArray.length = array.length;
            for (let i = 0; i < this.scenes.length; i++) {
                const sceneTransform = this.getScene(i).transform;
                const sceneTransformElements = sceneTransform.elements;
                for (let j = 0; j < 16; j++) {
                    tempArray[i * 16 + j] = sceneTransformElements[j];
                }
            }
            array.set(tempArray);
        };

    }();

    computeDistancesOnGPU = function() {

        const tempMatrix = new THREE.Matrix4();

        return function(modelViewProjMatrix, outComputedDistances) {
            if (!this.renderer) return;

            // console.time("gpu_compute_distances");
            const gl = this.renderer.getContext();

            const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
            const currentProgram = gl.getParameter(gl.CURRENT_PROGRAM);
            const currentProgramDeleted = currentProgram ? gl.getProgramParameter(currentProgram, gl.DELETE_STATUS) : false;

            gl.bindVertexArray(this.distancesTransformFeedback.vao);
            gl.useProgram(this.distancesTransformFeedback.program);

            gl.enable(gl.RASTERIZER_DISCARD);

            if (this.dynamicMode) {
                for (let i = 0; i < this.scenes.length; i++) {
                    tempMatrix.copy(this.getScene(i).transform);
                    tempMatrix.premultiply(modelViewProjMatrix);

                    if (this.integerBasedDistancesComputation) {
                        const iTempMatrix = SplatMesh.getIntegerMatrixArray(tempMatrix);
                        const iTransform = [iTempMatrix[2], iTempMatrix[6], iTempMatrix[10], iTempMatrix[14]];
                        gl.uniform4i(this.distancesTransformFeedback.transformsLocs[i], iTransform[0], iTransform[1],
                                                                                        iTransform[2], iTransform[3]);
                    } else {
                        gl.uniformMatrix4fv(this.distancesTransformFeedback.transformsLocs[i], false, tempMatrix.elements);
                    }
                }
            } else {
                if (this.integerBasedDistancesComputation) {
                    const iViewProjMatrix = SplatMesh.getIntegerMatrixArray(modelViewProjMatrix);
                    const iViewProj = [iViewProjMatrix[2], iViewProjMatrix[6], iViewProjMatrix[10]];
                    gl.uniform3i(this.distancesTransformFeedback.modelViewProjLoc, iViewProj[0], iViewProj[1], iViewProj[2]);
                } else {
                    const viewProj = [modelViewProjMatrix.elements[2], modelViewProjMatrix.elements[6], modelViewProjMatrix.elements[10]];
                    gl.uniform3f(this.distancesTransformFeedback.modelViewProjLoc, viewProj[0], viewProj[1], viewProj[2]);
                }
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.centersBuffer);
            gl.enableVertexAttribArray(this.distancesTransformFeedback.centersLoc);
            if (this.integerBasedDistancesComputation) {
                gl.vertexAttribIPointer(this.distancesTransformFeedback.centersLoc, 4, gl.INT, 0, 0);
            } else {
                gl.vertexAttribPointer(this.distancesTransformFeedback.centersLoc, 4, gl.FLOAT, false, 0, 0);
            }

            if (this.dynamicMode) {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.sceneIndexesBuffer);
                gl.enableVertexAttribArray(this.distancesTransformFeedback.sceneIndexesLoc);
                gl.vertexAttribIPointer(this.distancesTransformFeedback.sceneIndexesLoc, 1, gl.UNSIGNED_INT, 0, 0);
            }

            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.distancesTransformFeedback.id);
            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.distancesTransformFeedback.outDistancesBuffer);

            gl.beginTransformFeedback(gl.POINTS);
            gl.drawArrays(gl.POINTS, 0, this.getSplatCount());
            gl.endTransformFeedback();

            gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
            gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

            gl.disable(gl.RASTERIZER_DISCARD);

            const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();

            const promise = new Promise((resolve) => {
                const checkSync = () => {
                    if (this.disposed) {
                        resolve();
                    } else {
                        const timeout = 0;
                        const bitflags = 0;
                        const status = gl.clientWaitSync(sync, bitflags, timeout);
                        switch (status) {
                            case gl.TIMEOUT_EXPIRED:
                                this.computeDistancesOnGPUSyncTimeout = setTimeout(checkSync);
                                return this.computeDistancesOnGPUSyncTimeout;
                            case gl.WAIT_FAILED:
                                throw new Error('should never get here');
                            default:
                                this.computeDistancesOnGPUSyncTimeout = null;
                                gl.deleteSync(sync);
                                const currentVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
                                gl.bindVertexArray(this.distancesTransformFeedback.vao);
                                gl.bindBuffer(gl.ARRAY_BUFFER, this.distancesTransformFeedback.outDistancesBuffer);
                                gl.getBufferSubData(gl.ARRAY_BUFFER, 0, outComputedDistances);
                                gl.bindBuffer(gl.ARRAY_BUFFER, null);

                                if (currentVao) gl.bindVertexArray(currentVao);

                                // console.timeEnd("gpu_compute_distances");

                                resolve();
                        }
                    }
                };
                this.computeDistancesOnGPUSyncTimeout = setTimeout(checkSync);
            });

            if (currentProgram && currentProgramDeleted !== true) gl.useProgram(currentProgram);
            if (currentVao) gl.bindVertexArray(currentVao);

            return promise;
        };

    }();

    /**
     * Given a global splat index, return corresponding local data (splat buffer, index of splat in that splat
     * buffer, and the corresponding transform)
     * @param {number} globalIndex Global splat index
     * @param {object} paramsObj Object in which to store local data
     * @param {boolean} returnSceneTransform By default, the transform of the scene to which the splat at 'globalIndex' belongs will be
     *                                       returned via the 'sceneTransform' property of 'paramsObj' only if the splat mesh is static.
     *                                       If 'returnSceneTransform' is true, the 'sceneTransform' property will always contain the scene
     *                                       transform, and if 'returnSceneTransform' is false, the 'sceneTransform' property will always
     *                                       be null.
     */
    getLocalSplatParameters(globalIndex, paramsObj, returnSceneTransform) {
        if (returnSceneTransform === undefined || returnSceneTransform === null) {
            returnSceneTransform = this.dynamicMode ? false : true;
        }
        paramsObj.splatBuffer = this.getSplatBufferForSplat(globalIndex);
        paramsObj.localIndex = this.getSplatLocalIndex(globalIndex);
        paramsObj.sceneTransform = returnSceneTransform ? this.getSceneTransformForSplat(globalIndex) : null;
    }

    /**
     * Fill arrays with splat data and apply transforms if appropriate. Each array is optional.
     * @param {Float32Array} covariances Target storage for splat covariances
     * @param {Float32Array} scales Target storage for splat scales
     * @param {Float32Array} rotations Target storage for splat rotations
     * @param {Float32Array} centers Target storage for splat centers
     * @param {Uint8Array} colors Target storage for splat colors
     * @param {Float32Array} sphericalHarmonics Target storage for spherical harmonics
     * @param {boolean} applySceneTransform By default, scene transforms are applied to relevant splat data only if the splat mesh is
     *                                      static. If 'applySceneTransform' is true, scene transforms will always be applied and if
     *                                      it is false, they will never be applied. If undefined, the default behavior will apply.
     * @param {number} covarianceCompressionLevel The compression level for covariances in the destination array
     * @param {number} sphericalHarmonicsCompressionLevel The compression level for spherical harmonics in the destination array
     * @param {number} srcStart The start location from which to pull source data
     * @param {number} srcEnd The end location from which to pull source data
     * @param {number} destStart The start location from which to write data
     */
    fillSplatDataArrays(covariances, scales, rotations, centers, colors, sphericalHarmonics, applySceneTransform,
                        covarianceCompressionLevel = 0, scaleRotationCompressionLevel = 0, sphericalHarmonicsCompressionLevel = 1,
                        srcStart, srcEnd, destStart = 0, sceneIndex) {
        const scaleOverride = new THREE.Vector3();
        scaleOverride.x = undefined;
        scaleOverride.y = undefined;
        if (this.splatRenderMode === SplatRenderMode.ThreeD) {
            scaleOverride.z = undefined;
        } else {
            scaleOverride.z = 1;
        }
        const tempTransform = new THREE.Matrix4();

        let startSceneIndex = 0;
        let endSceneIndex = this.scenes.length - 1;
        if (sceneIndex !== undefined && sceneIndex !== null && sceneIndex >= 0 && sceneIndex <= this.scenes.length) {
            startSceneIndex = sceneIndex;
            endSceneIndex = sceneIndex;
        }
        for (let i = startSceneIndex; i <= endSceneIndex; i++) {
            if (applySceneTransform === undefined || applySceneTransform === null) {
                applySceneTransform = this.dynamicMode ? false : true;
            }

            const scene = this.getScene(i);
            const splatBuffer = scene.splatBuffer;
            let sceneTransform;
            if (applySceneTransform) {
                this.getSceneTransform(i, tempTransform);
                sceneTransform = tempTransform;
            }
            if (covariances) {
                splatBuffer.fillSplatCovarianceArray(covariances, sceneTransform, srcStart, srcEnd, destStart, covarianceCompressionLevel);
            }
            if (scales || rotations) {
                if (!scales || !rotations) {
                    throw new Error('SplatMesh::fillSplatDataArrays() -> "scales" and "rotations" must both be valid.');
                }
                splatBuffer.fillSplatScaleRotationArray(scales, rotations, sceneTransform,
                                                        srcStart, srcEnd, destStart, scaleRotationCompressionLevel, scaleOverride);
            }
            if (centers) splatBuffer.fillSplatCenterArray(centers, sceneTransform, srcStart, srcEnd, destStart);
            if (colors) splatBuffer.fillSplatColorArray(colors, scene.minimumAlpha, srcStart, srcEnd, destStart);
            if (sphericalHarmonics) {
                splatBuffer.fillSphericalHarmonicsArray(sphericalHarmonics, this.minSphericalHarmonicsDegree,
                                                        sceneTransform, srcStart, srcEnd, destStart, sphericalHarmonicsCompressionLevel);
            }
            destStart += splatBuffer.getSplatCount();
        }
    }

    fillSplatCompressedTextureUVs(outUVArray, srcFrom, srcEnd, destStart) {
        let currentDest = destStart * 2;

        for (let i = srcFrom; i <= srcEnd; i++) {
            const localIndex = this.getSplatLocalIndex(i);
            const splatBuffer = this.getSplatBufferForSplat(i);
            const sectionIndex = splatBuffer.globalSplatIndexToSectionMap[localIndex];
            const section = splatBuffer.sections[sectionIndex];
            const inSectionIndex = localIndex - section.splatCountOffset;

            const compressionLevel = splatBuffer.compressionLevel;
            const shOffset = splatBuffer.constructor.CompressionLevels[compressionLevel].SphericalHarmonicsOffsetBytes;
            const baseOffset = section.dataBase + inSectionIndex * section.bytesPerSplat + shOffset;

            const dataView = new DataView(splatBuffer.bufferData, baseOffset, 8);
            const u = dataView.getUint32(0, true);
            const v = dataView.getUint32(4, true);

            outUVArray[currentDest] = u;
            outUVArray[currentDest + 1] = v;

            currentDest += 2;
        }
    }

    fillSplatASTCUVs(outUVArray, srcFrom, srcEnd, destStart) {
        return this.fillSplatCompressedTextureUVs(outUVArray, srcFrom, srcEnd, destStart);
    }

    fillDirectCompressedTextureDataArrays = function() {

        const scale = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        const tempMatrix4 = new THREE.Matrix4();
        const scaleMatrix = new THREE.Matrix3();
        const rotationMatrix = new THREE.Matrix3();
        const covarianceMatrix = new THREE.Matrix3();
        const transformedCovariance = new THREE.Matrix3();
        const toHalfFloat = THREE.DataUtils.toHalfFloat.bind(THREE.DataUtils);

        const writeCovariance = (scale, rotation, outCovariance, outOffset, desiredOutputCompressionLevel) => {
            tempMatrix4.makeScale(scale.x, scale.y, scale.z);
            scaleMatrix.setFromMatrix4(tempMatrix4);
            tempMatrix4.makeRotationFromQuaternion(rotation);
            rotationMatrix.setFromMatrix4(tempMatrix4);
            covarianceMatrix.copy(rotationMatrix).multiply(scaleMatrix);
            transformedCovariance.copy(covarianceMatrix).transpose().premultiply(covarianceMatrix);

            if (desiredOutputCompressionLevel >= 1) {
                outCovariance[outOffset] = toHalfFloat(transformedCovariance.elements[0]);
                outCovariance[outOffset + 1] = toHalfFloat(transformedCovariance.elements[3]);
                outCovariance[outOffset + 2] = toHalfFloat(transformedCovariance.elements[6]);
                outCovariance[outOffset + 3] = toHalfFloat(transformedCovariance.elements[4]);
                outCovariance[outOffset + 4] = toHalfFloat(transformedCovariance.elements[7]);
                outCovariance[outOffset + 5] = toHalfFloat(transformedCovariance.elements[8]);
            } else {
                outCovariance[outOffset] = transformedCovariance.elements[0];
                outCovariance[outOffset + 1] = transformedCovariance.elements[3];
                outCovariance[outOffset + 2] = transformedCovariance.elements[6];
                outCovariance[outOffset + 3] = transformedCovariance.elements[4];
                outCovariance[outOffset + 4] = transformedCovariance.elements[7];
                outCovariance[outOffset + 5] = transformedCovariance.elements[8];
            }
        };

        return function(fromSplat, toSplat, covarianceCompressionLevel = 0, scaleRotationCompressionLevel = 0) {
            if (!this.useCompressedTexture || this.dynamicMode || this.scenes.length !== 1) return false;

            const scene = this.scenes[0];
            if (scene.position.lengthSq() !== 0 ||
                scene.quaternion.x !== 0 || scene.quaternion.y !== 0 || scene.quaternion.z !== 0 || scene.quaternion.w !== 1 ||
                scene.scale.x !== 1 || scene.scale.y !== 1 || scene.scale.z !== 1) {
                return false;
            }

            const directData = scene.splatBuffer.directCompressedTextureData || scene.splatBuffer.directASTCData;
            if (!directData) return false;

            const covariances = this.splatDataTextures.baseData.covariances;
            const scales = this.splatDataTextures.baseData.scales;
            const rotations = this.splatDataTextures.baseData.rotations;
            const centers = this.splatDataTextures.baseData.centers;
            const colors = this.splatDataTextures.baseData.colors;
            const compressedTextureUVs = this.splatDataTextures.baseData.compressedTextureUVs;
            const directPositions = directData.positions;
            const directScales = directData.scales;
            const directRotations = directData.rotations;
            const directColors = directData.colors;
            const directCompressedTextureUVs = directData.uvs || directData.astcUVs;
            const directCovariances = directData.covariances;
            const scaleConversion = scaleRotationCompressionLevel >= 1 ? toHalfFloat : (v) => v;

            for (let i = fromSplat; i <= toSplat; i++) {
                const centerBase = i * 3;
                const rotationBase = i * 4;
                const uvBase = i * 2;
                const covarianceBase = i * 6;

                centers[centerBase] = directPositions[centerBase];
                centers[centerBase + 1] = directPositions[centerBase + 1];
                centers[centerBase + 2] = directPositions[centerBase + 2];

                scale.set(directScales[centerBase], directScales[centerBase + 1], directScales[centerBase + 2]);
                rotation.set(directRotations[rotationBase + 1],
                             directRotations[rotationBase + 2],
                             directRotations[rotationBase + 3],
                             directRotations[rotationBase]).normalize();
                const flip = rotation.w < 0 ? -1 : 1;

                if (scales) {
                    scales[centerBase] = scaleConversion(scale.x);
                    scales[centerBase + 1] = scaleConversion(scale.y);
                    scales[centerBase + 2] = scaleConversion(scale.z);
                }
                if (rotations) {
                    rotations[rotationBase] = scaleConversion(rotation.x * flip);
                    rotations[rotationBase + 1] = scaleConversion(rotation.y * flip);
                    rotations[rotationBase + 2] = scaleConversion(rotation.z * flip);
                    rotations[rotationBase + 3] = scaleConversion(rotation.w * flip);
                }

                colors[rotationBase] = directColors[rotationBase];
                colors[rotationBase + 1] = directColors[rotationBase + 1];
                colors[rotationBase + 2] = directColors[rotationBase + 2];
                colors[rotationBase + 3] = directColors[rotationBase + 3];

                compressedTextureUVs[uvBase] = directCompressedTextureUVs[uvBase];
                compressedTextureUVs[uvBase + 1] = directCompressedTextureUVs[uvBase + 1];

                if (directCovariances && covarianceCompressionLevel === 0) {
                    covariances.set(directCovariances.subarray(covarianceBase, covarianceBase + 6), covarianceBase);
                } else {
                    writeCovariance(scale, rotation, covariances, covarianceBase, covarianceCompressionLevel);
                }
            }

            return true;
        };

    }();

    fillDirectASTCDataArrays(...args) {
        return this.fillDirectCompressedTextureDataArrays(...args);
    }

    /**
     * Convert splat centers, which are floating point values, to an array of integers and multiply
     * each by 1000. Centers will get transformed as appropriate before conversion to integer.
     * @param {number} start The index at which to start retrieving data
     * @param {number} end The index at which to stop retrieving data
     * @param {boolean} padFour Enforce alignment of 4 by inserting a 1 after every 3 values
     * @return {Int32Array}
     */
    getIntegerCenters(start, end, padFour = false) {
        const splatCount = end - start + 1;
        const floatCenters = new Float32Array(splatCount * 3);
        this.fillSplatDataArrays(null, null, null, floatCenters, null, null, undefined, undefined, undefined, undefined, start);
        let intCenters;
        let componentCount = padFour ? 4 : 3;
        intCenters = new Int32Array(splatCount * componentCount);
        for (let i = 0; i < splatCount; i++) {
            for (let t = 0; t < 3; t++) {
                intCenters[i * componentCount + t] = Math.round(floatCenters[i * 3 + t] * 1000.0);
            }
            if (padFour) intCenters[i * componentCount + 3] = 1000;
        }
        return intCenters;
    }

    /**
     * Returns an array of splat centers, transformed as appropriate, optionally padded.
     * @param {number} start The index at which to start retrieving data
     * @param {number} end The index at which to stop retrieving data
     * @param {boolean} padFour Enforce alignment of 4 by inserting a 1 after every 3 values
     * @return {Float32Array}
     */
    getFloatCenters(start, end, padFour = false) {
        const splatCount = end - start + 1;
        const floatCenters = new Float32Array(splatCount * 3);
        this.fillSplatDataArrays(null, null, null, floatCenters, null, null, undefined, undefined, undefined, undefined, start);
        if (!padFour) return floatCenters;
        let paddedFloatCenters = new Float32Array(splatCount * 4);
        for (let i = 0; i < splatCount; i++) {
            for (let t = 0; t < 3; t++) {
                paddedFloatCenters[i * 4 + t] = floatCenters[i * 3 + t];
            }
            paddedFloatCenters[i * 4 + 3] = 1.0;
        }
        return paddedFloatCenters;
    }

    /**
     * Get the center for a splat, transformed as appropriate.
     * @param {number} globalIndex Global index of splat
     * @param {THREE.Vector3} outCenter THREE.Vector3 instance in which to store splat center
     * @param {boolean} applySceneTransform By default, if the splat mesh is static, the transform of the scene to which the splat at
     *                                      'globalIndex' belongs will be applied to the splat center. If 'applySceneTransform' is true,
     *                                      the scene transform will always be applied and if 'applySceneTransform' is false, the
     *                                      scene transform will never be applied. If undefined, the default behavior will apply.
     */
    getSplatCenter = function() {

        const paramsObj = {};

        return function(globalIndex, outCenter, applySceneTransform) {
            this.getLocalSplatParameters(globalIndex, paramsObj, applySceneTransform);
            paramsObj.splatBuffer.getSplatCenter(paramsObj.localIndex, outCenter, paramsObj.sceneTransform);
        };

    }();

    /**
     * Get the scale and rotation for a splat, transformed as appropriate.
     * @param {number} globalIndex Global index of splat
     * @param {THREE.Vector3} outScale THREE.Vector3 instance in which to store splat scale
     * @param {THREE.Quaternion} outRotation THREE.Quaternion instance in which to store splat rotation
     * @param {boolean} applySceneTransform By default, if the splat mesh is static, the transform of the scene to which the splat at
     *                                      'globalIndex' belongs will be applied to the splat scale and rotation. If
     *                                      'applySceneTransform' is true, the scene transform will always be applied and if
     *                                      'applySceneTransform' is false, the scene transform will never be applied. If undefined,
     *                                      the default behavior will apply.
     */
    getSplatScaleAndRotation = function() {

        const paramsObj = {};
        const scaleOverride = new THREE.Vector3();

        return function(globalIndex, outScale, outRotation, applySceneTransform) {
            this.getLocalSplatParameters(globalIndex, paramsObj, applySceneTransform);
            scaleOverride.x = undefined;
            scaleOverride.y = undefined;
            scaleOverride.z = undefined;
            if (this.splatRenderMode === SplatRenderMode.TwoD) scaleOverride.z = 0;
            paramsObj.splatBuffer.getSplatScaleAndRotation(paramsObj.localIndex, outScale, outRotation,
                                                           paramsObj.sceneTransform, scaleOverride);
        };

    }();

    /**
     * Get the color for a splat.
     * @param {number} globalIndex Global index of splat
     * @param {THREE.Vector4} outColor THREE.Vector4 instance in which to store splat color
     */
    getSplatColor = function() {

        const paramsObj = {};

        return function(globalIndex, outColor) {
            this.getLocalSplatParameters(globalIndex, paramsObj);
            paramsObj.splatBuffer.getSplatColor(paramsObj.localIndex, outColor);
        };

    }();

    /**
     * Store the transform of the scene at 'sceneIndex' in 'outTransform'.
     * @param {number} sceneIndex Index of the desired scene
     * @param {THREE.Matrix4} outTransform Instance of THREE.Matrix4 in which to store the scene's transform
     */
    getSceneTransform(sceneIndex, outTransform) {
        const scene = this.getScene(sceneIndex);
        scene.updateTransform(this.dynamicMode);
        outTransform.copy(scene.transform);
    }

    /**
     * Get the scene at 'sceneIndex'.
     * @param {number} sceneIndex Index of the desired scene
     * @return {SplatScene}
     */
    getScene(sceneIndex) {
        if (sceneIndex < 0 || sceneIndex >= this.scenes.length) {
            throw new Error('SplatMesh::getScene() -> Invalid scene index.');
        }
        return this.scenes[sceneIndex];
    }

    getSceneCount() {
        return this.scenes.length;
    }

    getSplatBufferForSplat(globalIndex) {
        const sceneIndex = this.implicitSingleSceneIndexMap ? 0 : this.globalSplatIndexToSceneIndexMap[globalIndex];
        return this.getScene(sceneIndex).splatBuffer;
    }

    getSceneIndexForSplat(globalIndex) {
        return this.implicitSingleSceneIndexMap ? 0 : this.globalSplatIndexToSceneIndexMap[globalIndex];
    }

    getSceneTransformForSplat(globalIndex) {
        const sceneIndex = this.implicitSingleSceneIndexMap ? 0 : this.globalSplatIndexToSceneIndexMap[globalIndex];
        return this.getScene(sceneIndex).transform;
    }

    getSplatLocalIndex(globalIndex) {
        return this.implicitSingleSceneIndexMap ? globalIndex : this.globalSplatIndexToLocalSplatIndexMap[globalIndex];
    }

    static getIntegerMatrixArray(matrix) {
        const matrixElements = matrix.elements;
        const intMatrixArray = [];
        for (let i = 0; i < 16; i++) {
            intMatrixArray[i] = Math.round(matrixElements[i] * 1000.0);
        }
        return intMatrixArray;
    }

    computeBoundingBox(applySceneTransforms = false, sceneIndex) {
        let splatCount = this.getSplatCount();
        if (sceneIndex !== undefined && sceneIndex !== null) {
            if (sceneIndex < 0 || sceneIndex >= this.scenes.length) {
                throw new Error('SplatMesh::computeBoundingBox() -> Invalid scene index.');
            }
            splatCount = this.scenes[sceneIndex].splatBuffer.getSplatCount();
        }

        const floatCenters = new Float32Array(splatCount * 3);
        this.fillSplatDataArrays(null, null, null, floatCenters, null, null, applySceneTransforms,
                                 undefined, undefined, undefined, undefined, sceneIndex);

        const min = new THREE.Vector3();
        const max = new THREE.Vector3();
        for (let i = 0; i < splatCount; i++) {
            const offset = i * 3;
            const x = floatCenters[offset];
            const y = floatCenters[offset + 1];
            const z = floatCenters[offset + 2];
            if (i === 0 || x < min.x) min.x = x;
            if (i === 0 || y < min.y) min.y = y;
            if (i === 0 || z < min.z) min.z = z;
            if (i === 0 || x > max.x) max.x = x;
            if (i === 0 || y > max.y) max.y = y;
            if (i === 0 || z > max.z) max.z = z;
        }

        return new THREE.Box3(min, max);
    }
}
