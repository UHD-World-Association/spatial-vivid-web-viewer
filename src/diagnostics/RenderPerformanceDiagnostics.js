import * as THREE from 'three';

const SCHEMA = 'uwa.render.performance.diagnostic.v2';
const DEFAULT_WARMUP_FRAMES = 8;
const DEFAULT_SAMPLE_FRAMES = 60;
const DEFAULT_REPEATS = 2;
const MAX_PENDING_QUERIES = 8;

const clampInteger = (value, fallback, minimum, maximum) => {
  const number = Number(value);
  return Number.isFinite(number) ?
    Math.min(maximum, Math.max(minimum, Math.round(number))) :
    fallback;
};
const round = (value) =>
  Number.isFinite(value) ? Number(value.toFixed(3)) : null;

function getWebGLRendererInfo(gl) {
  let vendor = null;
  let renderer = null;
  let source = 'masked';
  try {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || null;
      renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || null;
      source = 'WEBGL_debug_renderer_info';
    }
    if (!vendor) vendor = gl.getParameter(gl.VENDOR) || null;
    if (!renderer) renderer = gl.getParameter(gl.RENDERER) || null;
  } catch (error) {
    source = 'unavailable';
  }
  const text = `${vendor || ''} ${renderer || ''}`.toLowerCase();
  const softwareRendererSuspected = /swiftshader|llvmpipe|software raster|software renderer|swrast/.test(text);
  return {vendor, renderer, source, softwareRendererSuspected};
}

export function summarizeSamples(values) {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  if (!sorted.length) {
return { count: 0, min: null, max: null, mean: null, p50: null, p95: null };
}
  const percentile = (fraction) => {
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return round(
      lower === upper ?
        sorted[lower] :
        sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower),
    );
  };
  return {
    count: sorted.length,
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

export function createEvenlySampledIndexes(source, requestedCount) {
  const count = Math.min(
    source.length,
    Math.max(0, Math.round(requestedCount)),
  );
  const output = new source.constructor(count);
  if (!count) return output;
  for (let i = 0; i < count; i++) {
output[i] = source[Math.floor((i * source.length) / count)];
}
  return output;
}

// Kept as the original public plan for integrations that display the legacy phase list.
export function createDiagnosticPhasePlan(originalDpr, shDegree) {
  const phases = [
    { id: 'B0', label: 'Baseline at original DPR', kind: 'baseline' },
  ];
  if (originalDpr > 1) {
phases.push({
      id: 'DPR1',
      label: 'Baseline at DPR 1',
      kind: 'dpr',
      dpr: 1,
    });
}
  phases.push(
    { id: 'B1', label: 'Baseline anchor', kind: 'baseline' },
    { id: 'V', label: 'Vertex only (rasterizer discard)', kind: 'vertex' },
    ...(shDegree > 0 ?
      [
          {
            id: 'V0',
            label: 'Vertex only with SH disabled',
            kind: 'vertex-sh0',
          },
        ] :
      []),
    { id: 'B2', label: 'Baseline anchor', kind: 'baseline' },
    { id: 'N', label: 'No blending', kind: 'no-blending' },
    {
      id: 'I50',
      label: '50% evenly sampled splats',
      kind: 'instances',
      fraction: 0.5,
    },
    {
      id: 'I25',
      label: '25% evenly sampled splats',
      kind: 'instances',
      fraction: 0.25,
    },
    { id: 'B3', label: 'Final baseline anchor', kind: 'baseline' },
  );
  return phases;
}

export function createDiagnosticPipelinePlan(
  originalDpr,
  repeats = DEFAULT_REPEATS,
  includeDepthOff = true,
) {
  const base = [
    {
      id: 'B_FULL',
      label: 'B_FULL',
      kind: 'baseline',
      intervention: 'full shader',
    },
    {
      id: 'F_CONST',
      label: 'F_CONST',
      kind: 'fragment-constant',
      intervention: 'constant low-alpha fragment',
    },
    {
      id: 'VERTEX_ONLY',
      label: 'VERTEX_ONLY',
      kind: 'vertex',
      intervention: 'rasterizer discard',
    },
    {
      id: 'INST50',
      label: 'INST50',
      kind: 'instances',
      fraction: 0.5,
      intervention: '50% instance count',
    },
    {
      id: 'SCISSOR25',
      label: 'SCISSOR25',
      kind: 'scissor',
      fraction: 0.25,
      intervention: '25% framebuffer scissor',
    },
    {
      id: 'SCISSOR50',
      label: 'SCISSOR50',
      kind: 'scissor',
      fraction: 0.5,
      intervention: '50% framebuffer scissor',
    },
    {
      id: 'SCISSOR100',
      label: 'SCISSOR100',
      kind: 'scissor',
      fraction: 1,
      intervention: 'full framebuffer scissor',
    },
  ];
  if (originalDpr > 1) {
base.splice(1, 0, {
      id: 'DPR1',
      label: 'DPR1',
      kind: 'dpr',
      dpr: 1,
      intervention: 'pixel ratio 1 lower bound',
    });
}
  if (includeDepthOff) {
base.push({
      id: 'DEPTH_OFF',
      label: 'DEPTH_OFF',
      kind: 'depth-off',
      intervention: 'depth test disabled',
    });
}
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const phase of base) {
plan.push({ ...phase, repeat, runId: `${phase.id}_R${repeat}` });
}
  }
  return plan;
}

function createFrameWaiter(canvas, gl) {
  let abortError = null;
  const pendingRejectors = new Set();
  const abort = (message) => {
    if (abortError) return;
    abortError = new Error(message);
    for (const reject of pendingRejectors) reject(abortError);
    pendingRejectors.clear();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
abort('Render diagnosis aborted because the page became hidden.');
}
  };
  const onContextLost = () =>
    abort('Render diagnosis aborted because the WebGL context was lost.');
  document.addEventListener('visibilitychange', onVisibilityChange);
  canvas?.addEventListener('webglcontextlost', onContextLost);
  onVisibilityChange();
  return {
    next() {
      if (abortError) return Promise.reject(abortError);
      return new Promise((resolve, reject) => {
        let settled = false;
        let rejectPending;
        const timeoutId = window.setTimeout(
          () =>
            abort(
              gl.isContextLost() ?
                'Render diagnosis aborted because the WebGL context was lost.' :
                'Render diagnosis aborted because animation frames stopped.',
            ),
          5000,
        );
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          pendingRejectors.delete(rejectPending);
          window.clearTimeout(timeoutId);
          callback(value);
        };
        rejectPending = (error) => finish(reject, error);
        pendingRejectors.add(rejectPending);
        requestAnimationFrame((time) => finish(resolve, time));
      });
    },
    dispose() {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      canvas?.removeEventListener('webglcontextlost', onContextLost);
      pendingRejectors.clear();
    },
  };
}

async function waitUntil(predicate, timeoutMs, waitForFrame) {
  const startedAt = performance.now();
  while (predicate()) {
    if (performance.now() - startedAt >= timeoutMs) return false;
    await waitForFrame();
  }
  return true;
}

function cameraSnapshot(camera) {
  return {
    type: camera?.isOrthographicCamera ? 'orthographic' : 'perspective',
    position: camera?.position?.toArray(),
    quaternion: camera?.quaternion?.toArray(),
    projectionMatrix: camera?.projectionMatrix?.toArray(),
    zoom: camera?.zoom,
  };
}
function cameraSignature(camera) {
  return JSON.stringify(cameraSnapshot(camera));
}
function getDimensions(renderer) {
  const logical = renderer.getSize(new THREE.Vector2());
  const rect = renderer.domElement?.getBoundingClientRect?.();
  const drawing = renderer.getDrawingBufferSize(new THREE.Vector2());
  const cssWidth =
    Number.isFinite(rect?.width) && rect.width > 0 ? rect.width : logical.x;
  const cssHeight =
    Number.isFinite(rect?.height) && rect.height > 0 ? rect.height : logical.y;
  return {
    css: { width: round(cssWidth), height: round(cssHeight) },
    drawing: { width: Math.round(drawing.x), height: Math.round(drawing.y) },
    drawingBufferPixels: Math.round(drawing.x) * Math.round(drawing.y),
  };
}

class TimerQueryCollector {
  constructor(gl) {
    this.gl = gl;
    this.extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.queries = [];
    this.disjointObserved = false;
    this.activeQuery = null;
    this.activeSample = null;
  }
  begin(sample) {
    if (
      !this.extension ||
      this.activeQuery ||
      this.pending.length >= MAX_PENDING_QUERIES
    ) {
return;
}
    const query = this.gl.createQuery();
    if (!query) return;
    this.queries.push(query);
    this.activeQuery = query;
    this.activeSample = sample;
    this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, query);
  }
  end() {
    if (!this.activeQuery) return;
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    this.pending.push({ query: this.activeQuery, sample: this.activeSample });
    this.activeQuery = null;
    this.activeSample = null;
  }
  poll() {
    if (!this.extension) return;
    if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
      this.disjointObserved = true;
      this.pending.length = 0;
      return;
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const item = this.pending[i];
      if (
        !this.gl.getQueryParameter(item.query, this.gl.QUERY_RESULT_AVAILABLE)
      ) {
continue;
}
      item.sample.gpuMs =
        this.gl.getQueryParameter(item.query, this.gl.QUERY_RESULT) / 1000000;
      this.pending.splice(i, 1);
    }
  }
  cancelActive() {
    if (!this.activeQuery) return;
    try {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
    } catch (_) {}
    this.activeQuery = null;
    this.activeSample = null;
  }
  deleteAll() {
    this.cancelActive();
    for (const query of this.queries) this.gl.deleteQuery(query);
    this.queries.length = 0;
    this.pending.length = 0;
  }
}

function createLongTaskObserver() {
  const state = { supported: false, count: 0, totalMs: 0, maxMs: 0 };
  if (typeof PerformanceObserver === 'undefined') return state;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.count++;
        state.totalMs += entry.duration;
        state.maxMs = Math.max(state.maxMs, entry.duration);
      }
    });
    observer.observe({ type: 'longtask', buffered: false });
    state.supported = true;
    state.observer = observer;
  } catch (_) {}
  return state;
}
function finishLongTaskObserver(state) {
  if (state.observer) {
    try {
      for (const entry of state.observer.takeRecords()) {
        state.count++;
        state.totalMs += entry.duration;
        state.maxMs = Math.max(state.maxMs, entry.duration);
      }
    } catch (_) {}
    state.observer.disconnect();
    delete state.observer;
  }
  return {
    supported: state.supported,
    count: state.count,
    totalMs: round(state.totalMs),
    maxMs: round(state.maxMs),
  };
}
function frameBuckets(values) {
  const buckets = { '16.7': 0, '33.3': 0, '50': 0, '66.7+': 0 };
  values.filter(Number.isFinite).forEach((value) => {
    if (value < 25) buckets['16.7']++;
    else if (value < 41.7) buckets['33.3']++;
    else if (value < 58.4) buckets['50']++;
    else buckets['66.7+']++;
  });
  return buckets;
}
function hasVisibleChildren(scene) {
  return !!scene?.children?.some((child) => child.visible);
}
function createConstantFragmentShader(source) {
  if (typeof source !== 'string') return null;
  const mainStart = source.indexOf('void main');
  const bodyStart = mainStart >= 0 ? source.indexOf('{', mainStart) : -1;
  const bodyEnd = source.lastIndexOf('}');
  if (bodyStart < 0 || bodyEnd <= bodyStart) return null;
  const supportExpression = source.includes('vGaussianSupportSquared') ?
    'vGaussianSupportSquared' : '8.0';
  const body = `{
                float A = dot(vPosition, vPosition);
                if (A > ${supportExpression}) discard;
                gl_FragColor = vec4(vColor.rgb, min(vColor.a, 0.01));
            }`;
  return `${source.slice(0, bodyStart)}${body}${source.slice(bodyEnd + 1)}`;
}

function createRasterProbeMaterial(originalMaterial) {
  const material = originalMaterial.clone();
  material.fragmentShader = `
    precision highp float;
    varying vec2 vPosition;
    void main() {
      float A = dot(vPosition, vPosition);
      if (A > 8.0) discard;
      gl_FragColor = vec4(1.0 / 255.0, 0.0, 0.0, 1.0);
    }
  `;
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.alphaTest = 0;
  material.needsUpdate = true;
  return material;
}

function measureRasterCoverageProxy(renderer, mesh, camera, gl) {
  const width = gl.drawingBufferWidth;
  const height = gl.drawingBufferHeight;
  if (!width || !height || !renderer.readRenderTargetPixels) return null;
  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.minFilter = THREE.NearestFilter;
  target.texture.magFilter = THREE.NearestFilter;
  target.texture.generateMipmaps = false;
  const probeMaterial = createRasterProbeMaterial(mesh.material);
  const originalMaterial = mesh.material;
  const originalTarget = renderer.getRenderTarget?.() || null;
  const originalAutoClear = renderer.autoClear;
  const scissorEnabled = gl.isEnabled(gl.SCISSOR_TEST);
  const scissorBox = Array.from(gl.getParameter(gl.SCISSOR_BOX));
  const pixels = new Uint8Array(width * height * 4);
  try {
    mesh.material = probeMaterial;
    renderer.setRenderTarget(target);
    renderer.setScissorTest(false);
    renderer.autoClear = true;
    renderer.clear(true, true, true);
    renderer.render(mesh, camera);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    let accumulatedByte = 0;
    let saturatedPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      accumulatedByte += pixels[i];
      if (pixels[i] >= 254) saturatedPixels++;
    }
    return {
      method: 'additive-rgba8-support-proxy',
      exact: false,
      note: 'Counts support fragments with per-pixel additive saturation at 255; ' +
        'it is a comparable lower-bound proxy, not a hardware invocation counter.',
      width,
      height,
      framebufferPixels: width * height,
      instanceCount: mesh.geometry.instanceCount,
      submittedVertexCount: mesh.geometry.instanceCount * 4,
      submittedTriangleCount: mesh.geometry.instanceCount * 2,
      accumulatedByte,
      saturatedPixels,
      saturationRatio: saturatedPixels / (width * height),
    };
  } catch (_) {
    return null;
  } finally {
    mesh.material = originalMaterial;
    renderer.autoClear = originalAutoClear;
    renderer.setRenderTarget(originalTarget);
    renderer.setScissorTest(scissorEnabled);
    renderer.setScissor(...scissorBox);
    probeMaterial.dispose();
    target.dispose();
  }
}

function metricFor(phase, useGpu) {
  return useGpu ? phase.gpuMs.p50 : phase.rafIntervalMs.p50;
}
function comparison(id, baseline, intervention, useGpu, approximation) {
  if (!baseline || !intervention) return null;
  const baselineValue = metricFor(baseline, useGpu);
    const interventionValue = metricFor(intervention, useGpu);
  if (!Number.isFinite(baselineValue) || !Number.isFinite(interventionValue)) {
return null;
}
  return {
    id,
    metric: useGpu ? 'gpuMs.p50' : 'rafIntervalMs.p50',
    confidence: useGpu ? 'medium' : 'low',
    baselinePhase: baseline.id,
    interventionPhase: intervention.id,
    baseline: baselineValue,
    intervention: interventionValue,
    difference: round(baselineValue - interventionValue),
    ratio: interventionValue ? round(baselineValue / interventionValue) : null,
    approximation,
  };
}

export function buildDiagnosticAnalysis(phases, timerAvailable, warnings = []) {
  const byId = Object.fromEntries(phases.map((phase) => [phase.id, phase]));
  const byLabel = (label) =>
    phases.find((phase) => phase.label === label || phase.baseId === label);
  const full = byLabel('B_FULL') || byId.B1 || byId.B2;
  const constant = byLabel('F_CONST');
  const vertex = byLabel('VERTEX_ONLY') || byId.V;
  const inst = byLabel('INST50') || byId.I50;
  const sc25 = byLabel('SCISSOR25');
  const sc50 = byLabel('SCISSOR50');
  const sc100 = byLabel('SCISSOR100');
  const depth = byLabel('DEPTH_OFF');
  const useGpu =
    !!timerAvailable &&
    phases.every(
      (phase) =>
        !phase.gpuMs || phase.gpuMs.p50 === null || phase.gpuMs.p50 > 0.01,
    ) &&
    phases.some((phase) => Number.isFinite(phase.gpuMs?.p50));
  const comparisons = [
    comparison(
      'F_CONST_vs_FULL',
      full,
      constant,
      useGpu,
      'Fragment arithmetic sensitivity; rAF includes browser scheduling.',
    ),
    comparison(
      'SCISSOR25/50/100',
      sc100,
      sc25,
      useGpu,
      'Coverage sensitivity across framebuffer area.',
    ),
    comparison(
      'SCISSOR50_vs_25',
      sc50,
      sc25,
      useGpu,
      'Coverage sensitivity between half and quarter framebuffer area.',
    ),
    comparison(
      'INST50_vs_FULL',
      full,
      inst,
      useGpu,
      'Per-instance sensitivity with fixed index order.',
    ),
    comparison(
      'VERTEX_ONLY_vs_F_CONST',
      constant,
      vertex,
      useGpu,
      'Directional raster/fragment boundary approximation.',
    ),
    comparison(
      'DEPTH_OFF_vs_FULL',
      full,
      depth,
      useGpu,
      'Depth-test sensitivity when splats are the only visible scene.',
    ),
    ...(!constant ?
      [
          comparison(
            'raster-fragment-blend',
            byId.B1,
            byId.V,
            useGpu,
            'Legacy combined raster, fragment, and blend work.',
          ),
        ] :
      []),
  ].filter(Boolean);
  if (!useGpu && timerAvailable) {
warnings.push(
      'GPU timer query samples were marked untrusted; comparisons use rAF intervals only.',
    );
}
  const inferences = comparisons.map((entry) => {
    const effectPercent =
      entry.baseline > 0 ? (entry.difference / entry.baseline) * 100 : 0;
    const finding =
      effectPercent >= 15 ?
        `The samples show material sensitivity for ${entry.id}.` :
        effectPercent <= -15 ?
        `The intervention was slower; ${entry.id} is inconclusive.` :
        `The samples show limited sensitivity for ${entry.id}.`;
    return {
      topic: entry.id,
      confidence: entry.confidence,
      finding,
      evidence: {
        metric: entry.metric,
        baseline: entry.baseline,
        intervention: entry.intervention,
        difference: entry.difference,
        effectPercent: round(effectPercent),
        ratio: entry.ratio,
      },
      interpretation: entry.approximation,
      caveat:
        'rAF is vsync-quantized and is not a hardware counter; GPU stages can overlap.',
    };
  });
  return { comparisons, inferences };
}

export async function runRenderPerformanceDiagnostic(viewer, options = {}) {
  if (
    !viewer?.initialized ||
    !viewer.splatRenderReady ||
    !viewer.splatMesh ||
    viewer.splatMesh.getSplatCount() <= 0
  ) {
    throw new Error(
      'Render diagnosis requires an initialized, render-ready splat scene.',
    );
  }
  if (
    !viewer.selfDrivenMode ||
    !viewer.selfDrivenModeRunning ||
    viewer.dropInMode ||
    viewer.usingExternalRenderer
  ) {
    throw new Error(
      'Render diagnosis requires a running self-driven Viewer with its own renderer.',
    );
  }
  if (
    viewer.webXRMode ||
    viewer.webXRActive ||
    viewer.renderer.xr?.isPresenting
  ) {
throw new Error('Render diagnosis is unavailable during WebXR rendering.');
}
  const renderer = viewer.renderer;
    const gl = renderer?.getContext();
  if (!gl || gl.isContextLost()) {
throw new Error('Render diagnosis requires an active WebGL context.');
}
  const warmupFrames = clampInteger(
    options.warmupFrames,
    DEFAULT_WARMUP_FRAMES,
    1,
    60,
  );
  const sampleFrames = clampInteger(
    options.sampleFrames,
    DEFAULT_SAMPLE_FRAMES,
    4,
    240,
  );
  const repeats = clampInteger(options.repeats, DEFAULT_REPEATS, 2, 3);
  const warnings = [];
    const frameWaiter = createFrameWaiter(renderer.domElement, gl);
  const emitProgress = (progress) => {
    try {
      options.onProgress?.(progress);
    } catch (_) {}
  };
  try {
    if (
      !(await waitUntil(
        () => viewer.sortRunning,
        clampInteger(options.sortTimeoutMs, 10000, 1000, 60000),
        frameWaiter.next,
      ))
    ) {
throw new Error(
        'Render diagnosis timed out waiting for the current splat sort.',
      );
}
    if (
      !(await waitUntil(
        () => viewer.splatMesh?.visibleRegionChanging,
        clampInteger(options.visibleRegionTimeoutMs, 5000, 250, 30000),
        frameWaiter.next,
      ))
    ) {
warnings.push('Visible-region animation did not settle before sampling.');
}
  } catch (error) {
    frameWaiter.dispose();
    throw error;
  }
  const mesh = viewer.splatMesh;
    const geometry = mesh.geometry;
    const originalMaterial = mesh.material;
    const indexAttribute = geometry?.attributes?.splatIndex;
  const originalInstanceCount = Math.min(
    geometry?.instanceCount || 0,
    indexAttribute?.count || 0,
  );
  if (
    !geometry ||
    !originalMaterial ||
    !indexAttribute?.array ||
    originalInstanceCount <= 0
  ) {
    frameWaiter.dispose();
    throw new Error('Render diagnosis could not access splat render data.');
  }
  const originalIndexes = indexAttribute.array.slice(0, originalInstanceCount);
    const originalSh =
      originalMaterial.uniforms?.sphericalHarmonicsDegree?.value ?? 0;
  const dimensions = getDimensions(renderer);
  const timer = new TimerQueryCollector(gl);
  const longTasks = createLongTaskObserver();
  const webglRendererInfo = getWebGLRendererInfo(gl);
  const includeDepthOff = !hasVisibleChildren(viewer.threeScene);
    const plan = createDiagnosticPipelinePlan(
      renderer.getPixelRatio(),
      repeats,
      includeDepthOff,
    );
  const report = {
    schema: SCHEMA,
    status: 'running',
    startedAt: new Date().toISOString(),
    environment: {
      userAgent:
        typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      platform:
        typeof navigator !== 'undefined' ? navigator.platform : 'unknown',
      hardwareConcurrency:
        typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null,
      crossOriginIsolated:
        typeof window !== 'undefined' ? !!window.crossOriginIsolated : false,
      timerQuery: timer.extension ? 'EXT_disjoint_timer_query_webgl2' : 'none',
      timerQueryStatus: timer.extension ? 'pending-validation' : 'unavailable',
      webglVendor: webglRendererInfo.vendor,
      webglRenderer: webglRendererInfo.renderer,
      webglRendererInfoSource: webglRendererInfo.source,
      softwareRendererSuspected: webglRendererInfo.softwareRendererSuspected,
      cssSize: dimensions.css,
      drawingSize: dimensions.drawing,
      drawingBufferPixels: dimensions.drawingBufferPixels,
      originalDpr: renderer.getPixelRatio(),
      viewport: {
        width: typeof window !== 'undefined' ? window.innerWidth : null,
        height: typeof window !== 'undefined' ? window.innerHeight : null,
      },
      framebuffer: {
        drawingBufferWidth: gl.drawingBufferWidth,
        drawingBufferHeight: gl.drawingBufferHeight,
        stencil: !!gl.getContextAttributes?.()?.stencil,
        stencilBits: gl.getParameter(gl.STENCIL_BITS),
      },
    },
    scene: {
      splatCount: mesh.getSplatCount(),
      renderCount: originalInstanceCount,
      completedSplatFrames: viewer.renderCount,
      currentFPS: viewer.currentFPS,
      camera: cameraSnapshot(viewer.camera),
      sphericalHarmonicsDegree: originalSh,
      texturePath: mesh.useCompressedTexture ?
        `compressed-gpu:${
            mesh.splatDataTextures?.compressedTexture?.format || 'unknown'
          }` :
        'standard-texture',
      covariancePath: originalMaterial.uniforms?.covariancesFromScaleRotation
        ?.value ?
        'scale-rotation-shader' :
        'covariance-texture',
    },
    sort: {
      lastSortTime: round(viewer.lastSortTime),
      lastSortMetrics: viewer.lastSortMetrics ?
        { ...viewer.lastSortMetrics } :
        null,
      splatRenderCount: viewer.splatRenderCount,
      splatSortCount: viewer.splatSortCount,
      sortRunning: viewer.sortRunning,
      workerGeneration: viewer.sortWorkerGeneration,
    },
    protocol: {
      warmupFrames,
      sampleFrames,
      repeats,
      maxPendingQueries: MAX_PENDING_QUERIES,
      queryPolicy: timer.extension ?
        'asynchronous non-blocking timer queries around splat draw only' :
        'CPU submit and rAF intervals only',
      phaseOrder: plan.map((phase) => phase.runId),
      deterministicOrder: true,
      cameraFixed: true,
      autoSortDisabled: true,
    },
    phases: [],
    comparisons: [],
    inferences: [],
    warnings,
    analysis: {
      pipeline: [],
      caveat: 'rAF is vsync-quantized and does not expose hardware counters.',
    },
    scheduling: null,
    restoration: { ok: false, mismatches: [] },
  };
  if (!timer.extension) {
warnings.push(
      'GPU timer queries are unavailable; conclusions use rAF intervals.',
    );
}
  const snapshot = {
    mesh,
    geometry,
    material: originalMaterial,
    rendererDpr: renderer.getPixelRatio(),
    viewerDpr: viewer.devicePixelRatio,
    meshDpr: mesh.devicePixelRatio,
    rendererSize: renderer.getSize(new THREE.Vector2()),
    blending: originalMaterial.blending,
    depthTest: originalMaterial.depthTest,
    sh: originalSh,
    beforeRender: mesh.onBeforeRender,
    afterRender: mesh.onAfterRender,
    instanceCount: geometry.instanceCount,
    drawRange: { ...geometry.drawRange },
    cameraSignature: cameraSignature(viewer.camera),
    cameraPosition: viewer.camera.position.clone(),
    cameraQuaternion: viewer.camera.quaternion.clone(),
    cameraUp: viewer.camera.up.clone(),
    cameraZoom: viewer.camera.zoom,
    cameraProjectionMatrix: viewer.camera.projectionMatrix.clone(),
    controlsEnabled: viewer.controls?.enabled,
    renderMode: viewer.renderMode,
    loopRunning: viewer.selfDrivenModeRunning,
    rasterizerDiscard: gl.isEnabled(gl.RASTERIZER_DISCARD),
    scissorEnabled: gl.isEnabled(gl.SCISSOR_TEST),
    scissorBox: gl.getParameter(gl.SCISSOR_BOX),
    autoClear: renderer.autoClear,
  };
  const constantShader = createConstantFragmentShader(
    originalMaterial.fragmentShader,
  );
  let constantMaterial = null;
  try {
    constantMaterial = constantShader ? originalMaterial.clone() : null;
    if (constantMaterial) {
      constantMaterial.fragmentShader = constantShader;
      constantMaterial.needsUpdate = true;
    }
  } catch (_) {
    constantMaterial = null;
  }
  if (!constantMaterial) {
warnings.push(
      'F_CONST variant could not be created; its phase will be skipped.',
    );
}
  let activeSample = null;
  mesh.onBeforeRender = function(...args) {
    snapshot.beforeRender?.apply(this, args);
    if (activeSample) timer.begin(activeSample);
  };
  mesh.onAfterRender = function(...args) {
    timer.end();
    snapshot.afterRender?.apply(this, args);
  };
  const restoreIndexes = () => {
    indexAttribute.array.set(originalIndexes, 0);
    indexAttribute.needsUpdate = true;
    geometry.instanceCount = snapshot.instanceCount;
    geometry.setDrawRange(snapshot.drawRange.start, snapshot.drawRange.count);
  };
  const setDpr = (dpr) => {
    renderer.setPixelRatio(dpr);
    renderer.setSize(snapshot.rendererSize.x, snapshot.rendererSize.y, false);
    viewer.devicePixelRatio = dpr;
    mesh.devicePixelRatio = dpr;
    viewer.updateSplatMesh();
  };
  const restoreGL = () => {
    if (snapshot.rasterizerDiscard) gl.enable(gl.RASTERIZER_DISCARD);
    else gl.disable(gl.RASTERIZER_DISCARD);
    if (snapshot.scissorEnabled) gl.enable(gl.SCISSOR_TEST);
    else gl.disable(gl.SCISSOR_TEST);
    gl.scissor(...snapshot.scissorBox);
  };
  const assertStable = () => {
    if (document.visibilityState === 'hidden' || gl.isContextLost()) {
throw new Error(
        'Render diagnosis aborted because page visibility or WebGL context changed.',
      );
}
    if (viewer.splatMesh !== mesh) {
throw new Error(
        'Render diagnosis aborted because the splat mesh generation changed.',
      );
}
    if (cameraSignature(viewer.camera) !== snapshot.cameraSignature) {
throw new Error('Render diagnosis aborted because the camera changed.');
}
  };
  const applyPhase = (phase) => {
    restoreIndexes();
    setDpr(snapshot.rendererDpr);
    restoreGL();
    mesh.material = originalMaterial;
    originalMaterial.depthTest = snapshot.depthTest;
    if (originalMaterial.uniforms?.sphericalHarmonicsDegree) {
originalMaterial.uniforms.sphericalHarmonicsDegree.value = snapshot.sh;
}
    if (phase.kind === 'dpr') setDpr(phase.dpr);
    if (phase.kind === 'fragment-constant' && constantMaterial) {
mesh.material = constantMaterial;
}
    if (phase.kind === 'vertex') gl.enable(gl.RASTERIZER_DISCARD);
    if (phase.kind === 'instances') {
      const count = Math.max(
        1,
        Math.floor(originalInstanceCount * phase.fraction),
      );
      indexAttribute.array.set(
        createEvenlySampledIndexes(originalIndexes, count),
        0,
      );
      indexAttribute.needsUpdate = true;
      geometry.instanceCount = count;
    }
    if (phase.kind === 'scissor') {
      const width = Math.max(
        1,
        Math.floor(gl.drawingBufferWidth * Math.sqrt(phase.fraction)),
      );
      const height = Math.max(
        1,
        Math.floor(gl.drawingBufferHeight * Math.sqrt(phase.fraction)),
      );
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, width, height);
    }
    if (phase.kind === 'depth-off') {
      originalMaterial.depthTest = false;
      originalMaterial.needsUpdate = true;
    }
    viewer.updateSplatMesh();
  };
  const samplePhase = async (phase) => {
    const resultBase = {
      id: phase.runId,
      baseId: phase.id,
      label: phase.label,
      intervention: phase.intervention,
      skipped: false,
      skipReason: null,
      warmup: warmupFrames,
      expectedSampleCount: sampleFrames,
      repeat: phase.repeat,
    };
    if (phase.kind === 'fragment-constant' && !constantMaterial) {
return {
        ...resultBase,
        skipped: true,
        skipReason: 'shader variant compilation source unavailable',
        actualSampleCount: 0,
        durationMs: 0,
      };
}
    applyPhase(phase);
    const samples = [];
      const frameTimes = [];
    let previousFrameTime = null;
    const started = performance.now();
    for (let frame = 0; frame < warmupFrames + sampleFrames; frame++) {
      const frameTime = await frameWaiter.next();
      assertStable();
      timer.poll();
      const sample = {
        rafIntervalMs:
          previousFrameTime === null ? null : frameTime - previousFrameTime,
        cpuSubmitMs: null,
        cpuUpdateMs: null,
        cpuRenderMs: null,
        gpuMs: null,
      };
      previousFrameTime = frameTime;
      activeSample = frame >= warmupFrames ? sample : null;
      const renderStart = performance.now();
      renderer.render(mesh, viewer.camera);
      const elapsed = performance.now() - renderStart;
      sample.cpuSubmitMs = elapsed;
      sample.cpuRenderMs = elapsed;
      activeSample = null;
      if (frame >= warmupFrames) {
        samples.push(sample);
        frameTimes.push(sample.rafIntervalMs);
      }
    }
    const drainStarted = performance.now();
    while (timer.pending.length && performance.now() - drainStarted < 2000) {
      await frameWaiter.next();
      timer.poll();
    }
    const phaseDimensions = getDimensions(renderer);
    const phaseScissor = Array.from(gl.getParameter(gl.SCISSOR_BOX));
    const scissorEnabled = gl.isEnabled(gl.SCISSOR_TEST);
    const scissorPixels = scissorEnabled ? phaseScissor[2] * phaseScissor[3] :
      phaseDimensions.drawingBufferPixels;
    return {
      ...resultBase,
      actualSampleCount: samples.length,
      durationMs: round(performance.now() - started),
      instanceCount: geometry.instanceCount,
      drawingBuffer: phaseDimensions.drawing,
      drawingBufferPixels: phaseDimensions.drawingBufferPixels,
      scissor: {
        enabled: scissorEnabled,
        box: phaseScissor,
      },
      workload: {
        instanceCount: geometry.instanceCount,
        submittedVertexCount: geometry.instanceCount * 4,
        submittedTriangleCount: geometry.instanceCount * 2,
        framebufferPixels: phaseDimensions.drawingBufferPixels,
        scissorPixels,
        fragmentInvocationCount: null,
        fragmentCountMethod: 'unavailable-in-webgl2',
      },
      materialVariant:
        phase.kind === 'fragment-constant' ? 'F_CONST' : 'B_FULL',
      blending: mesh.material.blending,
      depthTest: mesh.material.depthTest,
      rafIntervalMs: summarizeSamples(frameTimes),
      frameBuckets: frameBuckets(frameTimes),
      cpuSubmitMs: summarizeSamples(
        samples.map((sample) => sample.cpuSubmitMs),
      ),
      cpuRenderMs: summarizeSamples(
        samples.map((sample) => sample.cpuRenderMs),
      ),
      cpuUpdateMs: summarizeSamples(
        samples.map((sample) => sample.cpuUpdateMs),
      ),
      gpuMs: summarizeSamples(samples.map((sample) => sample.gpuMs)),
      gpuTrusted: false,
    };
  };
  try {
    viewer.stop();
    if (viewer.controls) viewer.controls.enabled = false;
    viewer.renderMode = 2;
    // One offscreen additive pass records a comparable support-fragment proxy.
    // WebGL2 has no portable hardware fragment invocation counter.
    report.rasterCoverageProxy = measureRasterCoverageProxy(renderer, mesh, viewer.camera, gl);
    for (const [index, phase] of plan.entries()) {
      emitProgress({
        state: 'running',
        phase: phase.runId,
        index: index + 1,
        total: plan.length,
        message: `Sampling ${phase.label} (${phase.repeat}/${repeats})…`,
      });
      report.phases.push(await samplePhase(phase));
    }
    const gpuValues = report.phases.flatMap((phase) =>
      phase.gpuMs?.p50 === null ? [] : [phase.gpuMs.p50],
    );
    const uniqueGpu = new Set(
      gpuValues.map((value) => Number(value.toFixed(4))),
    );
    const timerUntrusted =
      !timer.extension ||
      timer.disjointObserved ||
      gpuValues.some((value) => value <= 0.01) ||
      uniqueGpu.size <= 1;
    report.environment.timerQueryStatus = timerUntrusted ?
      'untrusted' :
      'trusted';
    if (timerUntrusted && timer.extension) {
warnings.push(
        'GPU timer output was invariant or <= 0.01 ms and is untrusted; rAF/CPU metrics are authoritative.',
      );
}
    report.phases.forEach((phase) => {
      phase.gpuTrusted = !timerUntrusted && !phase.skipped;
    });
    const analysis = buildDiagnosticAnalysis(
      report.phases,
      !timerUntrusted,
      warnings,
    );
    report.comparisons = analysis.comparisons;
    report.inferences = analysis.inferences;
    report.analysis.pipeline = analysis.inferences.map((entry) => ({
      topic: entry.topic,
      finding: entry.finding,
      metric: entry.evidence.metric,
      caveat: entry.caveat,
    }));
    report.status = 'complete';
  } catch (error) {
    report.status = /aborted/i.test(error?.message || '') ? 'aborted' : 'error';
    report.error = error?.message || String(error);
    warnings.push(report.error);
    const analysis = buildDiagnosticAnalysis(report.phases, false, warnings);
    report.comparisons = analysis.comparisons;
    report.inferences = analysis.inferences;
  } finally {
    activeSample = null;
    timer.cancelActive();
    mesh.material = originalMaterial;
    mesh.onBeforeRender = snapshot.beforeRender;
    mesh.onAfterRender = snapshot.afterRender;
    restoreIndexes();
    originalMaterial.blending = snapshot.blending;
    originalMaterial.depthTest = snapshot.depthTest;
    originalMaterial.needsUpdate = true;
    if (originalMaterial.uniforms?.sphericalHarmonicsDegree) {
originalMaterial.uniforms.sphericalHarmonicsDegree.value = snapshot.sh;
}
    viewer.camera.position.copy(snapshot.cameraPosition);
    viewer.camera.quaternion.copy(snapshot.cameraQuaternion);
    viewer.camera.up.copy(snapshot.cameraUp);
    viewer.camera.zoom = snapshot.cameraZoom;
    viewer.camera.projectionMatrix.copy(snapshot.cameraProjectionMatrix);
    viewer.camera.updateMatrixWorld(true);
    setDpr(snapshot.rendererDpr);
    viewer.devicePixelRatio = snapshot.viewerDpr;
    mesh.devicePixelRatio = snapshot.meshDpr;
    viewer.updateSplatMesh();
    restoreGL();
    renderer.autoClear = snapshot.autoClear;
    viewer.renderMode = snapshot.renderMode;
    if (viewer.controls && snapshot.controlsEnabled !== undefined) {
viewer.controls.enabled = snapshot.controlsEnabled;
}
    if (
      snapshot.loopRunning &&
      !viewer.selfDrivenModeRunning &&
      !viewer.isDisposingOrDisposed()
    ) {
viewer.start();
}
    timer.deleteAll();
    frameWaiter.dispose();
    report.scheduling = {
      longTasks: finishLongTaskObserver(longTasks),
      rafBuckets: Object.fromEntries(
        report.phases.map((phase) => [phase.id, phase.frameBuckets || {}]),
      ),
    };
    viewer.forceRenderNextFrame();
    const mismatches = report.restoration.mismatches;
    if (renderer.getPixelRatio() !== snapshot.rendererDpr) {
mismatches.push('renderer.devicePixelRatio');
}
    if (viewer.devicePixelRatio !== snapshot.viewerDpr) {
mismatches.push('viewer.devicePixelRatio');
}
    if (geometry.instanceCount !== snapshot.instanceCount) {
mismatches.push('geometry.instanceCount');
}
    if (mesh.material !== originalMaterial) {
mismatches.push('splatMesh.material');
}
    if (mesh.onBeforeRender !== snapshot.beforeRender) {
mismatches.push('splatMesh.onBeforeRender');
}
    if (mesh.onAfterRender !== snapshot.afterRender) {
mismatches.push('splatMesh.onAfterRender');
}
    if (cameraSignature(viewer.camera) !== snapshot.cameraSignature) {
mismatches.push('camera');
}
    if (gl.isEnabled(gl.RASTERIZER_DISCARD) !== snapshot.rasterizerDiscard) {
mismatches.push('gl.RASTERIZER_DISCARD');
}
    if (gl.isEnabled(gl.SCISSOR_TEST) !== snapshot.scissorEnabled) {
mismatches.push('gl.SCISSOR_TEST');
}
    report.restoration.ok = mismatches.length === 0;
    report.finishedAt = new Date().toISOString();
    emitProgress({
      state: report.status,
      message:
        report.status === 'complete' ? 'Diagnosis complete.' : report.error,
    });
    console.log('[UWA_RENDER_DIAGNOSTIC_JSON] ' + JSON.stringify(report));
  }
  return report;
}
