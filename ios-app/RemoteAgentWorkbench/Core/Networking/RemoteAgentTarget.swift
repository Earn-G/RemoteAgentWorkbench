import Foundation
import Moya

struct RemoteAgentTarget: TargetType {
    enum Endpoint {
        case projects
        case project(projectID: String)
        case projectTasks(projectID: String, limit: Int?)
        case createProjectTask(projectID: String, request: CreateProjectTaskRequest)
        case directoryPresets
        case createDirectory(CreateDirectoryRequest)
        case tasks(limit: Int?)
        case task(taskID: String, includeDetails: Bool)
        case createTask(CreateTaskRequest)
        case deleteTask(taskID: String)
        case continueTask(taskID: String)
        case completeTask(taskID: String)
        case openInCodexApp(taskID: String)
        case recheckWorkspace(taskID: String)
        case stopTask(taskID: String)
        case resolveDirtyWorkspace(taskID: String, decision: DirtyWorkspaceDecision)
        case sendMessage(taskID: String, message: String)
        case approvals
        case decideApproval(approvalID: String, decision: String)
        case gitAction(taskID: String, action: GitAction, message: String?, title: String?, targetBranch: String?, reviewMode: ReviewMode?)
        case runners
        case systemSummary
        case switchCodexConfig(profileName: String)
        case deleteCodexConfig(profileName: String)
        case createCodexConfig(request: CreateCodexConfigRequest)
    }

    let baseURL: URL
    let endpoint: Endpoint
    let userBearerToken: String?

    var path: String {
        switch endpoint {
        case .projects:
            "/v1/projects"
        case let .project(projectID):
            "/v1/projects/\(projectID)"
        case let .projectTasks(projectID, _), let .createProjectTask(projectID, _):
            "/v1/projects/\(projectID)/tasks"
        case .directoryPresets:
            "/v1/directories"
        case .createDirectory:
            "/v1/directories/actions/create"
        case .tasks, .createTask:
            "/v1/tasks"
        case let .task(taskID, _):
            "/v1/tasks/\(taskID)"
        case let .deleteTask(taskID):
            "/v1/tasks/\(taskID)"
        case let .continueTask(taskID):
            "/v1/tasks/\(taskID)/actions/continue"
        case let .completeTask(taskID):
            "/v1/tasks/\(taskID)/actions/complete"
        case let .openInCodexApp(taskID):
            "/v1/tasks/\(taskID)/actions/open-in-codex-app"
        case let .recheckWorkspace(taskID):
            "/v1/tasks/\(taskID)/actions/recheck-workspace"
        case let .stopTask(taskID):
            "/v1/tasks/\(taskID)/actions/stop"
        case let .resolveDirtyWorkspace(taskID, _):
            "/v1/tasks/\(taskID)/actions/dirty-workspace"
        case let .sendMessage(taskID, _):
            "/v1/tasks/\(taskID)/messages"
        case .approvals:
            "/v1/approvals"
        case let .decideApproval(approvalID, _):
            "/v1/approvals/\(approvalID)/decision"
        case let .gitAction(taskID, action, _, _, _, _):
            "/v1/tasks/\(taskID)/git/\(action.pathComponent)"
        case .runners:
            "/v1/runners"
        case .systemSummary:
            "/v1/system/summary"
        case .switchCodexConfig:
            "/v1/system/codex-configs/switch"
        case .deleteCodexConfig:
            "/v1/system/codex-configs/delete"
        case .createCodexConfig:
            "/v1/system/codex-configs/create"
        }
    }

    var method: Moya.Method {
        switch endpoint {
        case .projects, .project, .projectTasks, .directoryPresets, .tasks, .task, .approvals, .runners, .systemSummary:
            .get
        case .createTask, .createProjectTask, .createDirectory, .continueTask, .completeTask, .openInCodexApp, .recheckWorkspace, .stopTask, .resolveDirtyWorkspace, .sendMessage, .decideApproval, .gitAction, .switchCodexConfig, .deleteCodexConfig, .createCodexConfig:
            .post
        case .deleteTask:
            .delete
        }
    }

    var task: Moya.Task {
        switch endpoint {
        case .projects, .project, .directoryPresets, .approvals, .runners, .systemSummary, .deleteTask, .continueTask, .completeTask, .openInCodexApp, .recheckWorkspace, .stopTask:
            return Moya.Task.requestPlain
        case let .task(_, includeDetails):
            if includeDetails {
                return Moya.Task.requestParameters(parameters: ["view": "full"], encoding: URLEncoding.queryString)
            }
            return Moya.Task.requestPlain
        case let .projectTasks(_, limit):
            if let limit {
                return Moya.Task.requestParameters(parameters: ["limit": limit], encoding: URLEncoding.queryString)
            }
            return Moya.Task.requestPlain
        case let .tasks(limit):
            if let limit {
                return Moya.Task.requestParameters(parameters: ["limit": limit], encoding: URLEncoding.queryString)
            }
            return Moya.Task.requestPlain
        case let .createTask(request):
            return Moya.Task.requestJSONEncodable(request)
        case let .createProjectTask(_, request):
            return Moya.Task.requestJSONEncodable(request)
        case let .createDirectory(request):
            return Moya.Task.requestJSONEncodable(request)
        case let .sendMessage(_, message):
            return Moya.Task.requestJSONEncodable(TaskMessageRequest(message: message))
        case let .resolveDirtyWorkspace(_, decision):
            return Moya.Task.requestJSONEncodable(DirtyWorkspaceDecisionRequest(decision: decision))
        case let .decideApproval(_, decision):
            return Moya.Task.requestJSONEncodable(ApprovalDecisionRequest(decision: decision))
        case let .gitAction(_, _, message, title, targetBranch, reviewMode):
            return Moya.Task.requestJSONEncodable(GitActionRequest(message: message, title: title, targetBranch: targetBranch, reviewMode: reviewMode))
        case let .switchCodexConfig(profileName):
            return Moya.Task.requestJSONEncodable(CodexConfigSwitchRequest(profileName: profileName))
        case let .deleteCodexConfig(profileName):
            return Moya.Task.requestJSONEncodable(CodexConfigDeleteRequest(profileName: profileName))
        case let .createCodexConfig(request):
            return Moya.Task.requestJSONEncodable(request)
        }
    }

    var headers: [String: String]? {
        var headers: [String: String]
        if sendsJSONBody {
            headers = [
                "Accept": "application/json",
                "Content-Type": "application/json"
            ]
        } else {
            headers = ["Accept": "application/json"]
        }

        if let userBearerToken, !userBearerToken.isEmpty {
            headers["Authorization"] = "Bearer \(userBearerToken)"
        }

        return headers
    }

    var sampleData: Data {
        Data()
    }

    private var sendsJSONBody: Bool {
        switch endpoint {
        case .createTask, .createProjectTask, .createDirectory, .resolveDirtyWorkspace, .sendMessage, .decideApproval, .gitAction, .switchCodexConfig, .deleteCodexConfig, .createCodexConfig:
            true
        case .projects, .project, .projectTasks, .directoryPresets, .tasks, .task, .deleteTask, .continueTask, .completeTask, .openInCodexApp, .recheckWorkspace, .stopTask, .approvals, .runners, .systemSummary:
            false
        }
    }
}
