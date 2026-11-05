import AVFoundation
import UniformTypeIdentifiers

/// Retain for the lifetime of the player item: AVAssetResourceLoader's delegate
/// is weak. All AVFoundation request state is confined to the main queue.
@MainActor
public final class CachedVideoAsset: NSObject, @preconcurrency AVAssetResourceLoaderDelegate {
    public let asset: AVURLAsset
    private let source: VideoRangeSource
    private let onUnsupportedRange: @MainActor () -> Void
    private let canReadAhead: @MainActor () -> Bool
    private var requests: [ObjectIdentifier: Task<Void, Never>] = [:]
    private var stopped = false

    public init(source: VideoRangeSource, canReadAhead: @escaping @MainActor () -> Bool = { true },
                onUnsupportedRange: @escaping @MainActor () -> Void) {
        self.source = source; self.onUnsupportedRange = onUnsupportedRange; self.canReadAhead = canReadAhead
        asset = AVURLAsset(url: URL(string: "molly-video://cache/video")!)
        super.init()
        asset.resourceLoader.setDelegate(self, queue: .main)
    }

    public func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                               shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
        guard !stopped else { return false }
        let id = ObjectIdentifier(request)
        requests[id] = Task { [weak self] in
            guard let self else { return }
            defer { self.requests[id] = nil }
            do {
                if let info = request.contentInformationRequest {
                    info.contentLength = source.descriptor.size
                    info.contentType = UTType(mimeType: source.descriptor.mime)?.identifier
                    info.isByteRangeAccessSupported = true
                }
                if let dataRequest = request.dataRequest {
                    var offset = max(dataRequest.requestedOffset, dataRequest.currentOffset)
                    let (requestedEnd, overflow) = dataRequest.requestedOffset.addingReportingOverflow(Int64(dataRequest.requestedLength))
                    guard offset >= 0, !overflow else { throw VideoRangeError.invalidResponse }
                    let end = dataRequest.requestsAllDataToEndOfResource ? source.descriptor.size : min(requestedEnd, source.descriptor.size)
                    var sentChunk = false
                    while offset < end {
                        try Task.checkCancellation()
                        // AVFoundation may ask for everything to EOF. Limit speculative
                        // read-ahead once the player has enough buffered video, while
                        // always allowing the first chunk of a new seek/metadata request.
                        while sentChunk && !canReadAhead() {
                            try await Task.sleep(for: .milliseconds(200))
                        }
                        let chunk = try await source.chunk(containing: offset)
                        try Task.checkCancellation()
                        guard !request.isCancelled, !stopped else { return }
                        let upper = min(end, chunk.range.upperBound)
                        dataRequest.respond(with: chunk.data.subdata(in: Int(offset - chunk.range.lowerBound)..<Int(upper - chunk.range.lowerBound)))
                        offset = upper; sentChunk = true
                    }
                }
                try Task.checkCancellation()
                if !request.isCancelled { request.finishLoading() }
            } catch is CancellationError {
                // AVFoundation owns cancelled requests; do not finish them twice.
            } catch {
                guard !Task.isCancelled, !request.isCancelled, !stopped else { return }
                request.finishLoading(with: error)
                if case VideoRangeError.rangeUnsupported = error { onUnsupportedRange() }
            }
        }
        return true
    }

    public func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel request: AVAssetResourceLoadingRequest) {
        requests.removeValue(forKey: ObjectIdentifier(request))?.cancel()
    }

    public func stop() {
        stopped = true
        requests.values.forEach { $0.cancel() }
        requests.removeAll()
        asset.resourceLoader.setDelegate(nil, queue: nil)
    }
}
