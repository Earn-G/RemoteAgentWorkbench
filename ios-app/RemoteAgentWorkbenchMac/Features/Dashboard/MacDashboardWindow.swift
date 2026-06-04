import AppKit
import SwiftUI

private enum WorkbenchSection: String, CaseIterable, Identifiable {
    case home
    case projects
    case history
    case runner

    var id: String { rawValue }

    var title: String {
        switch self {
        case .home:
            "Home"
        case .projects:
            "Projects"
        case .history:
            "Tasks"
        case .runner:
            "Runner"
        }
    }

    var iconName: String {
        switch self {
        case .home:
            "house"
        case .projects:
            "folder.badge.gearshape"
        case .history:
            "list.bullet.rectangle"
        case .runner:
            "desktopcomputer"
        }
    }

    var subtitle: String {
        switch self {
        case .home:
            "Overview and attention queue"
        case .projects:
            "Pinned local repos"
        case .history:
            "Task queue and saved runs"
        case .runner:
            "Service status and journal"
        }
    }
}

private enum RunnerSelection: Hashable {
    case local
    case remote(String)
}

struct MacDashboardWindow: View {
    @ObservedObject var appModel: AppModel
    @ObservedObject var localMachineModel: LocalMachineModel
    @Environment(\.openWindow) private var openWindow

    @State private var selectedSection: WorkbenchSection = .home
    @State private var selectedTaskID: String?
    @State private var selectedApprovalID: String?
    @State private var selectedProjectID: String?
    @State private var selectedRunnerSelection: RunnerSelection? = .local
    @State private var taskDetail: LocalTaskDetail?
    @State private var pendingProjectDeletion: LocalProjectConfig?
    @State private var isDeleteProjectAlertPresented = false
    private let refreshTimer = Timer.publish(every: 4, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 230, ideal: 260, max: 300)
        } content: {
            contentColumn
                .navigationSplitViewColumnWidth(min: 520, ideal: 650, max: 760)
        } detail: {
            detailColumn
                .navigationSplitViewColumnWidth(min: 560, ideal: 720)
        }
        .navigationSplitViewStyle(.balanced)
        .toolbar {
            ToolbarItemGroup {
                Button {
                    refreshSnapshot()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }

                Button {
                    selectedSection = .projects
                    chooseAndAddProject()
                } label: {
                    Label("Add Project", systemImage: "folder.badge.plus")
                }

                Button {
                    openWindow(id: "history")
                } label: {
                    Label("Local History", systemImage: "clock.arrow.circlepath")
                }
            }
        }
        .background(workbenchBackground)
        .onAppear {
            refreshSnapshot()
            autoSelectLandingSection()
            bootstrapSelection(for: selectedSection)
            focusOnMostRelevantTaskIfNeeded(force: true)
        }
        .onChange(of: selectedSection) { _, newValue in
            bootstrapSelection(for: newValue)
        }
        .onChange(of: localMachineModel.localTasks) { _, _ in
            focusOnMostRelevantTaskIfNeeded()
            autoSelectLandingSection()
            bootstrapSelection(for: selectedSection)
            Task {
                await refreshSelectedTaskDetail()
            }
        }
        .onChange(of: localMachineModel.projects) { _, _ in
            autoSelectLandingSection()
            bootstrapSelection(for: selectedSection)
        }
        .onReceive(refreshTimer) { _ in
            guard (selectedSection == .home || selectedSection == .history), selectedTaskID != nil else { return }
            localMachineModel.refresh()
            Task {
                await refreshSelectedTaskDetail()
            }
        }
        .task(id: selectedTaskID) {
            await refreshSelectedTaskDetail()
        }
        .alert("Delete Project?", isPresented: $isDeleteProjectAlertPresented) {
            Button("Cancel", role: .cancel) {
                pendingProjectDeletion = nil
            }
            Button("Delete Project", role: .destructive) {
                guard let pendingProjectDeletion else {
                    return
                }
                removeProject(id: pendingProjectDeletion.id)
                self.pendingProjectDeletion = nil
            }
        } message: {
            Text("Remove \(pendingProjectDeletion?.name ?? "this project") from the Mac project list. This does not delete the folder or repository on disk.")
        }
    }

    private var sidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                workspaceSidebarHeader

                VStack(alignment: .leading, spacing: 6) {
                    Text("Workbench")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)

                    ForEach([WorkbenchSection.home, .history, .projects, .runner]) { section in
                        sidebarButton(for: section)
                    }
                }
            }
            .padding(14)
        }
        .safeAreaPadding(.top)
        .background(sidebarBackground)
        .safeAreaInset(edge: .bottom) {
            sidebarFooter
        }
    }

    private var workspaceSidebarHeader: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.accentColor.opacity(0.12))
                    .frame(width: 42, height: 42)
                    .overlay(
                        Image(systemName: "laptopcomputer.and.iphone")
                            .font(.title3)
                            .foregroundStyle(Color.accentColor)
                    )

                VStack(alignment: .leading, spacing: 3) {
                    Text("Remote Agent")
                        .font(.system(.headline, design: .rounded).weight(.semibold))
                    Text("Workbench")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)
            }

            HStack(spacing: 8) {
                StatusBadge(title: localMachineModel.serviceState.title, tint: localRunnerTint)
                Text("•")
                    .foregroundStyle(.tertiary)
                Text("\(onlineRunnerCount) online")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }

            Divider().overlay(WorkbenchTheme.divider)

            if let activeLocalTask {
                Button {
                    selectedSection = .home
                    selectedTaskID = activeLocalTask.id
                    selectedApprovalID = nil
                } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("CURRENT TASK")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }

                        HStack(spacing: 6) {
                            Circle()
                                .fill(localStatusTint(activeLocalTask.status))
                                .frame(width: 7, height: 7)
                            Text(activeLocalTask.statusTitle)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }

                        Text(activeLocalTask.displayTitle)
                            .font(.system(.subheadline, design: .rounded).weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(2)

                        Text(activeLocalTask.id)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(WorkbenchTheme.sidebarSelection.opacity(0.75))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(WorkbenchTheme.sidebarSelectionBorder.opacity(0.75), lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("No active local task")
                        .font(.caption.weight(.semibold))
                    Text("Start a task from the phone and it will appear here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(WorkbenchTheme.panel.opacity(0.65))
                )
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(WorkbenchTheme.elevated.opacity(0.96))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(WorkbenchTheme.cardBorder)
        )
    }

    private func sidebarButton(for section: WorkbenchSection) -> some View {
        Button {
            selectedSection = section
        } label: {
            HStack(spacing: 10) {
                Image(systemName: section.iconName)
                    .frame(width: 18)
                    .foregroundStyle(selectedSection == section ? Color.accentColor : Color.secondary)

                VStack(alignment: .leading, spacing: 2) {
                    Text(section.title)
                        .font(.system(.body, design: .rounded).weight(.medium))
                        .foregroundStyle(.primary)
                    Text(section.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 10)

                if let countText = badgeText(for: section) {
                    Text(countText)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(selectedSection == section ? Color.accentColor : Color.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            Capsule(style: .continuous)
                                .fill(selectedSection == section ? Color.accentColor.opacity(0.14) : Color.secondary.opacity(0.10))
                        )
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(selectedSection == section ? WorkbenchTheme.sidebarSelection : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(selectedSection == section ? WorkbenchTheme.sidebarSelectionBorder : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var sidebarFooter: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let errorMessage = localMachineModel.lastErrorMessage ?? appModel.errorMessage {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.orange.opacity(0.08))
                )
            }

            Divider().overlay(WorkbenchTheme.divider)

            HStack(spacing: 6) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .foregroundStyle(.secondary)
                Text("API")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(appModel.settings.serverURL)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                Circle()
                    .fill(localRunnerTint)
                    .frame(width: 6, height: 6)
            }

            HStack(spacing: 8) {
                quickSidebarButton("Logs", systemImage: "doc.text") {
                    openFile(localMachineModel.paths.stdoutLogPath)
                }

                quickSidebarButton("Projects", systemImage: "folder.badge.gearshape") {
                    selectedSection = .projects
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.62))
    }

    private var contentColumn: some View {
        Group {
            switch selectedSection {
            case .home:
                homeColumn
            case .projects:
                projectsColumn
            case .history:
                historyColumn
            case .runner:
                runnersColumn
            }
        }
        .safeAreaPadding(.top)
    }

    private var detailColumn: some View {
        Group {
            switch selectedSection {
            case .home:
                homeInspector
            case .projects:
                projectsInspector
            case .history:
                tasksInspector
            case .runner:
                runnersInspector
            }
        }
        .safeAreaPadding(.top)
    }

    private var homeColumn: some View {
        VStack(spacing: 0) {
            sectionHeader(
                title: "Overview",
                detail: "\(pendingApprovals.count) approvals • \(activeBoardTasks.count) active runs • \(onlineRunnerCount) runner online",
                actionTitle: "Open History Window"
            ) {
                openWindow(id: "history")
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    attentionPanel
                    desktopSummaryStrip

                    WorkbenchPanel(title: "Active Runs", caption: "Local task queue from this Mac") {
                        if localMachineModel.localTasks.isEmpty {
                            WorkbenchEmptyState(
                                title: "No local runs yet",
                                detail: "Start a task from the phone. The Mac will capture the workspace, Codex session, artifacts, and report link here."
                            )
                        } else {
                            VStack(spacing: 0) {
                                MacTaskTableHeader()
                                    .padding(.horizontal, 12)
                                    .padding(.bottom, 6)

                                ForEach(Array(localMachineModel.localTasks.prefix(7))) { task in
                                    previewButton {
                                        selectedTaskID = task.id
                                        selectedApprovalID = nil
                                    } label: {
                                        MacTaskTableRow(task: task, isSelected: selectedTaskID == task.id)
                                    }
                                }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        }
                    }

                    WorkbenchPanel(title: "Recent Activity", caption: "Runner journal and local workflow events") {
                        if localMachineModel.recentActivity.isEmpty {
                            WorkbenchEmptyState(
                                title: "No recent runner events",
                                detail: "Claims, completions, profile switches, Git actions, and failures will be listed here."
                            )
                        } else {
                            VStack(spacing: 0) {
                                ForEach(Array(localMachineModel.recentActivity.prefix(6))) { entry in
                                    if localMachineModel.localTasks.contains(where: { $0.id == entry.taskId }) {
                                        previewButton {
                                            selectedSection = .history
                                            selectedTaskID = entry.taskId
                                            selectedApprovalID = nil
                                        } label: {
                                            MacJournalTableRow(entry: entry)
                                        }
                                    } else {
                                        MacJournalTableRow(entry: entry)
                                    }
                                }
                            }
                        }
                    }

                    if !featuredProjects.isEmpty {
                        WorkbenchPanel(title: "Featured Projects", caption: "Pinned launch presets synced from this Mac") {
                            VStack(spacing: 0) {
                                ForEach(Array(featuredProjects.prefix(5))) { project in
                                    previewButton {
                                        selectedSection = .projects
                                        selectedProjectID = project.id
                                    } label: {
                                        MacProjectCompactRow(project: project, historyCount: relatedTasks(for: project).count)
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(columnBackground)
        }
        .background(columnBackground)
    }

    @ViewBuilder
    private var attentionPanel: some View {
        if let approval = pendingApprovals.first {
            Button {
                selectedApprovalID = approval.id
                selectedTaskID = nil
            } label: {
                MacAttentionPanel(
                    eyebrow: "Needs Approval",
                    title: approval.title,
                    detail: approval.detail,
                    status: approval.status.title,
                    tint: WorkbenchTheme.approvalAmber,
                    primaryAction: "Inspect approval"
                )
            }
            .buttonStyle(.plain)
        } else if let activeLocalTask {
            Button {
                selectedTaskID = activeLocalTask.id
                selectedApprovalID = nil
            } label: {
                MacAttentionPanel(
                    eyebrow: "Running Now",
                    title: activeLocalTask.displayTitle,
                    detail: activeLocalTask.displaySubtitle,
                    status: activeLocalTask.statusTitle,
                    tint: localStatusTint(activeLocalTask.status),
                    primaryAction: "Open task"
                )
            }
            .buttonStyle(.plain)
        } else {
            MacAttentionPanel(
                eyebrow: "All Clear",
                title: "No approvals or active runs need attention",
                detail: "Runner health and recent activity remain visible below.",
                status: localMachineModel.serviceState.title,
                tint: localRunnerTint,
                primaryAction: "Review dashboard"
            )
        }
    }

    private var desktopSummaryStrip: some View {
        HStack(spacing: 12) {
            MacSummaryMetric(
                title: "Needs Approval",
                value: "\(pendingApprovals.count)",
                caption: "Awaiting input",
                icon: "exclamationmark.circle.fill",
                tint: pendingApprovals.isEmpty ? WorkbenchTheme.offlineGray : WorkbenchTheme.approvalAmber
            )
            MacSummaryMetric(
                title: "Active Runs",
                value: "\(activeBoardTasks.count)",
                caption: "Running now",
                icon: "bolt.horizontal.fill",
                tint: WorkbenchTheme.runningBlue
            )
            MacSummaryMetric(
                title: "Completed",
                value: "\(completedTaskCount)",
                caption: "Saved locally",
                icon: "checkmark.circle.fill",
                tint: WorkbenchTheme.completedGreen
            )
            MacSummaryMetric(
                title: "Runner Online",
                value: "\(onlineRunnerCount)",
                caption: localMachineModel.serviceState.title,
                icon: "desktopcomputer",
                tint: localRunnerTint
            )
        }
    }

    private var historyColumn: some View {
        VStack(spacing: 0) {
            sectionHeader(
                title: "Tasks",
                detail: "\(localMachineModel.localTasks.count) local runs • \(completedTaskCount) completed",
                actionTitle: "Open History Window"
            ) {
                openWindow(id: "history")
            }

            if localMachineModel.localTasks.isEmpty {
                WorkbenchEmptyState(
                    title: "No tasks recorded locally",
                    detail: "Start a task from the phone and this Mac will save the timeline, artifacts, workspace pointers, and report link here."
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(20)
                .background(columnBackground)
            } else {
                List(localMachineModel.localTasks, selection: $selectedTaskID) { task in
                    MacTaskTableRow(task: task, isSelected: selectedTaskID == task.id)
                        .tag(task.id)
                }
                .listStyle(.inset)
                .scrollContentBackground(.hidden)
                .background(columnBackground)
            }
        }
        .background(columnBackground)
    }

    private var projectsColumn: some View {
        VStack(spacing: 0) {
            sectionHeader(
                title: "Projects",
                detail: "\(featuredProjects.count) featured • \(localMachineModel.projects.count) synced presets",
                actionTitle: "Add Project"
            ) {
                chooseAndAddProject()
            }

            if sortedProjects.isEmpty {
                VStack(spacing: 14) {
                    WorkbenchEmptyState(
                        title: "No local project presets",
                        detail: "Add a folder or repository from this Mac. It will sync to the phone so task creation can start from one tap."
                    )

                    Button {
                        chooseAndAddProject()
                    } label: {
                        Label("Choose Folder or Repo", systemImage: "folder.badge.plus")
                            .frame(minWidth: 220)
                    }
                    .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(20)
                .background(columnBackground)
            } else {
                List(selection: $selectedProjectID) {
                    Section {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Project Library")
                                .font(.headline)
                            Text("Add folders here; use the phone to start work. Repo paths and default flows stay owned by this Mac.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)

                    if !featuredProjects.isEmpty {
                        Section("Featured") {
                            ForEach(featuredProjects) { project in
                                ProjectLibraryRow(
                                    project: project,
                                    historyCount: relatedTasks(for: project).count
                                )
                                .tag(project.id)
                            }
                        }
                    }

                    Section(featuredProjects.isEmpty ? "All Projects" : "More Projects") {
                        if standardProjects.isEmpty {
                            Text("All synced presets are already featured.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(standardProjects) { project in
                                ProjectLibraryRow(
                                    project: project,
                                    historyCount: relatedTasks(for: project).count
                                )
                                .tag(project.id)
                            }
                        }
                    }
                }
                .listStyle(.inset)
                .scrollContentBackground(.hidden)
                .background(columnBackground)
            }
        }
        .background(columnBackground)
    }

    private var runnersColumn: some View {
        VStack(spacing: 0) {
            sectionHeader(
                title: "Runner",
                detail: "\(onlineRunnerCount) online • \(localMachineModel.recentActivity.count) local journal entries",
                actionTitle: "Open Journal"
            ) {
                openFile(localMachineModel.paths.requestJournalPath)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    WorkbenchPanel(title: "Local Runner", caption: localRunnerCaption) {
                        VStack(alignment: .leading, spacing: 14) {
                            LocalRunnerRow(serviceState: localMachineModel.serviceState)

                            HStack(spacing: 8) {
                                actionButton("Start", systemImage: "play.fill") {
                                    localMachineModel.startRunner()
                                }
                                actionButton("Restart", systemImage: "arrow.clockwise") {
                                    localMachineModel.restartRunner()
                                }
                                actionButton("Stop", systemImage: "stop.fill") {
                                    localMachineModel.stopRunner()
                                }
                            }
                            .controlSize(.small)
                        }
                    }

                    WorkbenchPanel(title: "Recent Journal", caption: "Latest local events") {
                        if localMachineModel.recentActivity.isEmpty {
                            WorkbenchEmptyState(
                                title: "No local runner activity yet",
                                detail: "Claims, completions, Git actions, and failures from this Mac will appear here."
                            )
                        } else {
                            VStack(spacing: 0) {
                                ForEach(Array(localMachineModel.recentActivity.prefix(10))) { entry in
                                    if localMachineModel.localTasks.contains(where: { $0.id == entry.taskId }) {
                                        previewButton {
                                            selectedSection = .history
                                            selectedTaskID = entry.taskId
                                            selectedApprovalID = nil
                                        } label: {
                                            MacJournalTableRow(entry: entry)
                                        }
                                    } else {
                                        MacJournalTableRow(entry: entry)
                                    }
                                }
                            }
                        }
                    }

                    WorkbenchPanel(title: "Remote Runners", caption: "Control-plane heartbeat snapshot") {
                        if appModel.runners.isEmpty {
                            WorkbenchEmptyState(
                                title: "No runner has registered yet",
                                detail: "Start the Mac runner and its control-plane status will appear here."
                            )
                        } else {
                            VStack(spacing: 0) {
                                ForEach(appModel.runners) { runner in
                                    previewButton {
                                        selectedRunnerSelection = .remote(runner.id)
                                    } label: {
                                        RunnerRow(runner: runner)
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(columnBackground)
        }
        .background(columnBackground)
    }

    private var tasksInspector: some View {
        ScrollView {
            if let taskDetail {
                VStack(alignment: .leading, spacing: 18) {
                    taskActionHeader(taskDetail)
                    taskSummaryPanel(taskDetail)
                    taskCodexPreviewPanel(taskDetail)
                    taskOpenPanel(taskDetail)
                    taskTimelinePanel(taskDetail)

                    if !taskDetail.artifactFiles.isEmpty {
                        taskArtifactsPanel(taskDetail)
                    }

                    taskPromptPanel(taskDetail)
                }
                .padding(20)
            } else {
                WorkbenchEmptyState(
                    title: "Select a task",
                    detail: "Pick a history item to inspect the summary, report link, raw files, and execution timeline."
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(20)
            }
        }
        .background(inspectorBackground)
    }

    @ViewBuilder
    private var homeInspector: some View {
        if selectedApproval != nil && selectedTaskID == nil {
            approvalsInspector
        } else if selectedTaskID != nil {
            tasksInspector
        } else {
            ScrollView {
                WorkbenchEmptyState(
                    title: "Choose an item from Home",
                    detail: "Select an approval or active task to inspect its full local context here."
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(20)
            }
            .background(inspectorBackground)
        }
    }

    private var approvalsInspector: some View {
        ScrollView {
            if let approval = selectedApproval {
                VStack(alignment: .leading, spacing: 18) {
                    WorkbenchPanel(title: approval.title, caption: approval.type.replacingOccurrences(of: "_", with: " ").capitalized) {
                        HStack(alignment: .top) {
                            StatusBadge(title: approval.status.title, tint: approval.status.tint)
                            Spacer()
                            Text(approval.displayCreatedAt)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        MarkdownTextBlock(approval.detail)

                        infoGrid([
                            ("Approval ID", approval.id),
                            ("Task ID", approval.taskId),
                            ("Status", approval.status.title),
                            ("Resolved At", approval.displayResolvedAt)
                        ])
                    }

                    if let relatedTask = localMachineModel.localTasks.first(where: { $0.id == approval.taskId }) {
                        WorkbenchPanel(title: "Local History Match", caption: "Open the saved task context on this Mac") {
                            previewButton {
                                selectedSection = .history
                                selectedTaskID = relatedTask.id
                                selectedApprovalID = nil
                            } label: {
                                TaskRow(task: relatedTask)
                            }
                        }
                    }

                    WorkbenchPanel(title: "Payload", caption: "\(approval.payload.count) fields") {
                        if approval.payload.isEmpty {
                            WorkbenchEmptyState(
                                title: "No extra payload attached",
                                detail: "This approval only carries a human-readable description."
                            )
                        } else {
                            VStack(spacing: 12) {
                                ForEach(approval.payload.keys.sorted(), id: \.self) { key in
                                    infoRow(key, value: approval.payload[key] ?? "")
                                }
                            }
                        }
                    }

                    WorkbenchPanel(title: "Next Step", caption: "Desktop is still read-only for approvals") {
                        Text("Approve or deny from the iPhone flow. This desktop view is here to give you context quickly, not to add another control surface.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(20)
            } else {
                WorkbenchEmptyState(
                    title: "Select an approval",
                    detail: "Choose a pending approval to inspect the request and jump into the local task history if it already exists."
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(20)
            }
        }
        .background(inspectorBackground)
    }

    private var projectsInspector: some View {
        ScrollView {
            if let project = selectedProject {
                VStack(alignment: .leading, spacing: 18) {
                    WorkbenchPanel(title: project.name, caption: project.id) {
                        HStack(alignment: .top) {
                            if project.isFeatured {
                                Label("Featured", systemImage: "star.fill")
                                    .font(.caption.weight(.semibold))
                            .foregroundStyle(WorkbenchTheme.approvalAmber)
                            }

                            Spacer()

                            Text(project.baseBranch)
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(
                                    Capsule(style: .continuous)
                                        .fill(Color.accentColor.opacity(0.10))
                                )
                                .foregroundStyle(Color.accentColor)
                        }

                        infoGrid([
                            ("Repository", project.repo),
                            ("Base Branch", project.baseBranch),
                            ("Default Task Title", project.defaultTaskTitle)
                        ])
                    }

                    WorkbenchPanel(title: "Default Prompt", caption: "Used for phone-triggered task creation") {
                        MarkdownTextBlock(project.defaultPrompt, tone: .secondary)
                    }

                    WorkbenchPanel(title: "How To Use", caption: "Daily flow stays on the phone") {
                        Text("Choose this project on the iPhone and send the instruction there. The Mac stays focused on paths, local history, artifacts, and runner health.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    WorkbenchPanel(title: "Recent History", caption: "\(relatedTasks(for: project).count) matching local tasks") {
                        if relatedTasks(for: project).isEmpty {
                            WorkbenchEmptyState(
                                title: "No saved runs for this project yet",
                                detail: "Once this preset is used, its local task history will show up here for quick review."
                            )
                        } else {
                            VStack(spacing: 10) {
                                ForEach(Array(relatedTasks(for: project).prefix(6))) { task in
                                    previewButton {
                                        selectedSection = .history
                                        selectedTaskID = task.id
                                        selectedApprovalID = nil
                                    } label: {
                                        TaskRow(task: task)
                                    }
                                }
                            }
                        }
                    }

                    WorkbenchPanel(title: "Quick Actions") {
                        actionGrid {
                            inspectorActionButton("Open Repo Folder", systemImage: "folder") {
                                openFile(project.repo)
                            }
                            inspectorActionButton("Add Project", systemImage: "folder.badge.plus") {
                                chooseAndAddProject()
                            }
                            Button(role: .destructive) {
                                pendingProjectDeletion = project
                                isDeleteProjectAlertPresented = true
                            } label: {
                                Label("Delete Project", systemImage: "trash")
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
                .padding(20)
            } else {
                VStack(spacing: 14) {
                    WorkbenchEmptyState(
                        title: "Select a project preset",
                        detail: "Choose a project to inspect its repo settings, default prompt, and related local history."
                    )

                    Button {
                        chooseAndAddProject()
                    } label: {
                        Label("Choose Folder or Repo", systemImage: "folder.badge.plus")
                    }
                    .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(20)
            }
        }
        .background(inspectorBackground)
    }

    private var runnersInspector: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                WorkbenchPanel(title: "Local Runner", caption: localRunnerCaption) {
                    HStack(alignment: .top) {
                        StatusBadge(title: localMachineModel.serviceState.title, tint: localRunnerTint)
                        Spacer()
                        Text(localMachineModel.paths.launchAgentPath)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.trailing)
                    }

                    Text("This Mac app only observes the runner. If launchd maintenance is needed, use the log and plist shortcuts below.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if let message = localMachineModel.lastErrorMessage, !message.isEmpty {
                        Text(message)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if let runner = selectedRemoteRunner {
                    WorkbenchPanel(title: runner.name, caption: runner.platform.capitalized) {
                        HStack(alignment: .top) {
                            StatusBadge(title: runner.isOnline ? "Online" : "Offline", tint: runner.isOnline ? .green : .gray)
                            Spacer()
                            Text(runner.displayLastHeartbeatAt)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        infoGrid([
                            ("Runner ID", runner.id),
                            ("Labels", runner.labels.joined(separator: ", ").nilIfEmpty ?? "None"),
                            ("Capabilities", runner.capabilities.joined(separator: " • ").nilIfEmpty ?? "None"),
                            ("Current Task", runner.currentTaskId?.nilIfEmpty ?? "Idle")
                        ])
                    }
                }

                WorkbenchPanel(title: "Recent Journal", caption: "\(localMachineModel.recentActivity.count) local entries") {
                    if localMachineModel.recentActivity.isEmpty {
                        WorkbenchEmptyState(
                            title: "No local runner activity yet",
                            detail: "Claims, completions, Git actions, and failures from this Mac will appear here."
                        )
                    } else {
                        VStack(spacing: 10) {
                            ForEach(Array(localMachineModel.recentActivity.prefix(8))) { entry in
                                if localMachineModel.localTasks.contains(where: { $0.id == entry.taskId }) {
                                    previewButton {
                                        selectedSection = .history
                                        selectedTaskID = entry.taskId
                                        selectedApprovalID = nil
                                    } label: {
                                        ActivityRow(entry: entry)
                                    }
                                } else {
                                    ActivityRow(entry: entry)
                                }
                            }
                        }
                    }
                }

                WorkbenchPanel(title: "Server Snapshot", caption: "Minimal control-plane metadata") {
                    infoGrid([
                        ("Configured Server", appModel.settings.serverURL),
                        ("Public Base URL", appModel.systemSummary?.publicBaseURL ?? "Unavailable"),
                        ("Runner Auth", (appModel.systemSummary?.runnerAuthConfigured ?? false) ? "Configured" : "Not configured"),
                        ("Online Runners", "\(onlineRunnerCount) / \(appModel.runners.count)")
                    ])
                }

                WorkbenchPanel(title: "Support Files", caption: "Local debugging shortcuts") {
                    actionGrid {
                        fileInspectorButton("Open Runner Stdout", path: localMachineModel.paths.stdoutLogPath)
                        fileInspectorButton("Open Runner Stderr", path: localMachineModel.paths.stderrLogPath)
                        fileInspectorButton("Open Request Journal", path: localMachineModel.paths.requestJournalPath)
                        fileInspectorButton("Open LaunchAgent Plist", path: localMachineModel.paths.launchAgentPath)
                        fileInspectorButton("Open Tasks Folder", path: localMachineModel.paths.tasksPath)
                        fileInspectorButton("Open Legacy Worktrees", path: localMachineModel.paths.legacyWorktreesPath)
                    }
                }
            }
            .padding(20)
        }
        .background(inspectorBackground)
    }

    private func taskActionHeader(_ detail: LocalTaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    StatusBadge(title: detail.task.statusTitle, tint: localStatusTint(detail.task.status))
                    Text(detail.task.displayTitle)
                        .font(.system(.title2, design: .rounded).weight(.semibold))
                        .foregroundStyle(WorkbenchTheme.textPrimary)
                        .lineLimit(2)
                    HStack(spacing: 12) {
                        Label(detail.task.projectDisplayName, systemImage: "folder")
                        Label(detail.task.baseBranch, systemImage: "arrow.triangle.branch")
                        Text(detail.task.displayUpdatedAt)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }

                Spacer(minLength: 16)

                VStack(alignment: .trailing, spacing: 8) {
                    if let codexSessionFilePath = detail.task.codexSessionFilePath {
                        Button {
                            openFile(codexSessionFilePath)
                        } label: {
                            Label("Open Codex Session", systemImage: "terminal")
                                .frame(minWidth: 170)
                        }
                        .buttonStyle(.borderedProminent)
                    }

                    HStack(spacing: 8) {
                        if let workspacePath = detail.task.workspacePath {
                            Button {
                                openFile(workspacePath)
                            } label: {
                                Label("Workspace", systemImage: "folder")
                            }
                            .buttonStyle(.bordered)
                        }

                        if let reportURL = detail.task.reportURL {
                            Button {
                                openURL(reportURL)
                            } label: {
                                Label("Report", systemImage: "doc.text")
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .controlSize(.small)
                }
            }

            if detail.task.status == "awaiting_human_input" || detail.task.status == "awaiting_plan_approval" || detail.task.status == "awaiting_git_approval" {
                HStack(spacing: 10) {
                    Image(systemName: "hand.raised.fill")
                        .foregroundStyle(WorkbenchTheme.approvalAmber)
                    Text("Agent is paused. Review the context here, then continue from the iPhone approval flow or the Codex session.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(WorkbenchTheme.approvalAmber.opacity(0.10))
                )
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(WorkbenchTheme.elevated.opacity(0.96))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }

    private func taskSummaryPanel(_ detail: LocalTaskDetail) -> some View {
        WorkbenchPanel(title: "Task Metadata", caption: "Repository, branch, session, and local identifiers") {
            HStack(alignment: .top) {
                StatusBadge(title: detail.task.statusTitle, tint: localStatusTint(detail.task.status))
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text(detail.task.displayUpdatedAt)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let publishedAt = detail.task.displayLastPublishedAt {
                        Text("Published \(publishedAt)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            MarkdownTextBlock(detail.task.displaySubtitle)

            infoGrid(taskInfoItems(for: detail.task))
        }
    }

    private func taskOpenPanel(_ detail: LocalTaskDetail) -> some View {
        WorkbenchPanel(title: "Open", caption: "Jump to the report, workspace, or raw task files") {
            actionGrid {
                if let reportURL = detail.task.reportURL {
                    actionButton("Open GitHub Report", systemImage: "doc.text") {
                        openURL(reportURL)
                    }
                }

                if let workspacePath = detail.task.workspacePath {
                    actionButton("Open Workspace", systemImage: "folder") {
                        openFile(workspacePath)
                    }
                }

                if let codexSessionFilePath = detail.task.codexSessionFilePath {
                    actionButton("Open Codex Session", systemImage: "text.badge.plus") {
                        openFile(codexSessionFilePath)
                    }
                }

                actionButton("Open Task Folder", systemImage: "folder.badge.person.crop") {
                    openFile(taskFolderPath(for: detail.task.id))
                }

                if !detail.artifactFiles.isEmpty {
                    actionButton("Open Artifacts Folder", systemImage: "shippingbox") {
                        openFile(artifactsFolderPath(for: detail.task.id))
                    }
                }

                actionButton("Open History Window", systemImage: "clock.arrow.circlepath") {
                    openWindow(id: "history")
                }
            }
        }
    }

    private func taskCodexPreviewPanel(_ detail: LocalTaskDetail) -> some View {
        WorkbenchPanel(title: "Agent Summary", caption: detail.codexSessionPreview?.displayLastUpdatedAt ?? "Waiting for session output") {
            if let preview = detail.codexSessionPreview, let primaryText = preview.primaryText, !primaryText.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    MarkdownTextBlock(primaryText)

                    actionGrid {
                        actionButton("Open Codex Session", systemImage: "text.badge.plus") {
                            openFile(preview.sessionFilePath)
                        }
                    }
                }
            } else {
                WorkbenchEmptyState(
                    title: "No readable Codex output yet",
                    detail: "When the local session writes a plan or final answer, it will appear here automatically."
                )
            }
        }
    }

    private func taskTimelinePanel(_ detail: LocalTaskDetail) -> some View {
        WorkbenchPanel(title: "Timeline", caption: "\(detail.events.count) saved local events") {
            if detail.events.isEmpty {
                WorkbenchEmptyState(
                    title: "No local events recorded",
                    detail: "As the runner writes execution milestones, the timeline will appear here."
                )
            } else {
                VStack(spacing: 12) {
                    ForEach(detail.events.prefix(10)) { event in
                        timelineEntry(event)
                    }
                }
            }
        }
    }

    private func taskArtifactsPanel(_ detail: LocalTaskDetail) -> some View {
        WorkbenchPanel(title: "Artifacts", caption: "\(detail.artifactFiles.count) saved files") {
            VStack(spacing: 10) {
                ForEach(detail.artifactFiles) { artifact in
                    fileInspectorButton(artifact.title, path: artifact.path)
                }

                Text("Stored in \(artifactsFolderPath(for: detail.task.id)). Each planning or implementation turn can write its own `.md` or `.jsonl` snapshot here.")
                    .font(.caption)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func taskPromptPanel(_ detail: LocalTaskDetail) -> some View {
        WorkbenchPanel(title: "Prompt", caption: detail.task.executionModeTitle) {
            MarkdownTextBlock(detail.task.prompt, tone: .secondary)
        }
    }

    private func timelineEntry(_ event: LocalTaskEventEntry) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Text(event.title)
                    .font(.headline)
                Spacer()
                Text(event.displayRecordedAt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            MarkdownTextBlock(event.detail, tone: .secondary, font: .callout)

            HStack(spacing: 8) {
                if let artifactPath = event.artifactPath {
                    smallInlineButton("Artifact", systemImage: "doc.text") {
                        openFile(artifactPath)
                    }
                }

                if let codexOutputPath = event.codexOutputPath {
                    smallInlineButton("Output", systemImage: "terminal") {
                        openFile(codexOutputPath)
                    }
                }

                if let reportURL = event.reportURL {
                    smallInlineButton("Report", systemImage: "arrow.up.right.square") {
                        openURL(reportURL)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                .fill(WorkbenchTheme.panel.opacity(0.72))
        )
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }

    private var workbenchBackground: some View {
        Color(nsColor: .windowBackgroundColor)
            .ignoresSafeArea()
    }

    private var sidebarBackground: some View {
        Color(nsColor: .windowBackgroundColor)
    }

    private var columnBackground: some View {
        Color(nsColor: .controlBackgroundColor)
    }

    private var inspectorBackground: some View {
        Color(nsColor: .windowBackgroundColor)
    }

    private var panelFill: Color {
        WorkbenchTheme.elevated
    }

    private var pendingApprovals: [ApprovalRequest] {
        appModel.approvals.filter(\.isPending)
    }

    private var onlineRunnerCount: Int {
        appModel.runners.filter(\.isOnline).count
    }

    private var completedTaskCount: Int {
        localMachineModel.localTasks.filter { $0.status == "completed" }.count
    }

    private var activeBoardTasks: [LocalTaskSummary] {
        localMachineModel.localTasks.filter { !$0.status.isTerminalDesktopStatus }
    }

    private var featuredProjects: [LocalProjectConfig] {
        sortedProjects.filter(\.isFeatured)
    }

    private var standardProjects: [LocalProjectConfig] {
        sortedProjects.filter { !$0.isFeatured }
    }

    private var activeLocalTask: LocalTaskSummary? {
        localMachineModel.localTasks.first(where: { !$0.status.isTerminalDesktopStatus })
    }

    private var mostRelevantLocalTask: LocalTaskSummary? {
        activeLocalTask ?? localMachineModel.localTasks.first
    }

    private var sortedProjects: [LocalProjectConfig] {
        localMachineModel.projects.sorted { lhs, rhs in
            if lhs.isFeatured != rhs.isFeatured {
                return lhs.isFeatured && !rhs.isFeatured
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private var selectedApproval: ApprovalRequest? {
        appModel.approvals.first(where: { $0.id == selectedApprovalID })
    }

    private var selectedProject: LocalProjectConfig? {
        localMachineModel.projects.first(where: { $0.id == selectedProjectID })
    }

    private var selectedRemoteRunner: RunnerInfo? {
        guard case let .remote(id) = selectedRunnerSelection else {
            return nil
        }
        return appModel.runners.first(where: { $0.id == id })
    }

    private var localRunnerCaption: String {
        switch localMachineModel.serviceState {
        case let .running(pid):
            if let pid {
                return "LaunchAgent active with pid \(pid)"
            }
            return "LaunchAgent active"
        case .loaded:
            return "LaunchAgent is loaded but not currently running"
        case .stopped:
            return "LaunchAgent is currently stopped"
        case .checking:
            return "Checking launchctl state"
        case let .unavailable(message):
            return message
        }
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

    private func badgeText(for section: WorkbenchSection) -> String? {
        switch section {
        case .home:
            return "\(pendingApprovals.count + activeBoardTasks.count)"
        case .projects:
            return "\(featuredProjects.count)"
        case .history:
            return "\(localMachineModel.localTasks.count)"
        case .runner:
            return "\(onlineRunnerCount)"
        }
    }

    private func relatedTasks(for project: LocalProjectConfig) -> [LocalTaskSummary] {
        localMachineModel.localTasks.filter { task in
            if let projectId = task.projectId, !projectId.isEmpty, projectId == project.id {
                return true
            }

            if let projectName = task.projectName, !projectName.isEmpty, projectName == project.name {
                return true
            }

            return task.repo == project.repo
        }
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

        if let existingProject = localMachineModel.projects.first(where: { $0.repo == repoPath }) {
            selectedSection = .projects
            selectedProjectID = existingProject.id
            return
        }

        let displayName = url.lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Local Project"
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

        selectedSection = .projects
        selectedProjectID = project.id
        localMachineModel.saveProjects(localMachineModel.projects + [project])
    }

    private func removeProject(id: String) {
        let nextProjects = localMachineModel.projects.filter { $0.id != id }
        if selectedProjectID == id {
            selectedProjectID = nextProjects.first?.id
        }
        localMachineModel.saveProjects(nextProjects)
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

    private func taskInfoItems(for task: LocalTaskSummary) -> [(String, String)] {
        var items: [(String, String)] = [
            ("Task ID", task.id),
            ("Repository", task.repo),
            ("Base Branch", task.baseBranch),
            ("Session", task.sessionAlias),
            ("Mode", task.executionModeTitle)
        ]

        if let threadId = task.threadId, !threadId.isEmpty {
            items.append(("Codex Thread", threadId))
        }

        return items
    }

    private func compactStatePill(_ title: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(title)
                .font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            Capsule(style: .continuous)
                .fill(color.opacity(0.10))
        )
        .overlay(
            Capsule(style: .continuous)
                .strokeBorder(color.opacity(0.22), lineWidth: 1)
        )
    }

    private func boardLane<Content: View>(
        title: String,
        subtitle: String,
        isEmpty: Bool,
        emptyTitle: String,
        emptyDetail: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        WorkbenchPanel(title: title, caption: subtitle) {
            VStack(alignment: .leading, spacing: 12) {
                if isEmpty {
                    if !emptyTitle.isEmpty {
                        WorkbenchEmptyState(title: emptyTitle, detail: emptyDetail)
                    }
                } else {
                    content()
                }
            }
        }
    }

    private func actionGrid<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 190), spacing: 10)], spacing: 10) {
            content()
        }
    }

    private func actionButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.bordered)
    }

    private func previewButton<Label: View>(action: @escaping () -> Void, @ViewBuilder label: () -> Label) -> some View {
        Button(action: action) {
            label()
        }
        .buttonStyle(.plain)
    }

    private func smallInlineButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private func sectionHeader(title: String, detail: String, actionTitle: String? = nil, action: (() -> Void)? = nil) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
            }

            Spacer()

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.bordered)
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 16)
        .padding(.bottom, 8)
        .background(columnBackground)
        .overlay(alignment: .bottom) {
            Divider().overlay(WorkbenchTheme.divider)
        }
    }

    private func infoGrid(_ items: [(String, String)]) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 12)], spacing: 12) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                infoRow(item.0, value: item.1)
            }
        }
    }

    private func infoRow(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func inspectorActionButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.bordered)
    }

    private func fileInspectorButton(_ title: String, path: String) -> some View {
        inspectorActionButton(title, systemImage: "arrow.up.right.square") {
            openFile(path)
        }
    }

    private func quickSidebarButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private func taskFolderPath(for taskId: String) -> String {
        "\(localMachineModel.paths.tasksPath)/\(taskId)"
    }

    private func artifactsFolderPath(for taskId: String) -> String {
        "\(taskFolderPath(for: taskId))/artifacts"
    }

    private func refreshSnapshot() {
        appModel.refreshAll()
        localMachineModel.refresh()
    }

    private func refreshSelectedTaskDetail() async {
        guard let selectedTaskID else {
            taskDetail = nil
            return
        }

        taskDetail = await localMachineModel.loadTaskDetail(taskId: selectedTaskID)
    }

    private func openFile(_ path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    private func openURL(_ rawValue: String) {
        guard let url = URL(string: rawValue) else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    private func autoSelectLandingSection() {
        let hasLocalTasks = !localMachineModel.localTasks.isEmpty
        let hasProjects = !sortedProjects.isEmpty

        switch selectedSection {
        case .home, .history:
            guard !hasLocalTasks else {
                return
            }
            selectedSection = hasProjects ? .projects : .runner
        case .projects:
            guard !hasProjects else {
                return
            }
            selectedSection = hasLocalTasks ? .home : .runner
        case .runner:
            return
        }
    }

    private func focusOnMostRelevantTaskIfNeeded(force: Bool = false) {
        guard let task = mostRelevantLocalTask else {
            selectedTaskID = nil
            return
        }

        if force {
            selectedSection = .home
            selectedTaskID = task.id
            return
        }

        guard let currentSelectedTaskID = selectedTaskID else {
            selectedTaskID = task.id
            return
        }

        let selectionStillExists = localMachineModel.localTasks.contains(where: { $0.id == currentSelectedTaskID })
        if !selectionStillExists {
            selectedTaskID = task.id
            return
        }

        if selectedSection == .home, task.id == activeLocalTask?.id {
            selectedTaskID = task.id
        }
    }

    private func bootstrapSelection(for section: WorkbenchSection) {
        switch section {
        case .home, .history:
            selectedTaskID = selectedTaskID ?? localMachineModel.localTasks.first?.id
        case .projects:
            selectedProjectID = selectedProjectID ?? sortedProjects.first?.id
        case .runner:
            if selectedRunnerSelection == nil {
                selectedRunnerSelection = .local
            }
        }
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

private struct MacAttentionPanel: View {
    let eyebrow: String
    let title: String
    let detail: String
    let status: String
    let tint: Color
    let primaryAction: String

    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    StatusBadge(title: status, tint: tint)
                    Text(eyebrow.uppercased())
                        .font(.caption.weight(.bold))
                        .foregroundStyle(tint)
                }

                Text(title)
                    .font(.system(.title2, design: .rounded).weight(.semibold))
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                    .lineLimit(2)

                Text(detail)
                    .font(.callout)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 20)

            HStack(spacing: 8) {
                Text(primaryAction)
                    .font(.callout.weight(.semibold))
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(
                Capsule(style: .continuous)
                    .fill(tint)
            )
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(WorkbenchTheme.elevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(tint.opacity(0.24), lineWidth: 1)
        )
    }
}

private struct MacSummaryMetric: View {
    let title: String
    let value: String
    let caption: String
    let icon: String
    let tint: Color

    var body: some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(tint.opacity(0.14))
                .frame(width: 38, height: 38)
                .overlay(
                    Image(systemName: icon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(tint)
                )

            VStack(alignment: .leading, spacing: 3) {
                Text(value)
                    .font(.system(size: 24, weight: .semibold, design: .rounded))
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                    .lineLimit(1)
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 86, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(WorkbenchTheme.elevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }
}

private struct MacTaskTableHeader: View {
    var body: some View {
        HStack(spacing: 14) {
            Text("Status")
                .frame(width: 124, alignment: .leading)
            Text("Task")
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Project")
                .frame(width: 126, alignment: .leading)
            Text("Updated")
                .frame(width: 86, alignment: .trailing)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
    }
}

private struct MacTaskTableRow: View {
    let task: LocalTaskSummary
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 14) {
            HStack(spacing: 8) {
                Circle()
                    .fill(tint)
                    .frame(width: 8, height: 8)
                Text(task.statusTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
                    .lineLimit(1)
            }
            .frame(width: 124, alignment: .leading)

            VStack(alignment: .leading, spacing: 4) {
                Text(task.displayTitle)
                    .font(.system(.subheadline, design: .rounded).weight(.semibold))
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                    .lineLimit(1)
                Text(task.id)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Text(task.projectDisplayName)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: 126, alignment: .leading)

            Text(task.displayUpdatedAt)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: 86, alignment: .trailing)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.10) : Color.clear)
        )
    }

    private var tint: Color {
        switch task.status {
        case "completed":
            return WorkbenchTheme.completedGreen
        case "failed", "blocked_conflict":
            return WorkbenchTheme.dangerRose
        case "awaiting_plan_approval", "awaiting_git_approval", "awaiting_human_input":
            return WorkbenchTheme.approvalAmber
        case "running":
            return WorkbenchTheme.runningBlue
        default:
            return WorkbenchTheme.infoCyan
        }
    }
}

private struct MacJournalTableRow: View {
    let entry: RunnerActivityEntry

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(tint.opacity(0.12))
                .frame(width: 30, height: 30)
                .overlay(
                    Image(systemName: icon)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(tint)
                )

            VStack(alignment: .leading, spacing: 4) {
                Text(entry.displayTitle)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                    .lineLimit(1)
                Text(entry.displaySubtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 12)

            Text(entry.relativeTimestamp)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private var icon: String {
        switch entry.event {
        case "assignment_completed", "utility_completed":
            return "checkmark.circle.fill"
        case "assignment_failed":
            return "xmark.circle.fill"
        case "assignment_claimed":
            return "bolt.horizontal.fill"
        default:
            return "terminal.fill"
        }
    }

    private var tint: Color {
        switch entry.event {
        case "assignment_completed", "utility_completed":
            return WorkbenchTheme.completedGreen
        case "assignment_failed":
            return WorkbenchTheme.dangerRose
        case "assignment_claimed":
            return WorkbenchTheme.runningBlue
        default:
            return WorkbenchTheme.infoCyan
        }
    }
}

private struct MacProjectCompactRow: View {
    let project: LocalProjectConfig
    let historyCount: Int

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: project.isFeatured ? "star.fill" : "folder.fill")
                .foregroundStyle(project.isFeatured ? WorkbenchTheme.approvalAmber : WorkbenchTheme.runningBlue)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 4) {
                Text(project.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(project.repo)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(project.baseBranch)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            Text("\(historyCount) runs")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

private struct TaskRow: View {
    let task: LocalTaskSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.displayTitle)
                        .font(.headline)
                        .lineLimit(2)

                    Text(task.projectDisplayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()
                StatusBadge(title: task.statusTitle, tint: tint)
            }

            MarkdownTextBlock(
                task.displaySubtitle,
                tone: .secondary,
                font: .subheadline,
                allowsSelection: false,
                lineLimit: 4
            )

            HStack(spacing: 10) {
                Label(task.baseBranch, systemImage: "arrow.triangle.branch")

                if task.reportURL != nil {
                    Label("Report", systemImage: "doc.text")
                }

                Spacer()
                Text(task.displayUpdatedAt)
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
    }

    private var tint: Color {
        switch task.status {
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

private struct ApprovalRow: View {
    let approval: ApprovalRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(approval.title)
                        .font(.headline)
                    Text(approval.type.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusBadge(title: approval.status.title, tint: approval.status.tint)
            }

            MarkdownTextBlock(
                approval.detail,
                tone: .secondary,
                font: .subheadline,
                allowsSelection: false,
                lineLimit: 4
            )

            Text(approval.taskId)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
    }
}

private struct ProjectRow: View {
    let project: LocalProjectConfig

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(project.name)
                            .font(.headline)

                        if project.isFeatured {
                            Image(systemName: "star.fill")
                                .font(.caption)
                                .foregroundStyle(WorkbenchTheme.approvalAmber)
                        }
                    }

                    Text(project.repo)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                Text(project.baseBranch)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }

            Text(project.defaultTaskTitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 6)
    }
}

private struct ProjectLibraryRow: View {
    let project: LocalProjectConfig
    let historyCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Label {
                    Text(project.name)
                        .font(.headline)
                        .lineLimit(1)
                } icon: {
                    Image(systemName: project.isFeatured ? "star.fill" : "folder.fill")
                        .foregroundStyle(project.isFeatured ? WorkbenchTheme.approvalAmber : WorkbenchTheme.runningBlue)
                }

                Spacer()

                Text(project.baseBranch)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            Text(project.repo)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            HStack(spacing: 10) {
                Text(project.defaultTaskTitle)
                    .lineLimit(1)

                Spacer()

                Text("\(historyCount) runs")
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 6)
    }
}

private struct RunnerRow: View {
    let runner: RunnerInfo

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(runner.name)
                    .font(.headline)
                Text(runner.id)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let currentTaskId = runner.currentTaskId, !currentTaskId.isEmpty {
                    Text(currentTaskId)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()
            StatusBadge(title: runner.isOnline ? "Online" : "Offline", tint: runner.isOnline ? WorkbenchTheme.completedGreen : WorkbenchTheme.offlineGray)
        }
        .padding(.vertical, 6)
    }
}

private struct LocalRunnerRow: View {
    let serviceState: RunnerServiceState

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "laptopcomputer.and.iphone")
                .foregroundStyle(Color.accentColor)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 4) {
                Text("This Mac")
                    .font(.headline)
                Text(serviceState.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
            StatusBadge(title: serviceState.title, tint: tint)
        }
        .padding(.vertical, 6)
    }

    private var tint: Color {
        switch serviceState {
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
}

private struct ActivityRow: View {
    let entry: RunnerActivityEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.displayTitle)
                        .font(.headline)
                    Text(entry.taskId)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()
                Text(entry.relativeTimestamp)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            Text(entry.displaySubtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(4)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                .fill(WorkbenchTheme.panel.opacity(0.72))
        )
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }
}

private struct WorkbenchPanel<Content: View>: View {
    let title: String
    let caption: String?
    @ViewBuilder var content: Content

    init(title: String, caption: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.caption = caption
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(.headline, design: .rounded).weight(.semibold))
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                if let caption, !caption.isEmpty {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                }
            }

            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(WorkbenchTheme.elevated)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }
}

private struct WorkbenchEmptyState: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(WorkbenchTheme.textPrimary)
            Text(detail)
                .font(.callout)
                .foregroundStyle(WorkbenchTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(WorkbenchTheme.panel.opacity(0.86))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }
}

private extension LocalTaskSummary {
    var executionModeTitle: String {
        if let threadId, !threadId.isEmpty {
            return "Resume History"
        }
        return "New Thread"
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }

    var isTerminalDesktopStatus: Bool {
        switch self {
        case "completed", "failed", "blocked_conflict":
            return true
        default:
            return false
        }
    }
}
