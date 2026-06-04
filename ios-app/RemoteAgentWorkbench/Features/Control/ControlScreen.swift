import SwiftUI

struct ControlScreen: View {
    @ObservedObject var appModel: AppModel
    let openProjects: () -> Void
    let openInbox: () -> Void

    @State private var showingCreateDirectorySheet = false

    private var pendingApprovalTaskIDs: Set<String> {
        Set(appModel.approvals.filter(\.isPending).map(\.taskId))
    }

    private var reviewTasks: [TaskRecord] {
        appModel.tasks.filter { task in
            pendingApprovalTaskIDs.contains(task.id) ||
            task.status == .awaitingPlanApproval ||
            task.status == .awaitingGitApproval
        }
        .sortedByRecency()
    }

    private var activeTasks: [TaskRecord] {
        appModel.tasks.filter { task in
            switch task.status {
            case .queued, .preparingWorkspace, .running:
                true
            default:
                false
            }
        }
        .sortedByRecency()
    }

    private var followUpTasks: [TaskRecord] {
        appModel.tasks.filter { task in
            switch task.status {
            case .awaitingHumanInput, .blockedConflict, .completed, .failed, .canceled:
                true
            default:
                false
            }
        }
        .sortedByRecency()
    }

    private var onlineRunnerCount: Int {
        appModel.runners.filter(\.isOnline).count
    }

    private var primaryRunner: RunnerInfo? {
        appModel.runners.first(where: \.isOnline) ?? appModel.runners.first
    }

    private var taskAttentionCount: Int {
        reviewTasks.count + activeTasks.count + followUpTasks.count
    }

    private var primaryAttentionTaskID: String? {
        reviewTasks.first?.id ?? activeTasks.first?.id ?? followUpTasks.first?.id
    }

    private var secondaryReviewTasks: [TaskRecord] {
        reviewTasks.filter { $0.id != primaryAttentionTaskID }
    }

    private var secondaryFollowUpTasks: [TaskRecord] {
        followUpTasks.filter { $0.id != primaryAttentionTaskID }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                WorkbenchBackground()

                ScrollView {
                    VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xl) {
                        NowHeader(
                            subtitle: headerSubtitle,
                            isLoading: appModel.isLoading
                        )

                        primaryAttentionCard

                        if let activeTask = activeTasks.first, !reviewTasks.contains(where: { $0.id == activeTask.id }) {
                            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.sm) {
                                sectionHeader("Running on Mac", count: activeTasks.count, tint: WorkbenchTheme.runningBlue)
                                NavigationLink {
                                    TaskDetailScreen(appModel: appModel, taskId: activeTask.id)
                                } label: {
                                    NowCompactTaskCard(
                                        task: activeTask,
                                        badgeTitle: activeTask.status.title,
                                        badgeTint: activeTask.status.tint,
                                        showsProgress: true
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }

                        runnerHealthCard

                        quickActions

                        if !secondaryReviewTasks.isEmpty || !secondaryFollowUpTasks.isEmpty {
                            attentionList
                        }
                    }
                    .padding(.horizontal, WorkbenchTheme.Spacing.md)
                    .padding(.top, WorkbenchTheme.Spacing.lg)
                    .padding(.bottom, 120)
                }
                .refreshable {
                    refreshSnapshot()
                }
            }
            .navigationTitle("Now")
            .navigationBarTitleDisplayMode(.inline)
            .workbenchNavigationChrome()
            .sheet(isPresented: $showingCreateDirectorySheet) {
                CreateDirectorySheet(appModel: appModel)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: refreshSnapshot) {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
            .task {
                await loadDashboardIfNeeded()
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

    private var headerSubtitle: String {
        if appModel.isLoading {
            return "Refreshing workspace status..."
        }

        if reviewTasks.isEmpty && activeTasks.isEmpty {
            return primaryRunner?.isOnline == true ? "Mac runner is ready." : "Waiting for runner connection."
        }

        return "Review, monitor, and continue remote agent work."
    }

    @ViewBuilder
    private var primaryAttentionCard: some View {
        if let task = reviewTasks.first {
            NavigationLink {
                TaskDetailScreen(appModel: appModel, taskId: task.id)
            } label: {
                NowHeroTaskCard(
                    eyebrow: "Needs your decision",
                    title: "Review the agent plan",
                    detail: "The runner is paused until you approve or request changes.",
                    task: task,
                    tint: WorkbenchTheme.approvalAmber,
                    actionTitle: "Review task",
                    systemImage: "exclamationmark.bubble.fill"
                )
            }
            .buttonStyle(.plain)
        } else if let task = activeTasks.first {
            NavigationLink {
                TaskDetailScreen(appModel: appModel, taskId: task.id)
            } label: {
                NowHeroTaskCard(
                    eyebrow: "Running now",
                    title: "Agent is working on your Mac",
                    detail: "Track progress, open the task, or refresh when the runner posts an update.",
                    task: task,
                    tint: WorkbenchTheme.runningBlue,
                    actionTitle: "Open task",
                    systemImage: "terminal.fill"
                )
            }
            .buttonStyle(.plain)
        } else if let task = followUpTasks.first {
            NavigationLink {
                TaskDetailScreen(appModel: appModel, taskId: task.id)
            } label: {
                NowHeroTaskCard(
                    eyebrow: "Ready for follow-up",
                    title: "Review the latest result",
                    detail: "Continue the same branch, open the report, or mark the task done.",
                    task: task,
                    tint: task.status.tint,
                    actionTitle: "Open result",
                    systemImage: "sparkles"
                )
            }
            .buttonStyle(.plain)
        } else {
            Button(action: openProjects) {
                NowEmptyHeroCard(
                    runnerOnline: primaryRunner?.isOnline == true
                )
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var runnerHealthCard: some View {
        let isOnline = primaryRunner?.isOnline == true
        let tint = isOnline ? WorkbenchTheme.completedGreen : WorkbenchTheme.offlineGray
        let title = primaryRunner == nil
            ? "No runner registered"
            : (isOnline ? "Mac runner online" : "Mac runner offline")
        let badgeTitle = isOnline ? "Ready" : "Offline"
        let detail = primaryRunner.map { runner in
            "\(runner.name) · \(runner.displayLastHeartbeatAt) · \(onlineRunnerCount) online"
        } ?? "Start the Mac runner and refresh to connect this phone."

        HStack(alignment: .center, spacing: WorkbenchTheme.Spacing.md) {
            WorkbenchIconBox(systemImage: "desktopcomputer", tint: tint)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: WorkbenchTheme.Spacing.xs) {
                    Text(title)
                        .font(WorkbenchTheme.Typography.cardTitle)
                        .foregroundStyle(WorkbenchTheme.textPrimary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.86)

                    StatusBadge(title: badgeTitle, tint: tint)

                    Spacer(minLength: 0)
                }

                Text(detail)
                    .font(WorkbenchTheme.Typography.metadata)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
        .workbenchCard(tint: tint)
    }

    private var quickActions: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.sm) {
            Text("Quick start")
                .font(WorkbenchTheme.Typography.sectionTitle)
                .foregroundStyle(WorkbenchTheme.textPrimary)

            LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: WorkbenchTheme.Spacing.sm),
                    GridItem(.flexible(), spacing: WorkbenchTheme.Spacing.sm)
                ],
                spacing: WorkbenchTheme.Spacing.sm
            ) {
                Button(action: openProjects) {
                    NowActionCard(title: "Projects", subtitle: "Start from repo", systemImage: "folder.fill", tint: WorkbenchTheme.agentViolet)
                }
                .buttonStyle(.plain)

                Button(action: openInbox) {
                    NowActionCard(title: "Tasks", subtitle: taskAttentionCount == 0 ? "All task history" : "\(taskAttentionCount) need attention", systemImage: "checklist", tint: WorkbenchTheme.runningBlue)
                }
                .buttonStyle(.plain)

                Button {
                    showingCreateDirectorySheet = true
                } label: {
                    NowActionCard(title: "Create Folder", subtitle: "Prepare workspace", systemImage: "plus.rectangle.fill", tint: WorkbenchTheme.actionMint)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var attentionList: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.sm) {
            sectionHeader("Needs attention", count: secondaryReviewTasks.count + secondaryFollowUpTasks.count, tint: WorkbenchTheme.approvalAmber)

            VStack(spacing: WorkbenchTheme.Spacing.sm) {
                ForEach(Array(secondaryReviewTasks.prefix(2))) { task in
                    NavigationLink {
                        TaskDetailScreen(appModel: appModel, taskId: task.id)
                    } label: {
                        NowCompactTaskCard(
                            task: task,
                            badgeTitle: pendingApprovalTaskIDs.contains(task.id) ? "Needs Review" : task.status.title,
                            badgeTint: pendingApprovalTaskIDs.contains(task.id) ? WorkbenchTheme.approvalAmber : task.status.tint,
                            showsProgress: false
                        )
                    }
                    .buttonStyle(.plain)
                }

                ForEach(Array(secondaryFollowUpTasks.prefix(3))) { task in
                    NavigationLink {
                        TaskDetailScreen(appModel: appModel, taskId: task.id)
                    } label: {
                        NowCompactTaskCard(
                            task: task,
                            badgeTitle: task.status.title,
                            badgeTint: task.status.tint,
                            showsProgress: false
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func sectionHeader(_ title: String, count: Int, tint: Color) -> some View {
        HStack(spacing: WorkbenchTheme.Spacing.xs) {
            Text(title)
                .font(WorkbenchTheme.Typography.sectionTitle)
                .foregroundStyle(WorkbenchTheme.textPrimary)

            Spacer()

            Text("\(count)")
                .font(WorkbenchTheme.Typography.badge)
                .foregroundStyle(tint)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(Capsule().fill(tint.opacity(0.14)))
        }
    }

    private func refreshSnapshot() {
        appModel.refreshAll()
        appModel.refreshTaskInbox()
    }

    private func loadDashboardIfNeeded() async {
        appModel.refreshAllIfNeeded()
        appModel.refreshTaskInboxAfterCurrentLoadIfNeeded()
    }
}

private struct NowHeader: View {
    let subtitle: String
    let isLoading: Bool

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 5) {
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    Text(TimeOfDayGreeting.title(for: context.date))
                        .font(WorkbenchTheme.Typography.pageTitle)
                        .foregroundStyle(WorkbenchTheme.textPrimary)
                }
                Text(isLoading ? "Refreshing..." : subtitle)
                    .font(WorkbenchTheme.Typography.body)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
            }

            Spacer()
        }
    }
}

private struct NowHeroTaskCard: View {
    let eyebrow: String
    let title: String
    let detail: String
    let task: TaskRecord
    let tint: Color
    let actionTitle: String
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.lg) {
            HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xs) {
                    Text(eyebrow.uppercased())
                        .font(WorkbenchTheme.Typography.badge)
                        .tracking(0.7)
                        .foregroundStyle(.white.opacity(0.72))

                    Text(title)
                        .font(WorkbenchTheme.Typography.heroTitle)
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(detail)
                        .font(WorkbenchTheme.Typography.body)
                        .foregroundStyle(.white.opacity(0.80))
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: WorkbenchTheme.Spacing.sm)

                Image(systemName: systemImage)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(.white.opacity(0.18)))
            }

            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.sm) {
                Text(task.displayTitle)
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)

                HStack(spacing: WorkbenchTheme.Spacing.xs) {
                    Label(task.projectName ?? task.repo, systemImage: "folder")
                    Text("·")
                    Text(task.displayUpdatedAt)
                }
                .font(WorkbenchTheme.Typography.metadata)
                .foregroundStyle(.white.opacity(0.78))
                .lineLimit(1)
            }
            .padding(WorkbenchTheme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                    .fill(.white.opacity(0.12))
            )
            .overlay(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                    .strokeBorder(.white.opacity(0.16), lineWidth: 1)
            )

            HStack {
                Text(actionTitle)
                    .font(WorkbenchTheme.Typography.bodyEmphasis)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, WorkbenchTheme.Spacing.md)
            .frame(height: WorkbenchTheme.Metrics.primaryButtonHeight)
            .background(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.control, style: .continuous)
                    .fill(.white.opacity(0.20))
            )
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .background(
            ZStack(alignment: .topTrailing) {
                LinearGradient(
                    colors: [WorkbenchTheme.agentViolet, WorkbenchTheme.agentBlue, tint],
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
        .shadow(color: tint.opacity(0.24), radius: 26, x: 0, y: 16)
    }
}

private struct NowEmptyHeroCard: View {
    let runnerOnline: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.lg) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xs) {
                    Text("ALL CLEAR")
                        .font(WorkbenchTheme.Typography.badge)
                        .tracking(0.7)
                        .foregroundStyle(.white.opacity(0.72))
                    Text("No tasks need your attention")
                        .font(WorkbenchTheme.Typography.heroTitle)
                        .foregroundStyle(.white)
                    Text(runnerOnline ? "Start a new agent task from a pinned project." : "Connect the Mac runner, then start from a project.")
                        .font(WorkbenchTheme.Typography.body)
                        .foregroundStyle(.white.opacity(0.80))
                }
                Spacer()
                Image(systemName: runnerOnline ? "checkmark.circle.fill" : "desktopcomputer")
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(.white.opacity(0.18)))
            }

            HStack {
                Text("Start from Projects")
                    .font(WorkbenchTheme.Typography.bodyEmphasis)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, WorkbenchTheme.Spacing.md)
            .frame(height: WorkbenchTheme.Metrics.primaryButtonHeight)
            .background(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.control, style: .continuous)
                    .fill(.white.opacity(0.20))
            )
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .background(
            LinearGradient(
                colors: [WorkbenchTheme.agentViolet, WorkbenchTheme.agentBlue, WorkbenchTheme.runningBlue],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .clipShape(RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.panel, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.panel, style: .continuous)
                .strokeBorder(.white.opacity(0.16), lineWidth: 1)
        )
        .shadow(color: WorkbenchTheme.agentBlue.opacity(0.22), radius: 26, x: 0, y: 16)
    }
}

private struct NowCompactTaskCard: View {
    let task: TaskRecord
    let badgeTitle: String
    let badgeTint: Color
    let showsProgress: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
            HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.md) {
                WorkbenchIconBox(systemImage: taskIcon, tint: badgeTint)

                VStack(alignment: .leading, spacing: 5) {
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

                VStack(alignment: .trailing, spacing: WorkbenchTheme.Spacing.xs) {
                    StatusBadge(title: badgeTitle, tint: badgeTint)
                    Text(task.displayUpdatedAt)
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textMuted)
                }
            }

            if showsProgress {
                HStack(spacing: WorkbenchTheme.Spacing.xs) {
                    Circle()
                        .fill(badgeTint)
                        .frame(width: 7, height: 7)
                    Text("Live status from Mac runner")
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textMuted)
                }
            }
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .workbenchCard(tint: badgeTint)
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

private struct NowActionCard: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
            WorkbenchIconBox(systemImage: systemImage, tint: tint)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(WorkbenchTheme.Typography.cardTitle)
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(WorkbenchTheme.Typography.metadata)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
                    .lineLimit(2)
            }
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .frame(maxWidth: .infinity, minHeight: 132, alignment: .leading)
        .workbenchCard(tint: tint)
    }
}
