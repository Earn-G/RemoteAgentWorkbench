import SwiftUI

struct SectionCard<Content: View>: View {
    let title: String
    let caption: String?
    @ViewBuilder var content: Content

    init(title: String, caption: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.caption = caption
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xxs) {
                Text(title)
                    .font(WorkbenchTheme.Typography.sectionTitle)
                    .foregroundStyle(WorkbenchTheme.textPrimary)
                if let caption, !caption.isEmpty {
                    Text(caption)
                        .font(WorkbenchTheme.Typography.metadata)
                        .foregroundStyle(WorkbenchTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            content
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .workbenchCard()
    }
}
