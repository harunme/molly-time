import SwiftUI
import AVFoundation
import VisionKit

struct QRScannerView: View {
    let found: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var allowed = false
    @State private var checked = false
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            Group {
                if failure == nil && allowed && DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    Scanner(found: found, failed: { failure = $0 }).ignoresSafeArea(edges: .bottom)
                } else {
                    ContentUnavailableView("暂时无法使用相机", systemImage: "camera",
                        description: Text(failure ?? (checked ? "你可以关闭此页，手动输入电视上的四位绑定码。相机权限可在系统设置中开启。" : "正在请求相机权限…")))
                }
            }.mollyPageBackground().navigationTitle("扫描电视二维码").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        }.task { allowed = await AVCaptureDevice.requestAccess(for: .video); checked = true }
    }
}
private struct Scanner: UIViewControllerRepresentable {
    let found: (String) -> Void
    let failed: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(found: found, failed: failed) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false, isGuidanceEnabled: true, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        do { try scanner.startScanning() } catch { DispatchQueue.main.async { context.coordinator.failed("相机暂时不可用，请关闭此页并手动输入四位绑定码。") } }
        return scanner
    }
    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) { controller.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        var delivered = false
        let failed: (String) -> Void
        init(found: @escaping (String) -> Void, failed: @escaping (String) -> Void) { self.found = found; self.failed = failed }
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            failed("扫描已中断，请关闭此页并手动输入四位绑定码。")
        }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !delivered else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let value = barcode.payloadStringValue {
                    delivered = true; dataScanner.stopScanning(); found(value); return
                }
            }
        }
    }
}
