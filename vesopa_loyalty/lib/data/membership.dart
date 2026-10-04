import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'session.dart';

/// The member's membership, from /loyalty/v1/me/membership.
///
/// NULL MEANS THE VENUE DOES NOT RUN MEMBERSHIPS (the server's 404), and then
/// nothing about plans, paying online or classes appears anywhere: a pub's
/// members should never see a gym's buttons. The account page falls back to
/// what /me says about the card's expiry, as it always did.
final membershipProvider = FutureProvider<Map<String, dynamic>?>((ref) async {
  final token = await ref.watch(sessionProvider.future);
  if (token == null) throw ApiError('Please sign in.', status: 401);
  return ref.read(apiProvider).membership();
});

/// The next fortnight of classes, each with this member's own booking.
final classesProvider = FutureProvider<List<Map<String, dynamic>>>((ref) async {
  final token = await ref.watch(sessionProvider.future);
  if (token == null) throw ApiError('Please sign in.', status: 401);
  return ref.read(apiProvider).classes(days: 14);
});

/// Whether the Classes tab belongs in this app: the venue runs memberships
/// and the member's plan includes classes, or a plan on sale does.
bool offersClasses(Map<String, dynamic>? m) {
  if (m == null) return false;
  final plan = m['plan'];
  if (plan is Map && plan['includes_classes'] == true) return true;
  final forSale = (m['plans_for_sale'] as List?) ?? const [];
  return forSale.any((p) => p is Map && p['includes_classes'] == true);
}

/// A Dojo checkout the member has gone off to pay, kept until it is checked.
///
/// KEPT ON THE DEVICE, because paying takes the member out to a browser and
/// a phone may well throw the app away while they type a card number. When
/// it comes back, the payment is asked about and the membership refreshed.
class PendingPaymentNotifier extends Notifier<String?> {
  String get _key => 'membership_payment_${ref.read(configProvider).slug}';

  @override
  String? build() {
    ref.watch(configProvider);
    _load();
    return null;
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final saved = prefs.getString(_key);
      if (saved != null && saved.isNotEmpty && state == null) state = saved;
    } catch (_) {
      // Nothing kept: the member can still check from the page.
    }
  }

  Future<void> set(String? paymentId) async {
    state = paymentId;
    try {
      final prefs = await SharedPreferences.getInstance();
      if (paymentId == null) {
        await prefs.remove(_key);
      } else {
        await prefs.setString(_key, paymentId);
      }
    } catch (_) {
      // This run still knows.
    }
  }
}

final pendingPaymentProvider = NotifierProvider<PendingPaymentNotifier, String?>(PendingPaymentNotifier.new);

const _monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/// "12 Sep 2026" from the server's 'YYYY-MM-DD'.
String dayText(Object? date) {
  final d = date is String ? DateTime.tryParse(date) : null;
  if (d == null) return '';
  return '${d.day} ${_monthNames[d.month - 1]} ${d.year}';
}

/// The membership's state in a few words, with its date where it has one.
String membershipStateText(Map<String, dynamic> m) {
  final expiry = m['expiry'];
  final daysLeft = (m['days_left'] as num?)?.toInt();
  switch (m['state']) {
    case 'active':
      if (expiry == null) return 'Active';
      final left = daysLeft != null && daysLeft >= 0 && daysLeft <= 31
          ? ' (${daysLeft == 0 ? 'last day' : '$daysLeft day${daysLeft == 1 ? '' : 's'} left'})'
          : '';
      return 'Active until ${dayText(expiry)}$left';
    case 'frozen':
      final until = m['frozen_until'];
      return until == null ? 'Frozen' : 'Frozen until ${dayText(until)}';
    case 'expired':
      return expiry == null ? 'Expired' : 'Expired on ${dayText(expiry)}';
    case 'pending':
      return 'Waiting for the venue to approve';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Not a member yet';
  }
}

/// A class's start, read as the venue's own clock: the server sends
/// 'YYYY-MM-DDTHH:mm' with no zone, and that is the time on the timetable.
DateTime? classStart(Map<String, dynamic> c) => DateTime.tryParse('${c['starts_at'] ?? ''}');
DateTime? classEnd(Map<String, dynamic> c) => DateTime.tryParse('${c['ends_at'] ?? ''}');

/// "HH:mm" of a class time.
String clock(DateTime? d) =>
    d == null ? '' : '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

/// "Today", "Tomorrow" or "Wednesday 14 Oct" for a class day.
String classDayTitle(DateTime day, DateTime now) {
  final today = DateTime(now.year, now.month, now.day);
  final diff = DateTime(day.year, day.month, day.day).difference(today).inDays;
  if (diff == 0) return 'Today';
  if (diff == 1) return 'Tomorrow';
  return '${_dayNames[day.weekday - 1]} ${day.day} ${_monthNames[day.month - 1]}';
}

/// Classes grouped by the day they start, in order, leaving out those already
/// over -- and cancelled ones, unless the member was booked on them and needs
/// to hear it.
List<(DateTime, List<Map<String, dynamic>>)> classesByDay(List<Map<String, dynamic>> list, DateTime now) {
  final days = <DateTime, List<Map<String, dynamic>>>{};
  for (final c in list) {
    final start = classStart(c);
    if (start == null) continue;
    final end = classEnd(c) ?? start;
    if (end.isBefore(now)) continue;
    final mine = c['my_status'];
    if (c['cancelled'] == true && (mine == null || mine == 'cancelled')) continue;
    days.putIfAbsent(DateTime(start.year, start.month, start.day), () => []).add(c);
  }
  final keys = days.keys.toList()..sort();
  return [
    for (final k in keys) (k, days[k]!..sort((a, b) => classStart(a)!.compareTo(classStart(b)!))),
  ];
}
