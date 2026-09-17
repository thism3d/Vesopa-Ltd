import 'brand.dart';
import 'session.dart';

/// The card as the Apple Watch app draws it (ios/VesopaWatch/CardStore.swift
/// reads these keys): the code, the points, four membership rows and the
/// latest three messages. Words and figures only, already formatted, so the
/// watch has nothing to work out and cannot disagree with the phone.
Map<String, Object?> watchCard({
  required Brand brand,
  required Map<String, dynamic> me,
  Map<String, dynamic>? messages,
}) {
  final points = (me['points'] as num?)?.toInt() ?? 0;
  final worth = (me['points_value_minor'] as num?)?.toInt() ?? 0;
  final minRedeem = brand.minRedeem;
  final short = minRedeem > points ? minRedeem - points : 0;
  final membership = (me['membership'] as Map?) ?? const {};
  final expiry = membership['expiry'] ?? me['membership_expiry'];
  final number = (me['card_number'] as String?) ??
      (me['member_no'] != null ? '${me['member_no']}' : '');

  final rows = <List<String>>[
    ['Visits', '${me['visits'] ?? 0}'],
    if (me['last_visit'] != null) ['Last visit', _dayMonth(me['last_visit'])],
    if (expiry != null) [membership['expired'] == true ? 'Ran out' : 'Until', when(expiry, time: false)],
    if (minRedeem > 0) ['Spend from', '$minRedeem pts'],
  ];

  final items = (messages?['items'] as List? ?? const []).cast<Map<String, dynamic>>();
  return {
    'signedIn': true,
    'title': watchTitle(brand.name),
    'qr': '${me['qr'] ?? ''}',
    'number': _grouped(number),
    'points': points,
    'worth': 'worth ${money(worth)}',
    'tier': (me['tier'] as String?) ?? '',
    'canSpend': minRedeem > 0 && short == 0,
    'spendNote': minRedeem <= 0 ? '' : (short == 0 ? 'Enough to spend' : '$short more to spend'),
    'rows': rows,
    'news': [
      for (final m in items.take(3))
        {
          'title': '${m['title'] ?? ''}',
          'date': _dayMonth(m['sent_at']),
          'unread': m['read_at'] == null,
        },
    ],
  };
}

/// Signed out on the phone: the watch forgets the card too.
const Map<String, Object?> watchSignedOut = {'signedIn': false};

/// A watch title has room for about ten letters: "The Vesopa Kitchen" is
/// "Kitchen", the way the screenshots show it.
String watchTitle(String name) {
  var n = name.trim();
  if (n.toLowerCase().startsWith('the ')) n = n.substring(4).trim();
  if (n.length <= 10) return n;
  // The longest word that fits, the later one on a tie: "Kitchen" from
  // "Vesopa Kitchen", "Pontardawe" from "Pontardawe RFC".
  String? best;
  for (final word in n.split(RegExp(r'\s+'))) {
    if (word.length <= 12 && (best == null || word.length >= best.length)) best = word;
  }
  return best ?? n;
}

String _grouped(String value) {
  final digits = value.replaceAll(RegExp(r'\s'), '');
  final out = StringBuffer();
  for (var i = 0; i < digits.length; i += 1) {
    if (i > 0 && i % 4 == 0) out.write(' ');
    out.write(digits[i]);
  }
  return out.toString();
}

/// "13 Sep": the year is noise on a screen this size.
String _dayMonth(Object? iso) {
  final full = when(iso, time: false);
  final parts = full.split(' ');
  return parts.length == 3 ? '${parts[0]} ${parts[1]}' : full;
}
