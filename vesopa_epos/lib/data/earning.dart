/// Whose points a settling bill moves.
///
/// The member attached on the payment page, if one was, and otherwise the
/// member on the order -- who was attached on the sale page or by a card
/// swipe and never reached the payment page's own variable. Until 1.8.1.0
/// only the first was asked, and a member attached anywhere else earned
/// nothing: no points, no visit, an empty Activity page in their app.
String? earningCustomer({String? attachedHere, String? onOrder}) {
  if (attachedHere != null && attachedHere.isNotEmpty) return attachedHere;
  if (onOrder != null && onOrder.isNotEmpty) return onOrder;
  return null;
}
