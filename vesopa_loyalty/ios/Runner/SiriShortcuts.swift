import AppIntents
import Foundation
import UIKit

/// Siri and the Shortcuts app: "Show my Pontardawe card", "Check my points
/// in Pontardawe", "Show Pontardawe news".
///
/// WHY APP SHORTCUTS AND NOT SIRIKIT
///
/// App Shortcuts (iOS 16) are there the moment the app is installed: nobody
/// records a phrase or adds anything in Settings, and the app needs no Siri
/// entitlement and no extension. The phrases are Apple's to match, so each one
/// names the app (`.applicationName` is the name under the icon), which is how
/// a club's own app and the shared one can both answer "show my card".
///
/// WHERE THEY GO
///
/// Opening the card or the news is the same thing a tapped notification does,
/// so it goes the same way: AppDelegate's `open`, which Dart already listens
/// for (lib/platform/push_io.dart) or collects at start. One route into the
/// app, not two that can disagree.
///
/// THE POINTS WITHOUT OPENING THE APP
///
/// Siri answers "check my points" from the figure the app last showed, kept in
/// this app's own UserDefaults by [SiriCard] whenever the card is sent to the
/// watch (WatchBridge.swift), so it costs Dart nothing. It is the balance as of
/// the last time the app was open, and Siri says so when that was a while ago.
/// Signed out, it is forgotten.
enum SiriCard {
  private static let pointsKey = "vesopa.siri.points"
  private static let nameKey = "vesopa.siri.name"
  private static let atKey = "vesopa.siri.at"

  /// The card as WatchBridge receives it from Dart (lib/data/watch_card.dart).
  static func save(_ card: [String: Any]) {
    let defaults = UserDefaults.standard
    guard (card["signedIn"] as? Bool) == true else {
      forget()
      return
    }
    if let points = (card["points"] as? NSNumber)?.intValue {
      defaults.set(points, forKey: pointsKey)
      defaults.set(Date().timeIntervalSince1970, forKey: atKey)
    }
    if let name = card["title"] as? String, !name.isEmpty {
      defaults.set(name, forKey: nameKey)
    }
  }

  static func forget() {
    let defaults = UserDefaults.standard
    for key in [pointsKey, nameKey, atKey] { defaults.removeObject(forKey: key) }
  }

  static var points: Int? {
    UserDefaults.standard.object(forKey: pointsKey) as? Int
  }

  static var name: String {
    UserDefaults.standard.string(forKey: nameKey) ?? ""
  }

  /// When the figure was last seen, or nil.
  static var savedAt: Date? {
    let at = UserDefaults.standard.double(forKey: atKey)
    return at > 0 ? Date(timeIntervalSince1970: at) : nil
  }
}

@available(iOS 16.0, *)
struct ShowCardIntent: AppIntent {
  static var title: LocalizedStringResource = "Show my card"
  static var description = IntentDescription("Opens the app at your card, ready to scan at the bar.")
  static var openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    AppDelegate.openFromSiri("/card")
    return .result()
  }
}

@available(iOS 16.0, *)
struct ShowNewsIntent: AppIntent {
  static var title: LocalizedStringResource = "Show the news"
  static var description = IntentDescription("Opens the app at the latest news.")
  static var openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    AppDelegate.openFromSiri("/inbox")
    return .result()
  }
}

@available(iOS 16.0, *)
struct CheckPointsIntent: AppIntent {
  static var title: LocalizedStringResource = "Check my points"
  static var description = IntentDescription("Tells you your points, as the app last showed them.")
  // Answered here, without the app coming to the front.
  static var openAppWhenRun: Bool = false

  @MainActor
  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let points = SiriCard.points else {
      return .result(dialog: "Open the app and sign in, then I can tell you your points.")
    }
    let unit = points == 1 ? "point" : "points"
    let place = SiriCard.name.isEmpty ? "" : " at \(SiriCard.name)"
    // A figure from more than a day ago might be out of date; say so rather
    // than read out a stale number as if it were today's.
    if let at = SiriCard.savedAt, Date().timeIntervalSince(at) > 24 * 3600 {
      return .result(dialog: "When you last opened the app you had \(points) \(unit)\(place).")
    }
    return .result(dialog: "You have \(points) \(unit)\(place).")
  }
}

@available(iOS 16.0, *)
struct VesopaShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: ShowCardIntent(),
      phrases: [
        "Show my \(.applicationName) card",
        "Open my \(.applicationName) card",
        "Show my card in \(.applicationName)",
      ],
      shortTitle: "My card",
      systemImageName: "qrcode"
    )
    AppShortcut(
      intent: CheckPointsIntent(),
      phrases: [
        "Check my points in \(.applicationName)",
        "How many \(.applicationName) points do I have",
        "Check my \(.applicationName) points",
      ],
      shortTitle: "My points",
      systemImageName: "star.circle"
    )
    AppShortcut(
      intent: ShowNewsIntent(),
      phrases: [
        "Show \(.applicationName) news",
        "Show the news in \(.applicationName)",
      ],
      shortTitle: "News",
      systemImageName: "bell"
    )
  }
}
