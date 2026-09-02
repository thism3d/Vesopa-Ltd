/// The handshake, driven from both ends.
///
/// The display's half is the code under test; the till's half is written by
/// hand here, which is the point — these tests are the written-down version of
/// the file format the two applications agree on, and a change to either end
/// that breaks the other should fail here rather than on a counter.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_display/data/pairing.dart';

void main() {
  late Directory folder;
  late PairingChannel channel;

  setUp(() {
    folder = Directory.systemTemp.createTempSync('vesopa_pairing_test');
    channel = PairingChannel(folderOverride: folder.path);
  });

  tearDown(() {
    if (folder.existsSync()) folder.deleteSync(recursive: true);
  });

  /// The till's end: what `DisplayPairing.grant` writes.
  void tillGrants(
    String deviceId, {
    String basket = r'C:\ProgramData\Till\display\basket.json',
    String terminal = 'Bar',
    String venue = 'The Crown',
    int format = pairingFormat,
  }) {
    File('${folder.path}\\grant-$deviceId.json').writeAsStringSync(
      jsonEncode({
        'format': format,
        'device_id': deviceId,
        'basket': basket,
        'terminal': terminal,
        'venue': venue,
        'paired_at': DateTime.now().toIso8601String(),
      }),
    );
  }

  const identity = PairingIdentity(deviceId: 'abc123def456', code: '0000');

  // ---------------------------------------------------------------------------
  // Asking
  // ---------------------------------------------------------------------------

  test('a request names the screen and carries its code', () async {
    await channel.writeRequest(
      identity: identity,
      name: 'Display on TILL-1',
      appVersion: '1.6.1',
    );

    final raw =
        jsonDecode(
              File(
                '${folder.path}\\request-${identity.deviceId}.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;

    expect(raw['kind'], 'display');
    expect(raw['device_id'], identity.deviceId);
    expect(raw['code'], identity.code);
    expect(raw['name'], 'Display on TILL-1');
    // The till uses this to ignore a screen that was switched off days ago.
    expect(DateTime.tryParse(raw['at'] as String), isNotNull);
  });

  test('the request folder is created rather than assumed', () async {
    // A display can be the first of the two applications to start, on a machine
    // where nothing has ever written to ProgramData.
    final fresh = Directory('${folder.path}\\not-there-yet');
    expect(fresh.existsSync(), isFalse);

    await PairingChannel(folderOverride: fresh.path).writeRequest(
      identity: identity,
      name: 'Display',
      appVersion: '1.6.1',
    );

    expect(fresh.existsSync(), isTrue);
  });

  // ---------------------------------------------------------------------------
  // Being answered
  // ---------------------------------------------------------------------------

  test('no grant is not an error, it is a screen nobody has connected', () {
    expect(channel.readGrant(identity.deviceId), isNull);
  });

  test('a grant is followed exactly as the till wrote it', () {
    tillGrants(identity.deviceId, basket: r'D:\Vesopa\display\basket.json');

    final pairing = channel.readGrant(identity.deviceId)!;
    // Not normalised, not re-derived, not checked against a folder this
    // application worked out for itself. That guessing is the entire fault this
    // handshake exists to remove.
    expect(pairing.basketPath, r'D:\Vesopa\display\basket.json');
    expect(pairing.terminalName, 'Bar');
    expect(pairing.venueName, 'The Crown');
    expect(pairing.folder, r'D:\Vesopa\display');
  });

  test('a grant for another screen is not this screen s', () {
    tillGrants('someone-else');
    expect(channel.readGrant(identity.deviceId), isNull);
  });

  test('a grant from a newer till is left alone', () {
    tillGrants(identity.deviceId, format: pairingFormat + 1);
    // Half-understanding a shape that has changed would put an unknown file on
    // a screen the public can read.
    expect(channel.readGrant(identity.deviceId), isNull);
  });

  test('a grant with no basket in it is not a pairing', () {
    File('${folder.path}\\grant-${identity.deviceId}.json').writeAsStringSync(
      jsonEncode({'format': pairingFormat, 'terminal': 'Bar'}),
    );
    expect(channel.readGrant(identity.deviceId), isNull);
  });

  test('an unreadable grant is a screen that is not paired, not a crash', () {
    File(
      '${folder.path}\\grant-${identity.deviceId}.json',
    ).writeAsStringSync('{ not json at all');
    expect(channel.readGrant(identity.deviceId), isNull);
  });

  test('a till that moves takes its display with it', () {
    tillGrants(identity.deviceId, basket: r'C:\Old\display\basket.json');
    expect(channel.readGrant(identity.deviceId)!.basketPath, contains('Old'));

    // The till is reinstalled from the Store and rewrites the grant on its next
    // start. Nobody sets anything up again.
    tillGrants(identity.deviceId, basket: r'C:\New\display\basket.json');
    expect(channel.readGrant(identity.deviceId)!.basketPath, contains('New'));
  });

  // ---------------------------------------------------------------------------
  // Letting go
  // ---------------------------------------------------------------------------

  test('clearing the request leaves the grant alone', () async {
    await channel.writeRequest(
      identity: identity,
      name: 'Display',
      appVersion: '1.6.1',
    );
    tillGrants(identity.deviceId);

    await channel.clearRequest(identity.deviceId);

    expect(
      File('${folder.path}\\request-${identity.deviceId}.json').existsSync(),
      isFalse,
    );
    expect(channel.readGrant(identity.deviceId), isNotNull);
  });

  test('forgetting removes both halves', () async {
    await channel.writeRequest(
      identity: identity,
      name: 'Display',
      appVersion: '1.6.1',
    );
    tillGrants(identity.deviceId);

    await channel.forget(identity.deviceId);

    expect(channel.readGrant(identity.deviceId), isNull);
    expect(
      File('${folder.path}\\request-${identity.deviceId}.json').existsSync(),
      isFalse,
    );
  });

  test('forgetting a screen that was never paired is not an error', () async {
    await channel.forget('never-seen');
  });

  // ---------------------------------------------------------------------------
  // Is the till there at all?
  // ---------------------------------------------------------------------------

  /// The till's end: what `DisplayPairing.announcePresence` writes.
  void tillIsHere({
    String deviceId = 'till-one',
    String terminal = 'Bar',
    bool signedIn = true,
    Duration ago = Duration.zero,
  }) {
    File('${folder.path}\\till-$deviceId.json').writeAsStringSync(
      jsonEncode({
        'format': pairingFormat,
        'device_id': deviceId,
        'terminal': terminal,
        'venue': 'The Crown',
        'app_version': '1.6.1',
        'signed_in': signedIn,
        'at': DateTime.now().subtract(ago).toIso8601String(),
      }),
    );
  }

  test('no till has said anything', () {
    // Which is not the same as "no till installed" — that question is answered
    // separately, and only because this one came back empty.
    expect(channel.readTillPresence(), isNull);
  });

  test('a running till is read, and says who it is', () {
    tillIsHere(terminal: 'Front counter');

    final till = channel.readTillPresence()!;
    expect(till.terminalName, 'Front counter');
    expect(till.venueName, 'The Crown');
    expect(till.signedIn, isTrue);
    expect(till.isRunning, isTrue);
  });

  test('a till closed last night is not running', () {
    // The file is still there — a till that loses power never gets to delete
    // it — so freshness is what decides, not existence.
    tillIsHere(ago: const Duration(hours: 9));

    final till = channel.readTillPresence()!;
    expect(till.isRunning, isFalse);
  });

  test('a till mid-hiccup is still running', () {
    // One missed heartbeat is a busy machine, not a closed till. Reporting it
    // as off would put a setup card in front of customers mid-service.
    tillIsHere(ago: const Duration(seconds: 7));
    expect(channel.readTillPresence()!.isRunning, isTrue);
  });

  test('a till nobody has signed in says so', () {
    // The display has to tell this apart from "not running": one means go and
    // start the till, the other means go and sign in.
    tillIsHere(signedIn: false);

    final till = channel.readTillPresence()!;
    expect(till.isRunning, isTrue);
    expect(till.signedIn, isFalse);
  });

  test('with two tills on one PC, the freshest is the one to ask', () {
    tillIsHere(deviceId: 'old', terminal: 'Office', ago: const Duration(minutes: 5));
    tillIsHere(deviceId: 'new', terminal: 'Bar');

    expect(channel.readTillPresence()!.terminalName, 'Bar');
  });

  test('a signed-in till beats a signed-out one', () {
    tillIsHere(deviceId: 'out', terminal: 'Office', signedIn: false);
    tillIsHere(deviceId: 'in', terminal: 'Bar');

    // The one that can actually answer a request.
    expect(channel.readTillPresence()!.terminalName, 'Bar');
  });

  test('an unreadable presence file does not hide a good one', () {
    File('${folder.path}\\till-broken.json').writeAsStringSync('{ nope');
    tillIsHere(terminal: 'Bar');

    expect(channel.readTillPresence()!.terminalName, 'Bar');
  });

  test('a presence from a newer till is left alone', () {
    File('${folder.path}\\till-future.json').writeAsStringSync(
      jsonEncode({
        'format': pairingFormat + 1,
        'terminal': 'Bar',
        'at': DateTime.now().toIso8601String(),
      }),
    );
    expect(channel.readTillPresence(), isNull);
  });

  // ---------------------------------------------------------------------------
  // The code
  // ---------------------------------------------------------------------------

  test('a code is four digits and always the same for one screen', () {
    final code = PairingIdentity.codeFor('abc123def456');
    expect(code, hasLength(4));
    expect(int.tryParse(code), isNotNull);
    expect(PairingIdentity.codeFor('abc123def456'), code);
  });

  test('two screens on one counter do not show the same code', () {
    // The only job the code has. A venue mounting two displays has to be able
    // to tell the till which one it is connecting.
    expect(
      PairingIdentity.codeFor('aaaaaaaaaaaaaaaa'),
      isNot(PairingIdentity.codeFor('bbbbbbbbbbbbbbbb')),
    );
  });
}
