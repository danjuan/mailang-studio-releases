import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

private let byteLimit: Int64 = 128 * 1024 * 1024

private enum VideoError: Error {
    case invalidInput, cannotExport
}

private struct Clip {
    let asset: AVURLAsset
    let video: AVAssetTrack
    let audio: AVAssetTrack?
    let range: CMTimeRange
    let transform: CGAffineTransform
    let display: CGRect
}

private func localFile(_ path: String) throws -> URL {
    guard path.hasPrefix("/") else { throw VideoError.invalidInput }
    let url = URL(fileURLWithPath: path)
    let info = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard info.isRegularFile == true, info.isSymbolicLink != true,
          let bytes = info.fileSize, bytes > 0, Int64(bytes) <= byteLimit else {
        throw VideoError.invalidInput
    }
    return url
}

private func localAsset(_ path: String) throws -> AVURLAsset {
    AVURLAsset(url: try localFile(path), options: [
        AVURLAssetPreferPreciseDurationAndTimingKey: true,
        AVURLAssetReferenceRestrictionsKey: AVAssetReferenceRestrictions.forbidAll.rawValue
    ])
}

private func loadClip(_ path: String) async throws -> Clip {
    let asset = try localAsset(path)
    let duration = try await asset.load(.duration)
    guard duration.seconds.isFinite, duration.seconds >= 0.05, duration.seconds <= 16,
          let video = try await asset.loadTracks(withMediaType: .video).first else {
        throw VideoError.invalidInput
    }
    let range = try await video.load(.timeRange)
    let transform = try await video.load(.preferredTransform)
    let size = try await video.load(.naturalSize)
    let display = CGRect(origin: .zero, size: size).applying(transform).standardized
    let seconds = range.duration.seconds
    guard range.start.seconds.isFinite, range.start.seconds >= 0, seconds.isFinite, seconds >= 0.05,
          range.end.seconds <= 16, display.width >= 2, display.height >= 2,
          display.width <= 4096, display.height <= 4096 else {
        throw VideoError.invalidInput
    }
    let audio = try await asset.loadTracks(withMediaType: .audio).first
    return Clip(asset: asset, video: video, audio: audio, range: range, transform: transform, display: display)
}

private func outputFile(_ path: String) throws -> URL {
    guard path.hasPrefix("/"), !FileManager.default.fileExists(atPath: path) else {
        throw VideoError.invalidInput
    }
    return URL(fileURLWithPath: path)
}

private func writeTail(_ clip: Clip, to destination: URL) throws {
    let generator = AVAssetImageGenerator(asset: clip.asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1024, height: 1024)
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.5, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = .zero
    let time = CMTimeSubtract(clip.range.end, CMTime(value: 1, timescale: 600))
    let image = try generator.copyCGImage(at: time, actualTime: nil)
    guard image.width >= 256, image.height >= 256,
          let output = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw VideoError.cannotExport
    }
    let options = [kCGImageDestinationLossyCompressionQuality: 0.84] as CFDictionary
    CGImageDestinationAddImage(output, image, options)
    guard CGImageDestinationFinalize(output),
          (try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) <= 1024 * 1024 else {
        throw VideoError.cannotExport
    }
}

private func renderSize(for display: CGRect) -> CGSize {
    let scale = min(1, 2048 / max(display.width, display.height))
    return CGSize(width: max(2, floor(display.width * scale / 2) * 2),
                  height: max(2, floor(display.height * scale / 2) * 2))
}

private func transform(_ clip: Clip, into canvas: CGSize) -> CGAffineTransform {
    let factor = min(canvas.width / clip.display.width, canvas.height / clip.display.height)
    let x = (canvas.width - clip.display.width * factor) / 2
    let y = (canvas.height - clip.display.height * factor) / 2
    return clip.transform
        .concatenating(CGAffineTransform(translationX: -clip.display.minX, y: -clip.display.minY))
        .concatenating(CGAffineTransform(scaleX: factor, y: factor))
        .concatenating(CGAffineTransform(translationX: x, y: y))
}

private func addAudio(from clip: Clip, to output: AVMutableCompositionTrack, at cursor: CMTime) async throws {
    guard let audio = clip.audio else { return }
    let source = try await audio.load(.timeRange)
    let common = CMTimeRangeGetIntersection(clip.range, otherRange: source)
    guard common.isValid, !common.isEmpty else { return }
    let start = CMTimeAdd(cursor, CMTimeSubtract(common.start, clip.range.start))
    try output.insertTimeRange(common, of: audio, at: start)
}

private func stitch(_ clips: [Clip], to destination: URL) async throws {
    guard let first = clips.first else { throw VideoError.invalidInput }
    let composition = AVMutableComposition()
    guard let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid),
          let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw VideoError.cannotExport
    }
    let canvas = renderSize(for: first.display)
    var cursor = CMTime.zero
    var instructions: [AVVideoCompositionInstructionProtocol] = []
    for clip in clips {
        try video.insertTimeRange(clip.range, of: clip.video, at: cursor)
        try await addAudio(from: clip, to: audio, at: cursor)
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: cursor, duration: clip.range.duration)
        instruction.backgroundColor = CGColor(gray: 0, alpha: 1)
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: video)
        layer.setTransform(transform(clip, into: canvas), at: cursor)
        instruction.layerInstructions = [layer]
        instructions.append(instruction)
        cursor = CMTimeAdd(cursor, clip.range.duration)
    }
    guard cursor.seconds.isFinite, cursor.seconds > 0, cursor.seconds <= 192 else {
        throw VideoError.invalidInput
    }
    if audio.segments.allSatisfy({ $0.isEmpty }) { composition.removeTrack(audio) }
    let rendering = AVMutableVideoComposition()
    rendering.renderSize = canvas
    rendering.frameDuration = CMTime(value: 1, timescale: 30)
    rendering.instructions = instructions

    guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality),
          export.supportedFileTypes.contains(.mp4) else {
        throw VideoError.cannotExport
    }
    export.outputURL = destination
    export.outputFileType = .mp4
    export.videoComposition = rendering
    export.timeRange = CMTimeRange(start: .zero, duration: cursor)
    export.shouldOptimizeForNetworkUse = true
    export.fileLengthLimit = byteLimit
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        export.exportAsynchronously { done.resume() }
    }
    guard export.status == .completed else { throw VideoError.cannotExport }

    let result = try localAsset(destination.path)
    let duration = try await result.load(.duration)
    let valid = abs(duration.seconds - cursor.seconds) <= 0.15
    guard valid, !((try? await result.loadTracks(withMediaType: .video)) ?? []).isEmpty else {
        throw VideoError.cannotExport
    }
}

@main
private struct SessionMediaVideo {
    static func main() async {
        do {
            let args = Array(CommandLine.arguments.dropFirst())
            guard args.count >= 3 else { throw VideoError.invalidInput }
            let destination = try outputFile(args[1])
            let paths = Array(args.dropFirst(2))
            switch args[0] {
            case "tail" where paths.count == 1:
                try writeTail(await loadClip(paths[0]), to: destination)
            case "stitch" where (2...12).contains(paths.count):
                var clips: [Clip] = []
                for path in paths { clips.append(try await loadClip(path)) }
                try await stitch(clips, to: destination)
            default:
                throw VideoError.invalidInput
            }
        } catch {
            // Only the parent sees a bounded error. AVFoundation can report local file paths.
            FileHandle.standardError.write(Data("Session media conversion failed.\n".utf8))
            exit(1)
        }
    }
}
