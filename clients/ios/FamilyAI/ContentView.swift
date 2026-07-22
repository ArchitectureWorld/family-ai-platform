import SwiftUI

struct ContentView: View {
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "house.and.flag.fill")
                    .font(.system(size: 48))
                    .accessibilityHidden(true)

                Text("Family AI")
                    .font(.largeTitle.bold())

                Text("个人入口基础工程已建立")
                    .font(.headline)

                Text("下一步接入安全配对、Keychain 会话恢复与真实个人上下文。")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .padding(24)
            .navigationTitle("个人入口")
        }
    }
}

#Preview {
    ContentView()
}
