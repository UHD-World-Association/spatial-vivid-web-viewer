#!/usr/bin/env bash
set -euo pipefail

em++ -std=c++11 sorter_no_simd.cpp -Os -s WASM=1 -s SIDE_MODULE=2 -s IMPORTED_MEMORY=1 -o sorter_no_simd.wasm
