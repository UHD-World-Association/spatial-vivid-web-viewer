#!/usr/bin/env bash
set -euo pipefail

em++ -std=c++11 sorter.cpp -Os -s WASM=1 -s SIDE_MODULE=2 -s IMPORTED_MEMORY=1 -msimd128 -o sorter.wasm
