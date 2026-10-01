import SwiftUI

@main
struct FamilyAIApp: App {
  @Environment(\.scenePhase) private var scenePhase
  @State private var coordinator = AppEnvironment.makeCoordinator()

  var body: some Scene {
    WindowGroup {
      ContentView(coordinator: coordinator)
        .task {
          guard coordinator.state == .launching else {
            return
          }
          await coordinator.start()
        }
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .active:
        Task {
          await coordinator.didBecomeActive()
        }
      case .inactive:
        coordinator.didBecomeInactive()
      case .background:
        coordinator.didEnterBackground()
      @unknown default:
        coordinator.didBecomeInactive()
      }
    }
  }
}
