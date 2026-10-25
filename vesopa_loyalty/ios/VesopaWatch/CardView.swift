import SwiftUI

/// The code the till scans, as big as the screen allows, on white.
struct CardView: View {
  @EnvironmentObject private var store: CardStore

  var body: some View {
    let card = store.card
    ScrollView {
      VStack(spacing: 2) {
        if let data = card.qrPng, let image = UIImage(data: data) {
          Image(uiImage: image)
            .interpolation(.none)
            .resizable()
            .scaledToFit()
            .padding(7)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .frame(maxWidth: 150)
            .accessibilityLabel("Your membership QR code")
        }
        Text(card.number)
          .font(.system(.title3, design: .rounded).weight(.semibold))
          .tracking(1.2)
          .monospacedDigit()
          .padding(.top, 5)
        Text("Show this at the till")
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity)
    }
    .venueTitle(card.title)
  }
}

/// The venue's name as the screen's title: "Pontardawe RFC" in full, made a
/// little smaller rather than cut short on a small watch (owner, 2026-10-25).
/// watchOS cuts a navigationTitle with an ellipsis, so it is drawn here.
extension View {
  func venueTitle(_ title: String) -> some View {
    toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Text(title)
          .font(.headline)
          .foregroundStyle(.tint)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
          .accessibilityAddTraits(.isHeader)
      }
    }
  }
}

/// The venue's name for the watch when no card has arrived yet. The words are
/// the Kitchen's; tool/make_venue_app.py writes each venue's own over them.
let watchVenueName: String = {
  let n = "The Vesopa Kitchen"
  return n.lowercased().hasPrefix("the ") ? String(n.dropFirst(4)) : n
}()
