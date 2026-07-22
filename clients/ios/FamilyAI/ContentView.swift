import SwiftUI

struct ContentView: View {
  @Bindable var coordinator: AppCoordinator

  var body: some View {
    ZStack {
      rootContent

      if coordinator.isPrivacyCoverVisible {
        PrivacyCoverView()
          .transition(.opacity)
          .zIndex(100)
      }
    }
    .animation(.easeInOut(duration: 0.18), value: coordinator.isPrivacyCoverVisible)
  }

  @ViewBuilder
  private var rootContent: some View {
    switch coordinator.state {
    case .launching, .restoringSession:
      LoadingView()
    case .needsPairing:
      PairingLandingView(coordinator: coordinator)
    case .pairing(let state):
      PairingFlowView(
        coordinator: coordinator,
        state: state
      )
    case .locked:
      AppLockedView(coordinator: coordinator)
    case .authenticated(let context):
      PersonalHomeView(
        coordinator: coordinator,
        context: context
      )
    case .offline(let cachedContext):
      OfflinePersonalHomeView(
        coordinator: coordinator,
        context: cachedContext
      )
    case .authorizationRevoked:
      AuthorizationRevokedView(coordinator: coordinator)
    case .fatalConfigurationError:
      FatalConfigurationView(coordinator: coordinator)
    }
  }
}

private struct LoadingView: View {
  var body: some View {
    VStack(spacing: 18) {
      ProgressView()
        .controlSize(.large)
      Text("正在准备个人入口")
        .font(.headline)
      Text("正在安全读取设备授权与会话状态")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .padding(32)
    .accessibilityIdentifier("app-loading")
  }
}

private struct AppLockedView: View {
  let coordinator: AppCoordinator

  var body: some View {
    VStack(spacing: 24) {
      Image(systemName: "lock.shield.fill")
        .font(.system(size: 56))
        .symbolRenderingMode(.hierarchical)
      VStack(spacing: 8) {
        Text("个人入口已锁定")
          .font(.title2.bold())
        Text("使用 Face ID 或设备密码继续")
          .foregroundStyle(.secondary)
      }
      Button("解锁") {
        Task {
          await coordinator.unlock()
        }
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .accessibilityIdentifier("unlock-button")
    }
    .padding(32)
    .task {
      await coordinator.unlock()
    }
  }
}

private struct AuthorizationRevokedView: View {
  let coordinator: AppCoordinator

  var body: some View {
    VStack(spacing: 20) {
      Image(systemName: "iphone.slash")
        .font(.system(size: 52))
        .foregroundStyle(.orange)
      Text("此设备授权已撤销")
        .font(.title2.bold())
      Text("设备凭证和个人会话已从本机清除。请重新配对后继续。")
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
      Button("返回配对") {
        coordinator.acknowledgeAuthorizationRevoked()
      }
      .buttonStyle(.borderedProminent)
    }
    .padding(32)
  }
}

private struct FatalConfigurationView: View {
  let coordinator: AppCoordinator

  var body: some View {
    VStack(spacing: 20) {
      Image(systemName: "exclamationmark.shield.fill")
        .font(.system(size: 52))
        .foregroundStyle(.red)
      Text("本机安全配置异常")
        .font(.title2.bold())
      Text("无法完整读取安全凭证。应用不会尝试猜测或部分使用损坏的授权数据。")
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
      Button("重新检查") {
        Task {
          await coordinator.start()
        }
      }
      .buttonStyle(.borderedProminent)
    }
    .padding(32)
  }
}

private struct PrivacyCoverView: View {
  var body: some View {
    ZStack {
      Color(uiColor: .systemBackground)
        .ignoresSafeArea()
      VStack(spacing: 14) {
        Image(systemName: "house.and.flag.fill")
          .font(.system(size: 44))
          .symbolRenderingMode(.hierarchical)
        Text("Family AI")
          .font(.title2.bold())
      }
    }
    .accessibilityHidden(true)
  }
}
