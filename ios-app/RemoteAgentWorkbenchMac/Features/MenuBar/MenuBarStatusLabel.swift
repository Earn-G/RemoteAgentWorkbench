import SwiftUI

struct MenuBarStatusLabel: View {
    @ObservedObject var appModel: AppModel
    @ObservedObject var localMachineModel: LocalMachineModel

    var body: some View {
        Image(systemName: statusImageName)
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(statusColor)
            .help(statusTooltip)
    }

    private var statusImageName: String {
        if appModel.isLoading && appModel.runners.isEmpty {
            return "arrow.triangle.2.circlepath"
        }

        if case .running = localMachineModel.serviceState {
            return appModel.runners.contains(where: \.isOnline) ? "bolt.horizontal.circle.fill" : "bolt.badge.clock.fill"
        }

        if appModel.runners.contains(where: \.isOnline) {
            return "bolt.horizontal.circle.fill"
        }

        if appModel.errorMessage != nil {
            return "exclamationmark.triangle.fill"
        }

        return "bolt.horizontal.circle"
    }

    private var statusColor: Color {
        if case .running = localMachineModel.serviceState {
            return appModel.runners.contains(where: \.isOnline) ? .green : .blue
        }

        if appModel.runners.contains(where: \.isOnline) {
            return .green
        }

        if appModel.errorMessage != nil {
            return .orange
        }

        return .secondary
    }

    private var statusTooltip: String {
        if let errorMessage = localMachineModel.lastErrorMessage, !errorMessage.isEmpty {
            return "Local runner issue: \(errorMessage)"
        }

        if let errorMessage = appModel.errorMessage, !errorMessage.isEmpty {
            return "Remote Agent issue: \(errorMessage)"
        }

        if case let .running(pid) = localMachineModel.serviceState {
            if let pid {
                return "Local runner active (pid \(pid))"
            }
            return "Local runner active"
        }

        if appModel.runners.contains(where: \.isOnline) {
            return "Remote Agent runner online"
        }

        return "Remote Agent idle"
    }
}
