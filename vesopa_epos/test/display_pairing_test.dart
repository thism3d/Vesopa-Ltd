/// The till's end of the customer-display handshake.
///
/// The display's half is written by hand here, which is the point: these tests
/// and `vesopa_epos_display/test/pairing_test.dart` are the written-down version
/// of the file format the two applications agree on, each driving the other's
/// side. A change to either end that breaks the other fails in one of the two
/// rather than on a counter.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vesopa_epos/data/display_pairing.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory folder;
  late DisplayPairing pairing;

  const basket = r'C:\ProgramData\Vesopa EPOS\display\basket.json';
  const office = 'manager@vesopa.co.uk';

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    folder = Directory.systemTemp.createTempSync('vesopa_till_pairing');
    pairing = DisplayPairing(
      folderOverride: folder.path,
      basketOverride: basket,
    );
  });

  tearDown(() {
    if (folder.existsSync()) folder.deleteSync(recursive: true);
  });

  /// The display's end: what `PairingChannel.writeRequest` writes.
  void displayAsks(
    String deviceId, {
    String code = '4821',
    String name = 'Display on TILL-1',
    Duration age = Duration.zero,
    String kind = 'display',
    int format = pairingFormat,
  }) {
    File('${folder.path}${Platform.pathSeparator}request-$deviceId.json')
        .writeAsStringSync(
          jsonEncode({
            'format': format,
            'kind': kind,
            'device_id': deviceId,
            'code': code,
            'name': name,
            'app_version': '1.6.1',
            'at': DateTime.now().subtract(age).toIso8601String(),
          }),
        );
  }

  Map<String, dynamic>? grantFor(String deviceId) {
    final file = File(
      '${folder.path}${Platform.pathSeparator}grant-$deviceId.json',
    );
    if (!file.existsSync()) return null;
    return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  }

  // ---------------------------------------------------------------------------
  // Who is asking
  // ---------------------------------------------------------------------------

  test('a screen that is asking is offered', () async {
    displayAsks('screen-one-abcdef');

    final pending = await pairing.pending();
    expect(pending, hasLength(1));
    expect(pending.single.deviceId, 'screen-one-abcdef');
    expect(pending.single.code, '4821');
    expect(pending.single.name, 'Display on TILL-1');
  });

  test('a screen that stopped asking is not offered', () async {
    // The display rewrites its request every few seconds while it is unpaired,
    // so anything this old is a screen that has been switched off. Offering it
    // would send a manager to check a display that is not there.
    displayAsks('gone-away-abcdef', age: const Duration(minutes: 5));
    expect(await pairing.pending(), isEmpty);
  });

  test('a screen already connected is not offered again', () async {
    displayAsks('screen-one-abcdef');
    await pairing.connect(
      (await pairing.pending()).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    // The request file is still there — the display deletes it on its own
    // schedule — and it must not put the screen back in the queue.
    expect(await pairing.pending(), isEmpty);
  });

  test('something that is not a display is ignored', () async {
    displayAsks('kitchen-screen-1', kind: 'kitchen');
    expect(await pairing.pending(), isEmpty);
  });

  test('a request from a newer display is left alone', () async {
    displayAsks('screen-one-abcdef', format: pairingFormat + 1);
    expect(await pairing.pending(), isEmpty);
  });

  test('one unreadable request does not hide the others', () async {
    File(
      '${folder.path}${Platform.pathSeparator}request-broken.json',
    ).writeAsStringSync('{ not json');
    displayAsks('screen-one-abcdef');

    expect(await pairing.pending(), hasLength(1));
  });

  // ---------------------------------------------------------------------------
  // Connecting
  // ---------------------------------------------------------------------------

  test('connecting hands over the path and nothing else', () async {
    displayAsks('screen-one-abcdef');
    final failure = await pairing.connect(
      (await pairing.pending()).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    expect(failure, isNull);
    final grant = grantFor('screen-one-abcdef')!;
    expect(grant['basket'], basket);
    expect(grant['terminal'], 'Bar');
    // The trading name, never the office email. The display puts this on a
    // screen a customer can read.
    expect(grant['venue'], 'The Crown');
    expect(grant.containsValue(office), isFalse);
  });

  test('a till nobody has signed in refuses to connect anything', () async {
    displayAsks('screen-one-abcdef');
    final request = (await pairing.pending()).single;

    for (final notAnOffice in ['', '   ', 'manager', 'manager@', 'a@b']) {
      expect(
        await pairing.connect(
          request,
          office: notAnOffice,
          terminalName: 'Bar',
          venueName: 'The Crown',
        ),
        PairFailure.notSignedIn,
        reason: 'office "$notAnOffice" should not commission a screen',
      );
    }
    // And nothing was written, so the screen carries on asking rather than
    // half-connecting to a till with no venue behind it.
    expect(grantFor('screen-one-abcdef'), isNull);
    expect(await pairing.paired(), isEmpty);
  });

  test('a connected screen is remembered', () async {
    displayAsks('screen-one-abcdef', name: 'Bar display');
    await pairing.connect(
      (await pairing.pending()).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    final paired = await pairing.paired();
    expect(paired, hasLength(1));
    expect(paired.single.deviceId, 'screen-one-abcdef');
    expect(paired.single.name, 'Bar display');
  });

  test('connecting the same screen twice leaves one of it', () async {
    displayAsks('screen-one-abcdef');
    final request = (await pairing.pending()).single;

    await pairing.connect(
      request,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );
    await pairing.connect(
      request,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    expect(await pairing.paired(), hasLength(1));
  });

  // ---------------------------------------------------------------------------
  // Staying connected
  // ---------------------------------------------------------------------------

  test('a till that moves rewrites the path its screens follow', () async {
    displayAsks('screen-one-abcdef');
    await pairing.connect(
      (await pairing.pending()).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );
    expect(grantFor('screen-one-abcdef')!['basket'], basket);

    // The till is reinstalled from the Store and its data folder moves. This is
    // the case the old discovery got wrong: the display would keep following
    // the folder nobody writes to any more.
    const moved = r'C:\Packages\Vesopa\LocalCache\Roaming\display\basket.json';
    await DisplayPairing(
      folderOverride: folder.path,
      basketOverride: moved,
    ).refreshGrants(
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    expect(grantFor('screen-one-abcdef')!['basket'], moved);
  });

  test('re-granting keeps the date the screen was first connected', () async {
    displayAsks('screen-one-abcdef');
    await pairing.connect(
      (await pairing.pending()).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );
    final first = grantFor('screen-one-abcdef')!['paired_at'];

    await pairing.refreshGrants(
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    expect(grantFor('screen-one-abcdef')!['paired_at'], first);
  });

  test('a till that has been signed out stops feeding its screens', () async {
    displayAsks('screen-one-abcdef');
    await pairing.connect(
      (await pairing.pending()).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    // Signed out: the office is gone. The existing grant is left where it is —
    // tearing a working screen down mid-service would be worse — but nothing is
    // refreshed, so a moved till stops dragging screens along with it.
    const moved = r'D:\Somewhere\else\basket.json';
    await DisplayPairing(
      folderOverride: folder.path,
      basketOverride: moved,
    ).refreshGrants(office: '', terminalName: 'Bar', venueName: '');

    expect(grantFor('screen-one-abcdef')!['basket'], basket);
  });

  // ---------------------------------------------------------------------------
  // Saying the till is here
  // ---------------------------------------------------------------------------

  Map<String, dynamic>? presenceFor(String deviceId) {
    final file = File(
      '${folder.path}${Platform.pathSeparator}till-$deviceId.json',
    );
    if (!file.existsSync()) return null;
    return jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  }

  test('the till says it is here, and who it is', () async {
    await pairing.announcePresence(
      deviceId: 'till-one',
      terminalName: 'Bar',
      venueName: 'The Crown',
      appVersion: '1.6.1',
      signedIn: true,
    );

    final raw = presenceFor('till-one')!;
    expect(raw['terminal'], 'Bar');
    expect(raw['venue'], 'The Crown');
    expect(raw['signed_in'], isTrue);
    // The display judges "running" by this and not by the file existing, so a
    // till that loses power stops counting on its own.
    expect(DateTime.tryParse(raw['at'] as String), isNotNull);
  });

  test('a signed-out till still says it is running', () async {
    // The two are different questions and the display answers them
    // differently: one sends somebody to start the till, the other to sign in.
    await pairing.announcePresence(
      deviceId: 'till-one',
      terminalName: 'Bar',
      venueName: '',
      appVersion: '1.6.1',
      signedIn: false,
    );

    expect(presenceFor('till-one')!['signed_in'], isFalse);
  });

  test('closing the till withdraws it', () async {
    await pairing.announcePresence(
      deviceId: 'till-one',
      terminalName: 'Bar',
      venueName: 'The Crown',
      appVersion: '1.6.1',
      signedIn: true,
    );
    await pairing.withdrawPresence('till-one');

    expect(presenceFor('till-one'), isNull);
  });

  test('withdrawing a till that never announced is not an error', () async {
    await pairing.withdrawPresence('never-ran');
  });

  // ---------------------------------------------------------------------------
  // Saying no
  // ---------------------------------------------------------------------------

  test('a declined screen stops interrupting', () async {
    displayAsks('screen-one-abcdef');
    expect(await pairing.pending(), hasLength(1));

    await pairing.decline('screen-one-abcdef');

    // The display goes on asking — it has no way to know it was refused — so
    // this is what stops the full-screen prompt coming straight back.
    expect(await pairing.pending(), isEmpty);
  });

  test('a declined screen can still be found deliberately', () async {
    // "Stop asking me" and "never connect this" are different instructions and
    // only the first one was given. The settings page still lists it.
    displayAsks('screen-one-abcdef');
    await pairing.decline('screen-one-abcdef');

    expect(await pairing.pending(includeDeclined: true), hasLength(1));
  });

  test('a screen can be offered again', () async {
    displayAsks('screen-one-abcdef');
    await pairing.decline('screen-one-abcdef');
    await pairing.allow('screen-one-abcdef');

    expect(await pairing.pending(), hasLength(1));
  });

  test('connecting a declined screen clears the decline', () async {
    displayAsks('screen-one-abcdef');
    await pairing.decline('screen-one-abcdef');

    await pairing.connect(
      (await pairing.pending(includeDeclined: true)).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    // Otherwise disconnecting it later would leave a screen that never asks
    // again, for a reason nobody could find.
    expect(await pairing.declined(), isEmpty);
  });

  test('declining one screen does not silence another', () async {
    displayAsks('screen-one-abcdef', code: '1111');
    displayAsks('screen-two-abcdef', code: '2222');

    await pairing.decline('screen-one-abcdef');

    final pending = await pairing.pending();
    expect(pending, hasLength(1));
    expect(pending.single.code, '2222');
  });

  // ---------------------------------------------------------------------------
  // Letting go
  // ---------------------------------------------------------------------------

  test('disconnecting removes the grant as well as the memory', () async {
    displayAsks('screen-one-abcdef');
    await pairing.connect(
      (await pairing.pending()).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    await pairing.forget('screen-one-abcdef');

    // Both halves. A screen that kept working after it was disconnected is the
    // worst of both: the manager thinks it is off and it is showing bills.
    expect(await pairing.paired(), isEmpty);
    expect(grantFor('screen-one-abcdef'), isNull);
  });

  test('a disconnected screen can ask again', () async {
    displayAsks('screen-one-abcdef');
    await pairing.connect(
      (await pairing.pending()).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );
    await pairing.forget('screen-one-abcdef');

    displayAsks('screen-one-abcdef');
    expect(await pairing.pending(), hasLength(1));
  });

  test('renaming a screen moves the entry rather than adding one', () async {
    displayAsks('screen-one-abcdef', name: 'Display on TILL-1');
    await pairing.connect(
      (await pairing.pending()).single,
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    await pairing.rename('screen-one-abcdef', 'Front counter');

    final paired = await pairing.paired();
    expect(paired, hasLength(1));
    expect(paired.single.name, 'Front counter');
  });

  test('two screens on one counter are both connected separately', () async {
    displayAsks('screen-one-abcdef', code: '1111', name: 'Left');
    displayAsks('screen-two-abcdef', code: '2222', name: 'Right');

    final pending = await pairing.pending();
    expect(pending, hasLength(2));

    await pairing.connect(
      pending.firstWhere((r) => r.code == '1111'),
      office: office,
      terminalName: 'Bar',
      venueName: 'The Crown',
    );

    expect(await pairing.paired(), hasLength(1));
    // The other one is still asking, which is what lets a venue connect them
    // one at a time and check each screen as it lights up.
    expect((await pairing.pending()).single.code, '2222');
  });
}
