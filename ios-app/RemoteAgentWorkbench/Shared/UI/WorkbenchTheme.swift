import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

private extension Color {
    static func workbenchDynamic(
        light: (Double, Double, Double, Double),
        dark: (Double, Double, Double, Double)
    ) -> Color {
        #if canImport(UIKit)
        Color(
            UIColor { traits in
                let value = traits.userInterfaceStyle == .dark ? dark : light
                return UIColor(
                    red: value.0,
                    green: value.1,
                    blue: value.2,
                    alpha: value.3
                )
            }
        )
        #elseif canImport(AppKit)
        Color(
            nsColor: NSColor(
                name: nil,
                dynamicProvider: { appearance in
                    let best = appearance.bestMatch(from: [.darkAqua, .aqua]) ?? .aqua
                    let value = best == .darkAqua ? dark : light
                    return NSColor(
                        calibratedRed: value.0,
                        green: value.1,
                        blue: value.2,
                        alpha: value.3
                    )
                }
            )
        )
        #else
        let value = light
        return Color(.sRGB, red: value.0, green: value.1, blue: value.2, opacity: value.3)
        #endif
    }
}

enum WorkbenchTheme {
    enum Radius {
        static let chip: CGFloat = 11
        static let card: CGFloat = 18
        static let panel: CGFloat = 22
        static let control: CGFloat = 14
        static let icon: CGFloat = 14
    }

    enum Spacing {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 20
        static let xl: CGFloat = 24
        static let xxl: CGFloat = 32
    }

    enum Metrics {
        static let rowHeight: CGFloat = 64
        static let compactRowHeight: CGFloat = 52
        static let iconBox: CGFloat = 42
        static let toolbarIcon: CGFloat = 44
        static let primaryButtonHeight: CGFloat = 54
    }

    enum Typography {
        static let pageTitle = Font.system(size: 32, weight: .bold, design: .default)
        static let heroTitle = Font.system(size: 24, weight: .bold, design: .default)
        static let sectionTitle = Font.system(size: 18, weight: .semibold, design: .default)
        static let cardTitle = Font.system(size: 17, weight: .semibold, design: .default)
        static let body = Font.system(size: 15, weight: .regular, design: .default)
        static let bodyEmphasis = Font.system(size: 15, weight: .semibold, design: .default)
        static let metadata = Font.system(size: 13, weight: .regular, design: .default)
        static let metadataEmphasis = Font.system(size: 13, weight: .semibold, design: .default)
        static let badge = Font.system(size: 12, weight: .semibold, design: .default)
        static let monoBadge = Font.system(size: 12, weight: .semibold, design: .monospaced)
    }

    static let canvas = Color.workbenchDynamic(
        light: (0.9647, 0.9725, 0.9843, 1.0), // #F6F8FB
        dark: (0.0235, 0.0353, 0.0549, 1.0)   // #06090E
    )
    static let canvasAlt = Color.workbenchDynamic(
        light: (0.9255, 0.9412, 0.9686, 1.0), // #ECF0F7
        dark: (0.0431, 0.0588, 0.0863, 1.0)   // #0B0F16
    )
    static let elevated = Color.workbenchDynamic(
        light: (1.0, 1.0, 1.0, 0.92),
        dark: (0.0863, 0.1059, 0.1412, 0.88)   // #161B24
    )
    static let elevatedStrong = Color.workbenchDynamic(
        light: (1.0, 1.0, 1.0, 1.0),
        dark: (0.1098, 0.1294, 0.1725, 1.0)    // #1C212C
    )
    static let panel = Color.workbenchDynamic(
        light: (0.9412, 0.9529, 0.9725, 0.86), // #F0F3F8
        dark: (0.1255, 0.1490, 0.1961, 0.78)   // #202632
    )
    static let panelStrong = Color.workbenchDynamic(
        light: (0.9098, 0.9255, 0.9608, 1.0),  // #E8ECF5
        dark: (0.1569, 0.1843, 0.2431, 1.0)    // #282F3E
    )
    static let border = Color.workbenchDynamic(
        light: (0.7804, 0.8118, 0.8706, 0.72), // #C7CFDE
        dark: (1.0, 1.0, 1.0, 0.10)
    )
    static let borderStrong = Color.workbenchDynamic(
        light: (0.6510, 0.6902, 0.7765, 0.68),
        dark: (1.0, 1.0, 1.0, 0.16)
    )
    static let divider = Color.workbenchDynamic(
        light: (0.8000, 0.8275, 0.8784, 0.54),
        dark: (1.0, 1.0, 1.0, 0.08)
    )
    static let textPrimary = Color.workbenchDynamic(
        light: (0.0549, 0.0667, 0.0941, 1.0),  // #0E1118
        dark: (0.9647, 0.9725, 1.0, 1.0)       // #F6F8FF
    )
    static let textSecondary = Color.workbenchDynamic(
        light: (0.2549, 0.2902, 0.3647, 1.0),  // #414A5D
        dark: (0.7686, 0.8039, 0.8667, 1.0)    // #C4CDDD
    )
    static let textMuted = Color.workbenchDynamic(
        light: (0.5020, 0.5451, 0.6275, 1.0),  // #808BA0
        dark: (0.5412, 0.5843, 0.6667, 1.0)    // #8A95AA
    )

    static let agentBlue = Color(red: 0.2314, green: 0.3804, blue: 1.0)      // #3B61FF
    static let agentViolet = Color(red: 0.4784, green: 0.3137, blue: 1.0)    // #7A50FF
    static let actionMint = Color(red: 0.1882, green: 0.8196, blue: 0.3451)  // #30D158
    static let approvalAmber = Color(red: 1.0, green: 0.6902, blue: 0.1255)  // #FFB020
    static let dangerRose = Color(red: 1.0, green: 0.2706, blue: 0.2275)     // #FF453A
    static let infoCyan = Color(red: 0.3922, green: 0.8235, blue: 1.0)       // #64D2FF
    static let runningBlue = Color(red: 0.0392, green: 0.5176, blue: 1.0)    // #0A84FF
    static let completedGreen = Color(red: 0.2039, green: 0.7804, blue: 0.3490)
    static let offlineGray = Color.workbenchDynamic(
        light: (0.5569, 0.5804, 0.6431, 1.0),
        dark: (0.6824, 0.7059, 0.7608, 1.0)
    )

    static let shadow = Color.workbenchDynamic(
        light: (0.0588, 0.0863, 0.1608, 0.10),
        dark: (0.0, 0.0, 0.0, 0.46)
    )
    static let shadowSoft = Color.workbenchDynamic(
        light: (0.0588, 0.0863, 0.1608, 0.07),
        dark: (0.0, 0.0, 0.0, 0.34)
    )
    static let glass = Color.workbenchDynamic(
        light: (1.0, 1.0, 1.0, 0.78),
        dark: (0.0863, 0.1059, 0.1412, 0.76)
    )
    static let gridLine = Color.workbenchDynamic(
        light: (0.2314, 0.3804, 1.0, 0.026),
        dark: (1.0, 1.0, 1.0, 0.018)
    )
    static let sidebarSelection = Color.workbenchDynamic(
        light: (0.2314, 0.3804, 1.0, 0.10),
        dark: (0.2314, 0.3804, 1.0, 0.18)
    )
    static let sidebarSelectionBorder = Color.workbenchDynamic(
        light: (0.2314, 0.3804, 1.0, 0.20),
        dark: (0.2314, 0.3804, 1.0, 0.28)
    )
    static let barBackground = Color.workbenchDynamic(
        light: (0.9647, 0.9725, 0.9843, 0.94),
        dark: (0.0235, 0.0353, 0.0549, 0.96)
    )

    static let navigationTitle = textPrimary
    static let selectionTint = agentViolet
    static let tabBarUnselected = textMuted

    // Backwards-compatible aliases used by older screens.
    static let abyss = Color(red: 0.0235, green: 0.0353, blue: 0.0549)
    static let carbon = Color(red: 0.0863, green: 0.1059, blue: 0.1412)
    static let signalGreen = actionMint
    static let shellTop = canvas
    static let shellBottom = canvasAlt
    static let shellAccent = Color.workbenchDynamic(
        light: (0.2314, 0.3804, 1.0, 0.10),
        dark: (0.4784, 0.3137, 1.0, 0.18)
    )
    static let shellHighlight = Color.workbenchDynamic(
        light: (1.0, 1.0, 1.0, 0.60),
        dark: (1.0, 1.0, 1.0, 0.045)
    )
    static let card = panel
    static let cardStrong = elevatedStrong
    static let cardBorder = border
    static let cardInsetHighlight = Color.workbenchDynamic(
        light: (1.0, 1.0, 1.0, 0.70),
        dark: (1.0, 1.0, 1.0, 0.08)
    )
    static let cardShadow = shadow
    static let heroStart = agentViolet
    static let heroMiddle = agentBlue
    static let heroEnd = runningBlue
    static let mint = actionMint
    static let emerald = completedGreen
    static let amber = approvalAmber
    static let rose = dangerRose
    static let info = infoCyan
    static let success = completedGreen
    static let slate = offlineGray
}

struct WorkbenchBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    WorkbenchTheme.shellTop,
                    WorkbenchTheme.shellBottom
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            WorkbenchGridOverlay()
                .opacity(colorScheme == .dark ? 0.65 : 0.45)

            Circle()
                .fill(WorkbenchTheme.agentViolet.opacity(colorScheme == .dark ? 0.22 : 0.10))
                .blur(radius: 80)
                .frame(width: 280, height: 280)
                .offset(x: -150, y: -300)

            Circle()
                .fill(WorkbenchTheme.runningBlue.opacity(colorScheme == .dark ? 0.18 : 0.08))
                .blur(radius: 90)
                .frame(width: 320, height: 320)
                .offset(x: 180, y: 120)

            LinearGradient(
                colors: [
                    WorkbenchTheme.shellHighlight,
                    .clear
                ],
                startPoint: .top,
                endPoint: .center
            )
            .allowsHitTesting(false)
        }
        .ignoresSafeArea()
    }
}

private struct WorkbenchGridOverlay: View {
    var body: some View {
        GeometryReader { geometry in
            Path { path in
                let step: CGFloat = 44
                var x: CGFloat = 0
                while x <= geometry.size.width {
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x, y: geometry.size.height))
                    x += step
                }

                var y: CGFloat = 0
                while y <= geometry.size.height {
                    path.move(to: CGPoint(x: 0, y: y))
                    path.addLine(to: CGPoint(x: geometry.size.width, y: y))
                    y += step
                }
            }
            .stroke(WorkbenchTheme.gridLine, lineWidth: 0.5)
        }
        .allowsHitTesting(false)
    }
}

struct WorkbenchHeroCard<Content: View, Accessory: View>: View {
    let eyebrow: String?
    let title: String
    let detail: String?
    @ViewBuilder var accessory: Accessory
    @ViewBuilder var content: Content

    init(
        eyebrow: String? = nil,
        title: String,
        detail: String? = nil,
        @ViewBuilder accessory: () -> Accessory,
        @ViewBuilder content: () -> Content
    ) {
        self.eyebrow = eyebrow
        self.title = title
        self.detail = detail
        self.accessory = accessory()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.lg) {
            HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.xs) {
                    if let eyebrow, !eyebrow.isEmpty {
                        Text(eyebrow.uppercased())
                            .font(WorkbenchTheme.Typography.badge)
                            .tracking(0.7)
                            .foregroundStyle(.white.opacity(0.72))
                    }

                    Text(title)
                        .font(WorkbenchTheme.Typography.heroTitle)
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)

                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(WorkbenchTheme.Typography.body)
                            .foregroundStyle(.white.opacity(0.80))
                            .lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: WorkbenchTheme.Spacing.sm)
                accessory
            }

            content
        }
        .padding(WorkbenchTheme.Spacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            ZStack(alignment: .topTrailing) {
                LinearGradient(
                    colors: [
                        WorkbenchTheme.agentViolet,
                        WorkbenchTheme.agentBlue,
                        WorkbenchTheme.runningBlue
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )

                Circle()
                    .fill(.white.opacity(0.18))
                    .frame(width: 180, height: 180)
                    .offset(x: 70, y: -90)
            }
            .clipShape(RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.panel, style: .continuous))
        )
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.panel, style: .continuous)
                .strokeBorder(.white.opacity(0.16), lineWidth: 1)
        )
        .shadow(color: WorkbenchTheme.agentBlue.opacity(0.22), radius: 24, x: 0, y: 16)
    }
}

extension WorkbenchHeroCard where Accessory == EmptyView {
    init(
        eyebrow: String? = nil,
        title: String,
        detail: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.init(
            eyebrow: eyebrow,
            title: title,
            detail: detail,
            accessory: { EmptyView() },
            content: content
        )
    }
}

struct WorkbenchStatCard: View {
    let title: String
    let value: String
    let caption: String?
    let icon: String
    let tint: Color

    init(title: String, value: String, caption: String? = nil, icon: String, tint: Color = WorkbenchTheme.runningBlue) {
        self.title = title
        self.value = value
        self.caption = caption
        self.icon = icon
        self.tint = tint
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WorkbenchTheme.Spacing.sm) {
            HStack(alignment: .top, spacing: WorkbenchTheme.Spacing.sm) {
                WorkbenchIconBox(systemImage: icon, tint: tint)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(WorkbenchTheme.Typography.metadataEmphasis)
                        .foregroundStyle(WorkbenchTheme.textPrimary)
                        .lineLimit(2)

                    if let caption, !caption.isEmpty {
                        Text(caption)
                            .font(WorkbenchTheme.Typography.metadata)
                            .foregroundStyle(WorkbenchTheme.textSecondary)
                            .lineLimit(2)
                    }
                }

                Spacer(minLength: WorkbenchTheme.Spacing.xs)
            }

            Text(value)
                .font(.system(size: 28, weight: .bold, design: .default))
                .foregroundStyle(WorkbenchTheme.textPrimary)
                .minimumScaleFactor(0.70)
                .lineLimit(1)
        }
        .padding(WorkbenchTheme.Spacing.md)
        .frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
        .workbenchCard(tint: tint)
    }
}

struct WorkbenchInlineTag: View {
    let title: String
    let systemImage: String?
    let tint: Color

    init(_ title: String, systemImage: String? = nil, tint: Color = WorkbenchTheme.runningBlue) {
        self.title = title
        self.systemImage = systemImage
        self.tint = tint
    }

    var body: some View {
        HStack(spacing: 6) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 12, weight: .semibold))
            }

            Text(title)
                .font(WorkbenchTheme.Typography.badge)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.chip, style: .continuous)
                .fill(tint.opacity(0.13))
        )
        .overlay(
            RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.chip, style: .continuous)
                .strokeBorder(tint.opacity(0.28), lineWidth: 1)
        )
        .foregroundStyle(tint)
    }
}

struct WorkbenchStrip<Content: View>: View {
    @ViewBuilder var content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: WorkbenchTheme.Spacing.sm) {
                content
            }
            .padding(.horizontal, 2)
        }
    }
}

struct WorkbenchListCard<Content: View>: View {
    let tint: Color?
    @ViewBuilder var content: Content

    init(tint: Color? = nil, @ViewBuilder content: () -> Content) {
        self.tint = tint
        self.content = content()
    }

    var body: some View {
        content
            .padding(WorkbenchTheme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .workbenchCard(tint: tint)
    }
}

struct WorkbenchIconBox: View {
    let systemImage: String
    let tint: Color

    var body: some View {
        RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.icon, style: .continuous)
            .fill(tint.opacity(0.14))
            .frame(width: WorkbenchTheme.Metrics.iconBox, height: WorkbenchTheme.Metrics.iconBox)
            .overlay {
                Image(systemName: systemImage)
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(tint)
            }
            .overlay(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.icon, style: .continuous)
                    .strokeBorder(tint.opacity(0.20), lineWidth: 1)
            )
    }
}

struct WorkbenchActionTile: View {
    let title: String
    let systemImage: String
    let badge: String?

    init(_ title: String, systemImage: String, badge: String? = nil) {
        self.title = title
        self.systemImage = systemImage
        self.badge = badge
    }

    var body: some View {
        HStack(spacing: WorkbenchTheme.Spacing.sm) {
            ZStack(alignment: .topTrailing) {
                WorkbenchIconBox(systemImage: systemImage, tint: WorkbenchTheme.agentViolet)

                if let badge, !badge.isEmpty {
                    Text(badge)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(WorkbenchTheme.approvalAmber))
                        .offset(x: 9, y: -7)
                }
            }

            Text(title)
                .font(WorkbenchTheme.Typography.cardTitle)
                .foregroundStyle(WorkbenchTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.82)

            Spacer(minLength: WorkbenchTheme.Spacing.xs)

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(WorkbenchTheme.textMuted)
        }
        .padding(WorkbenchTheme.Spacing.md)
        .frame(maxWidth: .infinity, minHeight: 78)
        .workbenchCard()
    }
}

private struct WorkbenchCardModifier: ViewModifier {
    let tint: Color?

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                    .fill(WorkbenchTheme.elevated)
            )
            .overlay(
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                    .strokeBorder(tint?.opacity(0.34) ?? WorkbenchTheme.border, lineWidth: 1)
            )
            .overlay(alignment: .top) {
                RoundedRectangle(cornerRadius: WorkbenchTheme.Radius.card, style: .continuous)
                    .stroke(.white.opacity(0.10), lineWidth: 1)
                    .blendMode(.overlay)
            }
            .shadow(color: WorkbenchTheme.shadowSoft, radius: 18, x: 0, y: 10)
    }
}

private struct WorkbenchNavigationChromeModifier: ViewModifier {
    #if os(iOS)
    @Environment(\.colorScheme) private var colorScheme
    #endif

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .toolbarBackground(WorkbenchTheme.barBackground, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(colorScheme == .dark ? .dark : .light, for: .navigationBar)
        #else
        content
        #endif
    }
}

extension View {
    func workbenchCard(tint: Color? = nil) -> some View {
        modifier(WorkbenchCardModifier(tint: tint))
    }

    func workbenchNavigationChrome() -> some View {
        modifier(WorkbenchNavigationChromeModifier())
    }
}
