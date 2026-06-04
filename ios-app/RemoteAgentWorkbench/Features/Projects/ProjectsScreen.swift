import SwiftUI

struct ProjectsScreen: View {
    @ObservedObject var appModel: AppModel
    @State private var searchText = ""
    @State private var showingCreateDirectorySheet = false

    private var trimmedSearchText: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredProjects: [ProjectSummary] {
        guard !trimmedSearchText.isEmpty else {
            return appModel.projects
        }

        return appModel.projects.filter { project in
            project.name.localizedCaseInsensitiveContains(trimmedSearchText) ||
            project.repo.localizedCaseInsensitiveContains(trimmedSearchText) ||
            project.baseBranch.localizedCaseInsensitiveContains(trimmedSearchText)
        }
    }

    private var pinnedProjects: [ProjectSummary] {
        guard trimmedSearchText.isEmpty else {
            return []
        }
        return filteredProjects.filter(\.isFeatured)
    }

    private var standardProjects: [ProjectSummary] {
        guard trimmedSearchText.isEmpty else {
            return filteredProjects
        }
        return filteredProjects.filter { !$0.isFeatured }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                WorkbenchBackground()

                ScrollView {
                    VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xl) {
                        ProjectsHeader(
                            totalCount: appModel.projects.count,
                            pinnedCount: appModel.projects.filter(\.isFeatured).count,
                            isSearching: !trimmedSearchText.isEmpty,
                            onAdd: { showingCreateDirectorySheet = true }
                        )

                        content
                    }
                    .padding(.horizontal, WorkbenchTheme.Spacing.md)
                    .padding(.top, WorkbenchTheme.Spacing.lg)
                    .padding(.bottom, 120)
                }
                .refreshable {
                    appModel.refreshAll()
                }
            }
            .navigationTitle("Projects")
            .workbenchNavigationChrome()
            .searchable(text: $searchText, prompt: "Search projects or repos")
            .sheet(isPresented: $showingCreateDirectorySheet) {
                CreateDirectorySheet(appModel: appModel)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        appModel.refreshAll()
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
            .onAppear {
                appModel.refreshAllIfNeeded()
            }
            .alert("Request Failed", isPresented: Binding(
                get: { appModel.errorMessage != nil },
                set: { value in
                    if !value {
                        appModel.clearError()
                    }
                }
            )) {
                Button("OK", role: .cancel) { }
            } message: {
                Text(appModel.errorMessage ?? "")
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if appModel.projects.isEmpty, appModel.isLoading {
            ProgressView("Loading projects...")
                .frame(maxWidth: .infinity, minHeight: 260)
                .workbenchCard()
        } else if filteredProjects.isEmpty {
            ContentUnavailableView(
                trimmedSearchText.isEmpty ? "No Projects Yet" : "No Matching Projects",
                systemImage: trimmedSearchText.isEmpty ? "folder.badge.questionmark" : "magnifyingglass",
                description: Text(
                    trimmedSearchText.isEmpty
                        ? "Pinned repositories from the Mac will appear here once they sync."
                        : "Try a different project name, repository path, or branch."
                )
            )
            .padding(WorkbenchTheme.Spacing.xl)
            .frame(maxWidth: .infinity, minHeight: 280)
            .workbenchCard()
        } else {
            if !pinnedProjects.isEmpty {
                projectSection(
                    title: "Pinned Projects",
                    count: pinnedProjects.count,
                    systemImage: "pin.fill",
                    projects: pinnedProjects
                )
            }

            projectSection(
                title: trimmedSearchText.isEmpty ? (pinnedProjects.isEmpty ? "Project Presets" : "More Projects") : "Search Results",
                count: standardProjects.count,
                systemImage: "folder",
                projects: standardProjects
            )
        }
    }

    private func projectSection(
        title: String,
        count: Int,
        systemImage: String,
        projects: [ProjectSummary]
    ) -> some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.sm) {
            HStack(spacing: WorkbenchTheme.Spacing.xs) {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(WorkbenchTheme.textSecondary)

                Text(title)
                    .font(WorkbenchTheme.Typography.sectionTitle)
                    .foregroundStyle(WorkbenchTheme.textPrimary)

                Spacer()

                Text("\(count)")
                    .font(WorkbenchTheme.Typography.badge)
                    .foregroundStyle(WorkbenchTheme.textMuted)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Capsule().fill(WorkbenchTheme.panel))
            }

            VStack(spacing: WorkbenchTheme.Spacing.sm) {
                ForEach(projects) { project in
                    NavigationLink {
                        ProjectDetailScreen(appModel: appModel, project: project)
                    } label: {
                        ProjectPresetCard(project: project)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct ProjectsHeader: View {
    let totalCount: Int
    let pinnedCount: Int
    let isSearching: Bool
    let onAdd: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.sm) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Projects")
                        .font(WorkbenchTheme.Typography.pageTitle)
                        .foregroundStyle(WorkbenchTheme.textPrimary)

                    Text(isSearching ? "Filtered repo presets" : "\(pinnedCount) pinned · \(totalCount) synced projects")
                        .font(WorkbenchTheme.Typography.body)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                }

                Spacer()

                Button(action: onAdd) {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 46, height: 46)
                        .background(
                            Circle()
                                .fill(
                                    LinearGradient(
                                        colors: [WorkbenchTheme.agentViolet, WorkbenchTheme.agentBlue],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    )
                                )
                        )
                        .opacity(0.92)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Create project folder")
            }

            Text("Pick a repo preset, then launch or review an agent task.")
                .font(WorkbenchTheme.Typography.metadata)
                .foregroundStyle(WorkbenchTheme.textMuted)
        }
    }
}

private struct ProjectPresetCard: View {
    let project: ProjectSummary

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
            HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.md) {
                ZStack(alignment: .topLeading) {
                    WorkbenchIconBox(
                        systemImage: ProjectDisplay.folderSystemImage,
                        tint: project.pendingApprovalsCount > 0 ? WorkbenchTheme.approvalAmber : WorkbenchTheme.agentViolet
                    )

                    if project.isFeatured {
                        Image(systemName: "star.fill")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(WorkbenchTheme.approvalAmber)
                            .offset(x: -4, y: -4)
                    }
                }

                VStack(alignment: .leading, spacing: 5) {
                    Text(project.name)
                        .font(WorkbenchTheme.Typography.cardTitle)
                        .foregroundStyle(WorkbenchTheme.textPrimary)
                        .lineLimit(1)

                    Text(project.repo)
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                        .lineLimit(1)
                }

                Spacer(minLength: WorkbenchTheme.Spacing.xs)

                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WorkbenchTheme.textMuted)
                    .padding(.top, 4)
            }

            HStack(spacing: WorkbenchTheme.Spacing.xs) {
                WorkbenchInlineTag(project.baseBranch, systemImage: "arrow.triangle.branch", tint: WorkbenchTheme.runningBlue)

                StatusBadge(
                    title: project.latestTaskStatus?.title ?? "Ready",
                    tint: project.latestTaskStatus?.tint ?? WorkbenchTheme.completedGreen
                )

                if project.pendingApprovalsCount > 0 {
                    StatusBadge(title: "\(project.pendingApprovalsCount) Pending", tint: WorkbenchTheme.approvalAmber)
                }
            }

            if let latestTaskTitle = project.latestTaskTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !latestTaskTitle.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Latest")
                        .font(WorkbenchTheme.Typography.badge)
                        .foregroundStyle(WorkbenchTheme.textMuted)
                    Text(latestTaskTitle)
                        .font(WorkbenchTheme.Typography.metadataEmphasis)
                        .foregroundStyle(WorkbenchTheme.textPrimary)
                        .lineLimit(2)
                }
                .padding(WorkbenchTheme.Spacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.control, style: .continuous)
                        .fill(WorkbenchTheme.panel)
                )
            }

            HStack {
                Text(project.pendingApprovalsCount > 0 ? "Review pending task" : "Start new task")
                    .font(WorkbenchTheme.Typography.bodyEmphasis)
                    .foregroundStyle(WorkbenchTheme.textPrimary)

                Spacer()

                Text(project.displayUpdatedAt)
                    .font(WorkbenchTheme.Typography.metadata)
                    .foregroundStyle(WorkbenchTheme.textMuted)

                Image(systemName: "arrow.up.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(WorkbenchTheme.textMuted)
            }
            .padding(.horizontal, WorkbenchTheme.Spacing.md)
            .frame(height: WorkbenchTheme.Metrics.primaryButtonHeight)
            .background(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.control, style: .continuous)
                    .fill((project.pendingApprovalsCount > 0 ? WorkbenchTheme.approvalAmber : WorkbenchTheme.agentBlue).opacity(0.12))
            )
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .workbenchCard(tint: project.pendingApprovalsCount > 0 ? WorkbenchTheme.approvalAmber : nil)
    }
}
