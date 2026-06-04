import Foundation

enum BeijingDateTime {
    private static let shanghaiTimeZone = TimeZone(identifier: "Asia/Shanghai") ?? .current

    static func parse(_ rawValue: String?) -> Date? {
        guard let value = rawValue?.trimmedNonEmpty else {
            return nil
        }

        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractionalFormatter.date(from: value) {
            return date
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    static func display(_ rawValue: String?) -> String? {
        guard let value = rawValue?.trimmedNonEmpty else {
            return nil
        }

        guard let date = parse(value) else {
            return value
        }

        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "zh_Hans_CN")
        formatter.timeZone = shanghaiTimeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm"
        return formatter.string(from: date)
    }

    static func displayOrFallback(_ rawValue: String?) -> String {
        display(rawValue) ?? rawValue?.trimmedNonEmpty ?? "Unknown"
    }

    static func sortDate(primary: String?, fallback: String? = nil) -> Date {
        parse(primary) ?? parse(fallback) ?? .distantPast
    }
}

enum TaskStatus: String, Codable, CaseIterable, Hashable {
    case draft
    case queued
    case preparingWorkspace = "preparing_workspace"
    case awaitingPlanApproval = "awaiting_plan_approval"
    case running
    case awaitingHumanInput = "awaiting_human_input"
    case awaitingGitApproval = "awaiting_git_approval"
    case blockedConflict = "blocked_conflict"
    case completed
    case failed
    case canceled

    var title: String {
        switch self {
        case .draft:
            "Draft"
        case .queued:
            "Queued"
        case .preparingWorkspace:
            "Preparing"
        case .awaitingPlanApproval:
            "Plan Approval"
        case .running:
            "Running"
        case .awaitingHumanInput:
            "Awaiting Input"
        case .awaitingGitApproval:
            "Git Approval"
        case .blockedConflict:
            "Conflict"
        case .completed:
            "Completed"
        case .failed:
            "Failed"
        case .canceled:
            "Canceled"
        }
    }
}

enum ApprovalStatus: String, Codable, Hashable {
    case pending
    case approved
    case denied

    var title: String {
        rawValue.capitalized
    }
}

enum GitAction: String, Codable, CaseIterable, Hashable {
    case commit
    case rebase
    case push
    case createPR = "create_pr"

    var pathComponent: String {
        switch self {
        case .createPR:
            "create-pr"
        default:
            rawValue
        }
    }

    var title: String {
        switch self {
        case .commit:
            "Commit"
        case .rebase:
            "Rebase"
        case .push:
            "Push"
        case .createPR:
            "Create PR"
        }
    }
}

enum ReviewMode: String, Codable, Hashable {
    case reviewOnly = "review_only"
    case commitAndReview = "commit_and_review"
}

enum ReviewPlatform: String, Codable, Hashable {
    case github
    case gitlab

    var reviewTitle: String {
        switch self {
        case .github:
            "PR"
        case .gitlab:
            "MR"
        }
    }

    var reviewNoun: String {
        switch self {
        case .github:
            "pull request"
        case .gitlab:
            "merge request"
        }
    }

    var createActionTitle: String {
        switch self {
        case .github:
            "Create PR"
        case .gitlab:
            "Create MR"
        }
    }
}

enum TaskExecutionMode: String, Codable, CaseIterable, Hashable {
    case newThread = "new_thread"
    case resumeThread = "resume_thread"

    var title: String {
        switch self {
        case .newThread:
            "New Thread"
        case .resumeThread:
            "Resume History"
        }
    }
}

enum DeliveryMode: String, Codable, CaseIterable, Hashable {
    case reviewRequired = "review_required"
    case directCommit = "direct_commit"

    var title: String {
        switch self {
        case .reviewRequired:
            "MR / PR Approval"
        case .directCommit:
            "Direct Submit"
        }
    }

    var shortTitle: String {
        switch self {
        case .reviewRequired:
            "Need Review"
        case .directCommit:
            "Direct Submit"
        }
    }

    var projectDescription: String {
        switch self {
        case .reviewRequired:
            "Cautious flow for mature projects: review the plan first, then implement, then keep Git actions behind approval."
        case .directCommit:
            "Fast flow for active work: after you send the prompt, the runner drafts the plan internally and starts implementation automatically. Git repos complete with a local commit; plain folders complete after files are saved and checked."
        }
    }
}

enum TaskBranchMode: String, Codable, CaseIterable, Hashable {
    case currentBranch = "current_branch"
    case newBranch = "new_branch"

    var title: String {
        switch self {
        case .currentBranch:
            "Current Branch"
        case .newBranch:
            "New Branch"
        }
    }

    func displayLabel(branchName: String?, executionBranch: String? = nil) -> String {
        if let resolvedExecutionBranch = executionBranch?.trimmedNonEmpty {
            return resolvedExecutionBranch
        }

        if let resolvedBranchName = branchName?.trimmedNonEmpty {
            return resolvedBranchName
        }

        return title
    }
}

enum AutoPushCopy {
    static let title = "Auto Push"
    static let label = "Push an existing remote branch automatically after the completed local commit is ready."
    static let footnote = "Only used when Direct Submit runs inside a Git repo. The local commit already counts as completion; if the current branch has no matching remote branch yet, the runner skips auto-push safely."
}

enum DirtyWorkspaceState: String, Codable, Hashable {
    case pendingDecision = "pending_decision"
}

enum DirtyWorkspaceDecision: String, Codable, Hashable {
    case clearAndContinue = "clear_and_continue"
    case continueCurrentWorkspace = "continue_current_workspace"
    case planOnly = "plan_only"
    case cancel
}

struct RunnerInfo: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let platform: String
    let isOnline: Bool
    let labels: [String]
    let capabilities: [String]
    let currentTaskId: String?
    let lastHeartbeatAt: String
}

struct ProjectSummary: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let repo: String
    let baseBranch: String
    let deliveryMode: DeliveryMode
    let autoPush: Bool
    let defaultTaskTitle: String
    let defaultPrompt: String
    let isFeatured: Bool
    let runnerId: String
    let createdAt: String
    let updatedAt: String
    let lastSyncedAt: String
    let recentTasksCount: Int
    let pendingApprovalsCount: Int
    let latestTaskId: String?
    let latestTaskTitle: String?
    let latestTaskStatus: TaskStatus?
    let latestTaskUpdatedAt: String?
    let latestReportURL: String?
    let latestResultSummary: String?
}

struct DirectoryPreset: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let rootPath: String
    let runnerId: String
    let createdAt: String
    let updatedAt: String
}

struct DirectoryCreationReceipt: Codable, Hashable {
    let requestId: String
    let presetId: String
    let runnerId: String
    let relativePath: String
    let absolutePath: String
    let createProject: Bool
    let projectName: String?
    let summary: String
}

struct TaskEvent: Codable, Identifiable, Hashable {
    let id: String
    let taskId: String
    let createdAt: String
    let kind: String
    let title: String
    let detail: String
}

struct Artifact: Codable, Identifiable, Hashable {
    let id: String
    let taskId: String
    let kind: String
    let title: String
    let summary: String
    let createdAt: String
}

struct ExecutorSession: Codable, Hashable {
    let sessionAlias: String
    let executorType: String
    let runnerId: String
    let threadId: String
    let cwd: String
    let materializedFromHistory: Bool
    let lastTurnAt: String
}

struct DirtyWorkspaceContext: Codable, Hashable {
    let state: DirtyWorkspaceState
    let currentBranch: String?
    let statusSummary: String?
    let detectedAt: String
    let snapshotPublishedAt: String?
    let lastDecision: DirtyWorkspaceDecision?
}

func userVisibleTaskFailureDetail(_ detail: String) -> String? {
    let message = detail.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty else {
        return nil
    }

    if message.contains("cannot create pull requests yet") {
        return "This Mac runner cannot create pull requests yet. Install `gh`, run `gh auth login`, then refresh the task."
    }

    if message.contains("cannot create merge requests yet") || message.contains("GITLAB_TOKEN") {
        return "This Mac runner cannot create merge requests yet. Add `GITLAB_TOKEN` on the runner, then refresh the task."
    }

    if message.contains("has not identified whether this repository uses GitHub or GitLab yet") {
        return "The Mac runner is still identifying whether this repository uses GitHub or GitLab. Refresh after workspace preparation finishes."
    }

    if message.contains("timed out on the Mac runner") {
        return "The Mac runner timed out while pushing. A local Git hook is probably scanning too much history or waiting for input. Check the repo's push hooks on the runner, then try again."
    }

    if message.contains("pre-push hook") || message.contains("does not bypass Git hooks automatically") {
        return "A local Git pre-push hook on the Mac runner blocked this push. The runner stopped safely before changing the remote. Check the repo's `.git/hooks/pre-push` or hook manager configuration, then try again."
    }

    if message.contains("will not force-push automatically") {
        return "The remote branch has commits that are missing from the runner workspace. The runner stopped safely instead of force-pushing. Fetch or rebase that branch, then try again."
    }

    if message.contains("not currently on a local branch") || message.contains("detached HEAD") {
        return "The Mac runner is not on a local branch right now, so it stopped before creating a remote branch for the review request. Check out or create a local branch on the runner, then try again."
    }

    if message.contains("could not authenticate to origin") {
        return "The Mac runner could not authenticate to the Git remote. Check the runner's SSH key or HTTPS credentials for this repository host, then try again."
    }

    if message.contains("branch protection or a server-side hook") {
        return "The Git server rejected this push because of branch protection or a server-side hook. Check the repository's push rules and your review permissions, then try again."
    }

    if message.contains("not authenticated") || message.contains("gh auth login") {
        return "GitHub CLI is installed on the Mac runner, but it is not logged in yet. Run `gh auth login`, then refresh the task."
    }

    if message.contains("merge request creation failed") {
        return "GitLab rejected the merge request creation. Check `GITLAB_TOKEN` and `GITLAB_BASE_URL` on the Mac runner, then try again."
    }

    return nil
}

struct ApprovalRequest: Codable, Identifiable, Hashable {
    let id: String
    let taskId: String
    let type: String
    let title: String
    let detail: String
    let status: ApprovalStatus
    let payload: [String: String]
    let createdAt: String
    let resolvedAt: String?

    var isPending: Bool {
        status == .pending
    }
}

struct TaskRecord: Codable, Identifiable, Hashable {
    let id: String
    let workflowKey: String
    let deliveryMode: DeliveryMode
    let autoPush: Bool
    let title: String
    let prompt: String
    let repo: String
    let baseBranch: String
    let branchMode: TaskBranchMode
    let branchName: String?
    let executionBranch: String?
    let reviewPlatform: ReviewPlatform?
    let reviewTargetBranches: [String]?
    let dirtyWorkspace: DirtyWorkspaceContext?
    let projectId: String?
    let projectName: String?
    let executionMode: TaskExecutionMode
    let resumeThreadId: String?
    let stopRequestedAt: String?
    let status: TaskStatus
    let runnerId: String?
    let sessionAlias: String
    let summary: String
    let reportURL: String?
    let lastPublishedAt: String?
    let latestResultSummary: String?
    let createdAt: String
    let updatedAt: String
}

struct TaskSnapshot: Codable, Identifiable, Hashable {
    let id: String
    let workflowKey: String
    let deliveryMode: DeliveryMode
    let autoPush: Bool
    let title: String
    let prompt: String
    let repo: String
    let baseBranch: String
    let branchMode: TaskBranchMode
    let branchName: String?
    let executionBranch: String?
    let reviewPlatform: ReviewPlatform?
    let reviewTargetBranches: [String]?
    let dirtyWorkspace: DirtyWorkspaceContext?
    let projectId: String?
    let projectName: String?
    let executionMode: TaskExecutionMode
    let resumeThreadId: String?
    let stopRequestedAt: String?
    let status: TaskStatus
    let runnerId: String?
    let sessionAlias: String
    let summary: String
    let reportURL: String?
    let lastPublishedAt: String?
    let latestResultSummary: String?
    let createdAt: String
    let updatedAt: String
    let approvals: [ApprovalRequest]
    let artifacts: [Artifact]
    let events: [TaskEvent]
    let executorSession: ExecutorSession?
}

extension TaskSnapshot {
    var taskRecord: TaskRecord {
        TaskRecord(
            id: id,
            workflowKey: workflowKey,
            deliveryMode: deliveryMode,
            autoPush: autoPush,
            title: title,
            prompt: prompt,
            repo: repo,
            baseBranch: baseBranch,
            branchMode: branchMode,
            branchName: branchName,
            executionBranch: executionBranch,
            reviewPlatform: reviewPlatform,
            reviewTargetBranches: reviewTargetBranches,
            dirtyWorkspace: dirtyWorkspace,
            projectId: projectId,
            projectName: projectName,
            executionMode: executionMode,
            resumeThreadId: resumeThreadId,
            stopRequestedAt: stopRequestedAt,
            status: status,
            runnerId: runnerId,
            sessionAlias: sessionAlias,
            summary: summary,
            reportURL: reportURL,
            lastPublishedAt: lastPublishedAt,
            latestResultSummary: latestResultSummary,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}

struct CreateTaskRequest: Encodable {
    let workflowKey: String
    let deliveryMode: DeliveryMode
    let autoPush: Bool
    let title: String
    let prompt: String
    let repo: String
    let baseBranch: String
    let branchMode: TaskBranchMode
    let branchName: String?
    let executionMode: TaskExecutionMode
    let resumeThreadId: String?
    let allowParallel: Bool?
}

struct TaskMessageRequest: Encodable {
    let message: String
}

struct CreateProjectTaskRequest: Encodable {
    let deliveryMode: DeliveryMode
    let autoPush: Bool
    let title: String
    let prompt: String
    let branchMode: TaskBranchMode
    let branchName: String?
    let executionMode: TaskExecutionMode
    let resumeThreadId: String?
    let allowParallel: Bool?
}

struct CreateDirectoryRequest: Encodable {
    let presetId: String
    let relativePath: String
    let createProject: Bool?
    let projectName: String?
    let baseBranch: String?
    let deliveryMode: DeliveryMode?
    let autoPush: Bool?
    let defaultTaskTitle: String?
    let defaultPrompt: String?
}

struct ApprovalDecisionRequest: Encodable {
    let decision: String
}

struct GitActionRequest: Encodable {
    let message: String?
    let title: String?
    let targetBranch: String?
    let reviewMode: ReviewMode?
}

struct DirtyWorkspaceDecisionRequest: Encodable {
    let decision: DirtyWorkspaceDecision
}

struct CodexConfigSwitchRequest: Encodable {
    let profileName: String
}

struct CodexConfigDeleteRequest: Encodable {
    let profileName: String
}

struct CreateCodexConfigRequest: Encodable {
    let profileName: String
    let baseURL: String
    let apiKey: String
}

struct CodexConfigActionReceipt: Codable, Hashable {
    let requestId: String
    let runnerId: String
    let profileName: String
    let summary: String
}

struct SystemSummary: Codable, Hashable {
    private enum CodingKeys: String, CodingKey {
        case publicBaseURL
        case corsOrigins
        case userAuthConfigured
        case runnerAuthConfigured
        case deployment
        case codexConfig
    }

    struct DeploymentSummary: Codable, Hashable {
        let sshHost: String
        let sshUser: String
        let deployDir: String
        let envFile: String
        let caddyfile: String
    }

    struct CodexConfigSummary: Codable, Hashable {
        private enum CodingKeys: String, CodingKey {
            case runnerId
            case profiles
            case activeProfileName
            case pendingAction
            case pendingProfileName
            case protectedProfileNames
        }

        let runnerId: String?
        let profiles: [String]
        let activeProfileName: String?
        let pendingAction: String?
        let pendingProfileName: String?
        let protectedProfileNames: [String]

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            runnerId = try container.decodeIfPresent(String.self, forKey: .runnerId)
            profiles = try container.decodeIfPresent([String].self, forKey: .profiles) ?? []
            activeProfileName = try container.decodeIfPresent(String.self, forKey: .activeProfileName)
            pendingAction = try container.decodeIfPresent(String.self, forKey: .pendingAction)
            pendingProfileName = try container.decodeIfPresent(String.self, forKey: .pendingProfileName)
            protectedProfileNames = try container.decodeIfPresent([String].self, forKey: .protectedProfileNames) ?? ["1000", "plus"]
        }
    }

    let publicBaseURL: String
    let corsOrigins: [String]
    let userAuthConfigured: Bool
    let runnerAuthConfigured: Bool
    let deployment: DeploymentSummary
    let codexConfig: CodexConfigSummary?

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        publicBaseURL = try container.decode(String.self, forKey: .publicBaseURL)
        corsOrigins = try container.decode([String].self, forKey: .corsOrigins)
        userAuthConfigured = try container.decodeIfPresent(Bool.self, forKey: .userAuthConfigured) ?? false
        runnerAuthConfigured = try container.decode(Bool.self, forKey: .runnerAuthConfigured)
        deployment = try container.decode(DeploymentSummary.self, forKey: .deployment)
        codexConfig = try container.decodeIfPresent(CodexConfigSummary.self, forKey: .codexConfig)
    }
}

extension RunnerInfo {
    var displayLastHeartbeatAt: String {
        BeijingDateTime.displayOrFallback(lastHeartbeatAt)
    }
}

extension ProjectSummary {
    var displayUpdatedAt: String {
        BeijingDateTime.displayOrFallback(latestTaskUpdatedAt ?? updatedAt)
    }
}

extension TaskEvent {
    var displayCreatedAt: String {
        BeijingDateTime.displayOrFallback(createdAt)
    }

    var sortDate: Date {
        BeijingDateTime.sortDate(primary: createdAt)
    }

    var displayDetail: String {
        guard ["task.failed", "assignment_failed", "failed"].contains(kind) else {
            return detail
        }

        return userVisibleTaskFailureDetail(detail) ?? detail
    }
}

extension Artifact {
    var displayCreatedAt: String {
        BeijingDateTime.displayOrFallback(createdAt)
    }
}

extension ExecutorSession {
    var displayLastTurnAt: String {
        BeijingDateTime.displayOrFallback(lastTurnAt)
    }
}

extension ApprovalRequest {
    var displayCreatedAt: String {
        BeijingDateTime.displayOrFallback(createdAt)
    }

    var displayResolvedAt: String {
        BeijingDateTime.display(resolvedAt) ?? "Pending"
    }
}

extension TaskRecord {
    var branchDisplayTitle: String {
        branchMode.displayLabel(
            branchName: branchName,
            executionBranch: executionBranch ?? dirtyWorkspace?.currentBranch
        )
    }

    var branchSearchText: String {
        [
            branchName?.trimmedNonEmpty,
            executionBranch?.trimmedNonEmpty,
            dirtyWorkspace?.currentBranch?.trimmedNonEmpty,
            branchMode == .currentBranch ? "current branch" : "new branch"
        ]
        .compactMap { $0 }
        .joined(separator: " ")
    }

    var displayTitle: String {
        title.trimmedNonEmpty ?? prompt.displayPromptTitle(fallback: "Untitled Task")
    }

    var displaySubtitle: String {
        latestResultSummary?.trimmedNonEmpty ?? summary.trimmedNonEmpty ?? prompt.displayPromptTitle(fallback: status.title)
    }

    var displayUpdatedAt: String {
        BeijingDateTime.displayOrFallback(updatedAt)
    }

    var displayLastPublishedAt: String? {
        BeijingDateTime.display(lastPublishedAt)
    }

    var sortDate: Date {
        BeijingDateTime.sortDate(primary: updatedAt, fallback: createdAt)
    }

    func targetsSameRepository(as repo: String) -> Bool {
        self.repo.normalizedRepositoryIdentity == repo.normalizedRepositoryIdentity
    }
}

extension Array where Element == TaskRecord {
    func sortedByRecency() -> [TaskRecord] {
        sorted { lhs, rhs in
            if lhs.sortDate == rhs.sortDate {
                return lhs.id > rhs.id
            }
            return lhs.sortDate > rhs.sortDate
        }
    }
}

extension TaskSnapshot {
    var branchDisplayTitle: String {
        branchMode.displayLabel(
            branchName: branchName,
            executionBranch: executionBranch ?? dirtyWorkspace?.currentBranch
        )
    }

    var displayTitle: String {
        title.trimmedNonEmpty ?? prompt.displayPromptTitle(fallback: "Untitled Task")
    }

    var displaySubtitle: String {
        latestResultSummary?.trimmedNonEmpty ?? summary.trimmedNonEmpty ?? prompt.displayPromptTitle(fallback: status.title)
    }

    var displayUpdatedAt: String {
        BeijingDateTime.displayOrFallback(updatedAt)
    }

    var displayLastPublishedAt: String? {
        BeijingDateTime.display(lastPublishedAt)
    }

    var sortedEventsByRecency: [TaskEvent] {
        events.sorted { lhs, rhs in
            if lhs.sortDate == rhs.sortDate {
                return lhs.id > rhs.id
            }
            return lhs.sortDate > rhs.sortDate
        }
    }
}

extension TaskStatus {
    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .canceled:
            true
        default:
            false
        }
    }
}

private extension String {
    var trimmedNonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    func displayPromptTitle(fallback: String) -> String {
        let normalized = replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty ? fallback : normalized
    }

    var normalizedRepositoryIdentity: String {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return ""
        }

        if trimmed.hasPrefix("/") || trimmed.hasPrefix("~/") {
            return trimmed.replacingOccurrences(of: "[/\\\\]+$", with: "", options: .regularExpression)
        }

        return trimmed
            .replacingOccurrences(of: "\\.git$", with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            .lowercased()
    }
}
