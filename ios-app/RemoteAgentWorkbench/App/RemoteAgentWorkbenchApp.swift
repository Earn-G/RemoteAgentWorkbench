import SwiftUI
import UIKit

private enum WorkbenchTab: Hashable {
    case now
    case projects
    case inbox
    case settings
}

@main
struct RemoteAgentWorkbenchApp: App {
    @StateObject private var appModel = AppModel()
    @State private var selectedTab: WorkbenchTab = .now
    @Environment(\.scenePhase) private var scenePhase

    init() {
        configureSystemChrome()
    }

    private var taskAttentionCount: Int {
        let pendingApprovalTaskIDs = Set(appModel.approvals.filter(\.isPending).map(\.taskId))
        let visibleTaskIDs = Set(appModel.tasks.map(\.id))
        let taskCount = appModel.tasks.filter { task in
            pendingApprovalTaskIDs.contains(task.id) ||
            task.status == .awaitingPlanApproval ||
            task.status == .awaitingGitApproval ||
            task.status == .awaitingHumanInput ||
            task.status == .failed
        }.count
        let orphanedApprovalCount = appModel.approvals.filter { approval in
            approval.isPending && !visibleTaskIDs.contains(approval.taskId)
        }.count
        return taskCount + orphanedApprovalCount
    }

    var body: some Scene {
        WindowGroup {
            TabView(selection: $selectedTab) {
                ControlScreen(
                    appModel: appModel,
                    openProjects: { selectedTab = .projects },
                    openInbox: { selectedTab = .inbox }
                )
                    .tabItem {
                        Label("Now", systemImage: "bolt.circle")
                    }
                    .tag(WorkbenchTab.now)
                    .badge(taskAttentionCount)

                ProjectsScreen(appModel: appModel)
                    .tabItem {
                        Label("Projects", systemImage: "folder")
                    }
                    .tag(WorkbenchTab.projects)

                TasksScreen(appModel: appModel)
                    .tabItem {
                        Label("Tasks", systemImage: "checklist")
                    }
                    .tag(WorkbenchTab.inbox)

                SettingsScreen(appModel: appModel)
                    .tabItem {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .tag(WorkbenchTab.settings)
            }
            .tint(WorkbenchTheme.selectionTint)
            .onAppear {
                AppDebugLog.info("RemoteAgentWorkbenchApp appeared.")
                appModel.refreshAllIfNeeded()
            }
            .onChange(of: scenePhase) { _, newPhase in
                switch newPhase {
                case .active:
                    AppDebugLog.info("Scene became active. Refreshing app snapshot.")
                    appModel.refreshAllIfNeeded()
                case .inactive, .background:
                    AppDebugLog.info("Scene left active state.")
                @unknown default:
                    break
                }
            }
        }
    }

    private func configureSystemChrome() {
        let navigationAppearance = UINavigationBarAppearance()
        navigationAppearance.configureWithOpaqueBackground()
        navigationAppearance.backgroundColor = UIColor(WorkbenchTheme.barBackground)
        navigationAppearance.shadowColor = UIColor(WorkbenchTheme.cardBorder)
        navigationAppearance.titleTextAttributes = [
            .foregroundColor: UIColor(WorkbenchTheme.navigationTitle)
        ]
        navigationAppearance.largeTitleTextAttributes = [
            .foregroundColor: UIColor(WorkbenchTheme.navigationTitle)
        ]

        UINavigationBar.appearance().standardAppearance = navigationAppearance
        UINavigationBar.appearance().scrollEdgeAppearance = navigationAppearance
        UINavigationBar.appearance().compactAppearance = navigationAppearance
        if #available(iOS 15.0, *) {
            UINavigationBar.appearance().compactScrollEdgeAppearance = navigationAppearance
        }
        UINavigationBar.appearance().tintColor = UIColor(WorkbenchTheme.selectionTint)

        let tabAppearance = UITabBarAppearance()
        tabAppearance.configureWithOpaqueBackground()
        tabAppearance.backgroundColor = UIColor(WorkbenchTheme.barBackground)
        tabAppearance.shadowColor = UIColor(WorkbenchTheme.cardBorder)
        configureTabBarItemAppearance(tabAppearance.stackedLayoutAppearance)
        configureTabBarItemAppearance(tabAppearance.inlineLayoutAppearance)
        configureTabBarItemAppearance(tabAppearance.compactInlineLayoutAppearance)

        UITabBar.appearance().standardAppearance = tabAppearance
        UITabBar.appearance().scrollEdgeAppearance = tabAppearance
        UITabBar.appearance().tintColor = UIColor(WorkbenchTheme.selectionTint)
        UITabBar.appearance().unselectedItemTintColor = UIColor(WorkbenchTheme.tabBarUnselected)
    }

    private func configureTabBarItemAppearance(_ appearance: UITabBarItemAppearance) {
        let selectedColor = UIColor(WorkbenchTheme.selectionTint)
        let normalColor = UIColor(WorkbenchTheme.tabBarUnselected)

        appearance.selected.iconColor = selectedColor
        appearance.selected.titleTextAttributes = [.foregroundColor: selectedColor]
        appearance.normal.iconColor = normalColor
        appearance.normal.titleTextAttributes = [.foregroundColor: normalColor]
    }
}
