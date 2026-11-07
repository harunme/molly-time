import Foundation
import Network

/// Uses Apple's resolver so URLs, SNI, certificate verification, cookies and streaming remain
/// owned by URLSession/AVFoundation. No business IP addresses or certificate exceptions.
@MainActor
public final class OfficialDNS {
    public static let shared = OfficialDNS(probe: { await check($0) }, apply: apply, monitorNetwork: true)
    nonisolated static let resolverURLs = ["https://223.5.5.5/dns-query", "https://1.12.12.12/dns-query"]
    private let probe: @Sendable (Int) async -> Bool
    private let apply: @MainActor (Int?) -> Void
    private var monitor: NWPathMonitor?
    private var selection: Task<Void, Never>?
    private var generation = 0
    private var enabled = false
    private(set) var resolverIndex: Int?

    init(probe: @escaping @Sendable (Int) async -> Bool,
         apply: @escaping @MainActor (Int?) -> Void, monitorNetwork: Bool = false) {
        self.probe = probe; self.apply = apply
        if monitorNetwork {
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { [weak self] _ in
                Task { @MainActor [weak self] in self?.networkChanged() }
            }
            monitor.start(queue: DispatchQueue(label: "app.mollytime.dns"))
            self.monitor = monitor
        }
    }

    public static func manages(_ origin: URL) -> Bool {
        guard origin.scheme == "https", let host = origin.host?.lowercased() else { return false }
        return host == "mollytime.app" || host.hasSuffix(".mollytime.app")
    }

    /// The platform setting is process-wide. Restore the system resolver for custom servers,
    /// including private names on a user's LAN, rather than imposing public DNS on them.
    public func configure(for origin: URL) {
        let next = Self.manages(origin)
        guard enabled != next else { return }
        generation += 1; selection?.cancel(); selection = nil
        enabled = next
        setResolver(next ? 0 : nil)
        if next { select(preferred: 0) }
    }

    public func ready() async {
        while let pending = selection, !Task.isCancelled {
            let current = generation
            await pending.value
            if current == generation { return }
        }
    }

    /// Select another authenticated resolver without replaying the failed request itself.
    public func recover(for origin: URL) async -> Bool {
        guard enabled, Self.manages(origin) else { return false }
        let previous = resolverIndex
        if selection != nil {
            await ready()
            return previous != resolverIndex
        }
        generation += 1; selection?.cancel()
        select(preferred: previous == 0 ? 1 : 0)
        await ready()
        return previous != resolverIndex
    }

    func networkChanged() {
        guard enabled else { return }
        generation += 1; selection?.cancel()
        // Flush only this app's Network-framework context, not the user's DNS configuration.
        setResolver(0)
        select(preferred: 0)
    }

    private func setResolver(_ index: Int?) {
        resolverIndex = index; apply(index)
    }

    private func select(preferred: Int) {
        let current = generation, probe = probe
        selection = Task { [weak self] in
            for index in [preferred, 1 - preferred] {
                let reachable = await probe(index)
                guard let self, !Task.isCancelled, self.generation == current, self.enabled else { return }
                if reachable {
                    self.setResolver(index); self.selection = nil
                    return
                }
            }
            guard let self, !Task.isCancelled, self.generation == current, self.enabled else { return }
            // Networks may block public encrypted DNS. System DNS is a last availability path;
            // normal HTTPS still rejects an incorrectly routed server. Try DoH again on change.
            self.setResolver(nil); self.selection = nil
        }
    }

    /// Read-only requests may be retried once after resolver rotation. A timeout on POST/PUT
    /// does not establish whether the server accepted it; upload recovery owns that decision.
    static func mayRetry(_ request: URLRequest, after error: Error) -> Bool {
        guard ["GET", "HEAD"].contains(request.httpMethod ?? "GET"), let error = error as? URLError else { return false }
        return [.cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .timedOut,
                .networkConnectionLost, .secureConnectionFailed, .serverCertificateUntrusted,
                .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
                .serverCertificateNotYetValid].contains(error.code)
    }

    private static func apply(_ index: Int?) {
        if let index, let url = URL(string: resolverURLs[index]) {
            // These public resolver IP URLs have publicly trusted IP certificates. Using the
            // literal URL avoids bootstrapping a hostname through the broken local DNS cache.
            NWParameters.PrivacyContext.default.requireEncryptedNameResolution(true,
                fallbackResolver: .https(url, serverAddresses: [
                    .hostPort(host: NWEndpoint.Host(url.host!), port: 443)
                ]))
        } else {
            NWParameters.PrivacyContext.default.requireEncryptedNameResolution(false, fallbackResolver: nil)
        }
        NWParameters.PrivacyContext.default.flushCache()
    }

    nonisolated private static func check(_ index: Int) async -> Bool {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.httpShouldSetCookies = false; config.httpCookieStorage = nil
        config.urlCache = nil; config.timeoutIntervalForRequest = 2; config.timeoutIntervalForResource = 3
        let session = URLSession(configuration: config, delegate: DNSNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: URL(string: resolverURLs[index])!)
        request.httpMethod = "POST"
        request.setValue("application/dns-message", forHTTPHeaderField: "Content-Type")
        request.setValue("application/dns-message", forHTTPHeaderField: "Accept")
        // RFC 8484 health query: mollytime.app IN A. No account or device information.
        request.httpBody = Data([0x4d, 0x54, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 9]
            + Array("mollytime".utf8) + [3] + Array("app".utf8) + [0, 0, 1, 0, 1])
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200,
                  http.mimeType == "application/dns-message", (12...4096).contains(data.count) else { return false }
            return data[0] == 0x4d && data[1] == 0x54 && data[2] & 0x82 == 0x80 &&
                data[3] & 0x0f == 0 && (data[6] != 0 || data[7] != 0)
        } catch { return false }
    }
}

private final class DNSNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
