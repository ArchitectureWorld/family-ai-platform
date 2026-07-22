import SwiftUI

struct PersonalHomeView: View {
  let coordinator: AppCoordinator
  let context: PersonalPortalContext
  @State private var showsSettings = false

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 18) {
          identityHeader
          assistantCard
          connectionCard
          chatEmptyCard
        }
        .padding(20)
      }
      .background(Color(uiColor: .secondarySystemBackground))
      .navigationTitle("个人入口")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            showsSettings = true
          } label: {
            Label("设置", systemImage: "gearshape")
          }
          .accessibilityIdentifier("open-settings")
        }
      }
      .sheet(isPresented: $showsSettings) {
        SettingsView(
          coordinator: coordinator,
          gatewayStatus: .connected
        )
      }
    }
    .accessibilityIdentifier("personal-home")
  }

  private var identityHeader: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(alignment: .top, spacing: 14) {
        Image(systemName: "person.crop.circle.fill")
          .font(.system(size: 54))
          .symbolRenderingMode(.hierarchical)
          .accessibilityHidden(true)

        VStack(alignment: .leading, spacing: 4) {
          Text(context.person.displayName)
            .font(.title2.bold())
          Text(context.family.displayName)
            .font(.headline)
            .foregroundStyle(.secondary)
          Text(context.membership.familyRole.displayName)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.thinMaterial, in: Capsule())
        }
        Spacer(minLength: 0)
      }
    }
    .familyAICard()
  }

  private var assistantCard: some View {
    VStack(alignment: .leading, spacing: 14) {
      Label("个人助理", systemImage: "sparkles")
        .font(.headline)
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text(context.agent.displayName)
            .font(.title3.bold())
          Text("个人入口已连接")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        Spacer()
        StatusBadge(title: "可用", systemImage: "checkmark.circle.fill")
      }
    }
    .familyAICard()
  }

  private var connectionCard: some View {
    VStack(alignment: .leading, spacing: 14) {
      Label("连接与会话", systemImage: "network")
        .font(.headline)

      PortalDetailRow(
        title: "Gateway",
        value: "已连接",
        systemImage: "checkmark.circle.fill"
      )
      Divider()
      PortalDetailRow(
        title: "当前设备",
        value: context.device.displayName,
        systemImage: "iphone"
      )
      Divider()
      PortalDetailRow(
        title: "Session",
        value: coordinator.sessionStatusText,
        systemImage: "key.horizontal"
      )
      Divider()
      PortalDetailRow(
        title: "最近同步",
        value: coordinator.lastSyncedAt?.formatted(
          date: .abbreviated,
          time: .shortened
        ) ?? "刚刚",
        systemImage: "arrow.triangle.2.circlepath"
      )
    }
    .familyAICard()
  }

  private var chatEmptyCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label("Chat", systemImage: "message.fill")
        .font(.headline)
      Text("个人助理入口已建立")
        .font(.title3.bold())
      Text("Chat 服务将在下一阶段接入")
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .familyAICard()
    .accessibilityIdentifier("chat-real-empty-state")
  }
}

struct OfflinePersonalHomeView: View {
  let coordinator: AppCoordinator
  let context: CachedPersonalContext?
  @State private var showsSettings = false

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 18) {
          offlineBanner

          if let context {
            cachedIdentityCard(context)
            cachedAssistantCard(context)
          } else {
            noCacheCard
          }

          Button {
            Task {
              await coordinator.retryOfflineConnection()
            }
          } label: {
            Label("重新连接 Gateway", systemImage: "arrow.clockwise")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
          .accessibilityIdentifier("retry-offline")
        }
        .padding(20)
      }
      .background(Color(uiColor: .secondarySystemBackground))
      .navigationTitle("离线个人入口")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            showsSettings = true
          } label: {
            Label("设置", systemImage: "gearshape")
          }
        }
      }
      .sheet(isPresented: $showsSettings) {
        SettingsView(
          coordinator: coordinator,
          gatewayStatus: .offline
        )
      }
    }
    .accessibilityIdentifier("offline-home")
  }

  private var offlineBanner: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "wifi.slash")
        .font(.title2)
        .foregroundStyle(.orange)
      VStack(alignment: .leading, spacing: 4) {
        Text("Gateway 当前不可达")
          .font(.headline)
        Text("本机凭证未被删除。下方内容来自最近一次成功同步的非敏感上下文。")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .familyAICard()
  }

  private func cachedIdentityCard(_ context: CachedPersonalContext) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(context.personDisplayName)
        .font(.title2.bold())
      Text(context.familyDisplayName)
        .font(.headline)
        .foregroundStyle(.secondary)
      PortalDetailRow(
        title: "家庭角色",
        value: context.familyRole.displayName,
        systemImage: "person.2"
      )
      PortalDetailRow(
        title: "当前设备",
        value: context.deviceDisplayName,
        systemImage: "iphone"
      )
      PortalDetailRow(
        title: "最近同步",
        value: context.lastSyncedAt.formatted(
          date: .abbreviated,
          time: .shortened
        ),
        systemImage: "clock"
      )
    }
    .familyAICard()
  }

  private func cachedAssistantCard(_ context: CachedPersonalContext) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("个人助理", systemImage: "sparkles")
        .font(.headline)
      Text(context.assistantDisplayName)
        .font(.title3.bold())
      Text("离线状态不提供 Chat、消息队列或伪造回复。")
        .font(.subheadline)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .familyAICard()
  }

  private var noCacheCard: some View {
    VStack(spacing: 12) {
      Image(systemName: "icloud.slash")
        .font(.system(size: 42))
        .foregroundStyle(.secondary)
      Text("尚无可展示的离线上下文")
        .font(.headline)
      Text("恢复 Gateway 连接后，应用会重新获取真实个人上下文。")
        .multilineTextAlignment(.center)
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity)
    .familyAICard()
  }
}

private struct PortalDetailRow: View {
  let title: String
  let value: String
  let systemImage: String

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: systemImage)
        .foregroundStyle(.secondary)
        .frame(width: 22)
      Text(title)
        .foregroundStyle(.secondary)
      Spacer(minLength: 12)
      Text(value)
        .fontWeight(.medium)
        .multilineTextAlignment(.trailing)
    }
  }
}

private struct StatusBadge: View {
  let title: String
  let systemImage: String

  var body: some View {
    Label(title, systemImage: systemImage)
      .font(.caption.weight(.semibold))
      .foregroundStyle(.green)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(.green.opacity(0.12), in: Capsule())
  }
}

extension View {
  fileprivate func familyAICard() -> some View {
    padding(18)
      .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 20))
  }
}

extension PersonalPortalContext.FamilyRole {
  var displayName: String {
    switch self {
    case .owner:
      return "家庭所有者"
    case .adult:
      return "成年成员"
    case .child:
      return "儿童成员"
    case .elder:
      return "长辈成员"
    }
  }
}

extension AppCoordinator {
  var sessionStatusText: String {
    guard let sessionExpiresAt else {
      return "未记录到期时间"
    }
    if sessionExpiresAt <= Date() {
      return "等待安全续期"
    }
    return "有效至 \(sessionExpiresAt.formatted(date: .abbreviated, time: .shortened))"
  }
}
