/// Where Vesopa Tap is, and everything the screens read.
///
/// The phone's life has five phases, and every screen is one of them:
///
///   booting   reading its terminal token from the phone's secure storage
///   welcome   not set up: Sign in with Vesopa, Register a venue, or the demo
///   setup     signed in: choose the site and how this phone is used
///   locked    set up, nobody signed on: PIN, staff card or Face ID
///   ready     a clerk is signed on and serving
///
/// The terminal token is in the Keychain / Keystore (flutter_secure_storage),
/// never in plain preferences: it is what makes this phone a till.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import '../payments/payment_service.dart';
import 'api.dart';
import 'demo_venue.dart';
import 'models.dart';

enum Phase { booting, welcome, setup, locked, ready }

@immutable
class TapState {
  const TapState({
    required this.phase,
    this.venue,
    this.demo = false,
    this.clerk,
    this.lastClerk,
    this.staff = const [],
    this.categories = const [],
    this.products = const [],
    this.tables = const [],
    this.bills = const {},
    this.online = true,
    this.message,
  });

  final Phase phase;
  final Venue? venue;
  final bool demo;
  final Clerk? clerk;

  /// Who last signed on here: Face ID brings back only them.
  final Clerk? lastClerk;
  final List<Clerk> staff;
  final List<MenuCategory> categories;
  final List<Product> products;
  final List<TableInfo> tables;

  /// Open bills by id: this phone's and (connected) every other terminal's.
  final Map<String, Bill> bills;
  final bool online;
  final String? message;

  Bill? billForTable(String tableId) {
    for (final b in bills.values) {
      if (b.tableId == tableId) return b;
    }
    return null;
  }

  TableState tableState(String tableId) {
    final b = billForTable(tableId);
    if (b == null) return TableState.free;
    if (b.lines.isEmpty) return TableState.seated;
    if (b.dueMinor <= 0) return TableState.paid;
    if (b.lines.any((l) => l.sent && l.product.course >= 2)) return TableState.mains;
    return TableState.ordered;
  }

  TapState copyWith({
    Phase? phase,
    Venue? venue,
    bool? demo,
    Clerk? clerk,
    bool clearClerk = false,
    Clerk? lastClerk,
    List<Clerk>? staff,
    List<MenuCategory>? categories,
    List<Product>? products,
    List<TableInfo>? tables,
    Map<String, Bill>? bills,
    bool? online,
    String? message,
  }) =>
      TapState(
        phase: phase ?? this.phase,
        venue: venue ?? this.venue,
        demo: demo ?? this.demo,
        clerk: clearClerk ? null : (clerk ?? this.clerk),
        lastClerk: lastClerk ?? this.lastClerk,
        staff: staff ?? this.staff,
        categories: categories ?? this.categories,
        products: products ?? this.products,
        tables: tables ?? this.tables,
        bills: bills ?? this.bills,
        online: online ?? this.online,
        message: message,
      );
}

final apiProvider = Provider<TapApi>((ref) => TapApi());

final paymentsProvider = Provider<PaymentService>((ref) {
  final demo = ref.watch(tapProvider.select((s) => s.demo));
  return demo ? DemoPayments() : DojoTapToPay(ref.watch(apiProvider));
});

final tapProvider = NotifierProvider<TapSession, TapState>(TapSession.new);

class TapSession extends Notifier<TapState> {
  static const _store = FlutterSecureStorage();
  static const _tokenKey = 'vesopa_tap_token';
  static const _venueKey = 'vesopa_tap_venue';
  final _uuid = const Uuid();

  @override
  TapState build() {
    unawaited(_boot());
    return const TapState(phase: Phase.booting);
  }

  Future<void> _boot() async {
    String? token;
    String? venue;
    try {
      token = await _store.read(key: _tokenKey);
      venue = await _store.read(key: _venueKey);
    } catch (_) {
      // a phone restored from a backup can lose its Keychain items: set up again
    }
    if (token == null || venue == null) {
      state = state.copyWith(phase: Phase.welcome);
      return;
    }
    ref.read(apiProvider).token = token;
    state = state.copyWith(phase: Phase.locked, venue: Venue.fromJson(jsonDecode(venue) as Map<String, dynamic>));
    await refresh();
  }

  /// Try everything with the demo venue: no back office, pretend payments.
  void startDemo() {
    state = TapState(
      phase: Phase.locked,
      venue: demoVenue,
      demo: true,
      staff: demoClerks,
      categories: demoCategories,
      products: demoProducts,
      tables: demoTables,
    );
  }

  /// After Continue with Vesopa: keep the terminal token, then choose how the phone is used.
  Future<void> commissioned(Map<String, dynamic> answer) async {
    final token = answer['token'] as String?;
    if (token == null) throw const TapApiError(0, 'Vesopa did not sign this phone in.');
    ref.read(apiProvider).token = token;
    await _store.write(key: _tokenKey, value: token);
    state = state.copyWith(
      phase: Phase.setup,
      venue: Venue(
        name: (answer['venue_name'] ?? answer['office_name'] ?? 'Your venue') as String,
        office: (answer['office'] ?? '') as String,
        mode: VenueMode.connected,
      ),
    );
  }

  Future<void> chooseMode(VenueMode mode) async {
    final v = state.venue!;
    final venue = Venue(name: v.name, office: v.office, mode: mode, site: v.site);
    await _store.write(key: _venueKey, value: jsonEncode(venue.toJson()));
    state = state.copyWith(phase: Phase.locked, venue: venue);
    await refresh();
  }

  /// Staff, menu and open bills from the back office.
  Future<void> refresh() async {
    if (state.demo) return;
    final api = ref.read(apiProvider);
    try {
      final staff = await api.staff();
      state = state.copyWith(staff: staff, online: true);
    } on TapApiError catch (e) {
      state = state.copyWith(online: e.status != 0, message: e.message);
    }
  }

  // ---- Clerks --------------------------------------------------------------------

  void signOn(Clerk clerk) => state = state.copyWith(phase: Phase.ready, clerk: clerk, lastClerk: clerk);
  void lock() => state = state.copyWith(phase: Phase.locked, clearClerk: true);

  Future<void> forgetPhone() async {
    await _store.deleteAll();
    ref.read(apiProvider).token = null;
    state = const TapState(phase: Phase.welcome);
  }

  // ---- Bills -------------------------------------------------------------------------

  Bill openTable(TableInfo table, {int covers = 0}) {
    final had = state.billForTable(table.id);
    if (had != null) return had;
    final bill = Bill(id: _uuid.v4(), name: table.name, tableId: table.id, covers: covers, clerk: state.clerk?.name ?? '');
    _put(bill);
    return bill;
  }

  Bill openTab(String name) {
    final bill = Bill(id: _uuid.v4(), name: name, clerk: state.clerk?.name ?? '');
    _put(bill);
    return bill;
  }

  void addLine(String billId, Product product, {List<Choice> choices = const [], String note = '', int seat = 0}) {
    final bill = state.bills[billId]!;
    _put(bill.copyWith(lines: [
      ...bill.lines,
      BillLine(id: _uuid.v4(), product: product, choices: choices, note: note, seat: seat),
    ]));
  }

  void changeQuantity(String billId, String lineId, int delta) {
    final bill = state.bills[billId]!;
    final lines = <BillLine>[];
    for (final l in bill.lines) {
      if (l.id != lineId) {
        lines.add(l);
        continue;
      }
      // A sent line goes only through a void with a reason (the till's rule).
      if (l.sent && delta < 0) {
        lines.add(l);
        continue;
      }
      final q = l.quantity + delta;
      if (q > 0) lines.add(l.copyWith(quantity: q));
    }
    _put(bill.copyWith(lines: lines));
  }

  /// Send what is new to the kitchen and bar. Returns how many lines went.
  int send(String billId) {
    final bill = state.bills[billId]!;
    final count = bill.lines.where((l) => !l.sent).length;
    _put(bill.copyWith(lines: [for (final l in bill.lines) l.sent ? l : l.copyWith(sent: true)]));
    return count;
  }

  void setServiceCharge(String billId, double percent) =>
      _put(state.bills[billId]!.copyWith(serviceChargePercent: percent));

  /// A payment the server confirmed. A bill paid in full is closed.
  void addTender(String billId, Tender tender, {Map<String, int> items = const {}}) {
    final bill = state.bills[billId]!;
    final lines = [
      for (final l in bill.lines)
        items.containsKey(l.id) ? l.copyWith(paidQuantity: l.paidQuantity + items[l.id]!) : l,
    ];
    final next = bill.copyWith(lines: lines, tenders: [...bill.tenders, tender]);
    if (next.dueMinor <= 0) {
      final bills = Map.of(state.bills)..remove(billId);
      state = state.copyWith(bills: bills);
    } else {
      _put(next);
    }
  }

  void _put(Bill bill) {
    state = state.copyWith(bills: {...state.bills, bill.id: bill});
    if (!state.demo && state.venue?.mode == VenueMode.connected) {
      // Shared with the tills (docs/PLAN.md phase 3: the full open-bills shape).
      unawaited(ref.read(apiProvider).saveBill({'id': bill.id, 'name': bill.name, 'total_minor': bill.totalMinor})
          .then((_) {}, onError: (Object _) {}));
    }
  }
}
