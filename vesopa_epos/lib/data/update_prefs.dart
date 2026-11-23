/// How this till takes updates (Settings, Updates; owner, 2026-11-07): on or
/// off, installed by itself between sales, asked first, and a short "What's
/// new" after an update. admin.vesopa.com decides the version and can still
/// say Install now, at a time, or force: that always wins over these.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/constants.dart' show VesopaBrand;

class UpdatePrefs {
  const UpdatePrefs({
    this.enabled = true,
    this.automatic = false,
    this.ask = true,
    this.whatsNew = true,
  });

  /// Updates offered at all. Off: nothing is asked or installed, unless admin
  /// says Install now, at a time, or force.
  final bool enabled;

  /// Install by itself at the next quiet moment between sales, with a short
  /// countdown, rather than asking.
  final bool automatic;

  /// Ask "Update now / On next start". Off (and not automatic): the update is
  /// downloaded and put in on the next start, without a question.
  final bool ask;

  /// After an update, a short list of what is new.
  final bool whatsNew;

  UpdatePrefs copyWith({bool? enabled, bool? automatic, bool? ask, bool? whatsNew}) => UpdatePrefs(
        enabled: enabled ?? this.enabled,
        automatic: automatic ?? this.automatic,
        ask: ask ?? this.ask,
        whatsNew: whatsNew ?? this.whatsNew,
      );
}

final updatePrefsProvider = NotifierProvider<UpdatePrefsStore, UpdatePrefs>(UpdatePrefsStore.new);

class UpdatePrefsStore extends Notifier<UpdatePrefs> {
  static const _k = 'vesopa_update_';

  @override
  UpdatePrefs build() {
    Future(() async {
      try {
        final p = await SharedPreferences.getInstance();
        state = UpdatePrefs(
          enabled: p.getBool('${_k}enabled') ?? true,
          automatic: p.getBool('${_k}automatic') ?? false,
          ask: p.getBool('${_k}ask') ?? true,
          whatsNew: p.getBool('${_k}whats_new') ?? true,
        );
      } catch (_) {}
    });
    return const UpdatePrefs();
  }

  Future<void> set({bool? enabled, bool? automatic, bool? ask, bool? whatsNew}) async {
    state = state.copyWith(enabled: enabled, automatic: automatic, ask: ask, whatsNew: whatsNew);
    try {
      final p = await SharedPreferences.getInstance();
      await p.setBool('${_k}enabled', state.enabled);
      await p.setBool('${_k}automatic', state.automatic);
      await p.setBool('${_k}ask', state.ask);
      await p.setBool('${_k}whats_new', state.whatsNew);
    } catch (_) {}
  }
}

/// What each version brought, as the till says it after updating. Short and
/// plain: what a clerk notices.
const whatsNewByVersion = <String, List<String>>{
  '1.16.48': ['Split bills: each share shows its own items to the penny, even after someone has paid.'],
  '1.16.49': [
    'Split like Newbridge: move one item between shares with minus and plus.',
    'Equal split shows a card for each person, with their own Bill and Pay now.',
    'Print all the shares\' bills at once, name each share, or split by amount.',
    'After a share is paid, the till asks "Pay the next share?".',
    'Staff drink slips carry a QR code and are easier to redeem.',
  ],
  '1.16.50': ['Your own sale follows you: sign on at another till and bring it over in one tap.'],
  '1.16.51': [
    'Updates: choose automatic, ask first, or off in Settings, and see what is new.',
    'The till repairs itself if a file goes missing, and updates can no longer leave a file out.',
  ],
  '1.16.52': ['X and Z reports always show the float, paid in, paid out, cashback and the cash expected.'],
  '1.16.53': [
    'Tills work together: choose Master or Slave in Settings, Local network. A slave stands in if the master is off.',
    'With the internet down, a till takes the menu, prices and staff from the master, and tables move at once.',
    'End of Day has All tills: one X or Z for the whole venue.',
    'The Z report takes cashback, paid in and cash refunds off the cash expected, as the X always did.',
  ],
  '1.16.54': [
    'Tables now show on every till: a table opened on one till appears on the others.',
    'Each till has its own X and Z. Settings, Local network has a switch to add one report for all tills.',
    'A phone or tablet running Vesopa Go as a Card terminal can take this till\'s card payments (Settings, Card payments).',
  ],
  '1.16.55': [
    'A picked item on the bill is just highlighted: no "1 x selected", no pencil and no item box. Void and Cancel take items off.',
    'Beside the totals: arrows to move down and up the bill, and Select all.',
    'Functions, Discount: money off the highlighted items, or the whole bill when none are highlighted.',
    'After signing in, the till asks which terminal it is, or replaces. Its sales, X and Z carry on under that terminal, and the X and Z show its number and name.',
  ],
  '1.16.56': [
    'A bigger keyboard for every box, along the bottom of the screen like an iPad\'s, with .?123 and #+=. Pull a key down for the small character above it.',
    'The box you are typing in moves up above the keyboard.',
    'Undo, redo, cut, copy, paste and select all above the keys; A- and A+ for the key size; the keyboard button for Dock, Undock, Split or Floating.',
    'Typing on a real keyboard puts the screen keyboard away; the keyboard button in the corner brings it back.',
    'Prices, quantities and covers get a big round number pad.',
  ],
  '1.16.57': [
    'Split bill: items a person has already paid for stay off the split. Open the split again and they are gone from Not split yet, and Left to split is what is still owed.',
    'Card machines: the till now notices when its link to the card machine drops and opens it again by itself, so sales no longer go to a machine the till has lost.',
  ],
  '1.16.58': [
    'Split bill on a table: when one person pays their share, their items leave the table as a sale of their own. The table keeps only what is still owed.',
    'After a share is paid, Leave on table saves the table and clears the till, with no need to press Save Table.',
    'Tables part-paid on the last version are tidied the next time they are paid on.',
  ],
};

/// The notes to show once after an update to [VesopaBrand.appVersion], or
/// null when there is nothing new to say or they were already shown.
Future<List<String>?> whatsNewToShow() async {
  try {
    final p = await SharedPreferences.getInstance();
    final seen = p.getString('vesopa_whats_new_seen');
    final now = VesopaBrand.appVersion;
    if (seen == now) return null;
    await p.setString('vesopa_whats_new_seen', now);
    // A first install has nothing to compare with: no notes.
    if (seen == null) return null;
    return whatsNewByVersion[now];
  } catch (_) {
    return null;
  }
}
