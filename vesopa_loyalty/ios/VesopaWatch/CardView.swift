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
    .navigationTitle(card.title)
  }
}
