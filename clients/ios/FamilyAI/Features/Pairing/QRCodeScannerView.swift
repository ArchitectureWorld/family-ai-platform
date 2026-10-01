@preconcurrency import AVFoundation
import SwiftUI

struct QRCodeScannerView: UIViewControllerRepresentable {
  let onCode: (String) -> Void
  let onPermissionDenied: () -> Void

  func makeUIViewController(context: Context) -> ScannerViewController {
    ScannerViewController(
      onCode: onCode,
      onPermissionDenied: onPermissionDenied
    )
  }

  func updateUIViewController(
    _ uiViewController: ScannerViewController,
    context: Context
  ) {}

  static func dismantleUIViewController(
    _ uiViewController: ScannerViewController,
    coordinator: Void
  ) {
    uiViewController.stopScanning()
  }
}

final class ScannerViewController: UIViewController,
  AVCaptureMetadataOutputObjectsDelegate
{
  private let captureSession = AVCaptureSession()
  private let sessionQueue = DispatchQueue(
    label: "FamilyAI.QRScanner.Session"
  )
  private let onCode: (String) -> Void
  private let onPermissionDenied: () -> Void
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private var didEmitCode = false

  init(
    onCode: @escaping (String) -> Void,
    onPermissionDenied: @escaping () -> Void
  ) {
    self.onCode = onCode
    self.onPermissionDenied = onPermissionDenied
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    resolveCameraPermission()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer?.frame = view.bounds
  }

  func stopScanning() {
    sessionQueue.async { [captureSession] in
      if captureSession.isRunning {
        captureSession.stopRunning()
      }
    }
  }

  private func resolveCameraPermission() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      configureAndStart()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        DispatchQueue.main.async {
          guard let self else {
            return
          }
          if granted {
            self.configureAndStart()
          } else {
            self.onPermissionDenied()
          }
        }
      }
    case .denied, .restricted:
      onPermissionDenied()
    @unknown default:
      onPermissionDenied()
    }
  }

  private func configureAndStart() {
    guard let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device),
      captureSession.canAddInput(input)
    else {
      onPermissionDenied()
      return
    }

    captureSession.beginConfiguration()
    captureSession.addInput(input)

    let output = AVCaptureMetadataOutput()
    guard captureSession.canAddOutput(output) else {
      captureSession.commitConfiguration()
      onPermissionDenied()
      return
    }
    captureSession.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    captureSession.commitConfiguration()

    let previewLayer = AVCaptureVideoPreviewLayer(
      session: captureSession
    )
    previewLayer.videoGravity = .resizeAspectFill
    previewLayer.frame = view.bounds
    view.layer.insertSublayer(previewLayer, at: 0)
    self.previewLayer = previewLayer

    sessionQueue.async { [captureSession] in
      captureSession.startRunning()
    }
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !didEmitCode,
      let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
      object.type == .qr,
      let value = object.stringValue
    else {
      return
    }
    didEmitCode = true
    stopScanning()
    onCode(value)
  }
}
