/// Vesopa Go's options from the back office (Vesopa Go > Vesopa Go options),
/// as `/api/tap/config` sends them under `go`. The keys and defaults are
/// vesopa_server/src/go_options.js's GO_DEFAULTS: keep the two in step.
library;

import 'package:flutter/foundation.dart';

@immutable
class GoOptions {
  const GoOptions([this._raw = const {}]);

  factory GoOptions.fromJson(Object? j) => GoOptions(j is Map ? Map<String, Object?>.from(j) : const {});

  final Map<String, Object?> _raw;
  Map<String, Object?> toJson() => _raw;

  bool _flag(String k, bool d) {
    final v = _raw[k];
    return v is bool ? v : (v is num ? v != 0 : d);
  }

  int _int(String k, int d) => (_raw[k] as num?)?.toInt() ?? d;
  String _str(String k, String d) => _raw[k] is String ? _raw[k] as String : d;

  /// pay_on_go | send_to_till
  String get orderMode => _str('order_mode', 'pay_on_go');
  bool get sendToTill => orderMode == 'send_to_till';

  /// till | on | off
  String get stackLines => _str('stack_lines', 'till');
  bool get floorPlan => _str('floor_view', 'plan') == 'plan';
  bool get productImages => _flag('product_images', true);
  String get cardIos => _str('card_ios', 'tap');
  String get cardAndroid => _str('card_android', 'machine');

  bool get loginPin => _flag('login_pin', true);
  bool get loginPhotos => _flag('login_photos', true);
  bool get loginNfc => _flag('login_nfc', true);
  bool get loginBiometrics => _flag('login_biometrics', true);
  bool get loginClockIn => _flag('login_clock_in', false);

  bool get idleEnabled => _flag('idle_enabled', true);
  int get idleSeconds => _int('idle_seconds', 120);
  bool get idleRequirePin => _flag('idle_require_pin', true);

  /// 0-100; 0 is off.
  int volume(GoSound s) => _int(s.key, s.byDefault);
  bool get haptics => _flag('haptics', true);

  bool get scanTableQr => _flag('scan_table_qr', true);
  bool get scanBarcode => _flag('scan_barcode', true);
  bool get scanGiftMember => _flag('scan_gift_member', true);
  bool get scanNfcTable => _flag('scan_nfc_table', true);

  List<String> get noteChips =>
      _str('note_chips', 'No ice,Well done,On the side,No salt,Extra sauce,Allergy - see note')
          .split(',')
          .map((s) => s.trim())
          .where((s) => s.isNotEmpty)
          .toList();
  bool get noteLongPress => _flag('note_long_press', true);
  bool get noteOrder => _flag('note_order', true);
  bool get allergenAlerts => _flag('allergen_alerts', true);

  bool get customerTip => _flag('customer_tip', true);
  bool get customerReceiptChoice => _flag('customer_receipt_choice', true);
  bool get customerLoyalty => _flag('customer_loyalty', true);
  bool get customerHandover => _flag('customer_handover', true);

  bool get printReceiptAuto => _flag('print_receipt_auto', false);
  bool get printAirprintFallback => _flag('print_airprint_fallback', true);
  bool get printKitchen => _flag('print_kitchen', true);

  bool get reportsClerks => _flag('reports_clerks', false);
  bool get reportsZ => _flag('reports_z', true);
  bool get reportsHourly => _flag('reports_hourly', true);
  bool get reportsStaff => _flag('reports_staff', true);
  bool get reportsProducts => _flag('reports_products', true);

  bool get allowRearrange => _flag('allow_rearrange', true);

  /// staff | managers | off: who may use Memberships, and Events & tickets.
  String get membershipsAccess => _str('memberships_access', 'managers');
  String get membershipsCancel => _str('memberships_cancel', 'managers');
  String get eventsAccess => _str('events_access', 'staff');

  /// What the sale screen shows: 'photos' (photo buttons by section) or
  /// 'till' (the till's programmed screens), per kind of device.
  String get screensPhone => _str('screens_phone', 'photos');
  String get screensTablet => _str('screens_tablet', 'till');
}

enum GoSound {
  add('sound_add', 40, 'assets/sounds/add.wav'),
  approved('sound_approved', 70, 'assets/sounds/approved.wav'),
  declined('sound_declined', 70, 'assets/sounds/declined.wav'),
  kitchenReady('sound_kitchen_ready', 70, 'assets/sounds/ready.wav'),
  allergen('sound_allergen', 60, 'assets/sounds/allergen.wav');

  const GoSound(this.key, this.byDefault, this.asset);
  final String key;
  final int byDefault;
  final String asset;
}
