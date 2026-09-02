/// Telling the back office which machines this venue has.
///
/// One POST, carrying this till and every customer display paired to it. The
/// server keeps one row per machine — see `vesopa_server/src/devices.js` and
/// `schema_devices.sql` — so a manager can open the back office and see what is
/// actually plugged in, rather than ringing the venue to ask.
///
/// WHY THE TILL SENDS THE DISPLAY'S ROW
///
/// The customer display has no network capability at all. That is deliberate:
/// its Store package declares none, because a screen pointed at the public that
/// reads one local file has no business reaching the internet. So it cannot
/// register itself, and it should not be given the ability to.
///
/// It does not need to. A display is paired to a till on the same PC, and the
/// till is commissioned and already talking to the server. The till sends what
/// it is paired with, which has a second useful property: a display can only
/// appear in a venue whose till accepted it. The pairing *is* the
/// authorisation.
///
/// AUTHENTICATED WITH THE TERMINAL TOKEN
///
/// Not the public `?office=` routes the catalogue sync uses. This writes rows
/// that say what hardware a venue has and who is signed into it, and knowing a
/// venue's contact email must not be enough to add one.
///
/// EVERY FAILURE IS SWALLOWED. A till whose registration does not land carries
/// on selling and its display carries on showing bills; the only thing lost is
/// a row on a screen somebody looks at once a month, and the next start
/// corrects it. Nothing in this file may throw into a sale.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'display_pairing.dart';

/// How often a running till says it is still here.
///
/// Ten minutes. The back office calls a machine stale after three, so this is
/// well inside that with room for one call to fail — and it is quiet enough
/// that a venue with four tills is not generating a request a second between
/// them for something nobody is watching in real time.
const deviceHeartbeat = Duration(minutes: 10);

/// One machine, as the back office records it.
class DeviceRecord {
  const DeviceRecord({
    required this.deviceId,
    required this.kind,
    required this.name,
    this.appVersion,
    this.signedInAs,
    this.pairedTo,
  });

  final String deviceId;

  /// 'till' | 'display' | 'kitchen'. Free text at the far end on purpose, so a
  /// kind invented in a later release reaches an older server and is recorded
  /// rather than refused.
  final String kind;

  final String name;
  final String? appVersion;

  /// The back-office account this machine was commissioned under.
  final String? signedInAs;

  /// For a display: the till it is paired to, by name. Carried into the log
  /// line so "which till was that screen on" is answerable a year later.
  final String? pairedTo;

  Map<String, Object?> toJson() => {
    'device_id': deviceId,
    'kind': kind,
    'name': name,
    'app_version': appVersion,
    'signed_in_as': signedInAs,
    'paired_to': pairedTo,
  };
}

class DeviceRegistry {
  DeviceRegistry({
    required this.apiBase,
    required this.terminalToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String apiBase;

  /// Null on a terminal commissioned before terminal tokens existed. Such a
  /// till registers nothing rather than falling back to an unauthenticated
  /// route — there is no unauthenticated route, and there should not be.
  final String? terminalToken;

  final http.Client _client;

  /// Whether this till can register anything at all.
  bool get canRegister => (terminalToken ?? '').isNotEmpty;

  /// Send this till and its screens.
  ///
  /// Returns whether the server took them. The answer is used only to decide
  /// what a settings screen says; nothing retries on it, because the heartbeat
  /// is the retry.
  Future<bool> register(List<DeviceRecord> devices) async {
    final token = terminalToken;
    if (token == null || token.isEmpty || devices.isEmpty) return false;

    try {
      final res = await _client
          .post(
            Uri.parse('$apiBase/till/devices'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: jsonEncode({
              'devices': [for (final device in devices) device.toJson()],
            }),
          )
          .timeout(const Duration(seconds: 10));
      return res.statusCode == 200;
    } catch (_) {
      // Offline, or a server that has not been deployed with this route yet.
      // Both are a venue whose device list is a little out of date.
      return false;
    }
  }

  /// Say that a machine has gone.
  ///
  /// Marks it offline rather than removing it: "this venue has a display and it
  /// is not switched on" is a more useful thing for a manager to read than the
  /// display not being listed, because a machine that vanishes from a list
  /// looks like a machine nobody ever had.
  Future<bool> offline(String deviceId, {String event = 'disconnected'}) async {
    final token = terminalToken;
    if (token == null || token.isEmpty) return false;

    try {
      final res = await _client
          .post(
            Uri.parse('$apiBase/till/devices/$deviceId/offline'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: jsonEncode({'event': event}),
          )
          .timeout(const Duration(seconds: 6));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }
}

/// Everything this till would tell the back office about itself right now.
///
/// Assembled here rather than in the UI so the shell's start-up call and the
/// customer display settings page send the same shape — a device list that
/// disagreed with itself depending on which screen last wrote it would be worse
/// than no list.
List<DeviceRecord> describeDevices({
  required String terminalDeviceId,
  required String terminalName,
  required String appVersion,
  required String? signedInAs,
  required List<PairedDisplay> displays,
}) => [
  DeviceRecord(
    deviceId: terminalDeviceId,
    kind: 'till',
    name: terminalName,
    appVersion: appVersion,
    signedInAs: signedInAs,
  ),
  for (final display in displays)
    DeviceRecord(
      deviceId: display.deviceId,
      kind: 'display',
      name: display.name,
      signedInAs: signedInAs,
      pairedTo: terminalName,
    ),
];
