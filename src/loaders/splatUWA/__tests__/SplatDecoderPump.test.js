import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.self = {__UWA_SPLAT_DECODER_BOOTSTRAP__: true};
const {canPackNextShard} = await import('../SplatDecoder.worker.js');

const MAX_PENDING_PACKET_BYTES = 32 * 1024 * 1024;

function model(overrides = {}) {
    return {
        nextBlock: 0,
        blockCount: 4,
        packetQueue: [],
        packetQueueBytes: 0,
        maxPacketBytes: 1024,
        ...overrides
    };
}

test('pump admission stops waking when all packet slots are full', () => {
    assert.equal(canPackNextShard(model({
        packetQueue: [{}, {}]
    }), 2), false);
});

test('pump admission wakes while a packet slot and byte budget remain', () => {
    assert.equal(canPackNextShard(model({
        packetQueue: [{}], packetQueueBytes: 1024
    }), 2), true);
});

test('pump admission allows one oversize packet into an empty queue', () => {
    assert.equal(canPackNextShard(model({
        maxPacketBytes: MAX_PENDING_PACKET_BYTES + 1
    }), 2), true);
    assert.equal(canPackNextShard(model({
        packetQueue: [{}],
        packetQueueBytes: MAX_PENDING_PACKET_BYTES + 1,
        maxPacketBytes: MAX_PENDING_PACKET_BYTES + 1
    }), 2), false);
});

test('pump admission stops after every block has been packed', () => {
    assert.equal(canPackNextShard(model({
        nextBlock: 4
    }), 2), false);
});
