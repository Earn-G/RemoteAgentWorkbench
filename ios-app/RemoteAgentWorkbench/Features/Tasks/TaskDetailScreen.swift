import Combine
import SwiftUI

private enum TaskDetailPanel: String, CaseIterable, Identifiable {
    case summary
    case updates
    case git
    case session

    var id: String { rawValue }

    var title: String {
        switch self {
        case .summary:
            "Summary"
        case .updates:
            "Updates"
        case .git:
            "Git"
        case .session:
            "Session"
        }
    }
}

private struct DeleteTaskConfirmationScreen: View {
    let taskTitle: String
    let repo: String
    let branchName: String
    let onCancel: () -> Void
    let onDelete: () -> Void

    var body: some View {
        NavigationStack {
            ZStack {
                WorkbenchBackground()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        WorkbenchHeroCard(
                            eyebrow: "Delete",
                            title: "Remove this task from server history?",
                            detail: "This keeps local task history on the Mac, but removes the cloud record from the iPhone inbox and task detail view."
                        ) {
                            ZStack {
                                Circle()
                                    .fill(.white.opacity(0.18))
                                    .frame(width: 52, height: 52)

                                Image(systemName: "trash")
                                    .font(.title3.weight(.semibold))
                                    .foregroundStyle(.white)
                            }
                        } content: {
                            Text("This action is intended for finished tasks only and cannot be undone from iPhone.")
                                .font(.subheadline)
                                .foregroundStyle(.white.opacity(0.82))
                                .fixedSize(horizontal: false, vertical: true)
                        }

                        SectionCard(title: "Delete Scope", caption: "Review the task before confirming the removal") {
                            VStack(alignment: .leading, spacing: 12) {
                                confirmationLine("Task", value: taskTitle)
                                confirmationLine("Repository", value: repo)
                                confirmationLine("Branch", value: branchName)
                                confirmationLine("Removes", value: "Server record, inbox entry, approvals, and compact artifacts")
                                confirmationLine("Keeps", value: "Full local history and workspace data on the Mac")
                            }
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.top, 12)
                    .padding(.bottom, 140)
                }
            }
            .navigationTitle("Delete Task")
            .navigationBarTitleDisplayMode(.inline)
            .workbenchNavigationChrome()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close", action: onCancel)
                }
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    Button(action: onDelete) {
                        Label("Delete Cloud Record", systemImage: "trash")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(WorkbenchTheme.rose)

                    Button("Keep Task", action: onCancel)
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 18)
                .padding(.top, 14)
                .padding(.bottom, 20)
                .background(.ultraThinMaterial)
            }
        }
        .interactiveDismissDisabled()
    }

    private func confirmationLine(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.caption2.weight(.semibold))
                .tracking(0.5)
                .foregroundStyle(.tertiary)

            Text(value)
                .font(WorkbenchTheme.Typography.body)
                .foregroundStyle(WorkbenchTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}

struct TaskDetailScreen: View {
    @ObservedObject var appModel: AppModel
    @StateObject private var store: TaskDetailStore
    @State private var commitMessage = "chore: apply codex workflow updates"
    @State private var pullRequestTitle = ""
    @State private var reviewTargetBranch = ""
    @State private var selectedPanel: TaskDetailPanel = .summary
    @State private var showStopConfirmation = false
    @State private var showDeleteConfirmation = false
    @State private var showClearWorkspaceConfirmation = false
    @State private var showCompleteConfirmation = false
    @State private var hasObservedPublishedBaseline = false
    @State private var lastObservedPublishedAt: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    init(appModel: AppModel, taskId: String) {
        self.appModel = appModel
        _store = StateObject(wrappedValue: TaskDetailStore(taskId: taskId, apiClient: appModel.makeAPIClient()))
    }

    var body: some View {
        Group {
            if let snapshot = store.snapshot {
                taskDetailList(snapshot)
            } else if store.isLoading {
                RefreshPlaceholderScrollView {
                    ProgressView("Loading task...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                RefreshPlaceholderScrollView {
                    ContentUnavailableView(
                        "Task Unavailable",
                        systemImage: "exclamationmark.triangle",
                        description: Text(store.errorMessage ?? "The task could not be loaded.")
                    )
                }
            }
        }
        .background(WorkbenchBackground())
        .navigationTitle(store.snapshot?.displayTitle ?? "Task")
        .navigationBarTitleDisplayMode(.inline)
        .workbenchNavigationChrome()
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    store.load()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }

                if let snapshot = store.snapshot, canStop(snapshot) {
                    Button {
                        showStopConfirmation = true
                    } label: {
                        Image(systemName: "stop.circle")
                    }
                    .foregroundStyle(.red)
                    .accessibilityLabel("Stop Task")
                    .alert("Stop Task?", isPresented: $showStopConfirmation) {
                        Button("Cancel", role: .cancel) { }
                        Button("Stop Task", role: .destructive) {
                            store.stopTask()
                            appModel.refreshTaskInbox()
                        }
                    } message: {
                        Text("The Mac runner will stop this task and halt local work.")
                    }
                }

                if let snapshot = store.snapshot, snapshot.status.isTerminal {
                    Button {
                        showDeleteConfirmation = true
                    } label: {
                        Image(systemName: "trash")
                    }
                    .foregroundStyle(.red)
                    .accessibilityLabel("Delete Task Record")
                }
            }
        }
        .onAppear {
            store.loadIfNeeded()
            if appModel.runners.isEmpty {
                appModel.refreshAll()
            }
        }
        .onReceive(store.$snapshot.map { $0?.lastPublishedAt }.removeDuplicates()) { publishedAt in
            defer {
                lastObservedPublishedAt = publishedAt
                hasObservedPublishedBaseline = true
            }

            guard hasObservedPublishedBaseline, lastObservedPublishedAt != publishedAt else {
                return
            }

            appModel.refreshTaskInbox()
            appModel.refreshAll()
        }
        .alert("Discard Local Changes?", isPresented: $showClearWorkspaceConfirmation) {
            Button("Cancel", role: .cancel) { }
            Button("Clear & Continue", role: .destructive) {
                store.resolveDirtyWorkspace(.clearAndContinue)
                appModel.refreshTaskInbox()
            }
        } message: {
            Text("This will discard local staged and unstaged changes in the current repository before preparing the task branch.")
        }
        .alert("Mark Task Completed?", isPresented: $showCompleteConfirmation) {
            Button("Cancel", role: .cancel) { }
            Button("Complete Task") {
                store.completeTask {
                    appModel.refreshTaskInbox()
                    appModel.refreshAll()
                }
            }
        } message: {
            Text(completeConfirmationMessage)
        }
        .onDisappear {
            store.stopStreaming()
        }
        .releaseToRefresh(isRefreshing: store.isLoading) {
            store.load()
        }
        .fullScreenCover(isPresented: $showDeleteConfirmation) {
            DeleteTaskConfirmationScreen(
                taskTitle: store.snapshot?.displayTitle ?? "Task",
                repo: store.snapshot?.repo ?? "Unknown",
                branchName: store.snapshot?.branchDisplayTitle ?? "Unknown",
                onCancel: {
                    showDeleteConfirmation = false
                },
                onDelete: {
                    store.deleteTask {
                        showDeleteConfirmation = false
                        appModel.refreshTaskInbox()
                        appModel.refreshAll()
                        dismiss()
                    }
                }
            )
        }
        .alert("Task Error", isPresented: Binding(
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
        .alert("Report Uploaded", isPresented: Binding(
            get: { store.reportUploadNotice != nil },
            set: { value in
                if !value {
                    store.reportUploadNotice = nil
                }
            }
        )) {
            if let reportURL = store.reportUploadNotice?.reportURL {
                Button("Open Report") {
                    openURL(reportURL)
                    store.reportUploadNotice = nil
                }
            }
            Button("OK", role: .cancel) {
                store.reportUploadNotice = nil
            }
        } message: {
            Text(store.reportUploadNotice?.message ?? "")
        }
    }

    private func taskDetailList(_ snapshot: TaskSnapshot) -> some View {
        List {
            overviewSection(snapshot)
            dirtyWorkspaceSection(snapshot)
            nextStepSection(snapshot)
            approvalsSection(snapshot)

            Section {
                panelPicker
                    .padding(.vertical, 4)
            } footer: {
                Text("Detailed repo, Git, timeline, and executor data stay one level below the primary action.")
            }

            panelContent(snapshot)
        }
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, WorkbenchTheme.Metrics.compactRowHeight)
        .scrollContentBackground(.hidden)
    }

    private func overviewSection(_ snapshot: TaskSnapshot) -> some View {
        Section {
            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
                HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.sm) {
                    Circle()
                        .fill(snapshot.status.tint)
                        .frame(width: 10, height: 10)
                        .padding(.top, 8)

                    VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xs) {
                        Text(snapshot.displayTitle)
                            .font(WorkbenchTheme.Typography.heroTitle)
                            .foregroundStyle(WorkbenchTheme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)

                        Text("#\(snapshot.id)")
                            .font(WorkbenchTheme.Typography.monoBadge)
                            .foregroundStyle(WorkbenchTheme.textMuted)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(
                                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.chip, style: .continuous)
                                    .fill(WorkbenchTheme.panel)
                            )
                    }

                    Spacer(minLength: WorkbenchTheme.Spacing.xs)

                    StatusBadge(title: snapshot.status.title, tint: snapshot.status.tint)
                }

                Text(snapshot.displaySubtitle)
                    .font(WorkbenchTheme.Typography.body)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)

                LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                    overviewMetaCard("Project", value: snapshot.projectName ?? snapshot.repo, systemImage: "folder")
                    overviewMetaCard("Base Branch", value: snapshot.baseBranch, systemImage: "arrow.triangle.branch")
                    overviewMetaCard("Runner", value: snapshot.runnerId ?? "Waiting", systemImage: "desktopcomputer")
                    overviewMetaCard("Updated", value: snapshot.displayUpdatedAt, systemImage: "clock")
                }
            }
            .padding(WorkbenchTheme.Spacing.lg)
            .workbenchCard(tint: snapshot.status.tint)
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        .listRowBackground(Color.clear)
    }

    @ViewBuilder
    private func dirtyWorkspaceSection(_ snapshot: TaskSnapshot) -> some View {
        if let dirtyWorkspace = snapshot.dirtyWorkspace, dirtyWorkspace.state == .pendingDecision {
            Section("Workspace Decision") {
                VStack(alignment: .leading, spacing: 12) {
                    taskNotice(snapshot.summary, tint: .orange)

                    if let branch = dirtyWorkspace.currentBranch ?? snapshot.executionBranch {
                        detailLine("Current Branch", value: branch)
                    }

                    if let statusSummary = dirtyWorkspace.statusSummary, !statusSummary.isEmpty {
                        MarkdownTextBlock(statusSummary, tone: .secondary, font: .caption, allowsSelection: false, lineLimit: 10)
                            .padding(12)
                            .background(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .fill(WorkbenchTheme.cardStrong)
                            )
                    }

                    actionGrid {
                        if snapshot.deliveryMode == .directCommit {
                            actionButton("Use Current Workspace") {
                                store.resolveDirtyWorkspace(.continueCurrentWorkspace)
                                appModel.refreshTaskInbox()
                            }
                            actionButton("Plan Only") {
                                store.resolveDirtyWorkspace(.planOnly)
                                appModel.refreshTaskInbox()
                            }
                            actionButton("Clear & Continue") {
                                showClearWorkspaceConfirmation = true
                            }
                        } else {
                            actionButton("Clear & Continue") {
                                showClearWorkspaceConfirmation = true
                            }
                            actionButton("Use Current Workspace") {
                                store.resolveDirtyWorkspace(.continueCurrentWorkspace)
                                appModel.refreshTaskInbox()
                            }
                            actionButton("Plan Only") {
                                store.resolveDirtyWorkspace(.planOnly)
                                appModel.refreshTaskInbox()
                            }
                        }
                        Button("Cancel Task", role: .destructive) {
                            store.resolveDirtyWorkspace(.cancel)
                            appModel.refreshTaskInbox()
                        }
                        .buttonStyle(.bordered)
                    }

                    Text(snapshot.deliveryMode == .directCommit
                        ? "Direct Submit is optimized for the workspace already open on the Mac. Use Current Workspace to keep going there, or Plan Only to inspect the local changes without editing files. Clear remains destructive."
                        : "Clear is an explicit destructive action: it discards local staged and unstaged changes before the task branch is prepared. Current workspace keeps the repo as-is and plans against that exact state.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }
        }
    }

    @ViewBuilder
    private func nextStepSection(_ snapshot: TaskSnapshot) -> some View {
        Section("Next Step") {
            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(nextStepHeadline(snapshot))
                        .font(WorkbenchTheme.Typography.sectionTitle)

                    Text(nextStepCaption(snapshot))
                        .font(WorkbenchTheme.Typography.body)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                        .lineLimit(3)
                }

                if canComplete(snapshot) {
                    actionTileGrid {
                        Button {
                            store.continueImplementation()
                            appModel.refreshTaskInbox()
                        } label: {
                            actionTileLabel(primaryActionTitle(for: snapshot), systemImage: "play.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(WorkbenchTheme.runningBlue)

                        Button {
                            showCompleteConfirmation = true
                        } label: {
                            actionTileLabel("Complete Task", systemImage: "checkmark")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(WorkbenchTheme.completedGreen)
                    }
                } else {
                    Button {
                        if canContinue(snapshot) {
                            store.continueImplementation()
                            appModel.refreshTaskInbox()
                        } else {
                            store.load()
                        }
                    } label: {
                        actionTileLabel(primaryActionTitle(for: snapshot), systemImage: canContinue(snapshot) ? "play.fill" : "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(hasPendingApproval(snapshot) ? WorkbenchTheme.approvalAmber : WorkbenchTheme.runningBlue)
                    .frame(maxWidth: .infinity)
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        if let reportURL = snapshot.reportURL, let url = URL(string: reportURL) {
                            secondaryActionButton("Open Report", systemImage: "doc.text") {
                                openURL(url)
                            }
                        }

                        if canRecheckWorkspace(snapshot) {
                            secondaryActionButton("Recheck", systemImage: "arrow.clockwise") {
                                store.recheckWorkspace()
                                appModel.refreshTaskInbox()
                            }
                        }

                        secondaryActionButton("Open In Codex", systemImage: "macwindow") {
                            store.openInCodexApp()
                        }
                    }
                    .padding(.horizontal, 1)
                }

                if let note = nextStepNote(snapshot) {
                    Text(note)
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(hasPendingApproval(snapshot) || hasPendingDirtyWorkspaceDecision(snapshot) ? WorkbenchTheme.approvalAmber : WorkbenchTheme.textSecondary)
                        .lineLimit(3)
                }
            }
            .padding(WorkbenchTheme.Spacing.md)
            .workbenchCard(tint: hasPendingApproval(snapshot) ? WorkbenchTheme.approvalAmber : WorkbenchTheme.runningBlue)
        }
        .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
        .listRowBackground(Color.clear)
    }

    @ViewBuilder
    private func approvalsSection(_ snapshot: TaskSnapshot) -> some View {
        if !snapshot.approvals.isEmpty {
            Section {
                ForEach(snapshot.approvals) { approval in
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(alignment: .top) {
                            Text(approval.title)
                                .font(.headline)
                            Spacer()
                            StatusBadge(title: approval.status.title, tint: approval.status.tint)
                        }

                        MarkdownTextBlock(approval.detail, tone: .secondary, font: .subheadline)

                        if approval.isPending {
                            HStack(spacing: 10) {
                                Button("Deny", role: .destructive) {
                                    store.resolveApproval(approvalId: approval.id, decision: "deny") {
                                        appModel.refreshTaskInbox()
                                    }
                                }
                                .buttonStyle(.bordered)

                                Button("Approve") {
                                    store.resolveApproval(approvalId: approval.id, decision: "approve") {
                                        appModel.refreshTaskInbox()
                                    }
                                }
                                .buttonStyle(.borderedProminent)
                            }
                        }
                    }
                    .padding(.vertical, 6)
                }
            } header: {
                Text("Approvals")
            } footer: {
                Text("Approve or deny here. The runner will only continue after the decision is synced back to the Mac.")
            }
        }
    }

    private var panelPicker: some View {
        Picker("Panel", selection: $selectedPanel) {
            ForEach(TaskDetailPanel.allCases) { panel in
                Text(panel.title).tag(panel)
            }
        }
        .pickerStyle(.segmented)
    }

    @ViewBuilder
    private func panelContent(_ snapshot: TaskSnapshot) -> some View {
        switch selectedPanel {
        case .summary:
            summarySections(snapshot)
        case .updates:
            updatesSections(snapshot)
        case .git:
            gitActionsSection(snapshot)
        case .session:
            sessionSection(snapshot)
        }
    }

    private func summarySections(_ snapshot: TaskSnapshot) -> some View {
        Group {
            Section("Summary") {
                VStack(alignment: .leading, spacing: 12) {
                    MarkdownTextBlock(snapshot.summary, tone: .secondary, font: .subheadline)

                    VStack(spacing: 12) {
                        detailLine("Repository", value: snapshot.repo)
                        detailLine("Base Branch", value: snapshot.baseBranch)
                        detailLine("Workflow", value: snapshot.deliveryMode.title)
                        detailLine("Completion", value: completionRuleTitle(for: snapshot), trailing: completionRuleTrailing(for: snapshot))
                        if snapshot.deliveryMode == .directCommit {
                            detailLine("Auto Push", value: snapshot.autoPush ? "Enabled" : "Off", trailing: snapshot.autoPush ? "existing remote branch only" : nil)
                        }
                        detailLine("Execution Branch", value: snapshot.executionBranch ?? snapshot.dirtyWorkspace?.currentBranch ?? "Pending")
                        detailLine("Resume Thread", value: resumeThreadLabel(for: snapshot))
                    }
                }
                .padding(.vertical, 4)
            }

            latestUpdateSection(snapshot)
            resultArtifactsSection(snapshot)
            followUpSection(snapshot)
        }
    }

    private func updatesSections(_ snapshot: TaskSnapshot) -> some View {
        Group {
            latestUpdateSection(snapshot)
            executionTimelineSection(snapshot)
        }
    }

    @ViewBuilder
    private func sessionSection(_ snapshot: TaskSnapshot) -> some View {
        if let executorSession = snapshot.executorSession {
            Section("Executor Session") {
                VStack(alignment: .leading, spacing: 12) {
                    detailLine("Alias", value: executorSession.sessionAlias)
                    detailLine("Executor", value: executorSession.executorType)
                    detailLine("Runner", value: executorSession.runnerId)
                    detailLine("Workspace", value: executorSession.cwd)
                    detailLine("Thread", value: executorSession.threadId)
                    detailLine("Last Turn", value: executorSession.displayLastTurnAt)
                }
                .padding(.vertical, 4)
            }
        } else {
            Section("Executor Session") {
                Text("The runner has not attached a Codex session to this task yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 4)
            }
        }
    }

    private func followUpSection(_ snapshot: TaskSnapshot) -> some View {
        Section("Follow-up") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Send another instruction to the same task branch once the task is no longer waiting on approval or workspace cleanup.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                TextEditor(text: $store.followUpText)
                    .frame(minHeight: 140)
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(WorkbenchTheme.cardStrong)
                    )

                HStack {
                    Spacer()
                    Button("Send") {
                        store.sendFollowUp()
                        appModel.refreshTaskInbox()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(
                        store.followUpText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        hasPendingApproval(snapshot) ||
                        hasPendingDirtyWorkspaceDecision(snapshot)
                    )
                }
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func gitActionsSection(_ snapshot: TaskSnapshot) -> some View {
        if isPlainLocalFolderTask(snapshot) {
            Section("Git Actions") {
                VStack(alignment: .leading, spacing: 10) {
                    Label("No Git repository detected", systemImage: "folder")
                        .font(WorkbenchTheme.Typography.bodyEmphasis)
                        .foregroundStyle(WorkbenchTheme.textPrimary)

                    Text("This task is running in a plain local folder. RemoteAgentWorkbench can still create and edit files there; completion does not require commit, push, PR, or MR actions.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)
            }
        } else {
            let showsReviewActions = snapshot.deliveryMode == .reviewRequired
            let supportsCreateReview = runnerSupportsCreateReview(snapshot)
            let reviewPlatform = snapshot.reviewPlatform
            let reviewTitle = reviewPlatform?.reviewTitle ?? "PR/MR"
            let createReviewTitle = reviewPlatform?.createActionTitle ?? "Create Review"
            let reviewNoun = reviewPlatform?.reviewNoun ?? "review request"
            let targetBranchOptions = reviewTargetBranchOptions(for: snapshot)

            Section("Git Actions") {
                VStack(alignment: .leading, spacing: 12) {
                    Text(gitActionsIntro(for: snapshot))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                TextField("Commit message", text: $commitMessage)
                    .textFieldStyle(.roundedBorder)

                if showsReviewActions {
                    TextField("\(reviewTitle) Title (Optional)", text: $pullRequestTitle)
                        .textFieldStyle(.roundedBorder)

                    Picker(
                        "Target Branch",
                        selection: Binding(
                            get: { resolvedReviewTargetBranch(for: snapshot) },
                            set: { reviewTargetBranch = $0 }
                        )
                    ) {
                        ForEach(targetBranchOptions, id: \.self) { branch in
                            Text(branch).tag(branch)
                        }
                    }
                    .pickerStyle(.menu)
                }

                if showsReviewActions {
                    Text("If you leave the title empty, the task title will be used for the \(reviewNoun).")
                        .font(.caption)
                        .foregroundStyle(WorkbenchTheme.textSecondary)

                    Text("The \(reviewNoun) will target `\(resolvedReviewTargetBranch(for: snapshot))`.")
                        .font(.caption)
                        .foregroundStyle(WorkbenchTheme.textSecondary)

                    Text("`\(createReviewTitle)` only uses committed changes. `Commit + \(createReviewTitle)` will commit current local changes first, then create the \(reviewNoun).")
                        .font(.caption)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                }

                if showsReviewActions {
                    VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.sm) {
                        gitActionGroupTitle("Recommended")

                        Button {
                            store.requestReviewAction(
                                title: resolvedPullRequestTitle(for: snapshot),
                                targetBranch: resolvedReviewTargetBranch(for: snapshot),
                                reviewMode: .commitAndReview,
                                commitMessage: commitMessage
                            )
                            appModel.refreshTaskInbox()
                        } label: {
                            Label("Commit + \(createReviewTitle)", systemImage: "arrow.up.doc.fill")
                                .font(WorkbenchTheme.Typography.bodyEmphasis)
                                .frame(maxWidth: .infinity)
                                .frame(height: WorkbenchTheme.Metrics.primaryButtonHeight)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(WorkbenchTheme.agentViolet)
                        .disabled(supportsCreateReview == false || hasPendingDirtyWorkspaceDecision(snapshot))

                        gitActionGroupTitle("Other actions")
                        actionGrid {
                            actionButton("Commit only", disabled: hasPendingDirtyWorkspaceDecision(snapshot)) {
                                store.requestGitAction(.commit, message: commitMessage)
                                appModel.refreshTaskInbox()
                            }
                            actionButton(createReviewTitle, disabled: supportsCreateReview == false || hasPendingDirtyWorkspaceDecision(snapshot)) {
                                store.requestReviewAction(
                                    title: resolvedPullRequestTitle(for: snapshot),
                                    targetBranch: resolvedReviewTargetBranch(for: snapshot),
                                    reviewMode: .reviewOnly,
                                    commitMessage: nil
                                )
                                appModel.refreshTaskInbox()
                            }
                        }

                        gitActionGroupTitle("Advanced")
                        actionGrid {
                            actionButton("Rebase", disabled: hasPendingDirtyWorkspaceDecision(snapshot)) {
                                store.requestGitAction(.rebase)
                                appModel.refreshTaskInbox()
                            }
                            actionButton("Push branch", disabled: hasPendingDirtyWorkspaceDecision(snapshot)) {
                                store.requestGitAction(.push)
                                appModel.refreshTaskInbox()
                            }
                        }
                    }
                } else {
                    actionGrid {
                        actionButton("Commit Now", disabled: hasPendingDirtyWorkspaceDecision(snapshot)) {
                            store.requestGitAction(.commit, message: commitMessage)
                            appModel.refreshTaskInbox()
                        }
                        actionButton("Push Branch", disabled: hasPendingDirtyWorkspaceDecision(snapshot)) {
                            store.requestGitAction(.push)
                            appModel.refreshTaskInbox()
                        }
                    }
                }

                if hasPendingDirtyWorkspaceDecision(snapshot) {
                    Text("Resolve the dirty workspace above before using Git actions.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                if showsReviewActions && supportsCreateReview == false {
                    Text(unsupportedReviewMessage(for: snapshot))
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                if snapshot.status == .awaitingGitApproval {
                    Text("A Git approval is currently pending in the approvals section.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                }
                .padding(.vertical, 4)
            }
        }
    }

    @ViewBuilder
    private func latestUpdateSection(_ snapshot: TaskSnapshot) -> some View {
        if let latestEvent = snapshot.sortedEventsByRecency.first {
            Section("Latest Update") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(latestEvent.title)
                            .font(.headline)
                        Spacer()
                        Text(latestEvent.displayCreatedAt)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }

                    MarkdownTextBlock(
                        latestEvent.displayDetail,
                        tone: snapshot.status == .failed ? .custom(.red) : .secondary,
                        font: .subheadline
                    )

                    StatusBadge(title: snapshot.status.title, tint: snapshot.status.tint)
                }
                .padding(.vertical, 4)
            }
        }
    }

    private func executionTimelineSection(_ snapshot: TaskSnapshot) -> some View {
        let recentEvents = Array(snapshot.sortedEventsByRecency.prefix(12))

        return Section {
            if recentEvents.isEmpty {
                Text("The runner has not posted a live update yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(recentEvents) { event in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top) {
                            Text(event.title)
                                .font(.headline)
                            Spacer()
                            Text(event.displayCreatedAt)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }

                        MarkdownTextBlock(
                            event.displayDetail,
                            tone: event.kind.contains("failed") ? .custom(.red) : .secondary,
                            font: .subheadline,
                            allowsSelection: false,
                            lineLimit: 6
                        )
                    }
                    .padding(.vertical, 6)
                }
            }
        } header: {
            Text("Execution Timeline")
        } footer: {
            Text("Live while this page is open. The phone only syncs recent lightweight updates.")
        }
    }

    @ViewBuilder
    private func resultArtifactsSection(_ snapshot: TaskSnapshot) -> some View {
        if !snapshot.artifacts.isEmpty {
            Section {
                ForEach(snapshot.artifacts) { artifact in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .top) {
                            Text(artifact.title)
                                .font(.headline)
                            Spacer()
                            Text(artifact.displayCreatedAt)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }

                        MarkdownTextBlock(
                            artifact.summary,
                            tone: .secondary,
                            font: .subheadline,
                            allowsSelection: false,
                            lineLimit: 8
                        )
                    }
                    .padding(.vertical, 6)
                }
            } header: {
                Text("Result Summary")
            } footer: {
                Text("The phone syncs compact summaries. Full local history stays on the Mac.")
            }
        }
    }

    private func overviewMetaCard(_ title: String, value: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.xs) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(WorkbenchTheme.textMuted)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(WorkbenchTheme.Typography.metadata)
                    .foregroundStyle(WorkbenchTheme.textSecondary)
                    .lineLimit(1)

                Text(value)
                    .font(WorkbenchTheme.Typography.metadataEmphasis)
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .padding(WorkbenchTheme.Spacing.sm)
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                .fill(WorkbenchTheme.panel.opacity(0.72))
        )
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }

    private func actionTileGrid<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 136), spacing: WorkbenchTheme.Spacing.sm)], spacing: WorkbenchTheme.Spacing.sm) {
            content()
        }
    }

    private func actionTileLabel(_ title: String, systemImage: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 20, weight: .semibold))
            Text(title)
                .font(WorkbenchTheme.Typography.bodyEmphasis)
                .lineLimit(1)
                .minimumScaleFactor(0.74)
        }
        .frame(maxWidth: .infinity, minHeight: WorkbenchTheme.Metrics.primaryButtonHeight)
    }

    private func actionButton(_ title: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.bordered)
            .controlSize(.large)
            .frame(maxWidth: .infinity)
            .disabled(disabled)
    }

    private func secondaryActionButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
        }
        .buttonStyle(.bordered)
    }

    private func gitActionGroupTitle(_ title: String) -> some View {
        Text(title.uppercased())
            .font(WorkbenchTheme.Typography.badge)
            .tracking(0.5)
            .foregroundStyle(WorkbenchTheme.textMuted)
            .padding(.top, WorkbenchTheme.Spacing.xs)
    }

    private func actionGrid<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 164), spacing: WorkbenchTheme.Spacing.sm)], spacing: WorkbenchTheme.Spacing.sm) {
            content()
        }
    }

    private func detailLine(_ title: String, value: String, trailing: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title)
                .font(WorkbenchTheme.Typography.badge)
                .foregroundStyle(.secondary)
                .frame(width: 96, alignment: .leading)

            Text(value)
                .font(WorkbenchTheme.Typography.body)
                .foregroundStyle(.primary)
                .textSelection(.enabled)

            Spacer(minLength: 8)

            if let trailing, !trailing.isEmpty {
                Text(trailing)
                    .font(WorkbenchTheme.Typography.metadata)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func taskNotice(_ text: String, tint: Color) -> some View {
        MarkdownTextBlock(text, tone: .custom(tint), font: .subheadline)
            .padding(WorkbenchTheme.Spacing.md)
            .background(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.control, style: .continuous)
                    .fill(tint.opacity(0.08))
            )
    }

    private func hasPendingApproval(_ snapshot: TaskSnapshot?) -> Bool {
        snapshot?.approvals.contains(where: { $0.isPending }) == true
    }

    private func hasPendingDirtyWorkspaceDecision(_ snapshot: TaskSnapshot?) -> Bool {
        snapshot?.dirtyWorkspace?.state == .pendingDecision
    }

    private func canContinue(_ snapshot: TaskSnapshot) -> Bool {
        !hasPendingApproval(snapshot) &&
        !hasPendingDirtyWorkspaceDecision(snapshot) &&
        [TaskStatus.awaitingHumanInput, .failed, .completed, .canceled].contains(snapshot.status)
    }

    private func canRecheckWorkspace(_ snapshot: TaskSnapshot) -> Bool {
        !hasPendingApproval(snapshot) &&
        !hasPendingDirtyWorkspaceDecision(snapshot) &&
        [TaskStatus.awaitingHumanInput, .failed, .completed, .canceled].contains(snapshot.status)
    }

    private func canComplete(_ snapshot: TaskSnapshot) -> Bool {
        !hasPendingApproval(snapshot) &&
        !hasPendingDirtyWorkspaceDecision(snapshot) &&
        snapshot.status == .awaitingHumanInput &&
        snapshot.stopRequestedAt == nil
    }

    private func canStop(_ snapshot: TaskSnapshot) -> Bool {
        snapshot.status != .completed &&
        snapshot.status != .canceled &&
        snapshot.stopRequestedAt == nil
    }

    private func primaryActionTitle(for snapshot: TaskSnapshot) -> String {
        canContinue(snapshot) ? "Continue Task" : "Refresh Status"
    }

    private func nextStepHeadline(_ snapshot: TaskSnapshot) -> String {
        if hasPendingApproval(snapshot) {
            return "Waiting for your approval"
        }
        if hasPendingDirtyWorkspaceDecision(snapshot) {
            return "Resolve workspace before continuing"
        }
        if canContinue(snapshot) {
            return "Ready for another turn"
        }
        if snapshot.stopRequestedAt != nil {
            return "Stopping on the Mac runner"
        }
        return "Runner is still working"
    }

    private func nextStepCaption(_ snapshot: TaskSnapshot) -> String {
        if hasPendingApproval(snapshot) {
            return "Approve or deny below to resume the task."
        }
        if hasPendingDirtyWorkspaceDecision(snapshot) {
            return "Choose how to handle local changes first."
        }
        if canContinue(snapshot) {
            if snapshot.deliveryMode == .directCommit && snapshot.status == .awaitingHumanInput {
                return "Continue on the same branch, or finish with Commit Now below when the repo is ready."
            }
            return "Continue on the same branch when you are ready."
        }
        return "Use refresh while the runner is still working."
    }

    private func nextStepNote(_ snapshot: TaskSnapshot) -> String? {
        if canContinue(snapshot) && snapshot.deliveryMode == .directCommit && snapshot.status == .awaitingHumanInput {
            if isPlainLocalFolderTask(snapshot) {
                return "Plain folders do not need Git. Continue with another instruction, or mark the task completed when the requested files are saved."
            }
            return "Direct Submit enters Completed automatically after a Git repo creates a local commit, or after a plain folder finishes saving the requested changes. If Codex stopped early, send another instruction, use Commit Now when Git is available, or mark the task completed."
        }
        if canComplete(snapshot) {
            return "If you are done for now, you can mark this task completed from iPhone without starting another runner turn."
        }
        if canContinue(snapshot) && snapshot.deliveryMode == .directCommit && snapshot.status == .completed {
            return "This task is already completed. Push is still optional when the workspace is a Git repo and you want the branch published on origin."
        }
        if canContinue(snapshot) && snapshot.deliveryMode == .reviewRequired && snapshot.status == .completed {
            return "Implementation is complete. Push or create a review later if you want a delivery step from this same task."
        }
        if canContinue(snapshot) && snapshot.status == .failed {
            return "The last turn failed, but this task can still continue."
        }
        if canContinue(snapshot) && snapshot.status == .completed {
            return "Completed tasks can still be reopened for another pass."
        }
        if snapshot.stopRequestedAt != nil {
            return "Stop was requested from iPhone."
        }
        if canRecheckWorkspace(snapshot) {
            return "Use recheck on older tasks to inspect the repo state again."
        }
        return nil
    }

    private func completionRuleTitle(for snapshot: TaskSnapshot) -> String {
        switch snapshot.deliveryMode {
        case .reviewRequired:
            return "Implementation turn"
        case .directCommit:
            return isPlainLocalFolderTask(snapshot) ? "Saved files after checks" : "Local commit or saved files"
        }
    }

    private func completionRuleTrailing(for snapshot: TaskSnapshot) -> String? {
        switch snapshot.deliveryMode {
        case .reviewRequired:
            return "delivery optional"
        case .directCommit:
            return isPlainLocalFolderTask(snapshot) ? "Git optional" : (snapshot.autoPush ? "auto-push optional" : "push optional")
        }
    }

    private func resolvedPullRequestTitle(for snapshot: TaskSnapshot) -> String {
        let trimmed = pullRequestTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? snapshot.title : trimmed
    }

    private func reviewTargetBranchOptions(for snapshot: TaskSnapshot) -> [String] {
        let branches = [snapshot.baseBranch] + (snapshot.reviewTargetBranches ?? [])
        var ordered: [String] = []
        for branch in branches where !branch.isEmpty && !ordered.contains(branch) {
            ordered.append(branch)
        }
        return ordered.isEmpty ? [snapshot.baseBranch] : ordered
    }

    private func resolvedReviewTargetBranch(for snapshot: TaskSnapshot) -> String {
        let trimmed = reviewTargetBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        let options = reviewTargetBranchOptions(for: snapshot)
        if !trimmed.isEmpty, options.contains(trimmed) {
            return trimmed
        }
        return options.first ?? snapshot.baseBranch
    }

    private func runnerSupportsCreateReview(_ snapshot: TaskSnapshot) -> Bool? {
        guard let runnerID = snapshot.runnerId else {
            return nil
        }

        guard let runner = appModel.runners.first(where: { $0.id == runnerID }) else {
            return nil
        }

        switch snapshot.reviewPlatform {
        case .github:
            return runner.capabilities.contains("github_pr")
        case .gitlab:
            return runner.capabilities.contains("gitlab_mr")
        case nil:
            return nil
        }
    }

    private func gitActionsIntro(for snapshot: TaskSnapshot) -> String {
        switch snapshot.deliveryMode {
        case .reviewRequired:
            return "These touch the real repo, and each one still requires a second approval before the Mac executes it."
        case .directCommit:
            return "This workflow completes after a local commit in Git repos, or after files are saved in plain folders. Push is optional, and PR/MR actions are hidden."
        }
    }

    private func isPlainLocalFolderTask(_ snapshot: TaskSnapshot) -> Bool {
        snapshot.executorSession != nil &&
        snapshot.executionBranch == nil &&
        snapshot.dirtyWorkspace?.currentBranch == nil &&
        snapshot.reviewPlatform == nil
    }

    private var completeConfirmationMessage: String {
        guard let snapshot = store.snapshot else {
            return "This only updates task status. It does not start another runner turn."
        }

        switch snapshot.deliveryMode {
        case .reviewRequired:
            return "This only updates task status. It will not push the branch or create a PR/MR."
        case .directCommit:
            return "This only updates task status. It will not create a local commit, push changes, or start another runner turn."
        }
    }

    private func unsupportedReviewMessage(for snapshot: TaskSnapshot) -> String {
        switch snapshot.reviewPlatform {
        case .github:
            return "This Mac runner cannot create pull requests yet. Install `gh` and run `gh auth login` on the runner, then refresh this page."
        case .gitlab:
            return "This Mac runner cannot create merge requests yet. Add `GITLAB_TOKEN` on the runner, and set `GITLAB_BASE_URL` too if you use self-hosted GitLab."
        case nil:
            return "This task has not identified whether the repository uses GitHub or GitLab yet. Refresh this page after workspace preparation."
        }
    }

    private func resumeThreadLabel(for snapshot: TaskSnapshot) -> String {
        let trimmed = snapshot.resumeThreadId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "New Thread" : trimmed
    }
}
