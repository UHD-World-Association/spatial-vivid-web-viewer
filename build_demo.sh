source ~/mylibs/emsdk/emsdk_env.sh

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
