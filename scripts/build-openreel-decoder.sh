#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: sh scripts/build-openreel-decoder.sh <ffmpeg-7.1.5.tar.xz> <package-bin-dir>" >&2
  exit 2
fi

source_dir="$(CDPATH='' cd -- "$(dirname -- "$1")" && pwd)"
archive="$source_dir/$(basename -- "$1")"
mkdir -p "$2"
destination="$(CDPATH='' cd -- "$2" && pwd)"
printf '%s  %s\n' de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f "$archive" |
  shasum -a 256 -c

build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
tar -xJf "$archive" -C "$build"
mkdir "$build/out"
cd "$build/out"

# The tools receive only descriptors opened by the desktop host. No
# network protocol, external codec library, GPL component, or device is needed.
../ffmpeg-7.1.5/configure \
  --disable-autodetect --disable-everything --disable-doc --disable-network \
  --disable-ffplay --disable-avdevice --disable-x86asm \
  --enable-ffmpeg --enable-ffprobe --enable-static --disable-shared --enable-videotoolbox \
  --enable-protocol=fd,pipe --enable-demuxer=mov,matroska,mp3,wav \
  --enable-decoder=h264,hevc,vp8,vp9,aac,aac_latm,alac,ac3,eac3,flac,opus,vorbis,mp3,mp3float,pcm_u8,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le \
  --enable-encoder=h264_videotoolbox,aac,flac,pcm_f32le,pcm_s16le --enable-muxer=flac,mp4,pcm_f32le,wav \
  --enable-parser=h264,hevc,vp8,vp9,aac,aac_latm,opus,vorbis,mpegaudio,flac \
  --enable-filter=aformat,anull,aresample,atrim,format,hflip,null,rotate,scale,transpose,trim,vflip \
  --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb
make -j 8 ffmpeg ffprobe

./ffmpeg -hide_banner -protocols | grep -q '^  fd$'
./ffmpeg -hide_banner -muxers | grep -q ' f32le '
./ffmpeg -hide_banner -muxers | grep -q ' flac '
./ffmpeg -hide_banner -muxers | grep -q ' wav '
./ffmpeg -hide_banner -encoders | grep -q ' flac '
./ffmpeg -hide_banner -encoders | grep -q ' pcm_s16le '
./ffmpeg -hide_banner -encoders | grep -q ' h264_videotoolbox '
./ffprobe -hide_banner -protocols | grep -q '^  fd$'
install -m 755 ffmpeg "$destination/ffmpeg"
install -m 755 ffprobe "$destination/ffprobe"
install -m 644 "$archive" "$destination/ffmpeg-7.1.5.tar.xz"
install -m 644 ../ffmpeg-7.1.5/COPYING.LGPLv2.1 "$destination/FFmpeg-COPYING.LGPLv2.1"
# The desktop LGPLv3 license incorporates this GPLv3 text from the pinned archive.
install -m 644 ../ffmpeg-7.1.5/COPYING.GPLv3 "$destination/COPYING.GPLv3"
