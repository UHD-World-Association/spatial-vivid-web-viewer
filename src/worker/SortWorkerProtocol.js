export function initializeIdentityCandidate(target, count = target.length) {
    if (count < 0 || count > target.length) throw new RangeError('Identity candidate count exceeds its target.');
    for (let i = 0; i < count; i++) target[i] = i;
    return target;
}

export function reconstructTreeCandidate(target, packedIndexes, nodeOffsets, nodeCounts,
                                         orderedNodeIds, splatRenderCount) {
    if (splatRenderCount < 0 || splatRenderCount > target.length) {
        throw new RangeError('Tree candidate count exceeds its target.');
    }
    let destinationOffset = splatRenderCount;
    for (let i = 0; i < orderedNodeIds.length; i++) {
        const nodeId = orderedNodeIds[i];
        if (nodeId >= nodeOffsets.length || nodeId >= nodeCounts.length) {
            throw new RangeError(`Unknown sort tree node ${nodeId}.`);
        }
        const sourceOffset = nodeOffsets[nodeId];
        const nodeCount = nodeCounts[nodeId];
        if (sourceOffset + nodeCount > packedIndexes.length || nodeCount > destinationOffset) {
            throw new RangeError(`Invalid compact data for sort tree node ${nodeId}.`);
        }
        destinationOffset -= nodeCount;
        target.set(packedIndexes.subarray(sourceOffset, sourceOffset + nodeCount), destinationOffset);
    }
    if (destinationOffset !== 0) {
        throw new RangeError('Ordered sort tree nodes do not match the requested render count.');
    }
    return target.subarray(0, splatRenderCount);
}

export function createSortResultBufferPool(bufferByteLength, initialSize = 2) {
    const available = [];
    for (let i = 0; i < initialSize; i++) available.push(new ArrayBuffer(bufferByteLength));
    return {
        bufferByteLength,
        available,
        poolMissCount: 0,
        take() {
            if (this.available.length > 0) return this.available.pop();
            this.poolMissCount++;
            return new ArrayBuffer(this.bufferByteLength);
        },
        recycle(buffer) {
            if (buffer instanceof ArrayBuffer && buffer.byteLength >= this.bufferByteLength) {
                this.available.push(buffer);
                return true;
            }
            return false;
        }
    };
}

export function isSortGenerationCurrent(message, generation, treeGeneration) {
    return message.generation === generation && message.treeGeneration === treeGeneration;
}
