import Foundation
import Capacitor
import AVFoundation
import Speech
import UniformTypeIdentifiers
import UIKit
import Security

@objc(AxiomIOSPlugin)
public class AxiomIOSPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "AxiomIOSPlugin"
    public let jsName = "AxiomSecureStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickDocuments", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeSharedPayload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startSpeech", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeech", returnType: CAPPluginReturnPromise)
    ]

    private let service = "com.axiom.mobile.credentials"
    private let appGroup = "group.com.axiom.mobile"
    private var documentPickerCall: CAPPluginCall?
    private var audioEngine: AVAudioEngine?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?

    private func credentialQuery(namespace: String, key: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service + "." + namespace,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: false
        ]
        return query
    }

    private func validName(_ value: String) -> Bool {
        return value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", options: .regularExpression) != nil
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let namespace = call.getString("namespace"), let key = call.getString("key"),
              validName(namespace), validName(key) else {
            call.reject("Invalid credential namespace or key.")
            return
        }
        var query = credentialQuery(namespace: namespace, key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Could not read the credential from iOS Keychain. OSStatus: \(status)")
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let namespace = call.getString("namespace"), let key = call.getString("key"),
              let value = call.getString("value"), validName(namespace), validName(key),
              value.utf8.count <= 65536 else {
            call.reject("Invalid credential request or value exceeds 64 KiB.")
            return
        }
        let query = credentialQuery(namespace: namespace, key: key)
        let data = Data(value.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        let finalStatus: OSStatus
        if status == errSecItemNotFound {
            var insert = query
            attributes.forEach { insert[$0.key] = $0.value }
            finalStatus = SecItemAdd(insert as CFDictionary, nil)
        } else {
            finalStatus = status
        }
        guard finalStatus == errSecSuccess else {
            call.reject("Could not save the credential to iOS Keychain. OSStatus: \(finalStatus)")
            return
        }
        call.resolve(["stored": true])
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let namespace = call.getString("namespace"), let key = call.getString("key"),
              validName(namespace), validName(key) else {
            call.reject("Invalid credential namespace or key.")
            return
        }
        let status = SecItemDelete(credentialQuery(namespace: namespace, key: key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve(["removed": status == errSecSuccess])
        } else {
            call.reject("Could not remove the credential from iOS Keychain. OSStatus: \(status)")
        }
    }

    @objc func pickDocuments(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.documentPickerCall == nil, let controller = self.bridge?.viewController else {
                call.reject("A document picker is already open or the app view is unavailable.")
                return
            }
            self.documentPickerCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = call.getBool("multiple") ?? true
            picker.delegate = self
            controller.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        defer { documentPickerCall = nil }
        guard let call = documentPickerCall else { return }
        let imports = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Imports", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: imports, withIntermediateDirectories: true)
            var files: [[String: Any]] = []
            for source in urls {
                let destination = imports.appendingPathComponent(UUID().uuidString + "-" + source.lastPathComponent)
                try FileManager.default.copyItem(at: source, to: destination)
                let values = try destination.resourceValues(forKeys: [.fileSizeKey])
                files.append(["name": source.lastPathComponent, "path": destination.path, "size": values.fileSize ?? 0])
            }
            call.resolve(["files": files])
        } catch {
            call.reject("Could not import the selected document: \(error.localizedDescription)")
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        documentPickerCall?.reject("Document selection was cancelled.")
        documentPickerCall = nil
    }

    @objc func consumeSharedPayload(_ call: CAPPluginCall) {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
            call.reject("Axiom's shared app-group container is unavailable.")
            return
        }
        let payloadURL = container.appendingPathComponent("AxiomSharedPayload.json")
        guard FileManager.default.fileExists(atPath: payloadURL.path) else {
            call.resolve(["payload": NSNull()])
            return
        }
        do {
            let data = try Data(contentsOf: payloadURL)
            let object = try JSONSerialization.jsonObject(with: data)
            try FileManager.default.removeItem(at: payloadURL)
            call.resolve(["payload": object])
        } catch {
            call.reject("Could not read the shared item: \(error.localizedDescription)")
        }
    }

    @objc func startSpeech(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else { call.reject("Speech recognition permission was not granted."); return }
            AVAudioApplication.requestRecordPermission { granted in
                guard granted else { call.reject("Microphone permission was not granted."); return }
                DispatchQueue.main.async { self.beginSpeech(call) }
            }
        }
    }

    private func beginSpeech(_ call: CAPPluginCall) {
        guard audioEngine == nil else { call.reject("Speech recognition is already running."); return }
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            call.reject("On-device speech recognition is currently unavailable.")
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
            engine.prepare()
            try engine.start()
            audioEngine = engine
            recognitionRequest = request
            recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self else { return }
                if let result {
                    self.notifyListeners("speechResult", data: [
                        "text": result.bestTranscription.formattedString,
                        "final": result.isFinal
                    ])
                }
                if let error {
                    self.notifyListeners("speechError", data: ["message": error.localizedDescription])
                    self.stopSpeechEngine()
                }
            }
            call.resolve(["started": true])
        } catch {
            stopSpeechEngine()
            call.reject("Could not start speech recognition: \(error.localizedDescription)")
        }
    }

    @objc func stopSpeech(_ call: CAPPluginCall) {
        stopSpeechEngine()
        call.resolve(["stopped": true])
    }

    private func stopSpeechEngine() {
        audioEngine?.stop()
        audioEngine?.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        audioEngine = nil
        recognitionRequest = nil
        recognitionTask = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    deinit { stopSpeechEngine() }
}
