/// The display reads what the till actually writes.
///
/// The other half of `vesopa_epos/test/pairing_contract_test.dart`. That one
/// drives the till's real [DisplayPairing] and commits the files it produces to
/// `docs/pairing-contract/`; this one reads those same files with this
/// application's real parser and pairing ladder.
///
/// WHY IT IS DONE THIS WAY
///
/// The two applications are separate packages and cannot import each other.
/// Everything they say to each other is three small JSON files, and until now
/// each side's tests wrote the *other* side's files by hand — a test of a
/// fixture rather than of a contract. Both suites could be green while a venue
/// sat looking at a paired display showing adverts, because the till was
/// writing something the display could not follow.
///
/// Now a format change on either side fails one of these two. That is the whole
/// point of it.
///
/// If this test goes red after a deliberate change to the till, the change is
/// one the display cannot read — and the venue would have found that out
/// instead of the suite.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos_display/data/pairing.dart';

/// Where both packages meet, relative to this package's root.
const contractDir = '../docs/pairing-contract';

/// The display this contract was cut for. Must match the till's test.
const displayDevice = 'd15p1ay000000000000000000000001';
const tillDevice = 't111000000000000000000000000001';

void main() {
  late Directory folder;

  /// The committed contract, with a stamp of `age` ago put back on it.
  ///
  /// The till's test strips timestamps before committing, because they must
  /// differ between runs. The display judges a till "running" by exactly that
  /// freshness, so a stamp has to be put back before the ladder means anything
  /// — and being able to choose it is what lets the tests below tell a till
  /// that is on from one closed last night.
  Map<String, Object?> contract(String name, {Duration age = Duration.zero}) {
    final file = File('$contractDir/$name');
    expect(
      file.existsSync(),
      isTrue,
      reason:
          '$contractDir/$name is missing. It is produced by the till package: '
          'cd vesopa_epos && flutter test test/pairing_contract_test.dart '
          '--dart-define=REWRITE_PAIRING_CONTRACT=true',
    );
    final json = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
    final stamp = DateTime.now().subtract(age).toIso8601String();
    return {...json, 'at': stamp, 'updated_at': stamp, 'paired_at': stamp};
  }

  void place(String name, Map<String, Object?> json) {
    File('${folder.path}${Platform.pathSeparator}$name')
        .writeAsStringSync(jsonEncode(json));
  }

  setUp(() async {
    folder = await Directory.systemTemp.createTemp('vesopa-display-contract');
    addTearDown(() async {
      if (folder.existsSync()) await folder.delete(recursive: true);
    });
  });

  PairingChannel channelHere() => PairingChannel(folderOverride: folder.path);

  // ---------------------------------------------------------------------------
  // The till's presence
  // ---------------------------------------------------------------------------

  group('the presence file the till writes', () {
    test('is read, and names the till', () {
      place('till-$tillDevice.json', contract('till-presence.json'));

      final till = channelHere().readTillPresence();
      expect(till, isNotNull, reason: 'the display could not read the presence');
      expect(till!.terminalName, 'Bar');
      expect(till.venueName, 'The Bridge Llangennech');
      expect(till.signedIn, isTrue);
      expect(till.isRunning, isTrue);
    });

    test('and a till closed last night is not running', () {
      // Three heartbeats old. The whole reason the display judges by the stamp
      // rather than by the file existing: a till that lost power says nothing.
      place(
        'till-$tillDevice.json',
        contract('till-presence.json', age: const Duration(minutes: 5)),
      );

      final till = channelHere().readTillPresence();
      expect(till, isNotNull);
      expect(till!.isRunning, isFalse);
    });
  });

  // ---------------------------------------------------------------------------
  // The grant
  // ---------------------------------------------------------------------------

  group('the grant the till writes', () {
    test('is read, and carries a basket the display may actually open', () {
      place('grant-$displayDevice.json', contract('grant.json'));

      final grant = channelHere().readGrant(displayDevice);
      expect(grant, isNotNull, reason: 'the display could not read the grant');
      expect(grant!.terminalName, 'Bar');
      expect(grant.venueName, 'The Bridge Llangennech');

      // The fault this contract exists for, checked from the reading end. A
      // basket under AppData is a path this application is not allowed to open
      // on a Store install — the till would be writing, the display watching,
      // and neither of them wrong about anything except where to meet.
      expect(grant.basketPath, isNotEmpty);
      expect(grant.basketPath.toLowerCase(), isNot(contains('appdata')));
      expect(grant.basketPath.toLowerCase(), contains('programdata'));
    });

    test('and its folder is where settings and status live too', () {
      // `control.dart` derives both from the basket's parent, so a grant that
      // named a basket in one place and settings in another would be a display
      // that shows bills and ignores every instruction.
      place('grant-$displayDevice.json', contract('grant.json'));

      final grant = channelHere().readGrant(displayDevice)!;
      expect(grant.folder, File(grant.basketPath).parent.path);
      expect(grant.folder.toLowerCase(), contains('programdata'));
    });

    test('a grant for another screen is not this screen\'s', () {
      // Two displays on one counter each read their own file. Reading the wrong
      // one would put the other screen's till on this one.
      place('grant-$displayDevice.json', contract('grant.json'));
      expect(channelHere().readGrant('some-other-display'), isNull);
    });
  });

  // ---------------------------------------------------------------------------
  // The ladder, end to end
  // ---------------------------------------------------------------------------

  group('what the screen shows', () {
    test('a running signed-in till and no grant means: here is a code', () {
      place('till-$tillDevice.json', contract('till-presence.json'));

      final identity = PairingIdentity.forDevice(displayDevice);
      final channel = channelHere();

      expect(channel.readGrant(identity.deviceId), isNull);
      final till = channel.readTillPresence();
      expect(till?.isRunning, isTrue);
      expect(till?.signedIn, isTrue);
      // Which is `PairingStage.waiting` — the state that draws the four digits.
      expect(identity.code, hasLength(4));
    });

    test('a till nobody has signed in is not asked for a code', () {
      final presence = contract('till-presence.json');
      place('till-$tillDevice.json', {...presence, 'signed_in': false});

      final till = channelHere().readTillPresence();
      expect(till!.isRunning, isTrue);
      expect(till.signedIn, isFalse);
    });

    test('and once the grant lands the screen follows the till', () {
      place('till-$tillDevice.json', contract('till-presence.json'));
      place('grant-$displayDevice.json', contract('grant.json'));

      final channel = channelHere();
      final grant = channel.readGrant(displayDevice);
      expect(grant, isNotNull);

      // The state the venue never reached: paired, with somewhere real to
      // watch.
      expect(grant!.basketPath, isNotEmpty);
      expect(channel.readTillPresence()?.isRunning, isTrue);
    });
  });

  // ---------------------------------------------------------------------------
  // The display's own half of the handshake
  // ---------------------------------------------------------------------------

  test('the request this screen writes is one the till can read back', () async {
    // The other direction. The till lists these to offer a manager a screen to
    // connect, and a request it cannot parse is a display that can never be
    // paired however long somebody stands in front of it.
    final channel = channelHere();
    await channel.writeRequest(
      identity: PairingIdentity.forDevice(displayDevice),
      name: 'Display on TILL-01',
      appVersion: '1.6.3',
    );

    final file = File(
      '${folder.path}${Platform.pathSeparator}request-$displayDevice.json',
    );
    expect(file.existsSync(), isTrue, reason: 'no request was written');

    final json = jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
    // The fields the till's `DisplayPairRequest.fromJson` requires.
    expect(json['device_id'], displayDevice);
    expect(json['name'], 'Display on TILL-01');
    expect('${json['code']}', hasLength(4));
    expect(DateTime.tryParse('${json['at']}'), isNotNull);
    expect(json['format'], pairingFormat);
  });
}
