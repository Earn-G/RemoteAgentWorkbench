import SwiftUI

struct ProjectDetailScreen: View {
    @ObservedObject var appModel: AppModel
    @StateObject private var store: ProjectDetailStore
    @State private var showingCreateSheet = false
    @State private var createSheetMode: ProjectTaskSheetMode = .review
    @State private var pendingTaskDestination: TaskDestination?
    @Environment(\.openURL) private var openURL

    init(appModel: AppModel, project: ProjectSummary) {
        self.appModel = appModel
        _store = StateObject(wrappedValue: ProjectDetailStore(project: project, apiClient: appModel.makeAPIClient()))
    }

    var body: some View {
        ZStack {
            WorkbenchBackground()

            ScrollView {
                VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xl) {
                    projectHeroSection
                    projectInfoGrid

                    if let latestResultSummary = store.project.latestResultSummary, !latestResultSummary.isEmpty {
                        latestResultCard(latestResultSummary)
                    }

                    recentTasksSections
                }
                .padding(.horizontal, WorkbenchTheme.Spacing.md)
                .padding(.top, WorkbenchTheme.Spacing.lg)
                .padding(.bottom, 120)
            }
            .releaseToRefresh(isRefreshing: store.isLoading) {
                store.refresh()
            }
        }
        .navigationTitle(store.project.name)
        .navigationBarTitleDisplayMode(.inline)
        .workbenchNavigationChrome()
        .navigationDestination(item: $pendingTaskDestination) { destination in
            TaskDetailScreen(appModel: appModel, taskId: destination.id)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    store.refresh()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
        }
        .sheet(isPresented: $showingCreateSheet) {
            ProjectTaskSheet(store: store, mode: createSheetMode)
        }
        .onReceive(store.$lastCreatedTaskID.compactMap { $0 }) { taskId in
            showingCreateSheet = false
            pendingTaskDestination = TaskDestination(id: taskId)
            store.lastCreatedTaskID = nil
        }
        .onAppear {
            store.loadIfNeeded()
        }
        .alert("Project Error", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { value in
                if !value {
                    store.errorMessage = nil
                }
            }
        )) {
            Button("OK", role: .cancel) { }
        } message: {
            Text(store.errorMessage ?? "")
        }
    }

    private var projectHeroSection: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.lg) {
            HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.md) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: ProjectDisplay.folderSystemImage)
                        .font(.system(size: 32, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 66, height: 66)
                        .background(
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(.white.opacity(0.18))
                        )

                    if store.project.isFeatured {
                        Image(systemName: "star.fill")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(WorkbenchTheme.approvalAmber)
                            .padding(6)
                            .background(Circle().fill(.white.opacity(0.22)))
                            .offset(x: 5, y: -5)
                    }
                }

                VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xs) {
                    Text(store.project.name)
                        .font(WorkbenchTheme.Typography.heroTitle)
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(store.project.repo)
                        .font(WorkbenchTheme.Typography.body)
                        .foregroundStyle(.white.opacity(0.78))
                        .lineLimit(2)
                }

                Spacer(minLength: WorkbenchTheme.Spacing.sm)
            }

            HStack(spacing: WorkbenchTheme.Spacing.xs) {
                WorkbenchInlineTag(store.project.baseBranch, systemImage: "arrow.triangle.branch", tint: .white.opacity(0.92))

                if store.project.isFeatured {
                    WorkbenchInlineTag("Pinned", systemImage: "star.fill", tint: .white.opacity(0.92))
                }

                if store.project.pendingApprovalsCount > 0 {
                    WorkbenchInlineTag("\(store.project.pendingApprovalsCount) Pending", systemImage: "exclamationmark.bubble.fill", tint: .white.opacity(0.92))
                }
            }

            VStack(spacing: WorkbenchTheme.Spacing.sm) {
                startTaskButton(primaryTaskMode, isPrimary: true)
                startTaskButton(secondaryTaskMode, isPrimary: false)
            }
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .background(
            ZStack(alignment: .topTrailing) {
                LinearGradient(
                    colors: [WorkbenchTheme.agentViolet, WorkbenchTheme.agentBlue, WorkbenchTheme.runningBlue],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )

                Circle()
                    .fill(.white.opacity(0.18))
                    .frame(width: 180, height: 180)
                    .offset(x: 70, y: -90)
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.panel, style: .continuous)
                .strokeBorder(.white.opacity(0.16), lineWidth: 1)
        )
        .shadow(color: WorkbenchTheme.agentBlue.opacity(0.22), radius: 26, x: 0, y: 16)
    }

    private var primaryTaskMode: ProjectTaskSheetMode {
        store.project.deliveryMode == .directCommit ? .directSubmit : .review
    }

    private var secondaryTaskMode: ProjectTaskSheetMode {
        store.project.deliveryMode == .directCommit ? .review : .directSubmit
    }

    private func openCreateSheet(_ mode: ProjectTaskSheetMode) {
        createSheetMode = mode
        showingCreateSheet = true
    }

    private func startTaskButton(_ mode: ProjectTaskSheetMode, isPrimary: Bool) -> some View {
        Button {
            openCreateSheet(mode)
        } label: {
            HStack(spacing: WorkbenchTheme.Spacing.sm) {
                Label(taskModeTitle(mode), systemImage: taskModeSystemImage(mode))
                    .font(WorkbenchTheme.Typography.bodyEmphasis)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                Spacer()
                Text(isPrimary ? "Default" : "Also available")
                    .font(WorkbenchTheme.Typography.badge)
                    .foregroundStyle(.white.opacity(isPrimary ? 0.84 : 0.66))
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, WorkbenchTheme.Spacing.md)
            .frame(height: WorkbenchTheme.Metrics.primaryButtonHeight)
            .background(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.control, style: .continuous)
                    .fill(.white.opacity(isPrimary ? 0.22 : 0.12))
            )
            .overlay(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.control, style: .continuous)
                    .strokeBorder(.white.opacity(isPrimary ? 0.18 : 0.10), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private func taskModeTitle(_ mode: ProjectTaskSheetMode) -> String {
        switch mode {
        case .directSubmit:
            "Direct Submit"
        case .review:
            "Review Task"
        }
    }

    private func taskModeSystemImage(_ mode: ProjectTaskSheetMode) -> String {
        switch mode {
        case .directSubmit:
            "arrow.down.doc.fill"
        case .review:
            "doc.text.magnifyingglass"
        }
    }

    private var projectInfoGrid: some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible(), spacing: WorkbenchTheme.Spacing.sm),
                GridItem(.flexible(), spacing: WorkbenchTheme.Spacing.sm)
            ],
            spacing: WorkbenchTheme.Spacing.sm
        ) {
            ProjectInfoTile(title: "Runner", value: store.project.runnerId, systemImage: "desktopcomputer", tint: WorkbenchTheme.slate)
            ProjectInfoTile(title: "Recent Tasks", value: "\(store.project.recentTasksCount)", systemImage: "checklist", tint: WorkbenchTheme.agentViolet)
            ProjectInfoTile(title: "Updated", value: store.project.displayUpdatedAt, systemImage: "clock", tint: WorkbenchTheme.runningBlue)
            ProjectInfoTile(title: "Delivery", value: store.project.deliveryMode.title, systemImage: "arrow.triangle.branch", tint: WorkbenchTheme.actionMint)
        }
    }

    private func latestResultCard(_ latestResultSummary: String) -> some View {
        SectionCard(title: "Latest Result", caption: "Compact report synced from the Mac runner.") {
            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
                if let latestTaskTitle = store.project.latestTaskTitle, !latestTaskTitle.isEmpty {
                    Text(latestTaskTitle)
                        .font(WorkbenchTheme.Typography.cardTitle)
                        .foregroundStyle(WorkbenchTheme.textPrimary)
                        .lineLimit(2)
                }

                MarkdownTextBlock(latestResultSummary, tone: .secondary, font: WorkbenchTheme.Typography.body)

                HStack(spacing: WorkbenchTheme.Spacing.sm) {
                    if let latestReportURL = store.project.latestReportURL, let url = URL(string: latestReportURL) {
                        Button("Open Report") {
                            openURL(url)
                        }
                        .buttonStyle(.bordered)
                    }

                    if let latestTaskId = store.project.latestTaskId {
                        NavigationLink {
                            TaskDetailScreen(appModel: appModel, taskId: latestTaskId)
                        } label: {
                            Text("Open Task")
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var recentTasksSections: some View {
        if store.isLoading && store.tasks.isEmpty {
            ProgressView("Loading tasks...")
                .frame(maxWidth: .infinity, minHeight: 180)
                .workbenchCard()
        } else {
            ProjectTaskLane(
                title: "Needs Approval",
                tint: WorkbenchTheme.approvalAmber,
                tasks: tasks(in: [.awaitingPlanApproval, .awaitingGitApproval]),
                emptyText: "Nothing is paused on approval for this project.",
                row: projectTaskRow
            )

            ProjectTaskLane(
                title: "Running",
                tint: WorkbenchTheme.runningBlue,
                tasks: tasks(in: [.queued, .preparingWorkspace, .running]),
                emptyText: "No active runner turn is currently in flight.",
                row: projectTaskRow
            )

            ProjectTaskLane(
                title: "Recent Results",
                tint: WorkbenchTheme.actionMint,
                tasks: tasks(in: [.awaitingHumanInput, .completed, .failed, .canceled]),
                emptyText: "No recent result has been synced for this preset yet.",
                row: projectTaskRow
            )
        }
    }

    private func tasks(in statuses: [TaskStatus]) -> [TaskRecord] {
        store.tasks.filter { statuses.contains($0.status) }
    }

    private func projectTaskRow(_ task: TaskRecord) -> some View {
        NavigationLink {
            TaskDetailScreen(appModel: appModel, taskId: task.id)
        } label: {
            HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.md) {
                WorkbenchIconBox(systemImage: taskIcon(for: task), tint: task.status.tint)

                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: WorkbenchTheme.Spacing.xs) {
                        StatusBadge(title: task.status.title, tint: task.status.tint)
                        Text(task.displayUpdatedAt)
                            .font(WorkbenchTheme.Typography.metadata)
                            .foregroundStyle(WorkbenchTheme.textMuted)
                    }

                    Text(task.displayTitle)
                        .font(WorkbenchTheme.Typography.cardTitle)
                        .foregroundStyle(WorkbenchTheme.textPrimary)
                        .lineLimit(2)

                    Text(task.displaySubtitle)
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                        .lineLimit(2)

                    Label(task.branchDisplayTitle, systemImage: "arrow.triangle.branch")
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textMuted)
                        .lineLimit(1)
                }

                Spacer(minLength: WorkbenchTheme.Spacing.xs)

                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WorkbenchTheme.textMuted)
                    .padding(.top, 6)
            }
            .padding(WorkbenchTheme.Spacing.md)
            .workbenchCard(tint: task.status.tint)
        }
        .buttonStyle(.plain)
    }

    private func taskIcon(for task: TaskRecord) -> String {
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

private struct ProjectInfoTile: View {
    let title: String
    let value: String
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
            WorkbenchIconBox(systemImage: systemImage, tint: tint)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(WorkbenchTheme.Typography.metadata)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
                Text(value)
                    .font(WorkbenchTheme.Typography.bodyEmphasis)
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.82)
                    .textSelection(.enabled)
            }
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .frame(
            maxWidth: .infinity,
            minHeight: ProjectInfoGridMetrics.tileHeight,
            maxHeight: ProjectInfoGridMetrics.tileHeight,
            alignment: .leading
        )
        .workbenchCard(tint: tint)
    }
}

private struct ProjectTaskLane<Row: View>: View {
    let title: String
    let tint: Color
    let tasks: [TaskRecord]
    let emptyText: String
    let row: (TaskRecord) -> Row

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.sm) {
            HStack {
                Text(title)
                    .font(WorkbenchTheme.Typography.sectionTitle)
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                Spacer()
                Text("\(tasks.count)")
                    .font(WorkbenchTheme.Typography.badge)
                    .foregroundStyle(tint)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(tint.opacity(0.14)))
            }

            if tasks.isEmpty {
                Text(emptyText)
                    .font(WorkbenchTheme.Typography.body)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
                    .padding(WorkbenchTheme.Spacing.lg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .workbenchCard()
            } else {
                VStack(spacing: WorkbenchTheme.Spacing.sm) {
                    ForEach(tasks.prefix(4)) { task in
                        row(task)
                    }
                }
            }
        }
    }
}

private struct TaskDestination: Identifiable, Hashable {
    let id: String
}
