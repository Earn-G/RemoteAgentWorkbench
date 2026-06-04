import SwiftUI

private struct AddCodexConfigScreen: View {
    @ObservedObject var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var profileName = ""
    @State private var baseURL = ""
    @State private var apiKey = ""

    private var trimmedProfileName: String {
        profileName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var profileNameValidationMessage: String? {
        guard !trimmedProfileName.isEmpty else {
            return nil
        }

        if trimmedProfileName.lowercased() == "none" {
            return "名称不能是 none。"
        }

        if trimmedProfileName == "." || trimmedProfileName == ".." || trimmedProfileName.contains("/") || trimmedProfileName.contains("\\") {
            return "名称不能包含路径分隔符。"
        }

        guard let codexConfig = appModel.systemSummary?.codexConfig else {
            return nil
        }

        let existingProfiles = ["1000", "plus"] + codexConfig.profiles
        if let duplicate = existingProfiles.first(where: {
            normalizedProfileName($0) == normalizedProfileName(trimmedProfileName)
        }) {
            return "名称与现有配置 \(duplicate) 重复。"
        }

        return nil
    }

    private var canSubmit: Bool {
        !trimmedProfileName.isEmpty &&
        !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        profileNameValidationMessage == nil &&
        !appModel.isUpdatingCodexConfig
    }

    var body: some View {
        ZStack {
            WorkbenchBackground()

            Form {
                Section("Config Info") {
                    TextField("名称", text: $profileName)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    if let profileNameValidationMessage {
                        Text(profileNameValidationMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    TextField("URL", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                    SecureField("Token", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.password)
                }

                Section {
                    Button(appModel.isUpdatingCodexConfig ? "Saving..." : "Save and Switch") {
                        appModel.createCodexConfig(
                            name: profileName,
                            baseURL: baseURL,
                            apiKey: apiKey
                        ) {
                            dismiss()
                        }
                    }
                    .disabled(!canSubmit)
                } footer: {
                    Text("新增配置会复制 `1000` 模板，只替换 URL 和 Token，保存后会立即覆盖 `~/.codex` 并重启 Codex。")
                }
            }
            .scrollContentBackground(.hidden)
        }
        .navigationTitle("新增配置")
        .navigationBarTitleDisplayMode(.inline)
        .workbenchNavigationChrome()
    }

    private func normalizedProfileName(_ profileName: String) -> String {
        profileName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct SettingsScreen: View {
    @ObservedObject var appModel: AppModel
    @State private var pendingCodexProfileDeletion: String?

    var body: some View {
        NavigationStack {
            ZStack {
                WorkbenchBackground()

                Form {
                    Section("Server") {
                        TextField(
                            "Server URL",
                            text: Binding(
                                get: { appModel.settings.serverURL },
                                set: { appModel.settings.serverURL = $0 }
                            )
                        )
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                        SecureField(
                            "Bearer Token (Optional)",
                            text: Binding(
                                get: { appModel.settings.userBearerToken },
                                set: { appModel.settings.userBearerToken = $0 }
                            )
                        )
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .textContentType(.password)

                        Text("Paste only the token value here when the control plane requires user auth. Do not include the `Bearer` prefix.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        Text("Default server is `\(WorkbenchAppDefaults.defaultServerURL)`. Replace it here only if you want this app to talk to a different control plane.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    codexConfigSection

                    if let systemSummary = appModel.systemSummary {
                        Section("Control Plane") {
                            LabeledContent("Public URL", value: systemSummary.publicBaseURL)
                            LabeledContent("CORS", value: systemSummary.corsOrigins.joined(separator: ", "))
                            LabeledContent("User Auth", value: systemSummary.userAuthConfigured ? "Configured" : "Disabled")
                            LabeledContent("Runner Auth", value: systemSummary.runnerAuthConfigured ? "Configured" : "Disabled")
                        }

                        if hasDeploymentInfo(systemSummary) {
                            Section("Deployment") {
                                ForEach(deploymentItems(systemSummary), id: \.0) { item in
                                    LabeledContent(item.0, value: item.1)
                                }
                            }
                        }
                    }

                    Section("Actions") {
                        Button("Refresh All Data") {
                            appModel.refreshAll()
                            appModel.refreshTaskInbox()
                        }

                        NavigationLink("Runners") {
                            RunnersScreen(appModel: appModel)
                        }

                        Button("Clear Error State", role: .destructive) {
                            appModel.clearError()
                        }
                    }

                    Section("About") {
                        LabeledContent("Workflow", value: "coding_session")
                        LabeledContent("Executor", value: "Codex CLI")
                        LabeledContent("Desktop Handoff", value: "Codex App")
                    }
                }
                .scrollContentBackground(.hidden)
            }
            .navigationTitle("Settings")
            .workbenchNavigationChrome()
            .alert("Codex Config", isPresented: Binding(
                get: { appModel.codexConfigNotice != nil },
                set: { value in
                    if !value {
                        appModel.clearCodexConfigNotice()
                    }
                }
            )) {
                Button("OK", role: .cancel) {
                    appModel.clearCodexConfigNotice()
                }
            } message: {
                Text(appModel.codexConfigNotice ?? "")
            }
            .alert("Settings Error", isPresented: Binding(
                get: { appModel.errorMessage != nil },
                set: { value in
                    if !value {
                        appModel.clearError()
                    }
                }
            )) {
                Button("OK", role: .cancel) {
                    appModel.clearError()
                }
            } message: {
                Text(appModel.errorMessage ?? "")
            }
        }
    }

    @ViewBuilder
    private var codexConfigSection: some View {
        Section {
            if let codexConfig = appModel.systemSummary?.codexConfig {
                LabeledContent("Current", value: currentCodexConfigLabel(for: codexConfig))

                if codexConfig.activeProfileName == nil {
                    Text("当前 `~/.codex` 没有匹配到列表里的配置，`none` 只表示不发送切换指令。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let pendingAction = codexConfig.pendingAction, let pendingProfileName = codexConfig.pendingProfileName {
                    LabeledContent(
                            "Pending",
                            value: pendingAction == "create"
                                ? "Creating \(pendingProfileName)"
                                : pendingAction == "delete"
                                    ? "Deleting \(pendingProfileName)"
                                    : "Switching to \(pendingProfileName)"
                    )
                }

                ForEach(displayedProfiles(from: codexConfig), id: \.self) { profileName in
                    Button {
                        appModel.switchCodexConfig(profileName: profileName)
                    } label: {
                        codexConfigRow(
                            title: profileName,
                            subtitle: profileName == codexConfig.activeProfileName ? "当前配置" : "切换后会重启 Codex",
                            isSelected: profileName == codexConfig.activeProfileName
                        )
                    }
                    .disabled(appModel.isUpdatingCodexConfig || codexConfig.pendingAction != nil)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if canDeleteCodexProfile(profileName, from: codexConfig)
                            && !appModel.isUpdatingCodexConfig
                            && codexConfig.pendingAction == nil {
                            Button(role: .destructive) {
                                pendingCodexProfileDeletion = profileName
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }

                Button {
                    appModel.switchCodexConfig(profileName: nil)
                } label: {
                    codexConfigRow(
                        title: "none",
                        subtitle: "不发送切换指令",
                        isSelected: false
                    )
                }
                .disabled(appModel.isUpdatingCodexConfig || codexConfig.pendingAction != nil)

                NavigationLink("新增") {
                    AddCodexConfigScreen(appModel: appModel)
                }
                .disabled(appModel.isUpdatingCodexConfig || codexConfig.pendingAction != nil)
            } else if appModel.isLoading {
                ProgressView("Loading Codex configs...")
            } else {
                Text("Refresh all data to load the Mac Codex config list.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Codex Config")
        } footer: {
            Text("选择现有配置会直接替换 `~/.codex/auth.json` 和 `~/.codex/config.toml`，然后重启 Codex。")
        }
        .confirmationDialog(
            "Delete Codex Config?",
            isPresented: Binding(
                get: { pendingCodexProfileDeletion != nil },
                set: { value in
                    if !value {
                        pendingCodexProfileDeletion = nil
                    }
                }
            ),
            titleVisibility: .visible
        ) {
            if let pendingCodexProfileDeletion {
                Button("Delete \(pendingCodexProfileDeletion)", role: .destructive) {
                    let profileName = pendingCodexProfileDeletion
                    self.pendingCodexProfileDeletion = nil
                    appModel.deleteCodexConfig(profileName: profileName)
                }
            }

            Button("Cancel", role: .cancel) {
                pendingCodexProfileDeletion = nil
            }
        } message: {
            if let pendingCodexProfileDeletion {
                Text("This removes the saved Codex config \(pendingCodexProfileDeletion) from the Mac. Protected profiles and the current active profile cannot be deleted.")
            }
        }
    }

    private func displayedProfiles(from codexConfig: SystemSummary.CodexConfigSummary) -> [String] {
        let baseProfiles = codexConfig.protectedProfileNames + codexConfig.profiles
        var ordered: [String] = []
        for name in baseProfiles where !name.isEmpty && !ordered.contains(name) {
            ordered.append(name)
        }
        return ordered
    }

    private func canDeleteCodexProfile(
        _ profileName: String,
        from codexConfig: SystemSummary.CodexConfigSummary
    ) -> Bool {
        !isProtectedCodexProfile(profileName)
            && normalizedCodexProfileName(profileName) != normalizedCodexProfileName(codexConfig.activeProfileName)
    }

    private func isProtectedCodexProfile(_ profileName: String) -> Bool {
        let protectedProfiles = appModel.systemSummary?.codexConfig?.protectedProfileNames ?? ["1000", "plus"]
        return protectedProfiles.map(normalizedCodexProfileName).contains(normalizedCodexProfileName(profileName))
    }

    private func normalizedCodexProfileName(_ profileName: String?) -> String {
        profileName?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    private func currentCodexConfigLabel(for codexConfig: SystemSummary.CodexConfigSummary) -> String {
        codexConfig.activeProfileName ?? "未知（未匹配）"
    }

    private func codexConfigRow(title: String, subtitle: String, isSelected: Bool) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            if isSelected {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(WorkbenchTheme.mint)
            }
        }
    }

    private func hasDeploymentInfo(_ summary: SystemSummary) -> Bool {
        !summary.deployment.sshHost.isEmpty ||
        !summary.deployment.sshUser.isEmpty ||
        !summary.deployment.deployDir.isEmpty ||
        !summary.deployment.envFile.isEmpty ||
        !summary.deployment.caddyfile.isEmpty
    }

    private func deploymentItems(_ summary: SystemSummary) -> [(String, String)] {
        var items: [(String, String)] = []

        if !summary.deployment.sshHost.isEmpty || !summary.deployment.sshUser.isEmpty {
            items.append(("SSH", "\(summary.deployment.sshUser)@\(summary.deployment.sshHost)"))
        }
        if !summary.deployment.deployDir.isEmpty {
            items.append(("Deploy Dir", summary.deployment.deployDir))
        }
        if !summary.deployment.envFile.isEmpty {
            items.append(("Env File", summary.deployment.envFile))
        }
        if !summary.deployment.caddyfile.isEmpty {
            items.append(("Caddyfile", summary.deployment.caddyfile))
        }

        return items
    }
}
