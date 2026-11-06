#include "texture_transcoder.h"
#include <vector>
#include <array>
#include <iostream>
#include <cmath>
#include <stdexcept>

static void check(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
static std::array<int,3> color(unsigned x, unsigned y) {
    return {32 + int(x % 4)*48, 48 + int(y % 3)*64, 160};
}
static std::array<int,3> rgb565(unsigned value) {
    return {int(((value>>11)&31)*255/31), int(((value>>5)&63)*255/63), int((value&31)*255/31)};
}
int main() {
    try {
        for (unsigned side : {4u,6u,8u,12u}) {
            const unsigned width=29, height=23;
            unsigned nx=(width+side-1)/side, ny=(height+side-1)/side;
            std::vector<uint8_t> astc(16+nx*ny*16,0);
            astc[0]=0x13; astc[1]=0xab; astc[2]=0xa1; astc[3]=0x5c;
            astc[4]=astc[5]=side; astc[6]=1; astc[7]=width; astc[10]=height; astc[13]=1;
            for(unsigned y=0;y<ny;y++) for(unsigned x=0;x<nx;x++) {
                auto p=astc.data()+16+(y*nx+x)*16;
                // LDR void-extent ASTC block, constant UNORM16 RGBA.
                p[0]=0xfc; p[1]=0xfd;
                for(int i=2;i<8;i++) p[i]=0xff;
                auto c=color(x,y);
                for(int i=0;i<4;i++) { unsigned v=(i==3?255:c[i])*257; p[8+i*2]=v&255; p[9+i*2]=v>>8; }
            }
            for(auto format : {BcTextureFormat::BC3,BcTextureFormat::BC7}) {
                BcTranscodeResult result; std::string error;
                check(transcodeAstcToBc(astc,format,result,error),error.c_str());
                const unsigned bx=(width+3)/4, by=(height+3)/4;
                check(result.data.size()==bx*by*16,"Wrong BC byte count");
                for(unsigned b=0;b<bx*by;b++) {
                    bool nonzero=false;
                    for(int k=0;k<16;k++) nonzero|=result.data[b*16+k]!=0;
                    check(nonzero,"Unwritten BC block");
                }
                if(format==BcTextureFormat::BC3) {
                    // Decode RGB at every pixel, checking row stride, full coverage and edge blocks.
                    for(unsigned y=0;y<height;y++) for(unsigned x=0;x<width;x++) {
                        const auto p=result.data.data()+((y/4)*bx+x/4)*16;
                        auto c0=rgb565(p[8]|(p[9]<<8)), c1=rgb565(p[10]|(p[11]<<8));
                        unsigned bits=p[12]|(unsigned(p[13])<<8)|(unsigned(p[14])<<16)|(unsigned(p[15])<<24);
                        unsigned index=(bits>>(2*((y%4)*4+x%4)))&3;
                        auto expected=color(x/side,y/side);
                        for(int c=0;c<3;c++) {
                            int actual=index==0?c0[c]:index==1?c1[c]:index==2?(2*c0[c]+c1[c])/3:(c0[c]+2*c1[c])/3;
                            // A 6x6 ASTC boundary can cross a BC block in both axes.
                            check(std::abs(actual-expected[c]) <= (side==6?70:12),"BC pixel color/position mismatch");
                        }
                    }
                }
            }
            std::cout << "PASS ASTC " << side << "x" << side << " -> BC3/BC7, partial edges and full coverage\n";
        }
    } catch(const std::exception& e) { std::cerr << e.what()<<'\n'; return 1; }
}
