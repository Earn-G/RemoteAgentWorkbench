import AppKit
import Combine
import SwiftUI

struct LocalHistoryWindow: View {
    @ObservedObject var appModel: AppModel
    @ObservedObject var localMachineModel: LocalMachineModel
    @State private var selectedTaskID: String?
    @State private var detail: LocalTaskDetail?
    @State private var pendingDeletionTask: LocalTaskSummary?
    @State private var deleteErrorMessage: String?
    @State private var isDeleting = false
    @State private var deleteCancellable: AnyCancellable?
    private let refreshTimer = Timer.publish(every: 4, on: .main, in: .common).autoconnect()

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedTaskID) {
                Section {
                    historyHeader
                        .listRowInsets(EdgeInsets(top: 10, leading: 14, bottom: 14, trailing: 14))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }

                Section("Tasks") {
                    ForEach(localMachineModel.localTasks) { task in
                        historyRow(task)
                            .tag(Optional(task.id))
                    }
                }
            }
            .navigationTitle("Local History")
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .background(WorkbenchBackground())
        } detail: {
            ScrollView {
                if let detail {
                    VStack(alignment: .leading, spacing: 18) {
                        overview(detail)
                        deletion(detail)
                        shortcuts(detail)
                        codexPreview(detail)
                        artifacts(detail)
                        timeline(detail)
                    }
                    .padding(20)
                } else {
                    ContentUnavailableView(
                        "Select a Task",
                        systemImage: "clock.arrow.circlepath",
                        description: Text("Pick a local task from the sidebar to inspect its timeline, shortcuts, and artifacts.")
                    )
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .safeAreaPadding(.top)
            .background(WorkbenchBackground())
        }
        .toolbar {
            ToolbarItemGroup {
                Button {
                    localMachineModel.refresh()
                    if selectedTaskID == nil {
                        selectedTaskID = localMachineModel.localTasks.first?.id
                    }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }

                Button {
                    openPath(localMachineModel.paths.tasksPath)
                } label: {
                    Label("Open Tasks Folder", systemImage: "folder")
                }
            }
        }
        .onAppear {
            localMachineModel.refresh()
            if selectedTaskID == nil {
                selectedTaskID = localMachineModel.localTasks.first?.id
            }
        }
        .onReceive(refreshTimer) { _ in
            guard selectedTaskID != nil else { return }
            localMachineModel.refresh()
            Task {
                await refreshSelectedTaskDetail()
            }
        }
        .task(id: selectedTaskID) {
            await refreshSelectedTaskDetail()
        }
        .onChange(of: localMachineModel.localTasks) { _, _ in
            Task {
                await refreshSelectedTaskDetail()
            }
        }
        .confirmationDialog(
            "Delete Task Record",
            isPresented: Binding(
                get: { pendingDeletionTask != nil },
                set: { value in
                    if !value {
                        pendingDeletionTask = nil
                    }
                }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Cloud", role: .destructive) {
                startDelete(cloudAndLocal: false)
            }
            Button("Delete Cloud + Local", role: .destructive) {
                startDelete(cloudAndLocal: true)
            }
            Button("Cancel", role: .cancel) {
                pendingDeletionTask = nil
            }
        } message: {
            Text("Cloud deletion removes the server record. Cloud + Local also removes the local task folder and any managed worktree under the runner's own worktree root.")
        }
        .alert("Delete Failed", isPresented: Binding(
            get: { deleteErrorMessage != nil },
            set: { value in
                if !value {
                    deleteErrorMessage = nil
                }
            }
        )) {
            Button("OK", role: .cancel) { }
        } message: {
            Text(deleteErrorMessage ?? "")
        }
    }

    private var historyHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(LinearGradient(
                        colors: [WorkbenchTheme.heroStart, WorkbenchTheme.heroMiddle, WorkbenchTheme.heroEnd],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ))
                    .frame(width: 42, height: 42)
                    .overlay(
                        Image(systemName: "clock.arrow.circlepath")
                            .foregroundStyle(.white)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text("Local History")
                        .font(.system(.title3, design: .rounded).weight(.semibold))
                    Text("Task snapshots, artifacts, and event timeline")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text(localMachineModel.paths.tasksPath)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .lineLimit(2)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(WorkbenchTheme.cardStrong.opacity(0.92))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(WorkbenchTheme.cardBorder)
        )
    }

    private func historyRow(_ task: LocalTaskSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.displayTitle)
                        .font(.headline)
                        .lineLimit(2)
                    Text(task.projectDisplayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

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
        .padding(.vertical, 6)
    }

    private func overview(_ detail: LocalTaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(detail.task.displayTitle)
                        .font(.system(size: 28, weight: .semibold, design: .rounded))
                        .lineLimit(2)
                    Text(detail.task.projectDisplayName)
                        .font(.callout)
                        .foregroundStyle(.white.opacity(0.78))
                }

                Spacer()

                StatusBadge(title: detail.task.statusTitle, tint: localStatusTint(detail.task.status))
            }

            MarkdownTextBlock(detail.task.displaySubtitle, tone: .inverse)

            HStack(spacing: 10) {
                overviewChip("Repo", detail.task.repo)
                overviewChip("Branch", detail.task.baseBranch)
                overviewChip("Updated", detail.task.displayUpdatedAt)
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [WorkbenchTheme.heroStart, WorkbenchTheme.heroMiddle, WorkbenchTheme.heroEnd],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        )
        .foregroundStyle(.white)
    }

    private func deletion(_ detail: LocalTaskDetail) -> some View {
        sectionCard(title: "Deletion", caption: "Aggressive cleanup for cloud and local history") {
            VStack(alignment: .leading, spacing: 12) {
                if detail.task.isTerminal {
                    Button(role: .destructive) {
                        pendingDeletionTask = detail.task
                    } label: {
                        Label("Delete Record", systemImage: "trash")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isDeleting)

                    if isDeleting {
                        ProgressView("Deleting...")
                            .controlSize(.small)
                    }

                    Text("Choose `Delete Cloud` to remove only the server record, or `Delete Cloud + Local` to also remove the local task folder and managed worktree.")
                        .font(.caption)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                } else {
                    Text("Cloud deletion is available after the task reaches `completed`, `failed`, or `canceled`.")
                        .font(.caption)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                }
            }
        }
    }

    private func shortcuts(_ detail: LocalTaskDetail) -> some View {
        sectionCard(title: "Shortcuts", caption: "Open local workspace and session artifacts") {
            VStack(alignment: .leading, spacing: 10) {
                if let workspacePath = detail.task.workspacePath {
                    shortcutButton("Open Workspace", path: workspacePath)
                }
                if let codexSessionFilePath = detail.task.codexSessionFilePath {
                    shortcutButton("Open Codex Session", path: codexSessionFilePath)
                }
                if let reportURL = detail.task.reportURL, let url = URL(string: reportURL) {
                    Button("Open GitHub Report") {
                        NSWorkspace.shared.open(url)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }

    private func codexPreview(_ detail: LocalTaskDetail) -> some View {
        sectionCard(title: "Codex Preview", caption: detail.codexSessionPreview?.displayLastUpdatedAt ?? "Waiting for session output") {
            if let preview = detail.codexSessionPreview, let primaryText = preview.primaryText, !primaryText.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    MarkdownTextBlock(primaryText)

                    HStack(spacing: 10) {
                        shortcutButton("Open Codex Session", path: preview.sessionFilePath)
                    }
                }
            } else {
                emptyState("No readable Codex output yet. Once the session produces a plan or final answer, it will show here automatically.")
            }
        }
    }

    private func artifacts(_ detail: LocalTaskDetail) -> some View {
        sectionCard(title: "Artifacts", caption: "\(detail.artifactFiles.count) files") {
            VStack(alignment: .leading, spacing: 8) {
                if detail.artifactFiles.isEmpty {
                    emptyState("No local artifacts saved yet.")
                } else {
                    ForEach(detail.artifactFiles) { artifact in
                        shortcutButton(artifact.title, path: artifact.path)
                    }
                }

                Text("Stored in \(localMachineModel.paths.tasksPath)/\(detail.task.id)/artifacts. Each planning or implementation turn can save a separate local snapshot here.")
                    .font(.caption)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
            }
        }
    }

    private func timeline(_ detail: LocalTaskDetail) -> some View {
        sectionCard(title: "Timeline", caption: "\(detail.events.count) events") {
            if detail.events.isEmpty {
                emptyState("No local timeline entries yet.")
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(detail.events) { event in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .top) {
                                Text(event.title)
                                    .font(.headline)
                                Spacer()
                                Text(event.displayRecordedAt)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            MarkdownTextBlock(event.detail, tone: .secondary, font: .subheadline)

                            HStack(spacing: 10) {
                                if let artifactPath = event.artifactPath {
                                    shortcutButton("Open Artifact", path: artifactPath)
                                }

                                if let codexOutputPath = event.codexOutputPath {
                                    shortcutButton("Open Codex Output", path: codexOutputPath)
                                }
                            }
                        }
                        .padding(14)
                        .background(
                            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                                .fill(WorkbenchTheme.panel.opacity(0.88))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
                        )
                    }
                }
            }
        }
    }

    private func sectionCard<Content: View>(title: String, caption: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                if let caption {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                }
            }

            content()
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.panel, style: .continuous)
                .fill(WorkbenchTheme.elevated.opacity(0.92))
        )
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.panel, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }

    private func overviewChip(_ title: String, _ value: String) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white.opacity(0.72))
            Text(value)
                .font(.caption.weight(.medium))
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            Capsule(style: .continuous)
                .fill(Color.white.opacity(0.12))
        )
    }

    private func emptyState(_ message: String) -> some View {
        Text(message)
            .foregroundStyle(WorkbenchTheme.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func shortcutButton(_ title: String, path: String) -> some View {
        Button(title) {
            openPath(path)
        }
        .buttonStyle(.bordered)
    }

    private func openPath(_ path: String) {
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    private func refreshSelectedTaskDetail() async {
        guard let selectedTaskID else {
            detail = nil
            return
        }
        detail = await localMachineModel.loadTaskDetail(taskId: selectedTaskID)
    }

    private func startDelete(cloudAndLocal: Bool) {
        guard let task = pendingDeletionTask else { return }

        deleteCancellable?.cancel()
        isDeleting = true

        deleteCancellable = appModel.makeAPIClient().deleteTask(taskId: task.id)
            .receive(on: DispatchQueue.main)
            .sink { completion in
                if case let .failure(error) = completion {
                    if cloudAndLocal,
                       case let .requestFailed(statusCode, _) = error,
                       statusCode == 404 {
                        finalizeLocalDelete(task)
                        return
                    }

                    isDeleting = false
                    deleteErrorMessage = error.localizedDescription
                }
            } receiveValue: {
                appModel.refreshTaskInbox()
                appModel.refreshAll()

                guard cloudAndLocal else {
                    isDeleting = false
                    pendingDeletionTask = nil
                    Task {
                        await refreshSelectedTaskDetail()
                    }
                    return
                }

                finalizeLocalDelete(task)
            }
    }

    private func finalizeLocalDelete(_ task: LocalTaskSummary) {
        localMachineModel.deleteLocalTask(task, removeManagedWorkspace: true) { result in
            isDeleting = false
            pendingDeletionTask = nil

            switch result {
            case .success:
                if selectedTaskID == task.id {
                    selectedTaskID = localMachineModel.localTasks.first?.id
                }
                Task {
                    await refreshSelectedTaskDetail()
                }
            case let .failure(error):
                deleteErrorMessage = error.localizedDescription
            }
        }
    }

    private func localStatusTint(_ value: String) -> Color {
        switch value {
        case "completed":
            return .green
        case "failed", "blocked_conflict":
            return .red
        case "awaiting_plan_approval", "awaiting_git_approval":
            return .orange
        case "running":
            return .indigo
        case "awaiting_human_input":
            return .teal
        default:
            return .blue
        }
    }
}
