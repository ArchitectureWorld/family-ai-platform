import SwiftUI

enum GatewayDisplayStatus {
  case connected
  case offline

  var title: String {
    switch self {
    case .connected:
      return "已连接"
    case .offline:
      return "离线"
    }
  }

  var systemImage: String {
    switch self {
    case .connected:
      return "checkmark.circle.fill"
    case .offline:
      return "wifi.slash"
    }
  }
}

struct SettingsView: View {
  @Environment(\.dismiss) private var dismiss
  let coordinator: AppCoordinator
  let gatewayStatus: GatewayDisplayStatus

  @State private var confirmsLogout = false
  @State private var confirmsUnbind = false
  @State private var isPerformingAction = false

  var body: some View {
    NavigationStack {
      Form {
        Section("连接") {
          LabeledContent("Gateway") {
            Label(gatewayStatus.title, systemImage: gatewayStatus.systemImage)
          }
          LabeledContent("Session", value: coordinator.sessionStatusText)
          if let lastSyncedAt = coordinator.lastSyncedAt {
            LabeledContent(
              "最近同步",
              value: lastSyncedAt.formatted(
                date: .abbreviated,
                time: .shortened
              )
            )
          }
        }

        Section("本机锁定") {
          Picker("锁定策略", selection: lockPolicyBinding) {
            Text("立即锁定").tag(AppLockPolicy.immediate)
            Text("5 分钟").tag(AppLockPolicy.fiveMinutes)
            Text("关闭本地锁定").tag(AppLockPolicy.disabled)
          }
          Text("Face ID 或设备密码只保护本机界面，不参与 Gateway 鉴权。默认策略为后台超过 5 分钟后验证。")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        if let failure = coordinator.lastFailure {
          Section {
            Label(failure.message, systemImage: "exclamationmark.triangle.fill")
              .foregroundStyle(.orange)
          }
        }

        Section("会话") {
          Button("退出当前会话") {
            confirmsLogout = true
          }
          .disabled(isPerformingAction)
          Text("撤销并清除当前 EntrySession；保留此设备授权。下次解锁时可使用设备凭证续期。")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Section("设备授权") {
          Button("解绑此设备", role: .destructive) {
            confirmsUnbind = true
          }
          .disabled(isPerformingAction)
          Text("先进行一次新的 Face ID 或设备密码验证，再请求 Gateway 撤销设备并清除设备与 Session 凭证。网络不可达时不会删除本机授权。")
            .font(.caption)
            .foregroundStyle(.secondary)
        }

        Section("诊断") {
          LabeledContent("App 版本", value: appVersion)
          LabeledContent("Mobile Entry 协议", value: "v1")
          Text("诊断信息不显示 Token、Device Credential、配对码、QR Payload 或完整内部 Ref。")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      .navigationTitle("设置")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("完成") {
            dismiss()
          }
        }
      }
      .confirmationDialog(
        "退出当前会话？",
        isPresented: $confirmsLogout,
        titleVisibility: .visible
      ) {
        Button("退出当前会话", role: .destructive) {
          perform {
            await coordinator.logout()
          }
        }
      } message: {
        Text("设备授权会保留，但当前个人会话将被撤销并清除。")
      }
      .confirmationDialog(
        "永久解绑此设备？",
        isPresented: $confirmsUnbind,
        titleVisibility: .visible
      ) {
        Button("验证并解绑", role: .destructive) {
          perform {
            await coordinator.unbindDevice()
          }
        }
      } message: {
        Text("系统会先要求 Face ID 或设备密码。本操作与退出会话不同。")
      }
      .overlay {
        if isPerformingAction {
          ZStack {
            Color.black.opacity(0.18).ignoresSafeArea()
            ProgressView()
              .controlSize(.large)
              .padding(24)
              .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
          }
        }
      }
      .onChange(of: coordinator.state) { _, state in
        switch state {
        case .locked, .needsPairing:
          dismiss()
        default:
          break
        }
      }
    }
    .accessibilityIdentifier("settings-view")
  }

  private var lockPolicyBinding: Binding<AppLockPolicy> {
    Binding(
      get: { coordinator.lockPolicy },
      set: { policy in
        Task {
          await coordinator.setLockPolicy(policy)
        }
      }
    )
  }

  private var appVersion: String {
    Bundle.main.object(
      forInfoDictionaryKey: "CFBundleShortVersionString"
    ) as? String ?? "Unknown"
  }

  private func perform(_ operation: @escaping @MainActor () async -> Void) {
    isPerformingAction = true
    Task { @MainActor in
      await operation()
      isPerformingAction = false
    }
  }
}

extension AppCoordinatorFailure {
  fileprivate var message: String {
    switch self {
    case .connectionUnavailable:
      return "Gateway 当前不可达，本机凭证未被删除。"
    case .operationFailed:
      return "操作未完成，请检查 Gateway 状态后重试。"
    case .configurationInvalid:
      return "本机安全凭证状态不完整，应用已停止继续使用。"
    }
  }
}
