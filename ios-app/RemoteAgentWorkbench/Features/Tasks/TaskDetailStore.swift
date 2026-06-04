import Combine
import Foundation

struct ReportUploadNotice: Equatable {
    let message: String
    let reportURL: URL?
}

final class TaskDetailStore: ObservableObject {
    let taskId: String

    @Published var snapshot: TaskSnapshot?
    @Published var followUpText = ""
    @Published var isLoading = false
    @Published var errorMessage: String?
    @Published var reportUploadNotice: ReportUploadNotice?

    private let apiClient: APIClient
    private var loadCancellable: AnyCancellable?
    private var actionCancellable: AnyCancellable?
    private var approvalCancellable: AnyCancellable?
    private var streamCancellable: AnyCancellable?
    private var reconnectWorkItem: DispatchWorkItem?
    private var didLoad = false
    private var shouldMaintainStream = false
    private var reconnectAttempt = 0

    init(taskId: String, apiClient: APIClient) {
        self.taskId = taskId
        self.apiClient = apiClient
    }

    func loadIfNeeded() {
        if !didLoad {
            didLoad = true
            load()
        }
        startStreaming()
    }

    func load() {
        loadCancellable?.cancel()
        isLoading = true

        loadCancellable = apiClient.fetchTask(taskId: taskId, includeDetails: true)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard let self else { return }
                self.isLoading = false
                if case let .failure(error) = completion {
                    self.errorMessage = error.localizedDescription
                }
            } receiveValue: { [weak self] snapshot in
                self?.applySnapshot(snapshot, shouldNotifyAboutReportUpload: false)
            }
    }

    func startStreaming() {
        shouldMaintainStream = true
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        guard streamCancellable == nil else { return }

        connectStream()
    }

    func stopStreaming() {
        shouldMaintainStream = false
        reconnectAttempt = 0
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        streamCancellable?.cancel()
        streamCancellable = nil
    }

    private func connectStream() {
        guard shouldMaintainStream else { return }

        streamCancellable = apiClient.streamTaskEvents(taskId: taskId)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard let self else { return }
                self.streamCancellable = nil

                switch completion {
                case .finished:
                    self.scheduleReconnectIfNeeded()
                case let .failure(error):
                    if self.snapshot == nil {
                        self.errorMessage = error.localizedDescription
                    }
                    self.scheduleReconnectIfNeeded()
                }
            } receiveValue: { [weak self] snapshot in
                guard let self else { return }
                self.applySnapshot(snapshot, shouldNotifyAboutReportUpload: true)
                self.reconnectAttempt = 0
            }
    }

    func continueImplementation() {
        performTaskUpdate(apiClient.continueTask(taskId: taskId))
    }

    func completeTask(receiveValue: (() -> Void)? = nil) {
        performTaskUpdate(apiClient.completeTask(taskId: taskId), receiveValue: receiveValue)
    }

    func openInCodexApp() {
        performTaskUpdate(apiClient.openInCodexApp(taskId: taskId))
    }

    func recheckWorkspace() {
        performTaskUpdate(apiClient.recheckWorkspace(taskId: taskId))
    }

    func stopTask() {
        performTaskUpdate(apiClient.stopTask(taskId: taskId))
    }

    func deleteTask(onDeleted: @escaping () -> Void) {
        actionCancellable?.cancel()
        actionCancellable = apiClient.deleteTask(taskId: taskId)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard let self else { return }
                if case let .failure(error) = completion {
                    self.errorMessage = self.userVisibleActionError(from: error)
                }
            } receiveValue: { [weak self] in
                self?.errorMessage = nil
                self?.snapshot = nil
                onDeleted()
            }
    }

    func resolveDirtyWorkspace(_ decision: DirtyWorkspaceDecision) {
        performTaskUpdate(apiClient.resolveDirtyWorkspace(taskId: taskId, decision: decision))
    }

    func sendFollowUp() {
        let trimmed = followUpText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        performTaskUpdate(apiClient.sendMessage(taskId: taskId, message: trimmed)) { [weak self] in
            self?.followUpText = ""
        }
    }

    func requestGitAction(_ action: GitAction, message: String? = nil, title: String? = nil, targetBranch: String? = nil) {
        performTaskUpdate(apiClient.requestGitAction(taskId: taskId, action: action, message: message, title: title, targetBranch: targetBranch))
    }

    func requestReviewAction(title: String, targetBranch: String, reviewMode: ReviewMode, commitMessage: String?) {
        performTaskUpdate(
            apiClient.requestGitAction(
                taskId: taskId,
                action: .createPR,
                message: commitMessage,
                title: title,
                targetBranch: targetBranch,
                reviewMode: reviewMode
            )
        )
    }

    func resolveApproval(approvalId: String, decision: String, receiveValue: (() -> Void)? = nil) {
        approvalCancellable?.cancel()
        approvalCancellable = apiClient.decideApproval(approvalId: approvalId, decision: decision)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard let self else { return }
                if case let .failure(error) = completion {
                    self.errorMessage = error.localizedDescription
                }
            } receiveValue: { [weak self] _ in
                guard let self else { return }
                self.errorMessage = nil
                receiveValue?()
                self.load()
            }
    }

    private func performTaskUpdate(
        _ publisher: AnyPublisher<TaskSnapshot, APIError>,
        receiveValue: (() -> Void)? = nil
    ) {
        actionCancellable?.cancel()
        actionCancellable = publisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard let self else { return }
                if case let .failure(error) = completion {
                    self.errorMessage = self.userVisibleActionError(from: error)
                    if case .requestFailed(409, _) = error {
                        self.load()
                    }
                }
            } receiveValue: { [weak self] snapshot in
                guard let self else { return }
                self.applySnapshot(snapshot, shouldNotifyAboutReportUpload: true)
                receiveValue?()
            }
    }

    private func applySnapshot(_ nextSnapshot: TaskSnapshot, shouldNotifyAboutReportUpload: Bool) {
        let hadSnapshot = snapshot != nil
        let previousPublishedAt = snapshot?.lastPublishedAt
        snapshot = nextSnapshot
        errorMessage = nil

        guard shouldNotifyAboutReportUpload, hadSnapshot else {
            return
        }

        let nextPublishedAt = nextSnapshot.lastPublishedAt
        guard nextPublishedAt != previousPublishedAt else {
            return
        }

        guard nextPublishedAt != nil || nextSnapshot.reportURL != nil else {
            return
        }

        let publishedLabel = nextSnapshot.displayLastPublishedAt ?? "just now"
        reportUploadNotice = ReportUploadNotice(
            message: "The latest task report was uploaded at \(publishedLabel).",
            reportURL: nextSnapshot.reportURL.flatMap(URL.init(string:))
        )
    }

    private func userVisibleActionError(from error: APIError) -> String {
        guard case let .requestFailed(statusCode, message) = error else {
            return error.localizedDescription
        }

        guard statusCode == 409 else {
            return error.localizedDescription
        }

        if message.contains("already has a pending approval") {
            return "This task is waiting for approval. Approve or deny it first, then continue."
        }

        if message.contains("already has a queued runner command") {
            return "This task is already queued on the Mac runner. Pull to refresh the latest status."
        }

        if message.contains("can only be manually completed while waiting for input") {
            return "Only tasks waiting for your input can be marked completed from iPhone."
        }

        if message.contains("dirty workspace decision") {
            return "This repo has local changes. Choose one of the dirty workspace options first."
        }

        if message.contains("stop request in progress") {
            return "This task is already stopping on the Mac runner. Pull to refresh the latest state."
        }

        if message.contains("must be completed, failed, or canceled before it can be deleted") {
            return "Only completed, failed, or canceled tasks can be deleted from cloud history."
        }

        if message.contains("cannot be deleted yet") {
            return "The Mac runner still owns this task. Pull to refresh and try again in a moment."
        }

        if let userVisibleMessage = userVisibleTaskFailureDetail(message) {
            return userVisibleMessage
        }

        return error.localizedDescription
    }

    private func scheduleReconnectIfNeeded() {
        guard shouldMaintainStream, shouldReconnectStream else { return }

        reconnectAttempt += 1
        let workItem = DispatchWorkItem { [weak self] in
            self?.reconnectWorkItem = nil
            self?.connectStream()
        }

        reconnectWorkItem?.cancel()
        reconnectWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + reconnectDelay, execute: workItem)
    }

    private var shouldReconnectStream: Bool {
        guard let snapshot else {
            return true
        }

        return !snapshot.status.isTerminal
    }

    private var reconnectDelay: TimeInterval {
        min(pow(2, Double(max(reconnectAttempt - 1, 0))), 15)
    }
}
