import AppKit
import SwiftUI

struct MenuBarDashboardView: View {
    @ObservedObject var appModel: AppModel
    @ObservedObject var localMachineModel: LocalMachineModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            localRunnerSection
            runnerSection
            taskSection
            activitySection
            quickActionsSection

            if let errorMessage = appModel.errorMessage, !errorMessage.isEmpty {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(18)
        .frame(width: 360)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            appModel.refreshAllIfNeeded()
            localMachineModel.refresh()
            localMachineModel.startAutoRefresh(interval: 10)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.accentColor.opacity(0.12))
                    .frame(width: 40, height: 40)
                    .overlay {
                        Image(systemName: "laptopcomputer.and.iphone")
                            .foregroundStyle(Color.accentColor)
                    }

                VStack(alignment: .leading, spacing: 3) {
                    Text("Remote Agent")
                        .font(.headline.weight(.semibold))
                    Text(appModel.settings.serverURL)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                StatusBadge(
                    title: appModel.runners.contains(where: \.isOnline) ? "Online" : "Idle",
                    tint: appModel.runners.contains(where: \.isOnline) ? WorkbenchTheme.completedGreen : WorkbenchTheme.offlineGray
                )
            }

            HStack(spacing: 10) {
                Button {
                    openWindow(id: "history")
                } label: {
                    Label("History", systemImage: "clock.arrow.circlepath")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button {
                    appModel.refreshAll()
                    localMachineModel.refresh()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(WorkbenchTheme.elevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }

    private var localRunnerSection: some View {
        SectionCard(title: "Local Runner", caption: localRunnerCaption) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text(localMachineModel.serviceState.title)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    StatusBadge(title: localMachineModel.serviceState.title, tint: localRunnerTint)
                }

                Text("This menu only shows runner state and shortcuts. Task creation and approvals stay on the iPhone.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if let message = localMachineModel.lastErrorMessage, !message.isEmpty {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
        }
    }

    private var runnerSection: some View {
        SectionCard(title: "Runner", caption: runnerCaption) {
            if let runner = appModel.runners.first {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(runner.name)
                            .font(.subheadline.weight(.semibold))
                        Text(runner.id)
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        if let currentTaskId = runner.currentTaskId, !currentTaskId.isEmpty {
                            Label(currentTaskId, systemImage: "hammer")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Spacer()
                    StatusBadge(title: runner.isOnline ? "Online" : "Offline", tint: runner.isOnline ? WorkbenchTheme.completedGreen : WorkbenchTheme.offlineGray)
                }
            } else {
                Text("No runner has registered yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var taskSection: some View {
        SectionCard(title: "Local History", caption: taskCaption) {
            if localMachineModel.localTasks.isEmpty {
                Text("No local runs yet. Start work from the iPhone app and this Mac will save history, artifacts, and reports here.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(localMachineModel.localTasks.prefix(4))) { task in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .top) {
                                Text(task.displayTitle)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(2)
                                Spacer()
                                StatusBadge(title: task.statusTitle, tint: localStatusTint(task.status))
                            }

                            MarkdownTextBlock(
                                task.displaySubtitle,
                                tone: .secondary,
                                font: .caption,
                                allowsSelection: false,
                                lineLimit: 4
                            )
                        }
                    }
                }
            }
        }
    }

    private var activitySection: some View {
        SectionCard(title: "Local Activity", caption: "\(localMachineModel.recentActivity.count) entries") {
            if localMachineModel.recentActivity.isEmpty {
                Text("No local execution records yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(localMachineModel.recentActivity.prefix(4)) { entry in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .top) {
                                Text(entry.displayTitle)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Spacer()
                                Text(entry.relativeTimestamp)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            Text(entry.displaySubtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(5)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    private var quickActionsSection: some View {
        SectionCard(title: "Quick Actions") {
            VStack(alignment: .leading, spacing: 10) {
                actionButton("Open Dashboard", systemImage: "rectangle.grid.1x2") {
                    openWindow(id: "dashboard")
                }
                actionButton("Open Local History", systemImage: "clock.arrow.circlepath") {
                    openWindow(id: "history")
                }
                actionButton("Add Project", systemImage: "folder.badge.plus") {
                    chooseAndAddProject()
                }
                actionButton("Open Runner Stdout Log", systemImage: "doc.text") {
                    openFile(localMachineModel.paths.stdoutLogPath)
                }
                actionButton("Open Runner Stderr Log", systemImage: "exclamationmark.bubble") {
                    openFile(localMachineModel.paths.stderrLogPath)
                }
                actionButton("Open Request Journal", systemImage: "text.badge.plus") {
                    openFile(localMachineModel.paths.requestJournalPath)
                }
                actionButton("Open Tasks Folder", systemImage: "folder.badge.person.crop") {
                    openFile(localMachineModel.paths.tasksPath)
                }
                actionButton("Open Legacy Worktrees", systemImage: "folder") {
                    openFile(localMachineModel.paths.legacyWorktreesPath)
                }
                actionButton("Open LaunchAgent Plist", systemImage: "switch.2") {
                    openFile(localMachineModel.paths.launchAgentPath)
                }
                actionButton("Quit Menu App", systemImage: "xmark.circle") {
                    NSApp.terminate(nil)
                }
            }
        }
    }

    private var localRunnerCaption: String {
        switch localMachineModel.serviceState {
        case let .running(pid):
            if let pid {
                return "LaunchAgent active with pid \(pid)"
            }
            return "LaunchAgent active"
        case .loaded:
            return "LaunchAgent loaded but not actively running"
        case .stopped:
            return "LaunchAgent is not loaded"
        case .checking:
            return "Checking launchctl state"
        case let .unavailable(message):
            return message
        }
    }

    private var runnerCaption: String {
        "\(appModel.runners.filter(\.isOnline).count) online / \(appModel.runners.count) total"
    }

    private var taskCaption: String {
        let pendingApprovalsCount = appModel.approvals.filter(\.isPending).count
        if pendingApprovalsCount > 0 {
            return "\(localMachineModel.localTasks.count) local • \(pendingApprovalsCount) approvals on iPhone"
        }
        return "\(localMachineModel.localTasks.count) local"
    }

    private var localRunnerTint: Color {
        switch localMachineModel.serviceState {
        case .running:
            return WorkbenchTheme.completedGreen
        case .loaded:
            return WorkbenchTheme.runningBlue
        case .checking:
            return WorkbenchTheme.approvalAmber
        case .stopped:
            return WorkbenchTheme.offlineGray
        case .unavailable:
            return WorkbenchTheme.dangerRose
        }
    }

    private func actionButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
    }

    private func openFile(_ path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    private func chooseAndAddProject() {
        let panel = NSOpenPanel()
        panel.title = "Choose Project Folder"
        panel.prompt = "Add Project"
        panel.message = "Choose a local folder or Git repository that this Mac runner can work in."
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true

        panel.begin { response in
            guard response == .OK, let url = panel.url else {
                return
            }
            addProject(from: url)
        }
    }

    private func addProject(from url: URL) {
        let repoPath = url.standardizedFileURL.path
        guard !localMachineModel.projects.contains(where: { $0.repo == repoPath }) else {
            openWindow(id: "dashboard")
            return
        }

        let trimmedName = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = trimmedName.isEmpty ? "Local Project" : trimmedName
        let project = LocalProjectConfig(
            id: uniqueProjectID(for: displayName),
            name: displayName,
            repo: repoPath,
            baseBranch: "main",
            deliveryMode: .directCommit,
            autoPush: false,
            defaultTaskTitle: "Work on \(displayName)",
            defaultPrompt: "",
            isFeatured: true
        )
        localMachineModel.saveProjects(localMachineModel.projects + [project])
        openWindow(id: "dashboard")
    }

    private func uniqueProjectID(for name: String) -> String {
        let slug = name
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let base = slug.isEmpty ? "project" : slug
        var candidate = "project_\(base)"
        var suffix = 2

        while localMachineModel.projects.contains(where: { $0.id == candidate }) {
            candidate = "project_\(base)_\(suffix)"
            suffix += 1
        }

        return candidate
    }

    private func localStatusTint(_ value: String) -> Color {
        switch value {
        case "completed":
            return WorkbenchTheme.completedGreen
        case "failed", "blocked_conflict":
            return WorkbenchTheme.dangerRose
        case "awaiting_plan_approval", "awaiting_git_approval":
            return WorkbenchTheme.approvalAmber
        case "running":
            return WorkbenchTheme.runningBlue
        case "awaiting_human_input":
            return WorkbenchTheme.actionMint
        default:
            return WorkbenchTheme.infoCyan
        }
    }
}
