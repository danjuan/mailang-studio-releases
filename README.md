# 麦浪 studio for Apple Silicon

This tree contains the build inputs for `openreel-mac-3` from release revision `cf287f14138bfcc43510dc09273bc0e0756da95c`.
The desktop project derives from [PI-Desktop](https://github.com/vastsa/PI-Desktop).
Its repository license is in [LICENSE](LICENSE) with the incorporated [GNU GPL v3](COPYING.GPLv3).
Bundled third-party components retain their own notices and terms.

## Rebuild

On an Apple Silicon Mac with Xcode Command Line Tools, Rust, and Node.js 22.19 or later,
use the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
mkdir -p .cache/private-mac
cp third-party/ffmpeg-7.1.5.tar.xz .cache/private-mac/
pnpm run dist:private:mac 3
```

The build verifies the FFmpeg source hash, builds the CLI tools with the flags in
`scripts/build-openreel-decoder.sh` and creates the numbered DMG under `apps/desktop/release`.
The FFmpeg source archive includes its upstream notices and configuration sources.

## Bundled components

- The root pnpm and Cargo lockfiles identify desktop dependencies. Local Pi changes and File Manager changes are in `patches/`. The [File Manager provenance](apps/desktop/resources/plugins/pi.file-manager/UPSTREAM.md) records its upstream commit and patch sequence.
- OpenReel editor and adapter sources are in `vendor/openreel/`. To rebuild the checked-in plugin, install the editor workspace using its own pinned pnpm and frozen lockfile, run `pnpm run build:wasm` there, then run `node vendor/openreel/build.mjs <new-directory>` and `node vendor/openreel/sync-bundled.mjs --check <new-directory>` from this root. The [OpenReel notices](apps/desktop/resources/plugins/local.openreel-proof/THIRD-PARTY-NOTICES.txt) include the exact Mediabunny source archive and font licenses.
- Media Generation sources and the packer are in `vendor/pi-media-generation/`. Run `node apps/desktop/build/verify-bundled-media.cjs` to compare the runtime with its source. Official Enhancements view sources are under `apps/desktop/plugin-sources/`. The other bundled plugin entry points, resources and notices are in `apps/desktop/resources/`.
