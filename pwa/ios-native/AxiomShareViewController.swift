import UIKit
import UniformTypeIdentifiers

final class AxiomShareViewController: UIViewController {
    private let appGroup = "group.com.axiom.mobile"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let label = UILabel()
        label.text = "Sending to Axiom…"
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
        Task { await collectAndFinish() }
    }

    private func collectAndFinish() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var textParts: [String] = []
        var sharedFiles: [String] = []
        let providers = items.flatMap { $0.attachments ?? [] }
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                if let value = try? await load(provider, type: UTType.url.identifier) as? URL {
                    textParts.append(value.absoluteString)
                    continue
                }
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                if let value = try? await load(provider, type: UTType.plainText.identifier) as? String {
                    textParts.append(value)
                    continue
                }
            }
            if provider.hasItemConformingToTypeIdentifier(UTType.item.identifier),
               let url = try? await load(provider, type: UTType.item.identifier) as? URL {
                if let destination = copySharedFile(url) { sharedFiles.append(destination) }
            }
        }
        let payload: [String: Any] = [
            "text": textParts.joined(separator: "\n"),
            "files": sharedFiles,
            "createdAt": ISO8601DateFormatter().string(from: Date())
        ]
        do {
            guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
                throw NSError(domain: "AxiomShare", code: 1, userInfo: [NSLocalizedDescriptionKey: "Shared app-group container is unavailable."])
            }
            let data = try JSONSerialization.data(withJSONObject: payload)
            try data.write(to: container.appendingPathComponent("AxiomSharedPayload.json"), options: .atomic)
            extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        } catch {
            extensionContext?.cancelRequest(withError: error)
        }
    }

    private func load(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding? {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: item) }
            }
        }
    }

    private func copySharedFile(_ source: URL) -> String? {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        let directory = container.appendingPathComponent("SharedFiles", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true, (values.fileSize ?? 0) <= 1_048_576 else { return nil }
            let destination = directory.appendingPathComponent(UUID().uuidString + "-" + source.lastPathComponent)
            try FileManager.default.copyItem(at: source, to: destination)
            return destination.path
        } catch { return nil }
    }
}
