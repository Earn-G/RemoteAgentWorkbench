import Combine
import SwiftUI

struct CreateDirectorySheet: View {
    @ObservedObject var appModel: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var presets: [DirectoryPreset] = []
    @State private var selectedPresetID = ""
    @State private var relativePath = ""
    @State private var addToProjects = true
    @State private var projectName = ""
    @State private var baseBranch = "main"
    @State private var deliveryMode: DeliveryMode = .directCommit
    @State private var autoPush = false
    @State private var isLoading = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var didLoad = false
    @State private var loadCancellable: AnyCancellable?
    @State private var createCancellable: AnyCancellable?

    private let apiClient: APIClient

    init(appModel: AppModel) {
        self.appModel = appModel
        self.apiClient = appModel.makeAPIClient()
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Preset") {
                    if presets.isEmpty {
                        Text("No directory presets have been synced yet.")
                            .foregroundStyle(.secondary)

                        Text("the Mac runner's directories catalog (`directories.json`)")
                            .font(.system(.footnote, design: .monospaced))
                            .foregroundStyle(.secondary)

                        Button {
                            loadPresets(force: true)
                        } label: {
                            Label(isLoading ? "Refreshing..." : "Refresh Presets", systemImage: "arrow.clockwise")
                        }
                        .disabled(isLoading)
                    } else {
                        Picker("Base Directory", selection: $selectedPresetID) {
                            ForEach(presets) { preset in
                                Text(preset.label).tag(preset.id)
                            }
                        }
                        .pickerStyle(.navigationLink)

                        if let selectedPreset {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(selectedPreset.rootPath)
                                    .font(.footnote.weight(.medium))
                                    .textSelection(.enabled)
                                Text("Only the relative folder path is entered on the phone. The Mac runner will create it inside this preset root.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                Section("Folder") {
                    TextField("Relative Path", text: $relativePath)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Text("Example: `feature/ios-login` or `clients/acme/demo`")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Project") {
                    Toggle("Add to Projects", isOn: $addToProjects)

                    if addToProjects {
                        TextField(suggestedProjectName, text: $projectName)
                            .textInputAutocapitalization(.words)
                            .autocorrectionDisabled()

                        Picker("Default Flow", selection: $deliveryMode) {
                            ForEach(DeliveryMode.allCases, id: \.self) { mode in
                                Text(mode.title).tag(mode)
                            }
                        }

                        TextField("Base Branch", text: $baseBranch)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()

                        Toggle(AutoPushCopy.title, isOn: $autoPush)

                        Text("Once the Mac runner creates the folder, it will sync this local folder as a Project. Git is optional: plain folders can run direct tasks without commits.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    Text("This action queues a small utility command on the Mac runner. It creates the folder first, then optionally pins it in Projects so you can start work immediately.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Create Folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button(isSubmitting ? "Creating..." : "Create") {
                        submit()
                    }
                    .disabled(!canSubmit || isSubmitting)
                }
            }
        }
        .onAppear {
            loadIfNeeded()
        }
        .alert("Directory Error", isPresented: Binding(
            get: { errorMessage != nil },
            set: { value in
                if !value {
                    errorMessage = nil
                }
            }
        )) {
            Button("OK", role: .cancel) { }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private var selectedPreset: DirectoryPreset? {
        presets.first(where: { $0.id == selectedPresetID })
    }

    private var canSubmit: Bool {
        !selectedPresetID.isEmpty &&
        !relativePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        (!addToProjects || !baseBranch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    private var suggestedProjectName: String {
        let trimmed = relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
        let components = trimmed.split(separator: "/").map(String.init)
        if let last = components.last?.trimmingCharacters(in: .whitespacesAndNewlines), !last.isEmpty {
            return last
        }
        return "Project Name"
    }

    private var resolvedProjectName: String {
        projectName.nonEmptyValue ?? suggestedProjectName
    }

    private func loadIfNeeded() {
        guard !didLoad else { return }
        didLoad = true
        loadPresets()
    }

    private func loadPresets(force: Bool = false) {
        if !force, isLoading {
            return
        }

        loadCancellable?.cancel()
        isLoading = true

        loadCancellable = apiClient.fetchDirectoryPresets()
            .receive(on: DispatchQueue.main)
            .sink { completion in
                isLoading = false
                if case let .failure(error) = completion {
                    errorMessage = error.localizedDescription
                }
            } receiveValue: { values in
                presets = values
                if let current = presets.first(where: { $0.id == selectedPresetID }) {
                    selectedPresetID = current.id
                } else {
                    selectedPresetID = values.first?.id ?? ""
                }
                errorMessage = nil
            }
    }

    private func submit() {
        let trimmedRelativePath = relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !selectedPresetID.isEmpty, !trimmedRelativePath.isEmpty else { return }

        let trimmedBaseBranch = baseBranch.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedName = resolvedProjectName

        createCancellable?.cancel()
        isSubmitting = true

        createCancellable = apiClient.createDirectory(
            CreateDirectoryRequest(
                presetId: selectedPresetID,
                relativePath: trimmedRelativePath,
                createProject: addToProjects,
                projectName: addToProjects ? resolvedName : nil,
                baseBranch: addToProjects ? trimmedBaseBranch : nil,
                deliveryMode: addToProjects ? deliveryMode : nil,
                autoPush: addToProjects ? autoPush : nil,
                defaultTaskTitle: addToProjects ? "Work on \(resolvedName)" : nil,
                defaultPrompt: addToProjects ? "Describe the outcome you want in \(resolvedName). Mention files to create or change and checks to run." : nil
            )
        )
        .receive(on: DispatchQueue.main)
        .sink { completion in
            isSubmitting = false
            if case let .failure(error) = completion {
                errorMessage = error.localizedDescription
            }
        } receiveValue: { receipt in
            errorMessage = nil
            appModel.refreshAll()
            if receipt.createProject {
                appModel.refreshUntilProjectAppears(
                    repo: receipt.absolutePath,
                    projectName: receipt.projectName
                )
            }
            dismiss()
        }
    }
}

private extension String {
    var nonEmptyValue: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
