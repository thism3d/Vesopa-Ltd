/// What the till's mix & match engine (mix_match_engine.dart, shared as it
/// is from vesopa_epos) reads, in Go's words: the till hands it rows from its
/// own database, Go hands it these, with the same names.
library;

import 'package:flutter/foundation.dart';

/// A deal from the back office (Programming > Mix & Match, `/till/deals`):
/// any [triggerQty] of its products for [dealPriceMinor].
@immutable
class MixMatchDeal {
  const MixMatchDeal({required this.id, required this.name, required this.triggerQty, required this.dealPriceMinor, this.active = true});
  final int id;
  final String name;
  final int triggerQty;
  final int dealPriceMinor;
  final bool active;
}

/// A bill line as the engine counts it: how many of which PLU at what price.
@immutable
class OrderLine {
  const OrderLine({required this.pluId, required this.quantity, required this.unitPriceMinor});
  final int pluId;
  final double quantity;
  final int unitPriceMinor;
}
