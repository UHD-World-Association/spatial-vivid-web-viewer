import argparse
import math
from pathlib import Path
import numpy as np
parser = argparse.ArgumentParser(description="Generate a compact sparse third-order SH probe PLY")
parser.add_argument("output", nargs="?", type=Path, default=Path("sh_probe.ply"))
out = parser.parse_args().output
# A compact cluster of large anisotropic Gaussians; DC is neutral gray and degree-3 terms are sparse and strong.
# SH layout follows encoder: f_dc RGB then f_rest channel-major, 15 coeffs/channel.
# Keep enough points to fill the encoder's minimum shard block while rendering as one compact blob.
point_offsets=[(-0.8 + 1.6 * x / 63.0, -0.8 + 1.6 * y / 63.0) for y in range(64) for x in range(64)]
normals=(0.0,0.0,1.0)
f_dc=(0.55,0.42,0.30)
f_rest=np.zeros(45,dtype=np.float32)
# Make every l=1..3 coefficient visibly non-zero, with per-channel variation.
for c in range(3):
    for j in range(15):
        order = 1 if j < 3 else (2 if j < 8 else 3)
        sign = -1.0 if ((c + j) % 3 == 0) else 1.0
        f_rest[c*15+j] = sign * (0.12 + 0.035 * order + 0.008 * ((c + j) % 5))
one=np.array([*normals,*f_dc,*f_rest,0.98, math.log(1.6 / (63.0 * 2.0)),math.log(1.6 / (63.0 * 2.0)),math.log(1.6 / (63.0 * 2.0)),1.,0.,0.,0.],dtype='<f4')
vals=np.concatenate([np.array([x,y,0.0],dtype='<f4') for x,y in point_offsets] + [one])
# Reorder to one contiguous record per point.
vals=np.concatenate([np.concatenate([np.array([x,y,0.0],dtype='<f4'), one]) for x,y in point_offsets])
props=['x','y','z','nx','ny','nz']+[f'f_dc_{i}' for i in range(3)]+[f'f_rest_{i}' for i in range(45)]+['opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3']
with out.open('wb') as f:
 f.write((f'ply\nformat binary_little_endian 1.0\nelement vertex {len(point_offsets)}\n'+''.join('property float '+p+'\n' for p in props)+'end_header\n').encode()); f.write(vals.tobytes())
print(out, len(vals), out.stat().st_size)
