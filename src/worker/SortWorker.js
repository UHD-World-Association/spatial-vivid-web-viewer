import SorterWasm from './sorter.wasm';
import SorterWasmNoSIMD from './sorter_no_simd.wasm';
import { Constants } from '../Constants.js';
import {
    createSortResultBufferPool,
    initializeIdentityCandidate,
    isSortGenerationCurrent,
    reconstructTreeCandidate
} from './SortWorkerProtocol.js';

function sortWorker(self, helpers) {

    let wasmInstance;
    let wasmMemory;
    let integerBasedSort;
    let dynamicMode;
    let splatCount;
    let indexesToSortOffset;
    let sortedIndexesOffset;
    let sceneIndexesOffset;
    let transformsOffset;
    let precomputedDistancesOffset;
    let mappedDistancesOffset;
    let frequenciesOffset;
    let centersOffset;
    let modelViewProjOffset;
    let countsZero;
    let distanceMapRange;
    let uploadedSplatCount;
    let generation;
    let treeGeneration = 0;
    let treePool = null;
    let resultBufferPool = null;
    let protocolFallbackCount = 0;
    let Constants;

    const postSortFailure = (sortRequest, error) => {
        const message = {
            'sortError': true,
            'requestId': sortRequest?.requestId,
            'generation': sortRequest?.generation,
            'treeGeneration': sortRequest?.treeGeneration,
            'error': error?.message || String(error)
        };
        try {
            self.postMessage(message);
        } catch (_) {}
    };

    const fillCandidateIndexes = (sortRequest, indexesToSort, splatRenderCount) => {
        const assemblyStartTime = performance.now();
        let usedLegacyCandidate = false;
        if (sortRequest.indexesToSort) {
            const source = sortRequest.indexesToSort instanceof Uint32Array ?
                sortRequest.indexesToSort : new Uint32Array(sortRequest.indexesToSort);
            indexesToSort.set(source.subarray(0, splatRenderCount), 0);
            usedLegacyCandidate = true;
        } else if (sortRequest.candidateMode === 'tree') {
            if (!treePool || sortRequest.treeGeneration !== treeGeneration) {
                throw new Error('Compact sort tree data is unavailable for this generation.');
            }
            const orderedNodeIds = sortRequest.orderedNodeIds instanceof Uint32Array ?
                sortRequest.orderedNodeIds : new Uint32Array(sortRequest.orderedNodeIds);
            helpers.reconstructTreeCandidate(indexesToSort, treePool.packedIndexes, treePool.nodeOffsets,
                                             treePool.nodeCounts, orderedNodeIds, splatRenderCount);
        } else if (sortRequest.candidateMode !== 'identity') {
            throw new Error(`Unsupported sort candidate mode: ${sortRequest.candidateMode}.`);
        }
        return {
            'candidateAssemblyTime': performance.now() - assemblyStartTime,
            usedLegacyCandidate
        };
    };

    const postSortResult = (sortRequest, sortMessage, resultBuffer) => {
        sortMessage.sortedIndexesBuffer = resultBuffer;
        sortMessage.sortedIndexes = new Uint32Array(resultBuffer, 0, sortMessage.splatRenderCount);
        try {
            self.postMessage(sortMessage, [resultBuffer]);
        } catch (transferError) {
            protocolFallbackCount++;
            sortMessage.protocolFallbackCount = protocolFallbackCount;
            sortMessage.transferFallback = true;
            let fallbackBuffer = resultBuffer;
            if (fallbackBuffer.byteLength === 0) {
                fallbackBuffer = new ArrayBuffer(resultBufferPool.bufferByteLength);
                const sortedIndexes = new Uint32Array(wasmMemory, sortedIndexesOffset, sortMessage.splatRenderCount);
                new Uint32Array(fallbackBuffer, 0, sortMessage.splatRenderCount).set(sortedIndexes);
            }
            sortMessage.sortedIndexesBuffer = fallbackBuffer;
            sortMessage.sortedIndexes = new Uint32Array(fallbackBuffer, 0, sortMessage.splatRenderCount);
            try {
                self.postMessage(sortMessage);
                resultBufferPool.recycle(fallbackBuffer);
            } catch (fallbackError) {
                resultBufferPool.recycle(fallbackBuffer);
                postSortFailure(sortRequest, new Error(
                    `Unable to send sort result: ${transferError.message}; fallback failed: ${fallbackError.message}`
                ));
            }
        }
    };

    function sort(sortRequest, splatSortCount, splatRenderCount) {
        const sortStartTime = performance.now();
        const indexesToSort = new Uint32Array(wasmMemory, indexesToSortOffset, splatCount);
        const assemblyMetrics = fillCandidateIndexes(sortRequest, indexesToSort, splatRenderCount);

        if (dynamicMode) {
            const copyTransforms = sortRequest.transforms;
            if (!copyTransforms) throw new Error('Dynamic sorting requires scene transforms.');
            const transforms = new Float32Array(wasmMemory, transformsOffset,
                                                copyTransforms.byteLength / Constants.BytesPerFloat);
            transforms.set(copyTransforms);
        }
        if (sortRequest.usePrecomputedDistances) {
            const copyPrecomputedDistances = sortRequest.precomputedDistances;
            if (!copyPrecomputedDistances) throw new Error('GPU sorting requires precomputed distances.');
            let precomputedDistances;
            if (integerBasedSort) {
                precomputedDistances = new Int32Array(wasmMemory, precomputedDistancesOffset,
                                                      copyPrecomputedDistances.byteLength / Constants.BytesPerInt);
            } else {
                precomputedDistances = new Float32Array(wasmMemory, precomputedDistancesOffset,
                                                        copyPrecomputedDistances.byteLength / Constants.BytesPerFloat);
            }
            precomputedDistances.set(copyPrecomputedDistances);
        }

        if (!countsZero) countsZero = new Uint32Array(distanceMapRange);
        new Float32Array(wasmMemory, modelViewProjOffset, 16).set(sortRequest.modelViewProj);
        new Uint32Array(wasmMemory, frequenciesOffset, distanceMapRange).set(countsZero);
        const wasmSortStartTime = performance.now();
        wasmInstance.exports.sortIndexes(indexesToSortOffset, centersOffset, precomputedDistancesOffset,
                                         mappedDistancesOffset, frequenciesOffset, modelViewProjOffset,
                                         sortedIndexesOffset, sceneIndexesOffset, transformsOffset, distanceMapRange,
                                         splatSortCount, splatRenderCount, splatCount,
                                         sortRequest.usePrecomputedDistances, integerBasedSort, dynamicMode);
        const wasmSortTime = performance.now() - wasmSortStartTime;

        const outputCopyStartTime = performance.now();
        const resultBuffer = resultBufferPool.take();
        const sortedIndexes = new Uint32Array(wasmMemory, sortedIndexesOffset, splatRenderCount);
        new Uint32Array(resultBuffer, 0, splatRenderCount).set(sortedIndexes);
        const outputCopyTime = performance.now() - outputCopyStartTime;
        postSortResult(sortRequest, {
            'sortDone': true,
            'requestId': sortRequest.requestId,
            'generation': generation,
            'treeGeneration': treeGeneration,
            'splatSortCount': splatSortCount,
            'splatRenderCount': splatRenderCount,
            'sortTime': performance.now() - sortStartTime,
            'candidateAssemblyTime': assemblyMetrics.candidateAssemblyTime,
            'wasmSortTime': wasmSortTime,
            'outputCopyTime': outputCopyTime,
            'poolMissCount': resultBufferPool.poolMissCount,
            'protocolFallbackCount': protocolFallbackCount,
            'usedLegacyCandidate': assemblyMetrics.usedLegacyCandidate
        }, resultBuffer);
    }

    self.onmessage = (e) => {
        if (e.data.centers) {
            const centers = e.data.centers;
            const sceneIndexes = e.data.sceneIndexes;
            if (integerBasedSort) {
                new Int32Array(wasmMemory, centersOffset + e.data.range.from * Constants.BytesPerInt * 4,
                               e.data.range.count * 4).set(new Int32Array(centers));
            } else {
                new Float32Array(wasmMemory, centersOffset + e.data.range.from * Constants.BytesPerFloat * 4,
                                 e.data.range.count * 4).set(new Float32Array(centers));
            }
            if (dynamicMode) {
                new Uint32Array(wasmMemory, sceneIndexesOffset + e.data.range.from * 4,
                                e.data.range.count).set(new Uint32Array(sceneIndexes));
            }
            uploadedSplatCount = e.data.range.from + e.data.range.count;
        } else if (e.data.registerSortTree) {
            const registration = e.data.registerSortTree;
            try {
                const packedIndexes = new Uint32Array(registration.packedIndexes);
                const nodeOffsets = new Uint32Array(registration.nodeOffsets);
                const nodeCounts = new Uint32Array(registration.nodeCounts);
                if (nodeOffsets.length !== nodeCounts.length || packedIndexes.length > splatCount) {
                    throw new Error('Invalid compact sort tree dimensions.');
                }
                treePool = { packedIndexes, nodeOffsets, nodeCounts };
                treeGeneration = registration.treeGeneration;
                self.postMessage({
                    'sortTreeRegistered': true,
                    'generation': generation,
                    'treeGeneration': treeGeneration,
                    'nodeCount': nodeOffsets.length,
                    'indexCount': packedIndexes.length
                });
            } catch (error) {
                treePool = null;
                self.postMessage({
                    'sortTreeRegistrationError': true,
                    'generation': registration.generation,
                    'treeGeneration': registration.treeGeneration,
                    'error': error?.message || String(error)
                });
            }
        } else if (e.data.clearSortTree) {
            treePool = null;
            treeGeneration = e.data.clearSortTree.treeGeneration;
        } else if (e.data.recycleSortResult) {
            const recycled = e.data.recycleSortResult;
            if (recycled.generation === generation && resultBufferPool) {
                resultBufferPool.recycle(recycled.buffer);
            }
        } else if (e.data.sort) {
            const sortRequest = e.data.sort;
            const legacyRequest = sortRequest.indexesToSort && sortRequest.generation === undefined;
            if (!legacyRequest && !helpers.isSortGenerationCurrent(sortRequest, generation, treeGeneration)) {
                self.postMessage({
                    'sortCanceled': true,
                    'requestId': sortRequest.requestId,
                    'generation': sortRequest.generation,
                    'treeGeneration': sortRequest.treeGeneration
                });
                return;
            }
            const availableSplatCount = sortRequest.usePrecomputedDistances ? splatCount : uploadedSplatCount;
            const renderCount = Math.min(sortRequest.splatRenderCount || 0, availableSplatCount);
            const sortCount = Math.min(sortRequest.splatSortCount || 0, availableSplatCount);
            try {
                sort(sortRequest, sortCount, renderCount);
            } catch (error) {
                postSortFailure(sortRequest, error);
            }
        } else if (e.data.init) {
            // Yep, this is super hacky and gross :(
            Constants = e.data.init.Constants;

            splatCount = e.data.init.splatCount;
            integerBasedSort = e.data.init.integerBasedSort;
            dynamicMode = e.data.init.dynamicMode;
            distanceMapRange = e.data.init.distanceMapRange;
            generation = e.data.init.generation;
            treeGeneration = e.data.init.treeGeneration;
            uploadedSplatCount = 0;

            const CENTERS_BYTES_PER_ENTRY = integerBasedSort ? (Constants.BytesPerInt * 4) : (Constants.BytesPerFloat * 4);
            const sorterWasmBytes = new Uint8Array(e.data.init.sorterWasmBytes);
            const matrixSize = 16 * Constants.BytesPerFloat;
            const memoryRequiredForIndexesToSort = splatCount * Constants.BytesPerInt;
            const memoryRequiredForCenters = splatCount * CENTERS_BYTES_PER_ENTRY;
            const memoryRequiredForModelViewProjectionMatrix = matrixSize;
            const memoryRequiredForPrecomputedDistances = integerBasedSort ?
                                                          (splatCount * Constants.BytesPerInt) : (splatCount * Constants.BytesPerFloat);
            const memoryRequiredForMappedDistances = splatCount * Constants.BytesPerInt;
            const memoryRequiredForSortedIndexes = splatCount * Constants.BytesPerInt;
            const memoryRequiredForIntermediateSortBuffers = integerBasedSort ? (distanceMapRange * Constants.BytesPerInt * 2) :
                                                                                (distanceMapRange * Constants.BytesPerFloat * 2);
            const memoryRequiredforTransformIndexes = dynamicMode ? (splatCount * Constants.BytesPerInt) : 0;
            const memoryRequiredforTransforms = dynamicMode ? (Constants.MaxScenes * matrixSize) : 0;
            const extraMemory = Constants.MemoryPageSize * 32;

            const totalRequiredMemory = memoryRequiredForIndexesToSort + memoryRequiredForCenters +
                                        memoryRequiredForModelViewProjectionMatrix + memoryRequiredForPrecomputedDistances +
                                        memoryRequiredForMappedDistances + memoryRequiredForIntermediateSortBuffers +
                                        memoryRequiredForSortedIndexes + memoryRequiredforTransformIndexes +
                                        memoryRequiredforTransforms + extraMemory;
            const totalPagesRequired = Math.floor(totalRequiredMemory / Constants.MemoryPageSize ) + 1;
            const sorterWasmImport = {
                module: {},
                env: {
                    memory: new WebAssembly.Memory({
                        initial: totalPagesRequired,
                        maximum: totalPagesRequired
                    }),
                }
            };
            WebAssembly.compile(sorterWasmBytes)
            .then((wasmModule) => WebAssembly.instantiate(wasmModule, sorterWasmImport))
            .then((instance) => {
                wasmInstance = instance;
                indexesToSortOffset = 0;
                centersOffset = indexesToSortOffset + memoryRequiredForIndexesToSort;
                modelViewProjOffset = centersOffset + memoryRequiredForCenters;
                precomputedDistancesOffset = modelViewProjOffset + memoryRequiredForModelViewProjectionMatrix;
                mappedDistancesOffset = precomputedDistancesOffset + memoryRequiredForPrecomputedDistances;
                frequenciesOffset = mappedDistancesOffset + memoryRequiredForMappedDistances;
                sortedIndexesOffset = frequenciesOffset + memoryRequiredForIntermediateSortBuffers;
                sceneIndexesOffset = sortedIndexesOffset + memoryRequiredForSortedIndexes;
                transformsOffset = sceneIndexesOffset + memoryRequiredforTransformIndexes;
                wasmMemory = sorterWasmImport.env.memory.buffer;
                helpers.initializeIdentityCandidate(new Uint32Array(wasmMemory, indexesToSortOffset, splatCount), splatCount);
                resultBufferPool = helpers.createSortResultBufferPool(memoryRequiredForSortedIndexes, 2);
                self.postMessage({
                    'sortSetupPhase1Complete': true,
                    'generation': generation,
                    'treeGeneration': treeGeneration
                });
            })
            .catch((error) => postSortFailure(e.data.init, error));
        }
    };
}

export function createSortWorker(splatCount, enableSIMDInSort, integerBasedSort, dynamicMode,
                                 splatSortDistanceMapPrecision = Constants.DefaultSplatSortDistanceMapPrecision,
                                 generation = 0, treeGeneration = 0) {
    const workerSource = `(${sortWorker.toString()})(self, {
        initializeIdentityCandidate: ${initializeIdentityCandidate.toString()},
        reconstructTreeCandidate: ${reconstructTreeCandidate.toString()},
        createSortResultBufferPool: ${createSortResultBufferPool.toString()},
        isSortGenerationCurrent: ${isSortGenerationCurrent.toString()}
    })`;
    const worker = new Worker(
        URL.createObjectURL(new Blob([workerSource], { type: 'application/javascript' }))
    );

    const sourceWasm = enableSIMDInSort ? SorterWasm : SorterWasmNoSIMD;
    const sorterWasmBinaryString = atob(sourceWasm);
    const sorterWasmBytes = new Uint8Array(sorterWasmBinaryString.length);
    for (let i = 0; i < sorterWasmBinaryString.length; i++) {
        sorterWasmBytes[i] = sorterWasmBinaryString.charCodeAt(i);
    }

    worker.postMessage({
        'init': {
            'sorterWasmBytes': sorterWasmBytes.buffer,
            'splatCount': splatCount,
            'integerBasedSort': integerBasedSort,
            'dynamicMode': dynamicMode,
            'distanceMapRange': 1 << splatSortDistanceMapPrecision,
            'generation': generation,
            'treeGeneration': treeGeneration,
            // Super hacky
            'Constants': {
                'BytesPerFloat': Constants.BytesPerFloat,
                'BytesPerInt': Constants.BytesPerInt,
                'MemoryPageSize': Constants.MemoryPageSize,
                'MaxScenes': Constants.MaxScenes
            }
        }
    }, [sorterWasmBytes.buffer]);
    return worker;
}
