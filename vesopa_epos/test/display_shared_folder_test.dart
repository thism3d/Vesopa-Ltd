/// The till writes the basket where the display can actually read it.
///
/// THE FAULT THIS IS HERE FOR
///
/// A venue paired a customer display, the till said "paired", and the screen
/// then sat on adverts with "Waiting for the till" in the corner. Three
/// terminals, same result. The handshake was never the problem: it meets in
/// `%PROGRAMDATA%\Vesopa\pairing`, both applications can reach that, and the
/// grant landed every time.
///
/// The basket did not. It was written to `getApplicationSupportDirectory()`,
/// which on a Store install is virtualised into the till's own package
/// container — a folder no other package may open. The grant handed the display
/// a perfectly accurate path to a file it was not allowed to see, so the feed
/// never advanced and the display correctly reported the till as silent.
///
/// Telling the display the path could never have fixed that. The data had to
/// move to where the handshake already was.
///
/// WHAT IS CHECKED, AND WHY IT IS THE PATH RATHER THAN THE FILE
///
/// The failure is about *which folder*, so that is what is asserted. Calling
/// the real directory helper would create `C:\ProgramData\Vesopa\display\...`
/// on whoever's machine ran the suite, so the path is built by a pure function
/// and checked without touching a disk.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/customer_display.dart';

void main() {
  const programData = r'C:\ProgramData';
  const till = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  group('where the till and the display meet', () {
    test('it is under ProgramData, which both packages can open', () {
      final path = sharedDisplayPath(programData: programData, deviceId: till);

      expect(path, isNotNull);
      // Not AppData, under any spelling. That is the whole bug.
      expect(path!.toLowerCase(), isNot(contains('appdata')));
      expect(path.toLowerCase(), isNot(contains(r'\packages\')));
      expect(path, startsWith(r'C:\ProgramData\'));
    });

    test('and it sits beside the pairing folder, not somewhere new', () {
      // `display_pairing.dart` meets at %PROGRAMDATA%\Vesopa\pairing. Sharing
      // the root means one folder to find during a support call, and one folder
      // whose permissions have already been proved to work by the handshake.
      final path = sharedDisplayPath(programData: programData, deviceId: till);
      expect(path, r'C:\ProgramData\Vesopa\display\' + till);
    });

    test('two tills on one PC do not write into one basket', () {
      // ProgramData is machine-wide. Without the device id on the end, a venue
      // running two terminals from one PC would have both publishing to one
      // basket.json, each overwriting the other several times a second, and
      // both displays showing whichever counter typed last.
      final one = sharedDisplayPath(programData: programData, deviceId: till);
      final two = sharedDisplayPath(
        programData: programData,
        deviceId: '00000000000000000000000000000001',
      );
      expect(one, isNot(two));
    });
  });

  group('when there is nowhere to meet', () {
    test('a machine that is not Windows has no shared folder', () {
      // The till falls back to its own data folder. Nothing is plugged into a
      // customer display on a Mac, so there is nothing to reach it anyway.
      expect(
        sharedDisplayPath(
          programData: programData,
          deviceId: till,
          windows: false,
        ),
        isNull,
      );
    });

    test('and neither has a Windows that will not name ProgramData', () {
      expect(sharedDisplayPath(programData: null, deviceId: till), isNull);
      expect(sharedDisplayPath(programData: '', deviceId: till), isNull);
    });

    test('a till with no id yet publishes nowhere shared', () {
      // Rather than to `...\display\`, which is the folder every till on the
      // machine would then share — the exact collision the id exists to stop.
      expect(sharedDisplayPath(programData: programData, deviceId: ''), isNull);
      expect(
        sharedDisplayPath(programData: programData, deviceId: '   '),
        isNull,
      );
    });
  });
}
