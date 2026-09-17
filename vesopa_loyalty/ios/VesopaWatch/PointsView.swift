import SwiftUI

struct PointsView: View {
  @EnvironmentObject private var store: CardStore

  var body: some View {
    let card = store.card
    ScrollView {
      VStack(spacing: 0) {
        Text("\(card.points)")
          .font(.system(size: 60, weight: .bold, design: .rounded))
          .monospacedDigit()
          .minimumScaleFactor(0.5)
          .lineLimit(1)
          .padding(.top, 6)
        Text(card.points == 1 ? "point" : "points")
          .font(.body)
          .foregroundStyle(.secondary)
        if !card.worth.isEmpty {
          Text(card.worth)
            .font(.headline)
            .padding(.top, 5)
        }
        if !card.tier.isEmpty {
          Text(card.tier)
            .font(.footnote.weight(.bold))
            .foregroundStyle(Color(white: 0.07))
            .padding(.horizontal, 9)
            .padding(.vertical, 3)
            .background(Color.accentColor, in: Capsule())
            .padding(.top, 8)
        }
        if !card.spendNote.isEmpty {
          HStack(spacing: 4) {
            if card.canSpend {
              Image(systemName: "checkmark").fontWeight(.heavy).foregroundStyle(.tint)
            }
            Text(card.spendNote)
              .foregroundStyle(
                card.canSpend
                  ? AnyShapeStyle(Color(red: 0.84, green: 0.91, blue: 0.54))
                  : AnyShapeStyle(.secondary)
              )
          }
          .font(.footnote)
          .padding(.top, 9)
        }
      }
      .frame(maxWidth: .infinity)
    }
    .navigationTitle("Points")
  }
}
