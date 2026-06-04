import SwiftUI

struct StatusBadge: View {
    let title: String
    let tint: Color

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(tint)
                .frame(width: 6, height: 6)

            Text(title)
                .font(WorkbenchTheme.Typography.badge)
                .lineLimit(1)
                .minimumScaleFactor(0.82)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.chip, style: .continuous)
                .fill(tint.opacity(0.13))
        )
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.chip, style: .continuous)
                .strokeBorder(tint.opacity(0.30), lineWidth: 1)
        )
        .foregroundStyle(tint)
    }
}

extension TaskStatus {
    var tint: Color {
        switch self {
        case .draft, .queued, .preparingWorkspace:
            WorkbenchTheme.infoCyan
        case .awaitingPlanApproval, .awaitingGitApproval:
            WorkbenchTheme.approvalAmber
        case .running:
            WorkbenchTheme.runningBlue
        case .awaitingHumanInput:
            WorkbenchTheme.actionMint
        case .blockedConflict, .failed:
            WorkbenchTheme.dangerRose
        case .completed:
            WorkbenchTheme.completedGreen
        case .canceled:
            WorkbenchTheme.offlineGray
        }
    }
}

extension ApprovalStatus {
    var tint: Color {
        switch self {
        case .pending:
            WorkbenchTheme.approvalAmber
        case .approved:
            WorkbenchTheme.completedGreen
        case .denied:
            WorkbenchTheme.dangerRose
        }
    }
}
