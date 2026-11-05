/// What this customer display does, set on the device by a manager and kept in
/// the back office with its other settings (data/terminal_sync.dart).
library;

import 'package:shared_preferences/shared_preferences.dart';

class DisplayOptions {
  const DisplayOptions({
    this.touch = true,
    this.sound = true,
    this.showQr = true,
    this.showAmount = true,
    this.showCardMarks = true,
    this.showCardSteps = true,
    this.showDiscount = true,
    this.thanksSeconds = 0,
    this.textScale = 1.0,
  });

  /// Whether a customer's touch does anything. Staff's corner always works.
  final bool touch;

  /// A chime when a payment is approved or declined.
  final bool sound;

  /// The code to pay from the customer's own phone, when the till offers one.
  final bool showQr;

  /// The amount in big figures on the pay screen.
  final bool showAmount;

  /// Which cards and wallets are taken, under the pay screen.
  final bool showCardMarks;

  /// The till's wording of what the card is doing ("Enter your PIN").
  final bool showCardSteps;

  /// Discounts and saved amounts on the bill.
  final bool showDiscount;

  /// Seconds the thank-you stays up; 0 follows the till.
  final int thanksSeconds;

  /// The size of the words, for a screen read from further away.
  final double textScale;

  static const _prefix = 'go_display_';

  static Future<DisplayOptions> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      bool flag(String name, bool fallback) => p.getBool('$_prefix$name') ?? fallback;
      return DisplayOptions(
        touch: flag('touch', true),
        sound: flag('sound', true),
        showQr: flag('show_qr', true),
        showAmount: flag('show_amount', true),
        showCardMarks: flag('show_card_marks', true),
        showCardSteps: flag('show_card_steps', true),
        showDiscount: flag('show_discount', true),
        thanksSeconds: p.getInt('${_prefix}thanks_seconds') ?? 0,
        textScale: (p.getDouble('${_prefix}text_scale') ?? 1.0).clamp(0.8, 1.6),
      );
    } catch (_) {
      return const DisplayOptions();
    }
  }

  Future<void> save() async {
    final p = await SharedPreferences.getInstance();
    await p.setBool('${_prefix}touch', touch);
    await p.setBool('${_prefix}sound', sound);
    await p.setBool('${_prefix}show_qr', showQr);
    await p.setBool('${_prefix}show_amount', showAmount);
    await p.setBool('${_prefix}show_card_marks', showCardMarks);
    await p.setBool('${_prefix}show_card_steps', showCardSteps);
    await p.setBool('${_prefix}show_discount', showDiscount);
    await p.setInt('${_prefix}thanks_seconds', thanksSeconds);
    await p.setDouble('${_prefix}text_scale', textScale);
  }

  DisplayOptions copyWith({
    bool? touch,
    bool? sound,
    bool? showQr,
    bool? showAmount,
    bool? showCardMarks,
    bool? showCardSteps,
    bool? showDiscount,
    int? thanksSeconds,
    double? textScale,
  }) => DisplayOptions(
    touch: touch ?? this.touch,
    sound: sound ?? this.sound,
    showQr: showQr ?? this.showQr,
    showAmount: showAmount ?? this.showAmount,
    showCardMarks: showCardMarks ?? this.showCardMarks,
    showCardSteps: showCardSteps ?? this.showCardSteps,
    showDiscount: showDiscount ?? this.showDiscount,
    thanksSeconds: thanksSeconds ?? this.thanksSeconds,
    textScale: textScale ?? this.textScale,
  );
}
