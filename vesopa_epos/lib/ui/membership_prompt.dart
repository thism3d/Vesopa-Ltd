/// The two things a membership card needs at the counter: a face to check it
/// against, and something to do about it when it has run out.
///
/// WHY A CARD THAT HAS EXPIRED MUST NOT SIMPLY BE ATTACHED
///
/// "Please allow a function on the till that is the customer have expired they
/// card can't be used." Until now the expiry travelled all the way down to the
/// till — the server sends it, the local database stores it — and nothing read
/// it. A lapsed member's card worked exactly as well as a paid-up one, which
/// means a venue running a membership scheme was not running one.
///
/// It refuses by *offering*, though, not by stopping: the useful thing to do
/// with somebody standing at the counter holding a card that ran out in March
/// is to take ten pounds off them. Declining the offer leaves no customer on
/// the bill, so the card genuinely cannot be used.
library;

import 'package:flutter/material.dart';

import '../data/commerce.dart';
import '../data/customer_repository.dart';
import 'theme.dart';

String _money(int minor) => '£${(minor / 100).toStringAsFixed(2)}';

String _day(DateTime d) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return '${d.day} ${months[d.month - 1]} ${d.year}';
}

/// Everything the membership dialogs need about one person, whichever lookup
/// found them.
///
/// WHY THIS EXISTS AT ALL
///
/// A card swipe produces a [LoyaltyCustomer] and the Customer key produces a
/// [TillCustomer], and until now only the first of those went anywhere near an
/// expiry check. That is the venue's complaint in one sentence: "if a customer
/// has expired, they can still use the loyalty card on the till" — swipe the
/// card and you were stopped, pick the same person off the list and you were
/// not.
///
/// So both become this, and there is exactly one gate. A third way in later
/// has to build one of these too, which is the point.
class ExpiredMember {
  const ExpiredMember({
    required this.id,
    required this.name,
    this.cardNumber,
    this.photoUrl,
    this.pointsBalance = 0,
    this.membershipExpiry,
    this.membershipFeeMinor = 0,
    this.membershipTermMonths = 12,
    this.membershipRenewalDate,
  });

  /// From a swiped or scanned card, or a phone-number lookup.
  ///
  /// The venue's fee and term travel on the customer because a swipe is one
  /// round trip, not two, with somebody standing at the counter.
  factory ExpiredMember.fromLoyalty(LoyaltyCustomer c) => ExpiredMember(
    id: c.id,
    name: c.name,
    cardNumber: c.cardNumber,
    photoUrl: c.photoUrl,
    pointsBalance: c.pointsBalance,
    membershipExpiry: c.membershipExpiry,
    membershipFeeMinor: c.membershipFeeMinor,
    membershipTermMonths: c.membershipTermMonths,
    membershipRenewalDate: c.membershipRenewalDate,
  );

  /// From the Customer key's list.
  ///
  /// That lookup carries no loyalty settings — it is a search over names, not
  /// a card read — so the fee and the term come from the settings the till has
  /// already cached. Both are passed in rather than defaulted here, because a
  /// dialog that offered to renew for the wrong money would be worse than one
  /// that did not offer at all.
  factory ExpiredMember.fromTill(
    TillCustomer c, {
    required int feeMinor,
    required int termMonths,
    required DateTime? renewalDate,
  }) => ExpiredMember(
    id: c.id,
    name: c.name,
    cardNumber: c.cardNumber,
    photoUrl: c.photoUrl,
    pointsBalance: c.pointsBalance,
    membershipExpiry: c.membershipExpiry,
    membershipFeeMinor: feeMinor,
    membershipTermMonths: termMonths,
    membershipRenewalDate: renewalDate,
  );

  final String id;
  final String name;
  final String? cardNumber;
  final String? photoUrl;
  final int pointsBalance;
  final DateTime? membershipExpiry;

  /// The venue's settings, carried on the person so a swipe is one lookup.
  final int membershipFeeMinor;
  final int membershipTermMonths;

  /// The night the season ends, when the venue runs one.
  final DateTime? membershipRenewalDate;

  /// Whether the card has run out, as of this terminal's clock.
  ///
  /// The expiry day itself counts: a card that says 31 March works all of the
  /// 31st. Compared as calendar days, so a member is not expired an evening
  /// early through British summer time.
  bool get membershipExpired {
    final expiry = membershipExpiry;
    if (expiry == null) return false;
    final now = DateTime.now();
    return expiry.isBefore(DateTime(now.year, now.month, now.day));
  }

  /// What renewing buys, said the way the venue has set it up.
  ///
  /// A season that has already passed is not quoted, because the server will
  /// not renew to it either — it falls back to the term rather than hand
  /// somebody a card that expired last year. Saying "runs to 31 August 2024"
  /// at the counter and then writing a different date would be worse than
  /// saying nothing.
  String get runsToPhrase {
    final season = membershipRenewalDate;
    final now = DateTime.now();
    if (season != null && !season.isBefore(DateTime(now.year, now.month, now.day))) {
      return 'runs the card to ${_day(season)}';
    }
    final months = membershipTermMonths;
    return 'moves the card on $months month${months == 1 ? '' : 's'}';
  }
}

/// What the clerk decided about an expired membership.
enum MembershipChoice {
  /// Take the fee and move the date on.
  renew,

  /// Leave it. Nobody goes on the bill.
  notNow,
}

/// A member's photograph, or their initials.
///
/// Never a gate on the sale. The picture is fetched from the back office and a
/// venue whose line is down still has to be able to serve people, so a photo
/// that will not load falls back to initials rather than to an error — and the
/// clerk is looking at a name either way.
class MemberFace extends StatelessWidget {
  const MemberFace({
    super.key,
    required this.name,
    this.photoUrl,
    this.apiBase,
    this.size = 96,
  });

  final String name;
  final String? photoUrl;

  /// Where the back office is. The stored URL is a path — `/uploads/x.png` —
  /// because that is what the venue's own pages use, so it has to be joined to
  /// a host before a till on a different machine can fetch it.
  final String? apiBase;
  final double size;

  String get _initials {
    final words = name.trim().split(RegExp('[ ]+')).where((w) => w.isNotEmpty);
    if (words.isEmpty) return '?';
    return words.take(2).map((w) => w[0].toUpperCase()).join();
  }

  String? get _url {
    final path = photoUrl;
    if (path == null || path.isEmpty) return null;
    if (path.startsWith('http')) return path;
    final base = (apiBase ?? '').replaceAll(RegExp(r'/$'), '');
    return base.isEmpty ? null : '$base$path';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final url = _url;

    final placeholder = Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: scheme.surfaceContainerHighest,
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Text(
        _initials,
        style: TextStyle(
          fontSize: size * 0.34,
          fontWeight: FontWeight.w700,
          color: scheme.onSurfaceVariant,
        ),
      ),
    );

    if (url == null) return placeholder;

    return ClipOval(
      child: SizedBox(
        width: size,
        height: size,
        child: Image.network(
          url,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => placeholder,
          loadingBuilder: (context, child, progress) =>
              progress == null ? child : placeholder,
        ),
      ),
    );
  }
}

/// This card has run out. Offer to renew it.
///
/// Returns null if the clerk dismissed the dialog, which is read the same way
/// as "not now": nothing is attached and nothing is charged.
Future<MembershipChoice?> showExpiredMembership(
  BuildContext context, {
  required ExpiredMember member,
  String? apiBase,
}) {
  final expiry = member.membershipExpiry;
  return showDialog<MembershipChoice>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('That membership has run out'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              MemberFace(
                name: member.name,
                photoUrl: member.photoUrl,
                apiBase: apiBase,
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      member.name,
                      style: const TextStyle(
                        fontSize: 19,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    if (expiry != null)
                      Text(
                        'Expired ${_day(expiry)}',
                        style: TextStyle(color: Pos.red),
                      ),
                    if (member.cardNumber != null)
                      Text(
                        'Card ${member.cardNumber}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Text(
            member.membershipFeeMinor > 0
                ? 'Renewing puts ${_money(member.membershipFeeMinor)} on this '
                      'bill and ${member.runsToPhrase} once it is paid.'
                : 'Renewing ${member.runsToPhrase}. No fee is set in the back '
                      'office, so nothing is added to the bill.',
          ),
          const SizedBox(height: 8),
          Text(
            'Until it is renewed, this card cannot be used.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () =>
              Navigator.of(context).pop(MembershipChoice.notNow),
          child: const Text('Not now'),
        ),
        FilledButton.icon(
          onPressed: () => Navigator.of(context).pop(MembershipChoice.renew),
          icon: const Icon(Icons.card_membership),
          label: Text(
            member.membershipFeeMinor > 0
                ? 'Renew — ${_money(member.membershipFeeMinor)}'
                : 'Renew',
          ),
        ),
      ],
    ),
  );
}

/// Who is on this bill, with their face, so the clerk can see they are serving
/// the person the card belongs to.
Future<void> showMemberOnBill(
  BuildContext context, {
  required ExpiredMember member,
  String? apiBase,
  String? footnote,
}) {
  final expiry = member.membershipExpiry;
  return showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              MemberFace(
                name: member.name,
                photoUrl: member.photoUrl,
                apiBase: apiBase,
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      member.name,
                      style: const TextStyle(
                        fontSize: 19,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    Text(
                      '${member.pointsBalance} point'
                      '${member.pointsBalance == 1 ? '' : 's'}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    if (expiry != null)
                      Text(
                        'Member until ${_day(expiry)}',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                  ],
                ),
              ),
            ],
          ),
          if (footnote != null) ...[
            const SizedBox(height: 14),
            Text(footnote),
          ],
        ],
      ),
      actions: [
        FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('OK'),
        ),
      ],
    ),
  );
}
