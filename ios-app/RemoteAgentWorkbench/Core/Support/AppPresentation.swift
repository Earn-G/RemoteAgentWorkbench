import CoreGraphics
import Foundation

enum TimeOfDayGreeting {
    static func title(for date: Date = Date(), calendar: Calendar = .current) -> String {
        title(hour: calendar.component(.hour, from: date))
    }

    static func title(hour: Int) -> String {
        switch hour {
        case 5..<12:
            "Good morning 👋"
        case 12..<17:
            "Good afternoon 👋"
        case 17..<22:
            "Good evening 👋"
        default:
            "Good night 👋"
        }
    }
}

enum ProjectDisplay {
    static let folderSystemImage = "folder.fill"
}

enum ProjectInfoGridMetrics {
    static let tileHeight: CGFloat = 172
}
