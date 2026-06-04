import Combine
import Darwin
import Foundation

struct RunnerHostConfiguration {
    static let defaultLaunchAgentLabel = "com.remoteagentworkbench.runner"
    static let legacyLaunchAgentLabel = "com.remoteagentworkbench.legacy-runner"
    static let defaultNodeBinary = "node"
    static let defaultShell = "/bin/zsh"
    static let defaultFileName = "runner-host.env"

    let homeDirectory: String
    let hostConfigFilePath: String
    let workbenchRoot: String
    let dataRoot: String
    let logRoot: String
    let runnerEnvFile: String
    let nodeCommand: String
    let shellPath: String
    let launchAgentLabel: String

    init(homeDirectory: String = FileManager.default.homeDirectoryForCurrentUser.path) {
        self.homeDirectory = homeDirectory

        let defaultDataRoot = "\(homeDirectory)/RemoteAgentWorkbenchData"
        let defaultConfigPath = "\(defaultDataRoot)/\(Self.defaultFileName)"
        let bootstrapValues = Self.readEnvFile(at: defaultConfigPath)
        let resolvedHostConfigFilePath = Self.expandPath(
            bootstrapValues["RUNNER_HOST_CONFIG_FILE"],
            fallback: defaultConfigPath,
            homeDirectory: homeDirectory
        )
        var values = bootstrapValues
        if resolvedHostConfigFilePath != defaultConfigPath {
            values.merge(Self.readEnvFile(at: resolvedHostConfigFilePath)) { _, override in
                override
            }
        }

        hostConfigFilePath = resolvedHostConfigFilePath
        workbenchRoot = Self.expandPath(values["WORKBENCH_ROOT"], fallback: "\(homeDirectory)/Code/RemoteAgentWorkbench", homeDirectory: homeDirectory)
        dataRoot = Self.expandPath(values["WORKBENCH_DATA_ROOT"], fallback: defaultDataRoot, homeDirectory: homeDirectory)
        logRoot = Self.expandPath(values["WORKBENCH_LOG_ROOT"], fallback: "\(homeDirectory)/Library/Logs/RemoteAgentWorkbench", homeDirectory: homeDirectory)
        runnerEnvFile = Self.expandPath(values["RUNNER_ENV_FILE"], fallback: "\(workbenchRoot)/runner/.env.production", homeDirectory: homeDirectory)
        nodeCommand = Self.nonEmptyTrimmed(values["RUNNER_NODE_BIN"]) ?? Self.defaultNodeBinary
        shellPath = Self.nonEmptyTrimmed(values["RUNNER_SHELL"]) ?? Self.defaultShell
        launchAgentLabel = Self.resolveLaunchAgentLabel(
            explicitLabel: values["RUNNER_LAUNCH_AGENT_LABEL"],
            homeDirectory: homeDirectory
        )
    }

    var runnerRoot: String {
        "\(workbenchRoot)/runner"
    }

    var launchAgentPath: String {
        "\(homeDirectory)/Library/LaunchAgents/\(launchAgentLabel).plist"
    }

    private static func expandPath(_ value: String?, fallback: String, homeDirectory: String) -> String {
        let raw = nonEmptyTrimmed(value) ?? fallback
        if raw == "~" {
            return homeDirectory
        }
        if raw.hasPrefix("~/") {
            return "\(homeDirectory)/\(raw.dropFirst(2))"
        }
        return raw
    }

    private static func nonEmptyTrimmed(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func resolveLaunchAgentLabel(explicitLabel: String?, homeDirectory: String) -> String {
        if let explicitLabel = nonEmptyTrimmed(explicitLabel) {
            return explicitLabel
        }

        let legacyLaunchAgentPath = "\(homeDirectory)/Library/LaunchAgents/\(legacyLaunchAgentLabel).plist"
        if FileManager.default.fileExists(atPath: legacyLaunchAgentPath) {
            return legacyLaunchAgentLabel
        }

        return defaultLaunchAgentLabel
    }

    private static func readEnvFile(at path: String) -> [String: String] {
        guard
            FileManager.default.fileExists(atPath: path),
            let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
            let text = String(data: data, encoding: .utf8)
        else {
            return [:]
        }

        var values: [String: String] = [:]
        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !line.isEmpty, !line.hasPrefix("#"), let separatorIndex = line.firstIndex(of: "=") else {
                continue
            }

            let key = String(line[..<separatorIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
            var value = String(line[line.index(after: separatorIndex)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 {
                value.removeFirst()
                value.removeLast()
            }
            values[key] = value
        }
        return values
    }
}

struct RunnerLocalPaths {
    let host: RunnerHostConfiguration

    init(host: RunnerHostConfiguration = RunnerHostConfiguration()) {
        self.host = host
    }

    var homeDirectory: String {
        host.homeDirectory
    }

    var workbenchRoot: String {
        host.workbenchRoot
    }

    var runnerRoot: String {
        host.runnerRoot
    }

    var launchAgentLabel: String {
        host.launchAgentLabel
    }

    var logsDirectory: String {
        host.logRoot
    }

    var stdoutLogPath: String {
        "\(logsDirectory)/runner.stdout.log"
    }

    var stderrLogPath: String {
        "\(logsDirectory)/runner.stderr.log"
    }

    var dataRoot: String {
        host.dataRoot
    }

    var requestJournalPath: String {
        "\(dataRoot)/logs/runner-requests.jsonl"
    }

    var legacyWorktreesPath: String {
        "\(dataRoot)/worktrees"
    }

    var tasksPath: String {
        "\(dataRoot)/tasks"
    }

    var projectsFilePath: String {
        "\(dataRoot)/projects.json"
    }

    var directoriesFilePath: String {
        "\(dataRoot)/directories.json"
    }

    var launchAgentPath: String {
        host.launchAgentPath
    }

    var runnerEnvFile: String {
        host.runnerEnvFile
    }

    var hostConfigFilePath: String {
        host.hostConfigFilePath
    }

    var nodeCommand: String {
        host.nodeCommand
    }

    var shellPath: String {
        host.shellPath
    }
}

struct LocalProjectConfig: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var repo: String
    var baseBranch: String
    var deliveryMode: DeliveryMode
    var autoPush: Bool
    var defaultTaskTitle: String
    var defaultPrompt: String
    var isFeatured: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case repo
        case baseBranch
        case deliveryMode
        case autoPush
        case defaultTaskTitle
        case defaultPrompt
        case isFeatured
    }

    init(
        id: String,
        name: String,
        repo: String,
        baseBranch: String,
        deliveryMode: DeliveryMode = .reviewRequired,
        autoPush: Bool = true,
        defaultTaskTitle: String,
        defaultPrompt: String,
        isFeatured: Bool = false
    ) {
        self.id = id
        self.name = name
        self.repo = repo
        self.baseBranch = baseBranch
        self.deliveryMode = deliveryMode
        self.autoPush = autoPush
        self.defaultTaskTitle = defaultTaskTitle
        self.defaultPrompt = defaultPrompt
        self.isFeatured = isFeatured
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        repo = try container.decode(String.self, forKey: .repo)
        baseBranch = try container.decode(String.self, forKey: .baseBranch)
        deliveryMode = try container.decodeIfPresent(DeliveryMode.self, forKey: .deliveryMode) ?? .reviewRequired
        autoPush = try container.decodeIfPresent(Bool.self, forKey: .autoPush) ?? true
        defaultTaskTitle = try container.decode(String.self, forKey: .defaultTaskTitle)
        defaultPrompt = try container.decode(String.self, forKey: .defaultPrompt)
        isFeatured = try container.decodeIfPresent(Bool.self, forKey: .isFeatured) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(repo, forKey: .repo)
        try container.encode(baseBranch, forKey: .baseBranch)
        try container.encode(deliveryMode, forKey: .deliveryMode)
        try container.encode(autoPush, forKey: .autoPush)
        try container.encode(defaultTaskTitle, forKey: .defaultTaskTitle)
        try container.encode(defaultPrompt, forKey: .defaultPrompt)
        try container.encode(isFeatured, forKey: .isFeatured)
    }
}

struct LocalTaskSummary: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let prompt: String
    let repo: String
    let baseBranch: String
    let projectId: String?
    let projectName: String?
    let status: String
    let summary: String
    let runnerId: String?
    let reportURL: String?
    let lastPublishedAt: String?
    let latestResultSummary: String?
    let createdAt: String
    let updatedAt: String
    let sessionAlias: String
    let threadId: String?
    let workspacePath: String?
    let codexSessionFilePath: String?

    var projectDisplayName: String {
        if let projectName, !projectName.isEmpty {
            return projectName
        }
        if let projectId, !projectId.isEmpty {
            return projectId
        }
        return "Unscoped"
    }

    var statusTitle: String {
        status.replacingOccurrences(of: "_", with: " ").capitalized
    }

    var displayTitle: String {
        let normalizedTitle = title
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalizedTitle.isEmpty {
            return normalizedTitle
        }

        let normalizedPrompt = prompt
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return normalizedPrompt.isEmpty ? "Untitled Task" : normalizedPrompt
    }

    var displaySubtitle: String {
        let latest = latestResultSummary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !latest.isEmpty {
            return latest
        }

        let fallback = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        if !fallback.isEmpty {
            return fallback
        }

        return statusTitle
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

    var isTerminal: Bool {
        ["completed", "failed", "canceled"].contains(status)
    }
}

struct LocalTaskEventEntry: Codable, Identifiable, Hashable {
    let id: String
    let taskId: String
    let recordedAt: String
    let kind: String
    let title: String
    let detail: String
    let artifactPath: String?
    let codexOutputPath: String?
    let reportURL: String?

    var displayRecordedAt: String {
        BeijingDateTime.displayOrFallback(recordedAt)
    }

    var sortDate: Date {
        BeijingDateTime.sortDate(primary: recordedAt)
    }
}

struct LocalArtifactFile: Identifiable, Hashable {
    let id: String
    let title: String
    let path: String
}

struct CodexSessionPreview: Hashable {
    let sessionFilePath: String
    let lastUpdatedAt: String?
    let finalAnswer: String?
    let latestAssistantMessage: String?
    let latestPlanMessage: String?

    var primaryText: String? {
        if let finalAnswer, !finalAnswer.isEmpty {
            return finalAnswer
        }
        if let latestAssistantMessage, !latestAssistantMessage.isEmpty {
            return latestAssistantMessage
        }
        if let latestPlanMessage, !latestPlanMessage.isEmpty {
            return latestPlanMessage
        }
        return nil
    }

    var displayLastUpdatedAt: String? {
        BeijingDateTime.display(lastUpdatedAt)
    }
}

struct LocalTaskDetail: Hashable {
    let task: LocalTaskSummary
    let events: [LocalTaskEventEntry]
    let artifactFiles: [LocalArtifactFile]
    let codexSessionPreview: CodexSessionPreview?
}

struct RunnerActivityEntry: Identifiable, Hashable {
    let id: String
    let recordedAt: Date?
    let event: String
    let taskId: String
    let kind: String?
    let title: String?
    let repo: String?
    let baseBranch: String?
    let executionMode: String?
    let prompt: String?
    let commitMessage: String?
    let error: String?

    var displayTitle: String {
        switch event {
        case "assignment_claimed":
            return title?.isEmpty == false ? title! : "Assignment claimed"
        case "assignment_completed":
            return "Assignment completed"
        case "assignment_failed":
            return "Assignment failed"
        default:
            return event.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var displaySubtitle: String {
        var lines: [String] = []
        let header = [kind, taskId]
            .compactMap { component in
                guard let component, !component.isEmpty else { return nil }
                return component
            }
            .joined(separator: " • ")

        if !header.isEmpty {
            lines.append(header)
        }

        if let repo, !repo.isEmpty {
            lines.append("Repo: \(repo)")
        }

        var metadata: [String] = []
        if let baseBranch, !baseBranch.isEmpty {
            metadata.append("Base: \(baseBranch)")
        }
        if let executionMode, !executionMode.isEmpty {
            metadata.append("Mode: \(executionMode)")
        }
        if !metadata.isEmpty {
            lines.append(metadata.joined(separator: " • "))
        }

        if let commitMessage, !commitMessage.isEmpty {
            lines.append("Commit: \(commitMessage)")
        }

        if let error, !error.isEmpty {
            lines.append(error)
        } else if let prompt, !prompt.isEmpty {
            lines.append(prompt)
        }

        return lines.joined(separator: "\n")
    }

    var relativeTimestamp: String {
        guard let recordedAt else {
            return "Unknown time"
        }

        return RelativeDateTimeFormatter().localizedString(for: recordedAt, relativeTo: Date())
    }
}

enum RunnerServiceState: Equatable {
    case checking
    case running(pid: Int?)
    case loaded
    case stopped
    case unavailable(message: String)

    var title: String {
        switch self {
        case .checking:
            return "Checking"
        case .running:
            return "Running"
        case .loaded:
            return "Loaded"
        case .stopped:
            return "Stopped"
        case .unavailable:
            return "Unavailable"
        }
    }
}

@MainActor
final class LocalMachineModel: ObservableObject {
    @Published private(set) var serviceState: RunnerServiceState = .checking
    @Published private(set) var recentActivity: [RunnerActivityEntry] = []
    @Published private(set) var projects: [LocalProjectConfig] = []
    @Published private(set) var localTasks: [LocalTaskSummary] = []
    @Published var lastErrorMessage: String?

    let paths: RunnerLocalPaths

    private let workQueue = DispatchQueue(label: "RemoteAgentWorkbench.LocalMachineModel", qos: .userInitiated)
    private var autoRefreshCancellable: AnyCancellable?

    init(paths: RunnerLocalPaths = RunnerLocalPaths()) {
        self.paths = paths
    }

    func refresh() {
        let paths = self.paths

        workQueue.async { [weak self] in
            let nextState = Self.readServiceState(paths: paths)
            let nextActivity = Self.readRecentActivity(paths: paths, limit: 12)
            let nextProjects = Self.readProjects(paths: paths)
            let nextLocalTasks = Self.readLocalTasks(paths: paths, limit: 40)

            DispatchQueue.main.async {
                self?.serviceState = nextState
                self?.recentActivity = nextActivity
                self?.projects = nextProjects
                self?.localTasks = nextLocalTasks
                if case let .unavailable(message) = nextState {
                    self?.lastErrorMessage = message
                } else {
                    self?.lastErrorMessage = nil
                }
            }
        }
    }

    func startAutoRefresh(interval: TimeInterval = 10) {
        guard autoRefreshCancellable == nil else { return }

        autoRefreshCancellable = Timer.publish(every: interval, on: .main, in: .common)
            .autoconnect()
            .sink { [weak self] _ in
                self?.refresh()
            }
    }

    func stopAutoRefresh() {
        autoRefreshCancellable?.cancel()
        autoRefreshCancellable = nil
    }

    func startRunner() {
        performCommandSequence([
            ["/bin/launchctl", "enable", "gui/\(getuid())/\(paths.launchAgentLabel)"],
            ["/bin/launchctl", "bootstrap", "gui/\(getuid())", paths.launchAgentPath],
            ["/bin/launchctl", "kickstart", "-k", "gui/\(getuid())/\(paths.launchAgentLabel)"]
        ], ignorableFailures: [
            "service already loaded"
        ])
    }

    func stopRunner() {
        performCommandSequence([
            ["/bin/launchctl", "bootout", "gui/\(getuid())", paths.launchAgentPath]
        ], ignorableFailures: [
            "could not find service",
            "no such process"
        ])
    }

    func restartRunner() {
        performCommandSequence([
            ["/bin/launchctl", "kickstart", "-k", "gui/\(getuid())/\(paths.launchAgentLabel)"]
        ])
    }

    func saveProjects(_ projects: [LocalProjectConfig]) {
        let paths = self.paths

        workQueue.async { [weak self] in
            do {
                let parent = (paths.projectsFilePath as NSString).deletingLastPathComponent
                try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true, attributes: nil)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
                let data = try encoder.encode(projects)
                try data.write(to: URL(fileURLWithPath: paths.projectsFilePath), options: .atomic)

                let nextProjects = Self.readProjects(paths: paths)
                DispatchQueue.main.async {
                    self?.projects = nextProjects
                    self?.lastErrorMessage = nil
                }
            } catch {
                DispatchQueue.main.async {
                    self?.lastErrorMessage = error.localizedDescription
                }
            }
        }
    }

    func loadTaskDetail(taskId: String) async -> LocalTaskDetail? {
        let paths = self.paths
        return await withCheckedContinuation { continuation in
            workQueue.async {
                continuation.resume(returning: Self.readTaskDetail(paths: paths, taskId: taskId))
            }
        }
    }

    func deleteLocalTask(_ task: LocalTaskSummary, removeManagedWorkspace: Bool, completion: ((Result<Void, Error>) -> Void)? = nil) {
        let paths = self.paths

        workQueue.async { [weak self] in
            do {
                let taskDirectoryPath = URL(fileURLWithPath: paths.tasksPath)
                    .appendingPathComponent(task.id)
                    .path
                try Self.removeItemIfExists(atPath: taskDirectoryPath)

                if removeManagedWorkspace,
                   let workspacePath = task.workspacePath,
                   Self.isManagedWorkspacePath(workspacePath, rootPath: paths.legacyWorktreesPath) {
                    try Self.removeItemIfExists(atPath: workspacePath)
                }

                let nextLocalTasks = Self.readLocalTasks(paths: paths, limit: 40)
                DispatchQueue.main.async {
                    self?.localTasks = nextLocalTasks
                    self?.lastErrorMessage = nil
                    completion?(.success(()))
                }
            } catch {
                DispatchQueue.main.async {
                    self?.lastErrorMessage = error.localizedDescription
                    completion?(.failure(error))
                }
            }
        }
    }

    private func performCommandSequence(_ commands: [[String]], ignorableFailures: [String] = []) {
        let paths = self.paths

        workQueue.async { [weak self] in
            do {
                for command in commands {
                    let result = try Self.runCommand(command)
                    if result.exitCode != 0 {
                        let output = [result.stdout, result.stderr]
                            .joined(separator: "\n")
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                            .lowercased()

                        if ignorableFailures.contains(where: output.contains) {
                            continue
                        }

                        throw LocalMachineError.commandFailed(output.isEmpty ? "launchctl exited with code \(result.exitCode)." : output)
                    }
                }

                let nextState = Self.readServiceState(paths: paths)
                let nextActivity = Self.readRecentActivity(paths: paths, limit: 12)
                let nextProjects = Self.readProjects(paths: paths)
                let nextLocalTasks = Self.readLocalTasks(paths: paths, limit: 40)
                DispatchQueue.main.async {
                    self?.serviceState = nextState
                    self?.recentActivity = nextActivity
                    self?.projects = nextProjects
                    self?.localTasks = nextLocalTasks
                    self?.lastErrorMessage = nil
                }
            } catch {
                DispatchQueue.main.async {
                    self?.lastErrorMessage = error.localizedDescription
                    self?.refresh()
                }
            }
        }
    }

    nonisolated private static func readServiceState(paths: RunnerLocalPaths) -> RunnerServiceState {
        guard FileManager.default.fileExists(atPath: paths.launchAgentPath) else {
            return .unavailable(message: "LaunchAgent plist not found at \(paths.launchAgentPath)")
        }

        guard let result = try? runCommand([
            "/bin/launchctl",
            "print",
            "gui/\(getuid())/\(paths.launchAgentLabel)"
        ]) else {
            return .unavailable(message: "Unable to query launchctl.")
        }

        let combinedOutput = [result.stdout, result.stderr]
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if result.exitCode != 0 {
            let normalized = combinedOutput.lowercased()
            if normalized.contains("could not find service") || normalized.contains("not found") {
                return .stopped
            }

            return .unavailable(message: combinedOutput.isEmpty ? "launchctl print failed." : combinedOutput)
        }

        if combinedOutput.contains("state = running") {
            return .running(pid: extractPID(from: combinedOutput))
        }

        return .loaded
    }

    nonisolated private static func readRecentActivity(paths: RunnerLocalPaths, limit: Int) -> [RunnerActivityEntry] {
        guard
            FileManager.default.fileExists(atPath: paths.requestJournalPath),
            let data = try? Data(contentsOf: URL(fileURLWithPath: paths.requestJournalPath)),
            let raw = String(data: data, encoding: .utf8)
        else {
            return []
        }

        return raw
            .split(whereSeparator: \.isNewline)
            .suffix(limit)
            .compactMap { line in
                guard
                    let lineData = line.data(using: .utf8),
                    let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
                else {
                    return nil
                }

                let timestamp = (json["recordedAt"] as? String).flatMap(parseISO8601Date)
                let event = (json["event"] as? String) ?? "unknown_event"
                let taskId = (json["taskId"] as? String) ?? "unknown-task"
                let kind = json["kind"] as? String
                let title = json["title"] as? String
                let repo = json["repo"] as? String
                let baseBranch = json["baseBranch"] as? String
                let executionMode = json["executionMode"] as? String
                let prompt = json["prompt"] as? String
                let commitMessage = json["commitMessage"] as? String
                let error = json["error"] as? String

                return RunnerActivityEntry(
                    id: "\(event)-\(taskId)-\((json["recordedAt"] as? String) ?? UUID().uuidString)",
                    recordedAt: timestamp,
                    event: event,
                    taskId: taskId,
                    kind: kind,
                    title: title,
                    repo: repo,
                    baseBranch: baseBranch,
                    executionMode: executionMode,
                    prompt: prompt,
                    commitMessage: commitMessage,
                    error: error
                )
            }
            .reversed()
    }

    nonisolated private static func readProjects(paths: RunnerLocalPaths) -> [LocalProjectConfig] {
        guard
            FileManager.default.fileExists(atPath: paths.projectsFilePath),
            let data = try? Data(contentsOf: URL(fileURLWithPath: paths.projectsFilePath)),
            let projects = try? JSONDecoder().decode([LocalProjectConfig].self, from: data)
        else {
            return []
        }

        return projects
    }

    nonisolated private static func readLocalTasks(paths: RunnerLocalPaths, limit: Int) -> [LocalTaskSummary] {
        guard let directories = try? FileManager.default.contentsOfDirectory(
            at: URL(fileURLWithPath: paths.tasksPath),
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return directories
            .compactMap { directory in
                let fileURL = directory.appendingPathComponent("task.json")
                guard
                    let data = try? Data(contentsOf: fileURL),
                    let task = try? JSONDecoder().decode(LocalTaskSummary.self, from: data)
                else {
                    return nil
                }
                return task
            }
            .sorted { lhs, rhs in
                if lhs.sortDate == rhs.sortDate {
                    return lhs.id > rhs.id
                }
                return lhs.sortDate > rhs.sortDate
            }
            .prefix(limit)
            .map { $0 }
    }

    nonisolated private static func readTaskDetail(paths: RunnerLocalPaths, taskId: String) -> LocalTaskDetail? {
        let taskURL = URL(fileURLWithPath: paths.tasksPath)
            .appendingPathComponent(taskId)
            .appendingPathComponent("task.json")
        guard
            let taskData = try? Data(contentsOf: taskURL),
            let task = try? JSONDecoder().decode(LocalTaskSummary.self, from: taskData)
        else {
            return nil
        }

        let eventsURL = URL(fileURLWithPath: paths.tasksPath)
            .appendingPathComponent(taskId)
            .appendingPathComponent("events.jsonl")
        let events: [LocalTaskEventEntry] = {
            guard
                let data = try? Data(contentsOf: eventsURL),
                let raw = String(data: data, encoding: .utf8)
            else {
                return []
            }

            return raw
                .split(whereSeparator: \.isNewline)
                .compactMap { line in
                    guard let lineData = line.data(using: .utf8) else {
                        return nil
                    }
                    return try? JSONDecoder().decode(LocalTaskEventEntry.self, from: lineData)
                }
                .sorted { lhs, rhs in
                    if lhs.sortDate == rhs.sortDate {
                        return lhs.id > rhs.id
                    }
                    return lhs.sortDate > rhs.sortDate
                }
        }()

        let artifactsURL = URL(fileURLWithPath: paths.tasksPath)
            .appendingPathComponent(taskId)
            .appendingPathComponent("artifacts")
        let artifactFiles: [LocalArtifactFile] = {
            guard let urls = try? FileManager.default.contentsOfDirectory(at: artifactsURL, includingPropertiesForKeys: nil) else {
                return []
            }

            return urls
                .map { url in
                    LocalArtifactFile(
                        id: url.path,
                        title: url.lastPathComponent,
                        path: url.path
                    )
                }
                .sorted { $0.title > $1.title }
        }()

        let codexSessionPreview = readCodexSessionPreview(from: task.codexSessionFilePath)

        return LocalTaskDetail(
            task: task,
            events: events,
            artifactFiles: artifactFiles,
            codexSessionPreview: codexSessionPreview
        )
    }

    nonisolated private static func readCodexSessionPreview(from path: String?) -> CodexSessionPreview? {
        guard
            let path,
            !path.isEmpty,
            FileManager.default.fileExists(atPath: path),
            let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
            let raw = String(data: data, encoding: .utf8)
        else {
            return nil
        }

        var lastUpdatedAt: String?
        var finalAnswer: String?
        var latestAssistantMessage: String?
        var latestPlanMessage: String?

        for line in raw.split(whereSeparator: \.isNewline) {
            guard
                let lineData = line.data(using: .utf8),
                let object = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                let timestamp = object["timestamp"] as? String
            else {
                continue
            }

            lastUpdatedAt = timestamp

            if let type = object["type"] as? String, type == "event_msg",
               let payload = object["payload"] as? [String: Any],
               let message = payload["message"] as? String,
               !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                latestAssistantMessage = message.trimmingCharacters(in: .whitespacesAndNewlines)
            }

            guard
                let type = object["type"] as? String,
                type == "response_item",
                let payload = object["payload"] as? [String: Any]
            else {
                continue
            }

            if let phase = payload["phase"] as? String, phase == "final_answer",
               let content = payload["content"] as? [[String: Any]] {
                let text = content
                    .compactMap { $0["text"] as? String }
                    .joined(separator: "\n\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    finalAnswer = text
                }
            }

            if let messageText = payload["text"] as? String,
               !messageText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                latestPlanMessage = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
            }

            if let content = payload["content"] as? [[String: Any]] {
                let text = content
                    .compactMap { item -> String? in
                        guard let value = item["text"] as? String else {
                            return nil
                        }
                        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
                        return normalized.isEmpty ? nil : normalized
                    }
                    .joined(separator: "\n\n")
                    .trimmingCharacters(in: .whitespacesAndNewlines)

                if !text.isEmpty {
                    latestAssistantMessage = text
                }
            }
        }

        return CodexSessionPreview(
            sessionFilePath: path,
            lastUpdatedAt: lastUpdatedAt,
            finalAnswer: finalAnswer,
            latestAssistantMessage: latestAssistantMessage,
            latestPlanMessage: latestPlanMessage
        )
    }

    nonisolated private static func parseISO8601Date(_ rawValue: String) -> Date? {
        BeijingDateTime.parse(rawValue)
    }

    nonisolated private static func extractPID(from output: String) -> Int? {
        guard let match = output.firstMatch(of: /pid = ([0-9]+)/) else {
            return nil
        }

        return Int(match.1)
    }

    nonisolated private static func runCommand(_ command: [String]) throws -> CommandResult {
        guard let executable = command.first else {
            throw LocalMachineError.commandFailed("Empty command.")
        }

        let process = Process()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(command.dropFirst())
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            throw LocalMachineError.commandFailed(error.localizedDescription)
        }

        process.waitUntilExit()

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
        let stderr = String(data: stderrData, encoding: .utf8) ?? ""

        return CommandResult(exitCode: process.terminationStatus, stdout: stdout, stderr: stderr)
    }

    nonisolated private static func removeItemIfExists(atPath targetPath: String) throws {
        guard FileManager.default.fileExists(atPath: targetPath) else {
            return
        }

        try FileManager.default.removeItem(atPath: targetPath)
    }

    nonisolated private static func isManagedWorkspacePath(_ targetPath: String, rootPath: String) -> Bool {
        let normalizedRoot = URL(fileURLWithPath: rootPath).standardizedFileURL.path
        let normalizedTarget = URL(fileURLWithPath: targetPath).standardizedFileURL.path
        let rootPrefix = normalizedRoot.hasSuffix("/") ? normalizedRoot : "\(normalizedRoot)/"
        return normalizedTarget.hasPrefix(rootPrefix)
    }
}

private struct CommandResult {
    let exitCode: Int32
    let stdout: String
    let stderr: String
}

private enum LocalMachineError: LocalizedError {
    case commandFailed(String)

    var errorDescription: String? {
        switch self {
        case let .commandFailed(message):
            return message
        }
    }
}
