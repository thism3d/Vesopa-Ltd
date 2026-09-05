/// The files the till leaves for the customer display, as it really writes them.
///
/// WHY THIS TEST AND THE DISPLAY'S ONE ARE A PAIR
///
/// The two applications are separate packages that cannot import each other,
/// and everything they say to each other is three small JSON files in
/// `%PROGRAMDATA%\Vesopa`. Until now each side had tests that wrote the *other*
/// side's files by hand — which is a test of a fixture, not of a contract, and
/// is exactly why a change could pass both suites and still leave a display
/// showing adverts at a venue.
///
/// So: this test drives the till's real [DisplayPairing] and writes what it
/// actually writes into `docs/pairing-contract/`. The display's
/// `pairing_contract_test.dart` reads those same files with its real parser. A
/// change to either end that the other cannot follow now fails one of the two.
///
/// REGENERATING
///
///     cd vesopa_epos && flutter test test/pairing_contract_test.dart \
///       --dart-define=REWRITE_PAIRING_CONTRACT=true
///
/// Do that only when the format is deliberately changing, then run the display's
/// suite — if it goes red, the change is one the display cannot read and the
/// venue would have found out instead.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/customer_display.dart';
import 'package:vesopa_epos/data/display_pairing.dart';

/// Where both packages meet. Relative to the package root, which is what
/// `flutter test` makes the working directory.
const contractDir = '../docs/pairing-contract';

/// Fixed so the files are stable between runs and a diff is readable.
const displayDevice = 'd15p1ay000000000000000000000001';
const tillDevice = 't111000000000000000000000000001';
const pairedAt = '2026-09-05T18:30:00.000';

/// The basket path the till hands over.
///
/// A real Windows one, and deliberately under ProgramData: that is the whole of
/// the fix this contract exists to hold. A path under AppData would be a path
/// the display is not allowed to open — see `data/customer_display.dart`.
const basketPath =
    r'C:\ProgramData\Vesopa\display\t111000000000000000000000000001\basket.json';

const _rewrite = bool.fromEnvironment('REWRITE_PAIRING_CONTRACT');

void main() {
  late Directory folder;

  setUp(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    SharedPreferences.setMockInitialValues({});
    folder = await Directory.systemTemp.createTemp('vesopa-pairing-contract');
    addTearDown(() async {
      if (folder.existsSync()) await folder.delete(recursive: true);
    });
  });

  /// Read one file the till has just written.
  Map<String, Object?> written(String name) {
    final file = File('${folder.path}${Platform.pathSeparator}$name');
    expect(file.existsSync(), isTrue, reason: '$name was never written');
    return jsonDecode(file.readAsStringSync()) as Map<String, Object?>;
  }

  /// Compare against the committed contract, or rewrite it when asked.
  ///
  /// Timestamps are dropped before comparing. They are the one part that must
  /// differ between runs — the display judges a till "running" by how fresh its
  /// presence is — so holding them fixed would test a clock rather than a
  /// format.
  void agreesWithContract(String name, Map<String, Object?> actual) {
    // `paired_at` is stamped with DateTime.now() inside `connect`, so it is as
    // volatile as the other two — see the note above about testing a clock.
    const volatile = {'updated_at', 'at', 'paired_at'};
    final stable = {
      for (final entry in actual.entries)
        if (!volatile.contains(entry.key)) entry.key: entry.value,
    };
    final pretty = const JsonEncoder.withIndent('  ').convert(stable);

    final file = File('$contractDir/$name');
    if (_rewrite) {
      file.parent.createSync(recursive: true);
      file.writeAsStringSync('$pretty\n');
      return;
    }

    expect(
      file.existsSync(),
      isTrue,
      reason:
          '$contractDir/$name is missing. Regenerate it with '
          '--dart-define=REWRITE_PAIRING_CONTRACT=true, then run the display '
          "package's suite to check it can still read it.",
    );
    expect(
      jsonDecode(file.readAsStringSync()),
      jsonDecode(pretty),
      reason:
          'The till now writes $name differently from the committed contract. '
          'If that is deliberate, regenerate it and make sure the display can '
          'still read it — that is the check this pair of tests exists for.',
    );
  }

  // ---------------------------------------------------------------------------
  // The till says it is here
  // ---------------------------------------------------------------------------

  test('the presence file says who the till is and whether anyone is on it', () async {
    final pairing = DisplayPairing(folderOverride: folder.path);
    await pairing.announcePresence(
      deviceId: tillDevice,
      terminalName: 'Bar',
      venueName: 'The Bridge Llangennech',
      appVersion: '1.6.3',
      signedIn: true,
    );

    final json = written('till-$tillDevice.json');

    // The trading name, never the office email — the display puts this on a
    // screen a customer can see.
    expect(json['venue'], 'The Bridge Llangennech');
    expect(json['terminal'], 'Bar');
    expect(json['signed_in'], isTrue);
    expect(json['device_id'], tillDevice);
    // Freshness is how the display tells "running" from "closed last night", so
    // the stamp has to be there and has to parse.
    expect(DateTime.tryParse('${json['at']}'), isNotNull);

    agreesWithContract('till-presence.json', json);
  });

  // ---------------------------------------------------------------------------
  // The till grants a screen
  // ---------------------------------------------------------------------------

  test('the grant hands over a basket path under ProgramData', () async {
    final pairing = DisplayPairing(
      folderOverride: folder.path,
      basketOverride: basketPath,
    );

    final failure = await pairing.connect(
      DisplayPairRequest(
        deviceId: displayDevice,
        name: 'Display on TILL-01',
        code: '4821',
        appVersion: '1.6.3',
        at: DateTime.parse(pairedAt),
      ),
      office: 'the-bridge@vesopa.co.uk',
      terminalName: 'Bar',
      venueName: 'The Bridge Llangennech',
    );
    expect(failure, isNull, reason: 'connect refused: $failure');

    final json = written('grant-$displayDevice.json');

    expect(json['device_id'], displayDevice);
    expect(json['terminal'], 'Bar');
    expect(json['venue'], 'The Bridge Llangennech');

    // The fault this whole contract exists for. A basket under AppData is a
    // path the display is not allowed to open on a Store install, and handing
    // one over is what left a venue paired and showing adverts.
    final basket = '${json['basket']}';
    expect(basket, isNotEmpty);
    expect(
      basket.toLowerCase(),
      isNot(contains('appdata')),
      reason: 'the grant points into a folder the display cannot open',
    );
    expect(basket.toLowerCase(), contains('programdata'));

    agreesWithContract('grant.json', json);
  });

  test('and it refuses a till that has not been signed in', () async {
    // A display is registered against the office it belongs to. Pairing first
    // and sorting the account out later would mean a device row owned by
    // nobody.
    final pairing = DisplayPairing(
      folderOverride: folder.path,
      basketOverride: basketPath,
    );
    final failure = await pairing.connect(
      DisplayPairRequest(
        deviceId: displayDevice,
        name: 'Display on TILL-01',
        code: '4821',
        appVersion: '1.6.3',
        at: DateTime.parse(pairedAt),
      ),
      office: '',
      terminalName: 'Bar',
      venueName: 'The Bridge Llangennech',
    );
    expect(failure, PairFailure.notSignedIn);
    expect(
      File('${folder.path}${Platform.pathSeparator}grant-$displayDevice.json')
          .existsSync(),
      isFalse,
      reason: 'a refused pairing still wrote a grant',
    );
  });

  // ---------------------------------------------------------------------------
  // Where the basket actually goes
  // ---------------------------------------------------------------------------

  test('the real basket path is the shared folder, not the till\'s own', () {
    // Asserted on the pure function so no folder is created on whoever's
    // machine runs the suite. `customerDisplayDirectory` builds exactly this.
    final path = sharedDisplayPath(
      programData: r'C:\ProgramData',
      deviceId: tillDevice,
    );
    expect(path, r'C:\ProgramData\Vesopa\display\' + tillDevice);

    // And it sits beside the handshake, which is what makes the permissions
    // already proven: the pairing folder has been readable and writable by both
    // packages for as long as pairing has worked.
    expect(path, startsWith(r'C:\ProgramData\Vesopa\'));
  });
}
