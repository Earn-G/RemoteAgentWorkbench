import SwiftUI

enum ProjectTaskSheetMode: Equatable {
    case review
    case directSubmit
}

struct ProjectTaskSheet: View {
    @ObservedObject var store: ProjectDetailStore
    let mode: ProjectTaskSheetMode
    @Environment(\.dismiss) private var dismiss

    init(store: ProjectDetailStore, mode: ProjectTaskSheetMode) {
        self.store = store
        self.mode = mode
    }

    var body: some View {
        NavigationStack {
            sheetContent
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") {
                    dismiss()
                }
            }
        }
        .onReceive(store.$lastCreatedTaskID.compactMap { $0 }) { _ in
            dismiss()
        }
    }

    @ViewBuilder
    private var sheetContent: some View {
        switch mode {
        case .review:
            ProjectReviewTaskComposer(store: store)
        case .directSubmit:
            ProjectDirectCommitTaskComposer(store: store)
        }
    }

}

private struct ProjectReviewTaskComposer: View {
    @ObservedObject var store: ProjectDetailStore

    @State private var title: String
    @State private var prompt: String
    @State private var branchName = ""
    @State private var executionMode: TaskExecutionMode = .newThread
    @State private var resumeThreadID = ""
    @State private var pendingParallelTask: TaskRecord?

    init(store: ProjectDetailStore) {
        self.store = store
        _title = State(initialValue: store.project.defaultTaskTitle)
        _prompt = State(initialValue: "")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xl) {
                WorkbenchHeroCard(
                    eyebrow: "Review workflow",
                    title: "Create a task branch",
                    detail: "The agent drafts work first. You approve the plan and later decide when to commit or create a review."
                ) {
                    WorkbenchInlineTag("Review Required", systemImage: "checkmark.shield.fill", tint: .white.opacity(0.9))
                } content: {
                    EmptyView()
                }

                SectionCard(title: "1. Task setup", caption: "Use a readable title and optional branch name.") {
                    VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
                        TextField("Title", text: $title)
                            .textFieldStyle(.roundedBorder)

                        TextField("Branch Name (Optional)", text: $branchName)
                            .textFieldStyle(.roundedBorder)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                        Text("Leave the branch empty to auto-generate a readable task branch.")
                            .font(WorkbenchTheme.Typography.metadata)
                            .foregroundStyle(WorkbenchTheme.textSecondary)
                    }
                }

                sessionCard
                promptCard(title: "2. Agent instruction", prompt: $prompt, placeholder: store.project.defaultPrompt)
            }
            .padding(.horizontal, WorkbenchTheme.Spacing.md)
            .padding(.top, WorkbenchTheme.Spacing.lg)
            .padding(.bottom, 120)
        }
        .background(WorkbenchBackground())
        .navigationTitle("Review Task")
        .navigationBarTitleDisplayMode(.inline)
        .workbenchNavigationChrome()
        .safeAreaInset(edge: .bottom) {
            composerFooter(
                title: store.isCreatingTask ? "Creating..." : "Start Agent Task",
                systemImage: "sparkles",
                disabled: isSubmitDisabled,
                tint: WorkbenchTheme.agentViolet,
                action: { submit() }
            )
        }
        .alert("Start Another Task In Parallel?", isPresented: Binding(
            get: { pendingParallelTask != nil },
            set: { value in
                if !value {
                    pendingParallelTask = nil
                }
            }
        )) {
            Button("Cancel", role: .cancel) {
                pendingParallelTask = nil
            }
            Button("Create In Parallel") {
                pendingParallelTask = nil
                submit(allowParallel: true)
            }
        } message: {
            Text(parallelConfirmationMessage)
        }
    }

    private var sessionCard: some View {
        SectionCard(title: "Codex session", caption: "Start fresh or resume an existing thread.") {
            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
                Picker("Mode", selection: $executionMode) {
                    ForEach(TaskExecutionMode.allCases, id: \.self) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                if executionMode == .resumeThread {
                    TextField("Thread ID (Optional)", text: $resumeThreadID)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Text("Optional. Leave blank to create a new Codex thread automatically.")
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                }
            }
        }
    }

    private var isSubmitDisabled: Bool {
        store.isCreatingTask ||
        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var normalizedBranchName: String? {
        let trimmed = branchName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var normalizedResumeThreadID: String? {
        let trimmed = resumeThreadID.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func submit(allowParallel: Bool = false) {
        if !allowParallel, let conflictingTask = conflictingTask {
            pendingParallelTask = conflictingTask
            return
        }

        store.createTask(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            branchMode: .newBranch,
            branchName: normalizedBranchName,
            deliveryMode: .reviewRequired,
            autoPush: store.project.autoPush,
            executionMode: executionMode,
            resumeThreadId: normalizedResumeThreadID,
            allowParallel: allowParallel
        )
    }

    private var conflictingTask: TaskRecord? {
        store.tasks.first { !$0.status.isTerminal }
    }

    private var parallelConfirmationMessage: String {
        guard let pendingParallelTask else {
            return "This project already has an unfinished task."
        }

        return "This project already has unfinished task \(pendingParallelTask.displayTitle) (\(pendingParallelTask.status.title), updated \(pendingParallelTask.displayUpdatedAt)). Create another task anyway?"
    }
}

private struct ProjectDirectCommitTaskComposer: View {
    @ObservedObject var store: ProjectDetailStore

    @State private var title: String
    @State private var prompt: String
    @State private var autoPush: Bool
    @State private var executionMode: TaskExecutionMode = .newThread
    @State private var resumeThreadID = ""
    @State private var pendingParallelTask: TaskRecord?

    init(store: ProjectDetailStore) {
        self.store = store
        _title = State(initialValue: store.project.defaultTaskTitle)
        _prompt = State(initialValue: "")
        _autoPush = State(initialValue: store.project.autoPush)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xl) {
                WorkbenchHeroCard(
                    eyebrow: "Direct submit workflow",
                    title: "Work on the current branch",
                    detail: "Direct Submit starts immediately. Git repos can commit; plain local folders simply save the requested files."
                ) {
                    WorkbenchInlineTag("Direct Submit", systemImage: "arrow.down.doc.fill", tint: .white.opacity(0.9))
                } content: {
                    EmptyView()
                }

                SectionCard(title: "1. Task setup", caption: "This workflow keeps work on the current branch.") {
                    VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
                        TextField("Title", text: $title)
                            .textFieldStyle(.roundedBorder)

                        Toggle(AutoPushCopy.title, isOn: $autoPush)

                        Text(AutoPushCopy.footnote)
                            .font(WorkbenchTheme.Typography.metadata)
                            .foregroundStyle(WorkbenchTheme.textSecondary)
                    }
                }

                sessionCard
                promptCard(title: "2. Agent instruction", prompt: $prompt, placeholder: store.project.defaultPrompt)
            }
            .padding(.horizontal, WorkbenchTheme.Spacing.md)
            .padding(.top, WorkbenchTheme.Spacing.lg)
            .padding(.bottom, 120)
        }
        .background(WorkbenchBackground())
	        .navigationTitle("Direct Submit")
        .navigationBarTitleDisplayMode(.inline)
        .workbenchNavigationChrome()
        .safeAreaInset(edge: .bottom) {
            composerFooter(
	                title: store.isCreatingTask ? "Creating..." : "Start Direct Submit",
                systemImage: "sparkles",
                disabled: isSubmitDisabled,
                tint: WorkbenchTheme.actionMint,
                action: { submit() }
            )
        }
        .alert("Start Another Task In Parallel?", isPresented: Binding(
            get: { pendingParallelTask != nil },
            set: { value in
                if !value {
                    pendingParallelTask = nil
                }
            }
        )) {
            Button("Cancel", role: .cancel) {
                pendingParallelTask = nil
            }
            Button("Create In Parallel") {
                pendingParallelTask = nil
                submit(allowParallel: true)
            }
        } message: {
            Text(parallelConfirmationMessage)
        }
    }

    private var sessionCard: some View {
        SectionCard(title: "Codex session", caption: "Start fresh or resume an existing thread.") {
            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
                Picker("Mode", selection: $executionMode) {
                    ForEach(TaskExecutionMode.allCases, id: \.self) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                if executionMode == .resumeThread {
                    TextField("Thread ID (Optional)", text: $resumeThreadID)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Text("Optional. Leave blank to create a new Codex thread automatically.")
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                }
            }
        }
    }

    private var isSubmitDisabled: Bool {
        store.isCreatingTask ||
        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var normalizedResumeThreadID: String? {
        let trimmed = resumeThreadID.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func submit(allowParallel: Bool = false) {
        if !allowParallel, let conflictingTask = conflictingTask {
            pendingParallelTask = conflictingTask
            return
        }

        store.createTask(
            title: title.trimmingCharacters(in: .whitespacesAndNewlines),
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            branchMode: .currentBranch,
            branchName: nil,
            deliveryMode: .directCommit,
            autoPush: autoPush,
            executionMode: executionMode,
            resumeThreadId: normalizedResumeThreadID,
            allowParallel: allowParallel
        )
    }

    private var conflictingTask: TaskRecord? {
        store.tasks.first { !$0.status.isTerminal }
    }

    private var parallelConfirmationMessage: String {
        guard let pendingParallelTask else {
            return "This project already has an unfinished task."
        }

        return "This project already has unfinished task \(pendingParallelTask.displayTitle) (\(pendingParallelTask.status.title), updated \(pendingParallelTask.displayUpdatedAt)). Create another task anyway?"
    }
}

private func promptCard(title: String, prompt: Binding<String>, placeholder: String) -> some View {
    SectionCard(title: title, caption: "Write the outcome you want. The runner will handle the repo context.") {
        ZStack(alignment: .topLeading) {
            TextEditor(text: prompt)
                .font(WorkbenchTheme.Typography.body)
                .frame(minHeight: 240)
                .padding(WorkbenchTheme.Spacing.sm)

            if prompt.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(placeholder)
                    .font(WorkbenchTheme.Typography.body)
                    .foregroundStyle(WorkbenchTheme.textMuted)
                    .padding(.horizontal, WorkbenchTheme.Spacing.md)
                    .padding(.vertical, WorkbenchTheme.Spacing.md)
                    .allowsHitTesting(false)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.control, style: .continuous)
                .fill(WorkbenchTheme.panel)
        )
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.control, style: .continuous)
                .strokeBorder(WorkbenchTheme.border, lineWidth: 1)
        )
    }
}

private func composerFooter(title: String, systemImage: String, disabled: Bool, tint: Color, action: @escaping () -> Void) -> some View {
    VStack(spacing: WorkbenchTheme.Spacing.sm) {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(WorkbenchTheme.Typography.bodyEmphasis)
                .frame(maxWidth: .infinity)
                .frame(height: WorkbenchTheme.Metrics.primaryButtonHeight)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
        .disabled(disabled)
    }
    .padding(.horizontal, WorkbenchTheme.Spacing.md)
    .padding(.top, WorkbenchTheme.Spacing.sm)
    .padding(.bottom, WorkbenchTheme.Spacing.md)
    .background(.ultraThinMaterial)
}
