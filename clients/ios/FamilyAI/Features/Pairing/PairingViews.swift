import SwiftUI
import UIKit

struct PairingLandingView: View {
  let coordinator: AppCoordinator

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 28) {
        Spacer()
        Image(systemName: "iphone.and.arrow.forward")
          .font(.system(size: 58))
          .symbolRenderingMode(.hierarchical)
        VStack(alignment: .leading, spacing: 10) {
          Text("连接家庭 AI")
            .font(.largeTitle.bold())
          Text("扫描家庭管理员生成的二维码，或输入 Gateway HTTPS 地址和短配对码。")
            .font(.body)
            .foregroundStyle(.secondary)
        }

        VStack(spacing: 12) {
          Button {
            Task {
              await coordinator.beginScannerPairing()
            }
          } label: {
            Label("扫描配对二维码", systemImage: "qrcode.viewfinder")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .accessibilityIdentifier("start-scanner-pairing")

          Button {
            Task {
              await coordinator.beginManualPairing()
            }
          } label: {
            Label("手动输入短码", systemImage: "keyboard")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.bordered)
          .controlSize(.large)
          .accessibilityIdentifier("start-manual-pairing")
        }
        Spacer()
      }
      .padding(28)
      .navigationTitle("个人入口")
    }
  }
}

struct PairingFlowView: View {
  let coordinator: AppCoordinator
  let state: PairingState

  var body: some View {
    NavigationStack {
      Group {
        switch state {
        case .scanner:
          ScannerPairingView(coordinator: coordinator)
        case .manualEntry:
          ManualPairingView(coordinator: coordinator)
        case .loadingPreview:
          PairingProgressView(
            title: "正在验证配对信息",
            detail: "仅向指定 Gateway 请求家庭和成员预览"
          )
        case .confirmation(let confirmation):
          PairingConfirmationView(
            coordinator: coordinator,
            confirmation: confirmation
          )
        case .claiming(let confirmation):
          PairingProgressView(
            title: "正在认领此设备",
            detail: "正在为 \(confirmation.deviceDisplayName) 建立个人入口"
          )
        case .completed:
          PairingProgressView(
            title: "配对已完成",
            detail: "正在打开个人首页"
          )
        case .failed(let failure):
          PairingFailureView(
            coordinator: coordinator,
            failure: failure
          )
        }
      }
      .navigationTitle("设备配对")
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}

private struct ScannerPairingView: View {
  let coordinator: AppCoordinator
  @State private var cameraDenied = false
  @State private var scannerIdentity = UUID()

  var body: some View {
    VStack(spacing: 18) {
      if cameraDenied {
        ContentUnavailableView {
          Label("无法使用摄像头", systemImage: "camera.fill")
        } description: {
          Text("请在系统设置中允许摄像头访问，或改用手动短码配对。")
        } actions: {
          Button("打开系统设置") {
            guard
              let url = URL(
                string: UIApplication.openSettingsURLString
              )
            else {
              return
            }
            UIApplication.shared.open(url)
          }
          .buttonStyle(.borderedProminent)
        }
      } else {
        QRCodeScannerView(
          onCode: { value in
            Task {
              await coordinator.previewScannedPairing(value)
            }
          },
          onPermissionDenied: {
            cameraDenied = true
          }
        )
        .id(scannerIdentity)
        .clipShape(RoundedRectangle(cornerRadius: 24))
        .overlay {
          RoundedRectangle(cornerRadius: 24)
            .stroke(.white.opacity(0.8), lineWidth: 2)
            .padding(38)
        }
        .accessibilityIdentifier("qr-scanner")

        Text("将二维码完整放入取景框。二维码内容不会写入日志或本地缓存。")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
      }

      HStack(spacing: 12) {
        if !cameraDenied {
          Button("重新扫描") {
            scannerIdentity = UUID()
          }
          .buttonStyle(.bordered)
        }
        Button("手动输入") {
          Task {
            await coordinator.beginManualPairing()
          }
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("scanner-manual-fallback")
      }
    }
    .padding(20)
  }
}

private struct ManualPairingView: View {
  let coordinator: AppCoordinator
  @State private var gateway = ""
  @State private var code = ""

  var body: some View {
    Form {
      Section("Gateway") {
        TextField(
          "https://gateway.example.com",
          text: $gateway
        )
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
        .autocorrectionDisabled()
        .accessibilityIdentifier("manual-gateway")
        Text("必须是没有用户名、密码、路径、Query 或 Fragment 的 HTTPS 地址。")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Section("短配对码") {
        TextField("ABCD-EFGH", text: $code)
          .textInputAutocapitalization(.characters)
          .autocorrectionDisabled()
          .fontDesign(.monospaced)
          .accessibilityIdentifier("manual-code")
        Text("手动模式只提交短码，不要求输入 pairingRef。")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Section {
        Button("验证配对信息") {
          Task {
            await coordinator.previewManualPairing(
              gateway: gateway,
              code: code
            )
          }
        }
        .frame(maxWidth: .infinity)
        .disabled(
          gateway.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        )
        .accessibilityIdentifier("manual-preview")
      }

      Section {
        Button("返回扫码") {
          Task {
            await coordinator.beginScannerPairing()
          }
        }
        .frame(maxWidth: .infinity)
      }
    }
  }
}

private struct PairingConfirmationView: View {
  let coordinator: AppCoordinator
  let confirmation: PairingConfirmation

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        VStack(alignment: .leading, spacing: 8) {
          Label("请确认配对对象", systemImage: "checkmark.shield")
            .font(.title2.bold())
          Text("确认后，此 iPhone 将获得该家庭成员的个人入口授权。")
            .foregroundStyle(.secondary)
        }

        VStack(spacing: 0) {
          ConfirmationRow(
            title: "家庭",
            value: confirmation.preview.family.displayName
          )
          Divider()
          ConfirmationRow(
            title: "成员",
            value: confirmation.preview.person.displayName
          )
          Divider()
          ConfirmationRow(
            title: "Gateway",
            value: confirmation.gateway.host ?? confirmation.preview.gatewayHost
          )
          Divider()
          ConfirmationRow(
            title: "当前设备",
            value: confirmation.deviceDisplayName
          )
          Divider()
          ConfirmationRow(
            title: "配对信息到期",
            value: confirmation.preview.expiresAt.formatted(
              date: .abbreviated,
              time: .standard
            )
          )
        }
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))

        Text("确认页不会显示 Token、Device Credential 或完整内部 Ref。")
          .font(.footnote)
          .foregroundStyle(.secondary)

        Button("确认并认领此设备") {
          Task {
            await coordinator.confirmPairing()
          }
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("confirm-pairing")

        Button("取消并重新扫描", role: .cancel) {
          Task {
            await coordinator.resetPairing()
          }
        }
        .frame(maxWidth: .infinity)
      }
      .padding(24)
    }
  }
}

private struct ConfirmationRow: View {
  let title: String
  let value: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 18) {
      Text(title)
        .foregroundStyle(.secondary)
      Spacer(minLength: 20)
      Text(value)
        .multilineTextAlignment(.trailing)
        .fontWeight(.medium)
    }
    .padding(16)
  }
}

private struct PairingProgressView: View {
  let title: String
  let detail: String

  var body: some View {
    VStack(spacing: 18) {
      ProgressView()
        .controlSize(.large)
      Text(title)
        .font(.title3.bold())
      Text(detail)
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
    }
    .padding(32)
  }
}

private struct PairingFailureView: View {
  let coordinator: AppCoordinator
  let failure: PairingFailure

  var body: some View {
    VStack(spacing: 22) {
      Image(systemName: iconName)
        .font(.system(size: 52))
        .foregroundStyle(iconColor)
      VStack(spacing: 8) {
        Text(title)
          .font(.title2.bold())
        Text(detail)
          .multilineTextAlignment(.center)
          .foregroundStyle(.secondary)
      }

      if coordinator.canRetryPairingClaim {
        Button("使用相同认领材料重试") {
          Task {
            await coordinator.retryPairingClaim()
          }
        }
        .buttonStyle(.borderedProminent)
        .accessibilityIdentifier("retry-claim")
      }

      if coordinator.canRetryPairingClaim {
        Button("重新扫描") {
          Task {
            await coordinator.resetPairing()
          }
        }
        .buttonStyle(.bordered)
      } else {
        Button("重新扫描") {
          Task {
            await coordinator.resetPairing()
          }
        }
        .buttonStyle(.borderedProminent)
      }

      Button("改用手动输入") {
        Task {
          await coordinator.beginManualPairing()
        }
      }
      .buttonStyle(.bordered)
    }
    .padding(28)
  }

  private var title: String {
    switch failure {
    case .invalidInput:
      return "配对信息无效"
    case .expired:
      return "配对信息已过期"
    case .unavailable:
      return "暂时无法连接 Gateway"
    case .rejected(let code):
      switch code {
      case .pairingConsumed:
        return "配对码已被使用"
      case .pairingAttemptsExceeded:
        return "配对尝试次数已用尽"
      case .pairingTargetInactive:
        return "配对目标当前不可用"
      default:
        return "Gateway 拒绝了配对"
      }
    case .invalidResponse:
      return "Gateway 响应不符合协议"
    }
  }

  private var detail: String {
    switch failure {
    case .invalidInput:
      return "请检查二维码或 HTTPS Gateway 地址与短码。"
    case .expired:
      return "请让家庭管理员生成新的配对信息。"
    case .unavailable:
      return coordinator.canRetryPairingClaim
        ? "认领结果不确定。重试将复用同一 installationId 和 deviceCredential。"
        : "凭证未被删除。请检查网络或 Gateway 状态后重试。"
    case .rejected:
      return "状态依据稳定错误码判断，而不是依据服务器返回的中文 message。"
    case .invalidResponse:
      return "应用不会自行兼容未冻结的字段或协议版本。"
    }
  }

  private var iconName: String {
    switch failure {
    case .unavailable:
      return "wifi.exclamationmark"
    case .expired:
      return "clock.badge.exclamationmark"
    default:
      return "exclamationmark.triangle.fill"
    }
  }

  private var iconColor: Color {
    failure == .unavailable ? .orange : .red
  }
}
