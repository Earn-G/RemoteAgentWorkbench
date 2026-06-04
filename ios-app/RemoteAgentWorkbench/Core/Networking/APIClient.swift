import Combine
import Foundation
import Moya
import CombineMoya

enum APIError: LocalizedError {
    case invalidBaseURL
    case invalidResponse
    case requestFailed(statusCode: Int, message: String)
    case decodingFailed(message: String)
    case streamFailed(message: String)
    case streamDecodingFailed(message: String)
    case underlying(message: String)

    init(error: Error) {
        if let apiError = error as? APIError {
            self = apiError
            return
        }

        if let moyaError = error as? MoyaError {
            self = APIError.map(moyaError)
            return
        }

        if let decodingError = error as? DecodingError {
            self = .decodingFailed(message: decodingError.localizedDescription)
            return
        }

        self = .underlying(message: error.localizedDescription)
    }

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "The server URL is invalid."
        case .invalidResponse:
            return "The server returned an invalid response."
        case let .requestFailed(statusCode, message):
            if statusCode == 401 {
                return "User auth is required. Add the bearer token in Settings, then refresh. Server said: \(message)"
            }
            if statusCode == 403 {
                return "The current bearer token was rejected. Update the token in Settings, then refresh. Server said: \(message)"
            }
            if statusCode == 409, message.contains("already has an unfinished task") {
                return "This repository already has an unfinished task. Open it first, or confirm that you want to start another task in parallel. Server said: \(message)"
            }
            return "Request failed (\(statusCode)): \(message)"
        case let .decodingFailed(message):
            return "Failed to decode the server response: \(message)"
        case let .streamFailed(message):
            return "The live task stream failed: \(message)"
        case let .streamDecodingFailed(message):
            return "The live task stream returned invalid data: \(message)"
        case let .underlying(message):
            return message
        }
    }

    private static func map(_ error: MoyaError) -> APIError {
        switch error {
        case let .statusCode(response):
            return .requestFailed(
                statusCode: response.statusCode,
                message: responseMessage(from: response.data, statusCode: response.statusCode)
            )
        case let .objectMapping(mappingError, _):
            return .decodingFailed(message: mappingError.localizedDescription)
        case let .underlying(underlyingError, _):
            return .underlying(message: underlyingError.localizedDescription)
        default:
            return .underlying(message: error.localizedDescription)
        }
    }

    fileprivate static func responseMessage(from data: Data, statusCode: Int) -> String {
        if let payload = try? JSONDecoder().decode(APIErrorPayload.self, from: data) {
            let message = payload.message?.trimmingCharacters(in: .whitespacesAndNewlines)
            let issue = payload.issues?.first?.message.trimmingCharacters(in: .whitespacesAndNewlines)

            if let issue, !issue.isEmpty {
                if let message, !message.isEmpty, message != issue, message != "Validation failed" {
                    return "\(message): \(issue)"
                }
                return issue
            }

            if let message, !message.isEmpty {
                return message
            }
        }

        let raw = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return (raw?.isEmpty == false ? raw : HTTPURLResponse.localizedString(forStatusCode: statusCode)) ?? "Request failed"
    }
}

private struct APIErrorPayload: Decodable {
    let message: String?
    let issues: [APIErrorIssue]?
}

private struct APIErrorIssue: Decodable {
    let message: String
}

final class APIClient {
    private let baseURLProvider: () -> String
    private let userBearerTokenProvider: () -> String
    private let decoder = JSONDecoder()
    private let session: Session
    private let provider: MoyaProvider<RemoteAgentTarget>

    init(
        baseURLProvider: @escaping () -> String,
        userBearerTokenProvider: @escaping () -> String = { "" }
    ) {
        self.baseURLProvider = baseURLProvider
        self.userBearerTokenProvider = userBearerTokenProvider

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 30
        self.session = Session(configuration: configuration)
        // Join baseURL + path with exactly one slash. The base URL is normalized to end
        // with "/", and every RemoteAgentTarget.path starts with "/", so Moya's default
        // mapping (baseURL.appendingPathComponent(path)) would emit a double slash like
        // `//v1/projects`, which strict servers reject as a different (missing) route.
        let endpointClosure = { (target: RemoteAgentTarget) -> Endpoint in
            let component = target.path.hasPrefix("/") ? String(target.path.dropFirst()) : target.path
            let url = component.isEmpty
                ? target.baseURL.absoluteString
                : target.baseURL.appendingPathComponent(component).absoluteString
            return Endpoint(
                url: url,
                sampleResponseClosure: { .networkResponse(200, target.sampleData) },
                method: target.method,
                task: target.task,
                httpHeaderFields: target.headers
            )
        }
        self.provider = MoyaProvider<RemoteAgentTarget>(endpointClosure: endpointClosure, session: session)
        AppDebugLog.info("APIClient initialized.")
    }

    func fetchProjects() -> AnyPublisher<[ProjectSummary], APIError> {
        request(.projects)
    }

    func fetchProject(projectId: String) -> AnyPublisher<ProjectSummary, APIError> {
        request(.project(projectID: projectId))
    }

    func fetchProjectTasks(projectId: String, limit: Int? = nil) -> AnyPublisher<[TaskRecord], APIError> {
        request(.projectTasks(projectID: projectId, limit: limit))
    }

    func createTaskForProject(projectId: String, requestBody: CreateProjectTaskRequest) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.createProjectTask(projectID: projectId, request: requestBody))
    }

    func fetchDirectoryPresets() -> AnyPublisher<[DirectoryPreset], APIError> {
        request(.directoryPresets)
    }

    func createDirectory(_ requestBody: CreateDirectoryRequest) -> AnyPublisher<DirectoryCreationReceipt, APIError> {
        request(.createDirectory(requestBody))
    }

    func fetchTasks(limit: Int? = nil) -> AnyPublisher<[TaskRecord], APIError> {
        request(.tasks(limit: limit))
    }

    func fetchTask(taskId: String, includeDetails: Bool = false) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.task(taskID: taskId, includeDetails: includeDetails))
    }

    func createTask(_ requestBody: CreateTaskRequest) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.createTask(requestBody))
    }

    func deleteTask(taskId: String) -> AnyPublisher<Void, APIError> {
        requestVoid(.deleteTask(taskID: taskId))
    }

    func continueTask(taskId: String) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.continueTask(taskID: taskId))
    }

    func completeTask(taskId: String) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.completeTask(taskID: taskId))
    }

    func openInCodexApp(taskId: String) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.openInCodexApp(taskID: taskId))
    }

    func recheckWorkspace(taskId: String) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.recheckWorkspace(taskID: taskId))
    }

    func stopTask(taskId: String) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.stopTask(taskID: taskId))
    }

    func resolveDirtyWorkspace(taskId: String, decision: DirtyWorkspaceDecision) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.resolveDirtyWorkspace(taskID: taskId, decision: decision))
    }

    func sendMessage(taskId: String, message: String) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.sendMessage(taskID: taskId, message: message))
    }

    func fetchApprovals() -> AnyPublisher<[ApprovalRequest], APIError> {
        request(.approvals)
    }

    func decideApproval(approvalId: String, decision: String) -> AnyPublisher<ApprovalRequest, APIError> {
        request(.decideApproval(approvalID: approvalId, decision: decision))
    }

    func requestGitAction(
        taskId: String,
        action: GitAction,
        message: String? = nil,
        title: String? = nil,
        targetBranch: String? = nil,
        reviewMode: ReviewMode? = nil
    ) -> AnyPublisher<TaskSnapshot, APIError> {
        request(.gitAction(taskID: taskId, action: action, message: message, title: title, targetBranch: targetBranch, reviewMode: reviewMode))
    }

    func fetchRunners() -> AnyPublisher<[RunnerInfo], APIError> {
        request(.runners)
    }

    func fetchSystemSummary() -> AnyPublisher<SystemSummary, APIError> {
        request(.systemSummary)
    }

    func switchCodexConfig(profileName: String) -> AnyPublisher<CodexConfigActionReceipt, APIError> {
        request(.switchCodexConfig(profileName: profileName))
    }

    func deleteCodexConfig(profileName: String) -> AnyPublisher<CodexConfigActionReceipt, APIError> {
        request(.deleteCodexConfig(profileName: profileName))
    }

    func createCodexConfig(_ requestBody: CreateCodexConfigRequest) -> AnyPublisher<CodexConfigActionReceipt, APIError> {
        request(.createCodexConfig(request: requestBody))
    }

    func streamTaskEvents(taskId: String) -> AnyPublisher<TaskSnapshot, APIError> {
        do {
            var request = URLRequest(url: try makeURL(path: "/v1/tasks/\(taskId)/events"))
            request.httpMethod = "GET"
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            if let authorizationHeader = authorizationHeaderValue() {
                request.setValue(authorizationHeader, forHTTPHeaderField: "Authorization")
            }
            request.timeoutInterval = 0
            AppDebugLog.info("API stream -> GET \(request.url?.absoluteString ?? "<invalid-url>")")

            let stream = TaskEventStream(request: request)
            return stream.publisher()
                .handleEvents(
                    receiveOutput: { snapshot in
                        AppDebugLog.info("API stream <- taskId=\(snapshot.id) status=\(snapshot.status.rawValue) events=\(snapshot.events.count)")
                    },
                    receiveCompletion: { completion in
                        switch completion {
                        case .finished:
                            AppDebugLog.info("API stream completed for task \(taskId)")
                        case let .failure(error):
                            AppDebugLog.error("API stream failed for task \(taskId): \(error.localizedDescription)")
                        }
                    },
                    receiveCancel: {
                        AppDebugLog.info("API stream cancelled for task \(taskId)")
                    }
                )
                .eraseToAnyPublisher()
        } catch {
            AppDebugLog.error("API stream setup failed for task \(taskId): \(error.localizedDescription)")
            return Fail(error: APIError(error: error))
                .eraseToAnyPublisher()
        }
    }

    private func request<Value: Decodable>(_ endpoint: RemoteAgentTarget.Endpoint) -> AnyPublisher<Value, APIError> {
        do {
            let target = try RemoteAgentTarget(
                baseURL: makeBaseURL(),
                endpoint: endpoint,
                userBearerToken: normalizedUserBearerToken()
            )
            let requestURL = target.baseURL.appendingPathComponent(target.path.hasPrefix("/") ? String(target.path.dropFirst()) : target.path)
            AppDebugLog.info("API request -> \(target.method.rawValue) \(requestURL.absoluteString)")

            return provider
                .requestPublisher(target)
                .handleEvents(
                    receiveOutput: { response in
                        AppDebugLog.info(
                            "API response <- \(response.statusCode) \(requestURL.absoluteString) bytes=\(response.data.count) body=\(AppDebugLog.preview(data: response.data))"
                        )
                    },
                    receiveCompletion: { [self] completion in
                        if case let .failure(error) = completion {
                            logProviderFailure(error, requestURL: requestURL)
                        }
                    },
                    receiveCancel: {
                        AppDebugLog.info("API request cancelled -> \(requestURL.absoluteString)")
                    }
                )
                .tryMap { [decoder] response -> Value in
                    guard (200 ..< 300).contains(response.statusCode) else {
                        let message = APIError.responseMessage(from: response.data, statusCode: response.statusCode)
                        AppDebugLog.error(
                            "API status failed <- \(response.statusCode) \(requestURL.absoluteString) bytes=\(response.data.count) message=\(message) body=\(AppDebugLog.preview(data: response.data))"
                        )
                        throw APIError.requestFailed(
                            statusCode: response.statusCode,
                            message: message
                        )
                    }

                    do {
                        let value = try decoder.decode(Value.self, from: response.data)
                        AppDebugLog.info("API decode <- \(Value.self) from \(requestURL.absoluteString)")
                        return value
                    } catch {
                        AppDebugLog.error("API decode failed for \(requestURL.absoluteString): \(error.localizedDescription)")
                        throw APIError(error: error)
                    }
                }
                .mapError { error -> APIError in
                    APIError(error: error)
                }
                .timeout(
                    .seconds(35),
                    scheduler: DispatchQueue.main,
                    customError: { () -> APIError in
                        APIError.underlying(message: "Request timed out for \(requestURL.absoluteString)")
                    }
                )
                .eraseToAnyPublisher()
        } catch {
            AppDebugLog.error("API request setup failed: \(error.localizedDescription)")
            return Fail(error: APIError(error: error))
                .eraseToAnyPublisher()
        }
    }

    private func requestVoid(_ endpoint: RemoteAgentTarget.Endpoint) -> AnyPublisher<Void, APIError> {
        do {
            let target = try RemoteAgentTarget(
                baseURL: makeBaseURL(),
                endpoint: endpoint,
                userBearerToken: normalizedUserBearerToken()
            )
            let requestURL = target.baseURL.appendingPathComponent(target.path.hasPrefix("/") ? String(target.path.dropFirst()) : target.path)
            AppDebugLog.info("API request -> \(target.method.rawValue) \(requestURL.absoluteString)")

            return provider
                .requestPublisher(target)
                .handleEvents(
                    receiveOutput: { response in
                        AppDebugLog.info(
                            "API response <- \(response.statusCode) \(requestURL.absoluteString) bytes=\(response.data.count) body=\(AppDebugLog.preview(data: response.data))"
                        )
                    },
                    receiveCompletion: { [self] completion in
                        if case let .failure(error) = completion {
                            logProviderFailure(error, requestURL: requestURL)
                        }
                    },
                    receiveCancel: {
                        AppDebugLog.info("API request cancelled -> \(requestURL.absoluteString)")
                    }
                )
                .tryMap { response -> Void in
                    guard (200 ..< 300).contains(response.statusCode) else {
                        let message = APIError.responseMessage(from: response.data, statusCode: response.statusCode)
                        AppDebugLog.error(
                            "API status failed <- \(response.statusCode) \(requestURL.absoluteString) bytes=\(response.data.count) message=\(message) body=\(AppDebugLog.preview(data: response.data))"
                        )
                        throw APIError.requestFailed(
                            statusCode: response.statusCode,
                            message: message
                        )
                    }
                    return ()
                }
                .mapError { error -> APIError in
                    APIError(error: error)
                }
                .timeout(
                    .seconds(35),
                    scheduler: DispatchQueue.main,
                    customError: { () -> APIError in
                        APIError.underlying(message: "Request timed out for \(requestURL.absoluteString)")
                    }
                )
                .eraseToAnyPublisher()
        } catch {
            AppDebugLog.error("API request setup failed: \(error.localizedDescription)")
            return Fail(error: APIError(error: error))
                .eraseToAnyPublisher()
        }
    }

    private func makeBaseURL() throws -> URL {
        let normalized = normalizedBaseURL()
        AppDebugLog.info("Resolved base URL: \(normalized)")
        guard let url = URL(string: normalized) else {
            AppDebugLog.error("Invalid base URL after normalization: \(normalized)")
            throw APIError.invalidBaseURL
        }
        return url
    }

    private func makeURL(path: String) throws -> URL {
        guard let url = URL(string: path.hasPrefix("/") ? String(path.dropFirst()) : path, relativeTo: try makeBaseURL())?.absoluteURL else {
            throw APIError.invalidBaseURL
        }
        return url
    }

    private func normalizedBaseURL() -> String {
        let raw = baseURLProvider().trimmingCharacters(in: .whitespacesAndNewlines)
        return raw.hasSuffix("/") ? raw : "\(raw)/"
    }

    private func normalizedUserBearerToken() -> String? {
        let token = userBearerTokenProvider().trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    private func authorizationHeaderValue() -> String? {
        guard let token = normalizedUserBearerToken() else {
            return nil
        }
        return "Bearer \(token)"
    }

    private func logProviderFailure(_ error: MoyaError, requestURL: URL) {
        if case let .statusCode(response) = error {
            let message = APIError.responseMessage(from: response.data, statusCode: response.statusCode)
            AppDebugLog.error(
                "API status failed <- \(response.statusCode) \(requestURL.absoluteString) bytes=\(response.data.count) message=\(message) body=\(AppDebugLog.preview(data: response.data))"
            )
            return
        }

        AppDebugLog.error("API transport failed for \(requestURL.absoluteString): \(error.localizedDescription)")
    }
}
