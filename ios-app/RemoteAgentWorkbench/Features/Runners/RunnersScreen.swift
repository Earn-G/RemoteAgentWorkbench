import SwiftUI

struct RunnersScreen: View {
    @ObservedObject var appModel: AppModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    WorkbenchHeroCard(
                        eyebrow: "Runners",
                        title: "Mac execution agents and their capabilities",
                        detail: "This screen stays read-only. Start work from projects and approve risky actions from task detail."
                    ) {
                        WorkbenchInlineTag("\(appModel.runners.filter(\.isOnline).count) online", systemImage: "bolt.horizontal", tint: .white.opacity(0.9))
                    } content: {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 132), spacing: 12)], spacing: 12) {
                            WorkbenchStatCard(
                                title: "Total",
                                value: "\(appModel.runners.count)",
                                caption: "Registered runners",
                                icon: "desktopcomputer",
                                tint: WorkbenchTheme.heroMiddle
                            )
                            WorkbenchStatCard(
                                title: "Online",
                                value: "\(appModel.runners.filter(\.isOnline).count)",
                                caption: "Currently reachable",
                                icon: "checkmark.circle",
                                tint: WorkbenchTheme.mint
                            )
                        }
                    }

                    if appModel.runners.isEmpty, appModel.isLoading {
                        SectionCard(title: "Runners", caption: "Loading runner status") {
                            ProgressView("Loading runners...")
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.vertical, 24)
                        }
                    } else if appModel.runners.isEmpty {
                        SectionCard(title: "Runners", caption: "Your Mac runner will appear here once it registers") {
                            ContentUnavailableView(
                                "No Runners",
                                systemImage: "desktopcomputer",
                                description: Text("Start a Mac runner and it will appear here.")
                            )
                        }
                    } else {
                        SectionCard(title: "Runner Status", caption: "Capabilities, current task, and labels") {
                            VStack(spacing: 12) {
                                ForEach(appModel.runners) { runner in
                                    WorkbenchListCard {
                                        VStack(alignment: .leading, spacing: 10) {
                                            HStack {
                                                VStack(alignment: .leading, spacing: 4) {
                                                    Text(runner.name)
                                                        .font(.headline)
                                                        .foregroundStyle(WorkbenchTheme.textPrimary)
                                                    Text(runner.id)
                                                        .font(.subheadline)
                                                        .foregroundStyle(WorkbenchTheme.textSecondary)
                                                }
                                                Spacer()
                                                StatusBadge(title: runner.isOnline ? "Online" : "Offline", tint: runner.isOnline ? .green : .gray)
                                            }

                                            if let currentTaskId = runner.currentTaskId, !currentTaskId.isEmpty {
                                                WorkbenchInlineTag(currentTaskId, systemImage: "hammer", tint: WorkbenchTheme.heroMiddle)
                                            }

                                            VStack(alignment: .leading, spacing: 6) {
                                                Text("Capabilities")
                                                    .font(.caption.weight(.semibold))
                                                    .foregroundStyle(WorkbenchTheme.textSecondary)
                                                Text(runner.capabilities.joined(separator: " • "))
                                                    .font(.footnote)
                                                    .foregroundStyle(WorkbenchTheme.textSecondary)
                                            }

                                            Text(runner.labels.map { "#\($0)" }.joined(separator: " "))
                                                .font(.caption)
                                                .foregroundStyle(.tertiary)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 12)
                .padding(.bottom, 28)
            }
            .background(WorkbenchBackground())
            .navigationTitle("Runners")
            .onAppear {
                if appModel.runners.isEmpty {
                    appModel.refreshAllIfNeeded()
                }
            }
        }
    }
}
