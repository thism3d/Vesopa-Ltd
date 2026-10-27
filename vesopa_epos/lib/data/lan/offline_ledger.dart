/// Points, gift cards, vouchers and memberships while the internet is down
/// (2026-10-27).
///
/// The owner: the main till holds them, applies spends in order, and
/// everything goes to the cloud when it is back. Two tills must still never
/// spend the same balance, which is why this is not a cache each till keeps
/// for itself.
///
/// HOW
///
///   * Every till keeps a **snapshot** from the back office (`/api/lan/snapshot`:
///     members, gift cards, vouchers), refreshed while the internet is up.
///   * A move made offline is an **entry**. Only the main till accepts one: it
///     checks it against its own view (is there that much on the card?), numbers
///     it, and sends it to every till on the `ledger` channel, so each holds the
///     same list and any of them can take over.
///   * A balance is the snapshot **plus the entries it does not yet include**.
///     The server's snapshot lists the replayed moves it already contains, and
///     those leave the list -- so a fresh snapshot never counts one twice.
///   * Back online, the main till sends each entry to the route it would have
///     used, once ([replayPath]; the server's `X-Vesopa-Offline-Id`).
///
/// Pure Dart, no I/O: see offline_money.dart for the part that talks.
library;

/// One move made while offline.
class LedgerEntry {
  LedgerEntry({
    required this.id,
    required this.kind,
    required this.body,
    required this.at,
    this.seq = 0,
    this.by = '',
    this.doneAt,
    this.failed,
  });

  /// Unique across the venue: the device that asked, and its own number.
  final String id;

  /// gift_redeem | gift_load | points | voucher | renew
  final String kind;

  /// What the cloud route takes, exactly as the till would have sent it.
  final Map<String, dynamic> body;

  /// Main-till clock, milliseconds.
  final int at;

  /// The main till's order.
  int seq;
  String by;

  /// When the cloud took it (main-till clock). Null: still to send.
  int? doneAt;

  /// The cloud's refusal, when it refused it.
  String? failed;

  bool get done => doneAt != null;

  Map<String, dynamic> toJson() => {
        'id': id,
        'kind': kind,
        'body': body,
        'at': at,
        'seq': seq,
        'by': by,
        if (doneAt != null) 'done_at': doneAt,
        if (failed != null) 'failed': failed,
      };

  static LedgerEntry? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final id = raw['id'], kind = raw['kind'], body = raw['body'];
    if (id is! String || kind is! String || body is! Map) return null;
    return LedgerEntry(
      id: id,
      kind: kind,
      body: body.cast<String, dynamic>(),
      at: (raw['at'] as num?)?.toInt() ?? 0,
      seq: (raw['seq'] as num?)?.toInt() ?? 0,
      by: '${raw['by'] ?? ''}',
      doneAt: (raw['done_at'] as num?)?.toInt(),
      failed: raw['failed'] as String?,
    );
  }
}

/// Raised when the main till will not accept a move: the money is not there.
class LedgerRefused implements Exception {
  const LedgerRefused(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Where each kind goes when the cloud is back.
String replayPath(String kind) => switch (kind) {
      'gift_redeem' => '/api/gift-cards/redeem',
      'gift_load' => '/api/gift-cards/load',
      'points' => '/api/loyalty/points',
      'voucher' => '/api/vouchers/redeem',
      'renew' => '/api/loyalty/renew',
      _ => '',
    };

class OfflineLedger {
  /// The back office's copy, and when it was taken (main-till clock, ms).
  List<Map<String, dynamic>> customers = const [];
  Map<String, dynamic> settingsByScheme = const {};
  List<Map<String, dynamic>> giftCards = const [];
  List<Map<String, dynamic>> vouchers = const [];
  int snapshotAt = 0;

  final List<LedgerEntry> entries = [];

  bool get hasSnapshot => snapshotAt > 0;

  void setSnapshot(Map<String, dynamic> j, {required int at}) {
    customers = [for (final c in (j['customers'] as List? ?? const [])) (c as Map).cast<String, dynamic>()];
    settingsByScheme = (j['settings_by_scheme'] as Map?)?.cast<String, dynamic>() ?? const {};
    giftCards = [for (final c in (j['gift_cards'] as List? ?? const [])) (c as Map).cast<String, dynamic>()];
    vouchers = [for (final c in (j['vouchers'] as List? ?? const [])) (c as Map).cast<String, dynamic>()];
    snapshotAt = at;
    // The moves this copy already includes, as the server lists them: counting
    // them again would spend the same money twice on paper.
    final applied = {for (final id in (j['applied'] as List? ?? const [])) '$id'};
    entries.removeWhere((e) => applied.contains(e.id));
  }

  Map<String, dynamic> snapshotJson() => {
        'customers': customers,
        'settings_by_scheme': settingsByScheme,
        'gift_cards': giftCards,
        'vouchers': vouchers,
        'at': snapshotAt,
      };

  /// Entries the snapshot does not include yet: every one still held. An
  /// entry leaves the list when a snapshot names it as applied.
  Iterable<LedgerEntry> get _pending => entries.where((e) => e.failed == null);

  /// Add an entry heard from the main till (or made here, on it). Idempotent.
  bool add(LedgerEntry e) {
    final i = entries.indexWhere((x) => x.id == e.id);
    if (i >= 0) {
      final known = entries[i];
      if (e.doneAt != null) known.doneAt = e.doneAt;
      if (e.failed != null) known.failed = e.failed;
      return false;
    }
    entries.add(e);
    entries.sort((a, b) => a.seq != b.seq ? a.seq.compareTo(b.seq) : a.at.compareTo(b.at));
    return true;
  }

  void markDone(String id, int at, {String? failed}) {
    for (final e in entries) {
      if (e.id == id) {
        e.doneAt = at;
        e.failed = failed;
      }
    }
  }

  int get nextSeq => entries.fold<int>(0, (m, e) => e.seq > m ? e.seq : m) + 1;

  List<LedgerEntry> get toReplay => [for (final e in entries) if (!e.done) e];

  // ---- gift cards -------------------------------------------------------------

  static String _digits(String s) => s.replaceAll(RegExp(r'[\s-]'), '').toUpperCase();

  Map<String, dynamic>? _giftRow(String code) {
    final want = _digits(code);
    for (final c in giftCards) {
      if (_digits('${c['code'] ?? ''}') == want) return c;
    }
    return null;
  }

  int _giftDelta(String code) {
    final want = _digits(code);
    var d = 0;
    for (final e in _pending) {
      if (_digits('${e.body['code'] ?? ''}') != want) continue;
      final amount = (e.body['amount_minor'] as num?)?.toInt() ?? 0;
      if (e.kind == 'gift_redeem') d -= amount;
      if (e.kind == 'gift_load') d += amount;
    }
    return d;
  }

  /// The card as `/gift-cards/lookup` answers, with offline moves applied.
  /// Null: not a card this venue had when the copy was made (or made since).
  Map<String, dynamic>? giftCard(String code) {
    final row = _giftRow(code);
    final delta = _giftDelta(code);
    if (row == null) {
      // A new card sold offline exists from its first load.
      if (delta <= 0) return null;
      return {
        'id': '',
        'code': code,
        'kind': 'swipe',
        'status': 'active',
        'balance_minor': delta,
        'available_minor': delta,
        'redeemable': true,
        'offline': true,
      };
    }
    final balance = ((row['balance_minor'] as num?)?.toInt() ?? 0) + delta;
    final blocked = row['reason'] != null || row['expired'] == true || row['not_yet'] == true;
    return {
      ...row,
      'balance_minor': balance,
      'available_minor': balance < 0 ? 0 : balance,
      'redeemable': !blocked && balance > 0,
      'offline': true,
    };
  }

  // ---- members ----------------------------------------------------------------

  double _pointsDelta(String customerId) {
    var d = 0.0;
    for (final e in _pending) {
      if (e.kind != 'points' || e.body['customer_id'] != customerId) continue;
      if (e.body['kind'] == 'redeem') d -= (e.body['points'] as num?)?.toDouble() ?? 0;
      if (e.body['kind'] == 'adjust') d += (e.body['points'] as num?)?.toDouble() ?? 0;
    }
    return d;
  }

  String? _renewedTo(String customerId) {
    String? last;
    for (final e in _pending) {
      if (e.kind == 'renew' && e.body['customer_id'] == customerId) last = e.body['offline_expiry'] as String?;
    }
    return last;
  }

  /// The member as `/loyalty/card` answers, with offline moves applied.
  Map<String, dynamic> member(Map<String, dynamic> row) {
    final settings = (settingsByScheme[row['scheme_id'] == null ? 'none' : '${row['scheme_id']}'] as Map?)
            ?.cast<String, dynamic>() ??
        (settingsByScheme['none'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    final bal = ((row['points_balance'] as num?)?.toDouble() ?? 0) + _pointsDelta('${row['id']}');
    final value = (settings['point_value_minor'] as num?)?.toDouble() ?? 0;
    final min = (settings['min_redeem_points'] as num?)?.toDouble() ?? 0;
    return {
      ...row,
      'points_balance': bal,
      'points_value_minor': (bal * value).round(),
      'redeemable': bal >= min,
      'settings': settings,
      'membership_expiry': _renewedTo('${row['id']}') ?? row['membership_expiry'],
      'offline': true,
    };
  }

  Map<String, dynamic>? memberByCard(String number) {
    final n = number.trim();
    final digits = n.replaceAll(RegExp(r'\D'), '');
    for (final c in customers) {
      if ('${c['id']}'.toLowerCase() == n.toLowerCase() || (digits.isNotEmpty && '${c['card_number'] ?? ''}' == digits)) {
        return member(c);
      }
    }
    return null;
  }

  Map<String, dynamic>? memberById(String id) {
    for (final c in customers) {
      if ('${c['id']}' == id) return member(c);
    }
    return null;
  }

  Map<String, dynamic>? memberByPhone(String phone) {
    final want = phone.replaceAll(' ', '');
    for (final c in customers) {
      if ('${c['phone'] ?? ''}'.replaceAll(' ', '') == want) return member(c);
    }
    return null;
  }

  List<Map<String, dynamic>> search(String query, {int limit = 25}) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return const [];
    final out = <Map<String, dynamic>>[];
    for (final c in customers) {
      final hay = [c['name'], c['phone'], c['card_number'], c['email'], c['member_no']]
          .whereType<Object>()
          .map((v) => '$v'.toLowerCase());
      if (hay.any((h) => h.contains(q))) out.add(member(c));
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- vouchers ---------------------------------------------------------------

  Map<String, dynamic>? voucher(String code, int subtotalMinor, {DateTime? today}) {
    final want = code.trim().toUpperCase();
    Map<String, dynamic>? row;
    for (final v in vouchers) {
      if ('${v['code'] ?? ''}'.toUpperCase() == want) row = v;
    }
    if (row == null) return null;
    final used = ((row['times_used'] as num?)?.toInt() ?? 0) +
        _pending.where((e) => e.kind == 'voucher' && '${e.body['code']}'.toUpperCase() == want).length;
    final day = today ?? DateTime.now();
    final d0 = DateTime(day.year, day.month, day.day);
    DateTime? date(Object? v) => v == null ? null : DateTime.tryParse('$v');
    final reasons = <String>[];
    if (row['active'] == 0 || row['active'] == false) reasons.add('This voucher is not active');
    final ends = date(row['expires_on']);
    if (ends != null && ends.isBefore(d0)) reasons.add('This voucher has expired');
    final starts = date(row['starts_on']);
    if (starts != null && starts.isAfter(d0)) reasons.add('This voucher is not valid yet');
    final reusable = row['reusable'] == 1 || row['reusable'] == true;
    if (!reusable && used > 0) reasons.add('This voucher has already been used');
    final max = (row['max_uses'] as num?)?.toInt() ?? 0;
    if (max > 0 && used >= max) reasons.add('This voucher has reached its limit');
    final minSpend = (row['min_spend_minor'] as num?)?.toInt() ?? 0;
    if (minSpend > 0 && subtotalMinor < minSpend) {
      reasons.add('Spend at least £${(minSpend / 100).toStringAsFixed(2)}');
    }
    var discount = 0;
    final value = (row['value'] as num?)?.toDouble() ?? 0;
    if (row['discount_type'] == 'percent') discount = (subtotalMinor * value / 100).round();
    if (row['discount_type'] == 'amount') discount = value.round();
    if (discount > subtotalMinor) discount = subtotalMinor;
    return {
      ...row,
      'times_used': used,
      'valid': reasons.isEmpty,
      'reasons': reasons,
      'discount_minor': reasons.isEmpty ? discount : 0,
      'offline': true,
    };
  }

  // ---- the main till's check ------------------------------------------------

  /// Check [e] against this view and take it, numbered. Throws
  /// [LedgerRefused] when the money is not there.
  LedgerEntry accept(LedgerEntry e) {
    if (entries.any((x) => x.id == e.id)) return entries.firstWhere((x) => x.id == e.id);
    switch (e.kind) {
      case 'gift_redeem':
        final code = '${e.body['code'] ?? ''}';
        final card = giftCard(code);
        final amount = (e.body['amount_minor'] as num?)?.toInt() ?? 0;
        if (card == null) throw const LedgerRefused('No such gift card');
        if (card['redeemable'] != true) throw LedgerRefused('${card['reason'] ?? 'This gift card cannot be used'}');
        if (amount <= 0) throw const LedgerRefused('Amount must be more than zero');
        if (amount > ((card['available_minor'] as num?)?.toInt() ?? 0)) {
          throw const LedgerRefused('There is not that much on the card');
        }
      case 'gift_load':
        if (((e.body['amount_minor'] as num?)?.toInt() ?? 0) <= 0) {
          throw const LedgerRefused('Amount must be more than zero');
        }
      case 'points':
        if (e.body['kind'] == 'redeem') {
          final m = memberById('${e.body['customer_id']}');
          if (m == null) throw const LedgerRefused('No such member');
          final want = (e.body['points'] as num?)?.toDouble() ?? 0;
          if (want > ((m['points_balance'] as num?)?.toDouble() ?? 0) + 1e-6) {
            throw const LedgerRefused('Not enough points');
          }
        }
      case 'voucher':
        final v = voucher('${e.body['code'] ?? ''}', 1 << 30);
        if (v == null) throw const LedgerRefused('No such voucher');
        final reasons = [for (final r in (v['reasons'] as List)) '$r'].where((r) => !r.startsWith('Spend at least'));
        if (reasons.isNotEmpty) throw LedgerRefused(reasons.first);
      case 'renew':
        break;
      default:
        throw LedgerRefused('Unknown move ${e.kind}');
    }
    e.seq = nextSeq;
    add(e);
    return e;
  }
}
