import SwiftUI

private enum InboxFilter: String, CaseIterable, Identifiable {
    case all
    case needsApproval
    case running
    case followUp

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all:
            "All"
        case .needsApproval:
            "Review"
        case .running:
            "Running"
        case .followUp:
            "Follow-Up"
        }
    }
}

private struct InboxSection: Identifiable {
    let id: String
    let title: String
    let tint: Color
    let tasks: [TaskRecord]
}

struct TasksScreen: View {
    @ObservedObject var appModel: AppModel
    @State private var navigationPath: [String] = []
    @State private var selectedFilter: InboxFilter = .all
    @State private var searchText = ""

    private var pendingApprovalTaskIDs: Set<String> {
        Set(appModel.approvals.filter(\.isPending).map(\.taskId))
    }

    private var trimmedSearchText: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredTasks: [TaskRecord] {
        let tasks = appModel.tasks.filter(matchesFilter).sortedByRecency()
        guard !trimmedSearchText.isEmpty else {
            return tasks
        }

        return tasks.filter { task in
            task.displayTitle.localizedCaseInsensitiveContains(trimmedSearchText) ||
            (task.projectName ?? task.repo).localizedCaseInsensitiveContains(trimmedSearchText) ||
            task.branchSearchText.localizedCaseInsensitiveContains(trimmedSearchText)
        }
    }

    private var taskSections: [InboxSection] {
        switch selectedFilter {
        case .all:
            let review = filteredTasks.filter(isReviewTask)
            let running = filteredTasks.filter(isRunningTask)
            let followUp = filteredTasks.filter(isFollowUpTask)
            let otherIDs = Set(review.map(\.id) + running.map(\.id) + followUp.map(\.id))
            let other = filteredTasks.filter { !otherIDs.contains($0.id) }

            return [
                InboxSection(id: "review", title: "Needs Review", tint: WorkbenchTheme.approvalAmber, tasks: review),
                InboxSection(id: "running", title: "Running", tint: WorkbenchTheme.runningBlue, tasks: running),
                InboxSection(id: "follow-up", title: "Ready for Follow-Up", tint: WorkbenchTheme.actionMint, tasks: followUp),
                InboxSection(id: "other", title: "Other", tint: WorkbenchTheme.textMuted, tasks: other)
            ]
            .filter { !$0.tasks.isEmpty }
        case .needsApproval:
            return [InboxSection(id: "review", title: "Needs Review", tint: WorkbenchTheme.approvalAmber, tasks: filteredTasks)]
        case .running:
            return [InboxSection(id: "running", title: "Running", tint: WorkbenchTheme.runningBlue, tasks: filteredTasks)]
        case .followUp:
            return [InboxSection(id: "follow-up", title: "Ready for Follow-Up", tint: WorkbenchTheme.actionMint, tasks: filteredTasks)]
        }
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            ZStack {
                WorkbenchBackground()

                VStack(spacing: 0) {
                    filterBar

                    ScrollView {
                        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.lg) {
                            TasksHeader(summaryText: summaryText)

                            content
                        }
                        .padding(.horizontal, WorkbenchTheme.Spacing.md)
                        .padding(.top, WorkbenchTheme.Spacing.md)
                        .padding(.bottom, 120)
                    }
                    .refreshable {
                        appModel.refreshTaskInbox()
                    }
                }
            }
            .navigationTitle("Tasks")
            .workbenchNavigationChrome()
            .searchable(text: $searchText, prompt: "Search task, project, or branch")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        appModel.refreshTaskInbox()
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
            .navigationDestination(for: String.self) { taskId in
                TaskDetailScreen(appModel: appModel, taskId: taskId)
            }
            .onReceive(appModel.$lastCreatedTaskID.compactMap { $0 }) { taskId in
                navigationPath = [taskId]
                appModel.clearCreatedTask()
            }
            .onAppear {
                appModel.refreshTaskInboxAfterCurrentLoadIfNeeded()
            }
            .alert("Request Failed", isPresented: Binding(
                get: { appModel.errorMessage != nil },
                set: { value in
                    if !value {
                        appModel.clearError()
                    }
                }
            )) {
                Button("OK", role: .cancel) { }
            } message: {
                Text(appModel.errorMessage ?? "")
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if appModel.tasks.isEmpty, appModel.isLoading {
            ProgressView("Loading tasks...")
                .frame(maxWidth: .infinity, minHeight: 260)
                .workbenchCard()
        } else if taskSections.isEmpty {
            ContentUnavailableView(
                filteredTasks.isEmpty && !trimmedSearchText.isEmpty ? "No Matching Tasks" : "No Tasks Yet",
                systemImage: filteredTasks.isEmpty && !trimmedSearchText.isEmpty ? "magnifyingglass" : "tray",
                description: Text(emptyStateDescription)
            )
            .padding(WorkbenchTheme.Spacing.xl)
            .frame(maxWidth: .infinity, minHeight: 280)
            .workbenchCard()
        } else {
            ForEach(taskSections) { section in
                taskSection(section)
            }
        }
    }

    private var filterBar: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xs) {
            Picker("Task Filter", selection: $selectedFilter) {
                ForEach(InboxFilter.allCases) { filter in
                    Text(filter.title).tag(filter)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(.horizontal, WorkbenchTheme.Spacing.md)
        .padding(.top, WorkbenchTheme.Spacing.sm)
        .padding(.bottom, WorkbenchTheme.Spacing.xs)
        .background(WorkbenchTheme.barBackground)
        .overlay(alignment: .bottom) {
            Divider().overlay(WorkbenchTheme.divider)
        }
    }

    private var summaryText: String {
        if trimmedSearchText.isEmpty {
            return "\(filteredTasks.count) task\(filteredTasks.count == 1 ? "" : "s") in \(sectionLabel.lowercased())."
        }

        return "\(filteredTasks.count) search result\(filteredTasks.count == 1 ? "" : "s") in \(sectionLabel.lowercased())."
    }

    private var emptyStateDescription: String {
        if !trimmedSearchText.isEmpty {
            return "Try a different project name, branch, or task title."
        }

        if appModel.tasks.isEmpty {
            return "Create tasks from Projects. Live status, approvals, and recent results will appear here."
        }

        return "Nothing matches the current filter."
    }

    private var sectionLabel: String {
        switch selectedFilter {
        case .all:
            "tasks"
        case .needsApproval:
            "needs review"
        case .running:
            "running"
        case .followUp:
            "follow-up"
        }
    }

    private func taskSection(_ section: InboxSection) -> some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xs) {
            HStack(spacing: WorkbenchTheme.Spacing.xs) {
                Circle()
                    .fill(section.tint)
                    .frame(width: 8, height: 8)

                Text(section.title)
                    .font(WorkbenchTheme.Typography.sectionTitle)
                    .foregroundStyle(WorkbenchTheme.textPrimary)

                Spacer()

                Text("\(section.tasks.count)")
                    .font(WorkbenchTheme.Typography.badge)
                    .foregroundStyle(section.tint)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(section.tint.opacity(0.14)))
            }

            VStack(spacing: WorkbenchTheme.Spacing.xs) {
                ForEach(section.tasks) { task in
                    NavigationLink(value: task.id) {
                        InboxTaskCard(
                            task: task,
                            badgeTitle: pendingApprovalTaskIDs.contains(task.id) ? "Needs Review" : task.status.title,
                            badgeTint: pendingApprovalTaskIDs.contains(task.id) ? WorkbenchTheme.approvalAmber : task.status.tint
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func matchesFilter(_ task: TaskRecord) -> Bool {
        switch selectedFilter {
        case .all:
            true
        case .needsApproval:
            isReviewTask(task)
        case .running:
            isRunningTask(task)
        case .followUp:
            isFollowUpTask(task)
        }
    }

    private func isReviewTask(_ task: TaskRecord) -> Bool {
        pendingApprovalTaskIDs.contains(task.id) ||
        task.status == .awaitingPlanApproval ||
        task.status == .awaitingGitApproval
    }

    private func isRunningTask(_ task: TaskRecord) -> Bool {
        [.queued, .preparingWorkspace, .running].contains(task.status)
    }

    private func isFollowUpTask(_ task: TaskRecord) -> Bool {
        [.awaitingHumanInput, .blockedConflict, .completed, .failed, .canceled].contains(task.status)
    }
}

private struct TasksHeader: View {
    let summaryText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Tasks")
                .font(WorkbenchTheme.Typography.pageTitle)
                .foregroundStyle(WorkbenchTheme.textPrimary)

            Text(summaryText)
                .font(WorkbenchTheme.Typography.body)
                .foregroundStyle(WorkbenchTheme.textSecondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct InboxTaskCard: View {
    let task: TaskRecord
    let badgeTitle: String
    let badgeTint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xs) {
            HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.sm) {
                WorkbenchIconBox(systemImage: taskIcon, tint: badgeTint)

                VStack(alignment: .leading, spacing: 3) {
                    Text(task.displayTitle)
                        .font(WorkbenchTheme.Typography.cardTitle)
                        .foregroundStyle(WorkbenchTheme.textPrimary)
                        .lineLimit(2)

                    Text(task.projectName ?? task.repo)
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                        .lineLimit(1)
                }

                Spacer(minLength: WorkbenchTheme.Spacing.xs)

                VStack(alignment: .trailing, spacing: 6) {
                    StatusBadge(title: badgeTitle, tint: badgeTint)
                    Text(task.displayUpdatedAt)
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textMuted)
                }
            }

            Text(task.displaySubtitle)
                .font(WorkbenchTheme.Typography.metadata)
                .foregroundStyle(WorkbenchTheme.textSecondary)
                .lineLimit(2)

            HStack(spacing: WorkbenchTheme.Spacing.sm) {
                Label(task.branchDisplayTitle, systemImage: "arrow.triangle.branch")
                if let runnerId = task.runnerId {
                    Label(runnerId, systemImage: "desktopcomputer")
                }
                Spacer()
                Image(systemName: "chevron.right")
            }
            .font(WorkbenchTheme.Typography.metadata)
            .foregroundStyle(WorkbenchTheme.textMuted)
            .lineLimit(1)
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .workbenchCard(tint: badgeTint.opacity(0.8))
    }

    private var taskIcon: String {
        switch task.status {
        case .running:
            "terminal"
        case .completed:
            "checkmark.circle.fill"
        case .failed, .blockedConflict:
            "exclamationmark.triangle.fill"
        case .awaitingPlanApproval, .awaitingGitApproval:
            "doc.text.fill"
        case .awaitingHumanInput:
            "bubble.left.and.bubble.right.fill"
        default:
            "arrow.triangle.branch"
        }
    }
}
