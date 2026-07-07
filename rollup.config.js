import { base64 } from "./util/import-base-64.js";
import terser from '@rollup/plugin-terser';
import url from '@rollup/plugin-url';

const globals = {
    'three': 'THREE'
};

const externalWasmArtifacts = [
    '**/splat_uwa_wasm.wasm',
    '**/splat_uwa_reconstruction_wasm.wasm'
];

const customWasmUrlPlugin = url({
    include: externalWasmArtifacts,
    limit: 0,
    fileName: '[name][extname]',
    destDir: 'build'
});

const standardWasmBase64Plugin = base64({
    include: ["**/*.wasm"],
    exclude: externalWasmArtifacts
});

export default [
    {
        input: './src/index.js',
        treeshake: false,
        external: [
            'three'
        ],
        output: [
            {
                name: 'Gaussian Splats 3D',
                extend: true,
                format: 'umd',
                file: './build/gaussian-splats-3d.umd.cjs',
                globals: globals,
                sourcemap: true
            },
            {
                name: 'Gaussian Splats 3D',
                extend: true,
                format: 'umd',
                file: './build/gaussian-splats-3d.umd.min.cjs',
                globals: globals,
                sourcemap: true,
                plugins: [terser()]
            }
        ],
        plugins: [
            customWasmUrlPlugin,
            standardWasmBase64Plugin
        ]
    },
    {
        input: './src/index.js',
        treeshake: false,
        external: [
            'three'
        ],
        output: [
            {
                name: 'Gaussian Splats 3D',
                format: 'esm',
                file: './build/gaussian-splats-3d.module.js',
                sourcemap: true
            },
            {
                name: 'Gaussian Splats 3D',
                format: 'esm',
                file: './build/gaussian-splats-3d.module.min.js',
                sourcemap: true,
                plugins: [terser()]
            }
        ],
        plugins: [
            customWasmUrlPlugin,
            standardWasmBase64Plugin
        ]
    }
];
