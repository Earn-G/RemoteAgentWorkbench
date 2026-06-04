import Combine
import Foundation

private enum CodexConfigExpectation {
    case switchTo(String)
    case createAndSwitch(String)
    case delete(String)

    var profileName: String {
        switch self {
        case let .switchTo(profileName), let .createAndSwitch(profileName), let .delete(profileName):
            profileName
        }
    }

    var successNotice: String {
        switch self {
        case let .switchTo(profileName):
            "Switched Codex config to \(profileName)."
        case let .createAndSwitch(profileName):
            "Created and switched Codex config to \(profileName)."
        case let .delete(profileName):
            "Deleted Codex config \(profileName)."
        }
    }

    var timeoutMessage: String {
        switch self {
        case let .switchTo(profileName):
            "Timed out waiting for Codex config \(profileName) to finish switching on the Mac. Refresh and confirm the current state."
        case let .createAndSwitch(profileName):
            "Timed out waiting for Codex config \(profileName) to finish creating on the Mac. Refresh and confirm the current state."
        case let .delete(profileName):
            "Timed out waiting for Codex config \(profileName) to finish deleting on the Mac. Refresh and confirm the current state."
        }
    }
}

final class AppModel: ObservableObject {
    let settings: AppSettings

    @Published var projects: [ProjectSummary] = []
    @Published var tasks: [TaskRecord] = []
    @Published var approvals: [ApprovalRequest] = []
    @Published var runners: [RunnerInfo] = []
    @Published var systemSummary: SystemSummary?
    @Published var isLoading = false
    @Published var isCreatingTask = false
    @Published var isUpdatingCodexConfig = false
    @Published var errorMessage: String?
    @Published var codexConfigNotice: String?
    @Published var lastCreatedTaskID: String?

    private let apiClient: APIClient
    private var hasLoadedInitially = false
    private var hasLoadedTaskInbox = false
    private var refreshCancellable: AnyCancellable?
    private var taskInboxCancellable: AnyCancellable?
    private var deferredTaskInboxCancellable: AnyCancellable?
    private var createTaskCancellable: AnyCancellable?
    private var approvalCancellable: AnyCancellable?
    private var codexConfigCancellable: AnyCancellable?
    private var codexConfigPollingCancellable: AnyCancellable?
    private var projectAppearanceCancellable: AnyCancellable?

    init(settings: AppSettings = AppSettings()) {
        self.settings = settings
        self.apiClient = APIClient(
            baseURLProvider: { settings.serverURL },
            userBearerTokenProvider: { settings.userBearerToken }
        )
        AppDebugLog.info("AppModel initialized. Effective server URL: \(settings.serverURL)")
    }

    func makeAPIClient() -> APIClient {
        apiClient
    }

    func refreshAllIfNeeded() {
        guard !isLoading else { return }
        let hasSnapshot = !projects.isEmpty || !approvals.isEmpty || !runners.isEmpty || systemSummary != nil
        guard !hasLoadedInitially || !hasSnapshot || errorMessage != nil else {
            AppDebugLog.info("refreshAllIfNeeded skipped. hasLoadedInitially=\(hasLoadedInitially) hasSnapshot=\(hasSnapshot) errorMessagePresent=\(errorMessage != nil)")
            return
        }
        AppDebugLog.info("refreshAllIfNeeded triggered. hasLoadedInitially=\(hasLoadedInitially) hasSnapshot=\(hasSnapshot) errorMessagePresent=\(errorMessage != nil)")
        hasLoadedInitially = true
        refreshAll()
    }

    func refreshAll() {
        refreshCancellable?.cancel()
        isLoading = true
        AppDebugLog.info("refreshAll started against server URL: \(settings.serverURL)")

        refreshCancellable = fetchRefreshSnapshot()
        .receive(on: DispatchQueue.main)
        .sink { [weak self] completion in
            guard let self else { return }
            self.isLoading = false
            if case let .failure(error) = completion {
                let displayMessage = self.userVisibleRefreshError(from: error)
                self.errorMessage = displayMessage
                AppDebugLog.error("refreshAll failed: \(displayMessage)")
            } else {
                AppDebugLog.info("refreshAll completed successfully.")
            }
        } receiveValue: { [weak self] projects, approvals, runners, systemSummary, tasks in
            guard let self else { return }
            self.projects = projects
            self.approvals = approvals
            self.runners = runners
            self.systemSummary = systemSummary
            self.tasks = tasks.sortedByRecency()
            self.hasLoadedTaskInbox = true
            self.errorMessage = nil
            AppDebugLog.info(
                "refreshAll received projects=\(self.projects.count) approvals=\(self.approvals.count) runners=\(self.runners.count) tasks=\(self.tasks.count) publicBaseURL=\(systemSummary.publicBaseURL)"
            )
        }
    }

    func refreshUntilProjectAppears(repo: String, projectName: String?) {
        let normalizedRepo = normalizedProjectIdentity(repo)
        guard !normalizedRepo.isEmpty else {
            refreshAll()
            return
        }

        projectAppearanceCancellable?.cancel()
        var remainingAttempts = 8

        projectAppearanceCancellable = Timer.publish(every: 2.0, on: .main, in: .common)
            .autoconnect()
            .prepend(Date())
            .sink { [weak self] _ in
                guard let self else { return }

                if self.projects.contains(where: { self.matchesProject($0, normalizedRepo: normalizedRepo) }) {
                    self.projectAppearanceCancellable?.cancel()
                    self.projectAppearanceCancellable = nil
                    return
                }

                guard remainingAttempts > 0 else {
                    self.projectAppearanceCancellable?.cancel()
                    self.projectAppearanceCancellable = nil
                    AppDebugLog.info("Stopped waiting for project sync. repo=\(repo) projectName=\(projectName ?? "<nil>")")
                    return
                }

                remainingAttempts -= 1
                AppDebugLog.info("Refreshing while waiting for project sync. repo=\(repo) attemptsRemaining=\(remainingAttempts)")
                self.refreshAll()
            }
    }

    func refreshTaskInboxIfNeeded() {
        guard !isLoading else { return }
        guard !hasLoadedTaskInbox || tasks.isEmpty || errorMessage != nil else { return }
        hasLoadedTaskInbox = true
        refreshTaskInbox()
    }

    func refreshTaskInboxAfterCurrentLoadIfNeeded() {
        guard !hasLoadedTaskInbox || tasks.isEmpty || errorMessage != nil else { return }

        guard isLoading else {
            refreshTaskInboxIfNeeded()
            return
        }

        deferredTaskInboxCancellable?.cancel()
        deferredTaskInboxCancellable = $isLoading
            .dropFirst()
            .filter { !$0 }
            .first()
            .sink { [weak self] _ in
                self?.deferredTaskInboxCancellable = nil
                self?.refreshTaskInboxIfNeeded()
            }
    }

    func refreshTaskInbox() {
        taskInboxCancellable?.cancel()
        isLoading = true
        AppDebugLog.info("refreshTaskInbox started against server URL: \(settings.serverURL)")

        taskInboxCancellable = Publishers.Zip(
            apiClient.fetchTasks(limit: 100),
            apiClient.fetchApprovals()
        )
        .receive(on: DispatchQueue.main)
        .sink { [weak self] completion in
            guard let self else { return }
            self.isLoading = false
            if case let .failure(error) = completion {
                self.errorMessage = error.localizedDescription
                AppDebugLog.error("refreshTaskInbox failed: \(error.localizedDescription)")
            } else {
                AppDebugLog.info("refreshTaskInbox completed successfully.")
            }
        } receiveValue: { [weak self] tasks, approvals in
            guard let self else { return }
            self.tasks = tasks.sortedByRecency()
            self.approvals = approvals
            self.errorMessage = nil
            AppDebugLog.info("refreshTaskInbox received tasks=\(tasks.count) approvals=\(approvals.count)")
        }
    }

    func createTask(
        title: String,
        repo: String,
        baseBranch: String,
        branchMode: TaskBranchMode,
        branchName: String?,
        prompt: String,
        deliveryMode: DeliveryMode,
        autoPush: Bool,
        executionMode: TaskExecutionMode,
        resumeThreadId: String?,
        allowParallel: Bool = false
    ) {
        createTaskCancellable?.cancel()
        isCreatingTask = true
        AppDebugLog.info("createTask started. title=\(title) repo=\(repo) baseBranch=\(baseBranch) branchMode=\(branchMode.rawValue) branchName=\(branchName ?? "<auto>") executionMode=\(executionMode.rawValue) resumeThreadId=\(resumeThreadId ?? "<nil>")")

        createTaskCancellable = apiClient.createTask(
            CreateTaskRequest(
                workflowKey: "coding_session",
                deliveryMode: deliveryMode,
                autoPush: autoPush,
                title: title,
                prompt: prompt,
                repo: repo,
                baseBranch: baseBranch,
                branchMode: branchMode,
                branchName: branchName,
                executionMode: executionMode,
                resumeThreadId: resumeThreadId,
                allowParallel: allowParallel
            )
        )
        .receive(on: DispatchQueue.main)
        .sink { [weak self] completion in
            guard let self else { return }
            self.isCreatingTask = false
            if case let .failure(error) = completion {
                self.errorMessage = error.localizedDescription
                AppDebugLog.error("createTask failed: \(error.localizedDescription)")
            }
        } receiveValue: { [weak self] snapshot in
            guard let self else { return }
            self.upsertTask(snapshot.taskRecord)
            self.lastCreatedTaskID = snapshot.id
            self.errorMessage = nil
            AppDebugLog.info("createTask succeeded. taskId=\(snapshot.id) status=\(snapshot.status.rawValue)")
            self.refreshTaskInbox()
            self.refreshAll()
        }
    }

    func resolveApproval(_ approval: ApprovalRequest, decision: String) {
        approvalCancellable?.cancel()
        AppDebugLog.info("resolveApproval started. approvalId=\(approval.id) taskId=\(approval.taskId) decision=\(decision)")
        approvalCancellable = apiClient.decideApproval(approvalId: approval.id, decision: decision)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard let self else { return }
                if case let .failure(error) = completion {
                    self.errorMessage = error.localizedDescription
                    AppDebugLog.error("resolveApproval failed: \(error.localizedDescription)")
                }
            } receiveValue: { [weak self] _ in
                self?.errorMessage = nil
                AppDebugLog.info("resolveApproval succeeded. approvalId=\(approval.id)")
                self?.refreshTaskInbox()
                self?.refreshAll()
            }
    }

    func clearCreatedTask() {
        lastCreatedTaskID = nil
    }

    func clearError() {
        DispatchQueue.main.async { [weak self] in
            self?.errorMessage = nil
            AppDebugLog.info("Error state cleared manually.")
        }
    }

    func clearCodexConfigNotice() {
        codexConfigNotice = nil
    }

    func switchCodexConfig(profileName: String?) {
        let trimmed = profileName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else {
            codexConfigNotice = "No config change requested."
            return
        }

        AppDebugLog.info("switchCodexConfig started. profileName=\(trimmed)")
        queueCodexConfigAction(
            apiClient.switchCodexConfig(profileName: trimmed),
            expectation: .switchTo(trimmed),
            actionLabel: "switchCodexConfig"
        )
    }

    func deleteCodexConfig(profileName: String) {
        let trimmed = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            errorMessage = "A config name is required."
            return
        }

        AppDebugLog.info("deleteCodexConfig started. profileName=\(trimmed)")
        queueCodexConfigAction(
            apiClient.deleteCodexConfig(profileName: trimmed),
            expectation: .delete(trimmed),
            actionLabel: "deleteCodexConfig"
        )
    }

    func createCodexConfig(name: String, baseURL: String, apiKey: String, onCompleted: (() -> Void)? = nil) {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBaseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedAPIKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !trimmedBaseURL.isEmpty, !trimmedAPIKey.isEmpty else {
            errorMessage = "Name, URL, and token are required."
            return
        }
        AppDebugLog.info("createCodexConfig started. profileName=\(trimmedName)")

        queueCodexConfigAction(
            apiClient.createCodexConfig(
                CreateCodexConfigRequest(
                    profileName: trimmedName,
                    baseURL: trimmedBaseURL,
                    apiKey: trimmedAPIKey
                )
            ),
            expectation: .createAndSwitch(trimmedName),
            actionLabel: "createCodexConfig",
            onCompleted: onCompleted
        )
    }

    private func upsertTask(_ task: TaskRecord) {
        if let index = tasks.firstIndex(where: { $0.id == task.id }) {
            tasks[index] = task
        } else {
            tasks.insert(task, at: 0)
        }
        tasks = tasks.sortedByRecency()
    }

    private func fetchRefreshSnapshot() -> AnyPublisher<([ProjectSummary], [ApprovalRequest], [RunnerInfo], SystemSummary, [TaskRecord]), APIError> {
        Publishers.Zip4(
            apiClient.fetchProjects(),
            apiClient.fetchApprovals(),
            apiClient.fetchRunners(),
            apiClient.fetchSystemSummary()
        )
        .zip(apiClient.fetchTasks(limit: 100))
        .map { snapshot, tasks in
            (snapshot.0, snapshot.1, snapshot.2, snapshot.3, tasks)
        }
        .eraseToAnyPublisher()
    }

    private func matchesProject(_ project: ProjectSummary, normalizedRepo: String) -> Bool {
        normalizedProjectIdentity(project.repo) == normalizedRepo
    }

    private func normalizedProjectIdentity(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return ""
        }

        let withoutTrailingSlashes = trimmed.replacingOccurrences(
            of: "[/\\\\]+$",
            with: "",
            options: .regularExpression
        )

        if withoutTrailingSlashes.hasPrefix("/") || withoutTrailingSlashes.hasPrefix("~/") {
            return withoutTrailingSlashes
        }

        return withoutTrailingSlashes
            .replacingOccurrences(of: "\\.git$", with: "", options: [.regularExpression, .caseInsensitive])
            .lowercased()
    }

    private func userVisibleRefreshError(from error: APIError) -> String {
        guard case let .requestFailed(statusCode, message) = error else {
            return error.localizedDescription
        }

        guard statusCode == 404, message.contains("/v1/projects") else {
            return error.localizedDescription
        }

        return "The server is still running an older build. Deploy the new server version that includes GET /v1/projects."
    }

    private func queueCodexConfigAction(
        _ publisher: AnyPublisher<CodexConfigActionReceipt, APIError>,
        expectation: CodexConfigExpectation,
        actionLabel: String,
        onCompleted: (() -> Void)? = nil
    ) {
        codexConfigCancellable?.cancel()
        codexConfigPollingCancellable?.cancel()
        isUpdatingCodexConfig = true

        codexConfigCancellable = publisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard let self else { return }
                if case let .failure(error) = completion {
                    self.isUpdatingCodexConfig = false
                    self.errorMessage = error.localizedDescription
                    AppDebugLog.error("\(actionLabel) failed: \(error.localizedDescription)")
                }
            } receiveValue: { [weak self] receipt in
                guard let self else { return }
                self.errorMessage = nil
                AppDebugLog.info("\(actionLabel) queued. profileName=\(receipt.profileName) requestId=\(receipt.requestId)")
                self.pollCodexConfigState(
                    for: expectation,
                    actionLabel: actionLabel,
                    attempt: 0,
                    maxAttempts: 30,
                    onCompleted: onCompleted
                )
            }
    }

    private func pollCodexConfigState(
        for expectation: CodexConfigExpectation,
        actionLabel: String,
        attempt: Int,
        maxAttempts: Int,
        onCompleted: (() -> Void)?
    ) {
        codexConfigPollingCancellable?.cancel()
        codexConfigPollingCancellable = apiClient.fetchSystemSummary()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard let self else { return }
                if case let .failure(error) = completion {
                    AppDebugLog.error("\(actionLabel) poll failed at attempt \(attempt + 1): \(error.localizedDescription)")
                    self.handleCodexConfigPollRetryOrFailure(
                        for: expectation,
                        actionLabel: actionLabel,
                        attempt: attempt,
                        maxAttempts: maxAttempts,
                        errorMessage: error.localizedDescription,
                        onCompleted: onCompleted
                    )
                }
            } receiveValue: { [weak self] summary in
                guard let self else { return }
                self.systemSummary = summary
                if self.codexConfigExpectation(expectation, isSatisfiedBy: summary.codexConfig) {
                    self.isUpdatingCodexConfig = false
                    self.errorMessage = nil
                    onCompleted?()
                    self.codexConfigNotice = expectation.successNotice
                    AppDebugLog.info("\(actionLabel) completed. profileName=\(expectation.profileName)")
                    self.refreshAll()
                    return
                }

                self.handleCodexConfigPollRetryOrFailure(
                    for: expectation,
                    actionLabel: actionLabel,
                    attempt: attempt,
                    maxAttempts: maxAttempts,
                    errorMessage: expectation.timeoutMessage,
                    onCompleted: onCompleted
                )
            }
    }

    private func handleCodexConfigPollRetryOrFailure(
        for expectation: CodexConfigExpectation,
        actionLabel: String,
        attempt: Int,
        maxAttempts: Int,
        errorMessage: String,
        onCompleted: (() -> Void)?
    ) {
        if attempt + 1 >= maxAttempts {
            isUpdatingCodexConfig = false
            self.errorMessage = errorMessage
            AppDebugLog.error("\(actionLabel) timed out. profileName=\(expectation.profileName)")
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.pollCodexConfigState(
                for: expectation,
                actionLabel: actionLabel,
                attempt: attempt + 1,
                maxAttempts: maxAttempts,
                onCompleted: onCompleted
            )
        }
    }

    private func codexConfigExpectation(
        _ expectation: CodexConfigExpectation,
        isSatisfiedBy codexConfig: SystemSummary.CodexConfigSummary?
    ) -> Bool {
        guard let codexConfig else {
            return false
        }

        switch expectation {
        case let .switchTo(profileName), let .createAndSwitch(profileName):
            return codexConfig.pendingAction == nil
                && normalizedCodexProfileName(codexConfig.activeProfileName) == normalizedCodexProfileName(profileName)
                && codexConfigContainsProfile(codexConfig, profileName: profileName)
        case let .delete(profileName):
            return codexConfig.pendingAction == nil
                && !codexConfigContainsProfile(codexConfig, profileName: profileName)
                && normalizedCodexProfileName(codexConfig.activeProfileName) != normalizedCodexProfileName(profileName)
        }
    }

    private func codexConfigContainsProfile(
        _ codexConfig: SystemSummary.CodexConfigSummary,
        profileName: String
    ) -> Bool {
        codexConfig.profiles.contains { normalizedCodexProfileName($0) == normalizedCodexProfileName(profileName) }
    }

    private func normalizedCodexProfileName(_ profileName: String?) -> String {
        profileName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }
}
