import SwiftUI

@main
struct RemoteAgentWorkbenchMacApp: App {
    @StateObject private var appModel = AppModel()
    @StateObject private var localMachineModel = LocalMachineModel()
    @NSApplicationDelegateAdaptor(RemoteAgentWorkbenchMacAppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuBarDashboardView(appModel: appModel, localMachineModel: localMachineModel)
        } label: {
            MenuBarStatusEntry(appModel: appModel, localMachineModel: localMachineModel)
        }
        .menuBarExtraStyle(.window)

        Window("Remote Agent Workbench", id: "dashboard") {
            MacDashboardWindow(appModel: appModel, localMachineModel: localMachineModel)
                .frame(minWidth: 1280, minHeight: 800)
                .onAppear {
                    appModel.refreshAllIfNeeded()
                    localMachineModel.refresh()
                    localMachineModel.startAutoRefresh(interval: 10)
                }
        }
        .defaultSize(width: 1480, height: 900)

        Window("Local History", id: "history") {
            LocalHistoryWindow(appModel: appModel, localMachineModel: localMachineModel)
                .frame(minWidth: 1120, minHeight: 760)
                .onAppear {
                    localMachineModel.refresh()
                }
        }
        .defaultSize(width: 1320, height: 860)
    }
}

private struct MenuBarStatusEntry: View {
    @ObservedObject var appModel: AppModel
    @ObservedObject var localMachineModel: LocalMachineModel
    @Environment(\.openWindow) private var openWindow
    @State private var didOpenInitialDashboard = false

    var body: some View {
        MenuBarStatusLabel(appModel: appModel, localMachineModel: localMachineModel)
            .onAppear {
                appModel.refreshAllIfNeeded()
                localMachineModel.refresh()
                localMachineModel.startAutoRefresh(interval: 10)

                guard !didOpenInitialDashboard else {
                    return
                }

                didOpenInitialDashboard = true
                DispatchQueue.main.async {
                    presentDashboard()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .remoteAgentWorkbenchShowDashboard)) { _ in
                presentDashboard()
            }
    }

    private func presentDashboard() {
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "dashboard")
    }
}
