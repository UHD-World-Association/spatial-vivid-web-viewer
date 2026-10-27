import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Generated runtimes must not opt into resizable memory views: some mobile
// browsers implement the memory API but reject its views in TextDecoder.
for (const name of ['splat_uwa_wasm', 'splat_uwa_wasm_pthread', 'splat_uwa_reconstruction_wasm']) {
    test(`${name} does not request resizable memory views`, () => {
        const code = fs.readFileSync(new URL(`../${name}.js`, import.meta.url), 'utf8');
        assert.equal(/toResizableBuffer/.test(code), false, 'Runtime must not request resizable memory views');
    });
}

for (const [name, className, rejectEmpty] of [
    ['splat_uwa_wasm', 'SplatUWACoordinatorWasm', (api) => api.beginPrepare(0, 0, 0, false)],
    ['splat_uwa_reconstruction_wasm', 'SplatUWAReconstructionWasm', (api) => api.initialize(0, 0)]
]) {
    test(`${name} decodes long native error strings with a strict TextDecoder`, async () => {
        const NativeTextDecoder = globalThis.TextDecoder;
        let decodedStrings = 0;
        globalThis.TextDecoder = class extends NativeTextDecoder {
            decode(input, options) {
                const buffer = ArrayBuffer.isView(input) ? input.buffer : input;
                assert.notEqual(buffer?.resizable, true, 'TextDecoder received a resizable ArrayBuffer');
                decodedStrings++;
                return super.decode(input, options);
            }
        };
        let api;
        try {
            const {default: createModule} = await import(`../${name}.js`);
            const mod = await createModule({
                instantiateWasm(imports, receiveInstance) {
                    const compiled = new WebAssembly.Module(fs.readFileSync(new URL(`../${name}.wasm`, import.meta.url)));
                    const instance = new WebAssembly.Instance(compiled, imports);
                    receiveInstance(instance, compiled);
                    return instance.exports;
                }
            });
            assert.notEqual(mod.HEAPU8.buffer.resizable, true);
            api = new mod[className]();
            rejectEmpty(api);
            const error = api.getLastError();
            assert.ok(error.length > 16, 'Exercise the TextDecoder fast path, not the short-string fallback');
            assert.ok(decodedStrings > 0);
            if (name === 'splat_uwa_reconstruction_wasm') {
                const previousSize = mod.HEAPU8.byteLength;
                const ptr = mod._malloc(previousSize + 1);
                assert.notEqual(ptr, 0);
                assert.ok(mod.HEAPU8.byteLength > previousSize, 'Memory growth remains enabled');
                assert.notEqual(mod.HEAPU8.buffer.resizable, true);
                assert.equal(api.getLastError(), error);
                mod._free(ptr);
            }
        } finally {
            api?.delete();
            globalThis.TextDecoder = NativeTextDecoder;
        }
    });
}
