import SwiftUI
#if canImport(VisionKit)
import VisionKit
#endif

/// Scans the pairing QR shown on the computer's Remote Access screen and returns
/// a parsed `PairingPayload` (nil on cancel / unsupported device). Uses
/// VisionKit's DataScannerViewController (iOS 16+).
struct QRScannerView: View {
    let onResult: (PairingPayload?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("扫码配对")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { onResult(nil); dismiss() }
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        #if canImport(VisionKit)
        if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
            ScannerRepresentable { payload in
                onResult(payload)
                dismiss()
            }
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .top) {
                Text("对准电脑「远程访问」页面上的配对二维码")
                    .font(.footnote)
                    .padding(8)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
                    .padding()
            }
        } else {
            unsupported
        }
        #else
        unsupported
        #endif
    }

    private var unsupported: some View {
        VStack(spacing: 12) {
            Image(systemName: "qrcode.viewfinder").font(.largeTitle)
            Text("此设备不支持二维码扫描,请手动输入地址与令牌。")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#if canImport(VisionKit)
private struct ScannerRepresentable: UIViewControllerRepresentable {
    let onResult: (PairingPayload) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onResult: (PairingPayload) -> Void
        private var handled = false
        init(onResult: @escaping (PairingPayload) -> Void) { self.onResult = onResult }

        func dataScanner(_ scanner: DataScannerViewController, didAdd added: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !handled else { return }
            for item in added {
                if case let .barcode(code) = item,
                   let str = code.payloadStringValue,
                   let payload = PairingPayload.parse(str) {
                    handled = true
                    scanner.stopScanning()
                    onResult(payload)
                    return
                }
            }
        }
    }
}
#endif
