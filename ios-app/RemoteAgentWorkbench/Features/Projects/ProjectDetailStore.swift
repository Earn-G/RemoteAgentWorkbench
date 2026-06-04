import Combine
import Foundation

final class ProjectDetailStore: ObservableObject {
    let projectId: String

    @Published var project: ProjectSummary
    @Published var tasks: [TaskRecord] = []
    @Published var isLoading = false
    @Published var isCreatingTask = false
    @Published var errorMessage: String?
    @Published var lastCreatedTaskID: String?

    private let apiClient: APIClient
    private var cancellables = Set<AnyCancellable>()
    private var didLoad = false

    init(project: ProjectSummary, apiClient: APIClient) {
        self.projectId = project.id
        self.project = project
        self.apiClient = apiClient
    }

    func loadIfNeeded() {
        guard !didLoad else { return }
        didLoad = true
        refresh()
    }

    func refresh() {
        isLoading = true

        Publishers.Zip(
            apiClient.fetchProject(projectId: projectId),
            apiClient.fetchProjectTasks(projectId: projectId, limit: 20)
        )
        .receive(on: DispatchQueue.main)
        .sink { [weak self] completion in
            guard let self else { return }
            self.isLoading = false
            if case let .failure(error) = completion {
                self.errorMessage = error.localizedDescription
            }
        } receiveValue: { [weak self] project, tasks in
            guard let self else { return }
            self.project = project
            self.tasks = tasks.sortedByRecency()
            self.errorMessage = nil
        }
        .store(in: &cancellables)
    }

    func createTask(
        title: String,
        prompt: String,
        branchMode: TaskBranchMode,
        branchName: String?,
        deliveryMode: DeliveryMode,
        autoPush: Bool,
        executionMode: TaskExecutionMode,
        resumeThreadId: String?,
        allowParallel: Bool = false
    ) {
        isCreatingTask = true

        apiClient.createTaskForProject(
            projectId: projectId,
            requestBody: CreateProjectTaskRequest(
                deliveryMode: deliveryMode,
                autoPush: autoPush,
                title: title,
                prompt: prompt,
                branchMode: branchMode,
                branchName: branchName,
                executionMode: executionMode,
                resumeThreadId: executionMode == .resumeThread ? resumeThreadId : nil,
                allowParallel: allowParallel
            )
        )
        .receive(on: DispatchQueue.main)
        .sink { [weak self] completion in
            guard let self else { return }
            self.isCreatingTask = false
            if case let .failure(error) = completion {
                self.errorMessage = error.localizedDescription
            }
        } receiveValue: { [weak self] snapshot in
            guard let self else { return }
            self.lastCreatedTaskID = snapshot.id
            self.errorMessage = nil
            self.refresh()
        }
        .store(in: &cancellables)
    }
}
