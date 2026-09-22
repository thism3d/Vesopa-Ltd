// Pins the shape of the environment switch. The URLs a till talks to are not
// something to discover at a customer-facing moment, and a typo here points an
// entire estate at the wrong server.
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/config/constants.dart';

void main() {
  group('live environment', () {
    test('points at the back office over TLS', () {
      expect(liveServer.apiBase, 'https://backoffice.vesopaepos.com');
      expect(liveServer.wsUrl, 'wss://backoffice.vesopaepos.com/ws');
    });

    test('never names the default port', () {
      // "https://host:443" is legal but wrong-looking, and some proxies and
      // certificate checks treat it differently from the bare host.
      expect(liveServer.apiBase, isNot(contains(':443')));
      expect(liveServer.apiBase, isNot(endsWith('/')));
    });

    test('uses a secure socket, matching the HTTP scheme', () {
      // A plain ws:// socket opened from an https:// origin is refused as mixed
      // content, which would break sync while REST kept working — a confusing
      // half-failure.
      expect(liveServer.secure, isTrue);
      expect(liveServer.wsUrl, startsWith('wss://'));
    });
  });

  group('local environment', () {
    test('uses the port the dev server actually listens on', () {
      // vesopa_server/.env sets PORT=5060. This was 4000 in main.dart, which
      // meant a default local build talked to a dead port.
      expect(localServer.port, 5060);
      expect(localServer.apiBase, contains(':5060'));
    });

    test('is plaintext, and its socket agrees', () {
      expect(localServer.secure, isFalse);
      expect(localServer.apiBase, startsWith('http://'));
      expect(localServer.wsUrl, startsWith('ws://'));
    });
  });

  group('the switch', () {
    test('selects one environment and they are genuinely different', () {
      expect(server.apiBase, useLiveServer ? liveServer.apiBase : localServer.apiBase);
      expect(liveServer.apiBase, isNot(localServer.apiBase));
    });

    test('defaults to live, so a build with no define ships to production', () {
      // If this ever fails, someone has flipped the default. That is a
      // deliberate act and the test should be updated deliberately too. A
      // developer working locally must now pass
      // --dart-define=USE_LIVE_SERVER=false explicitly.
      expect(useLiveServer, isTrue,
          reason: 'default build should target the live server');
      expect(Api.isLive, isTrue);
      expect(Api.base, liveServer.apiBase);
    });
  });

  group('brand constants', () {
    test('phone and WhatsApp are dialable, not display-formatted', () {
      // 'tel:' and wa.me both need digits without spaces; a pretty-printed
      // number silently fails to dial.
      expect(VesopaBrand.phone, matches(RegExp(r'^\+\d{10,15}$')));
      expect(VesopaBrand.whatsAppNumber, matches(RegExp(r'^\d{10,15}$')));
    });

    test('the WhatsApp link carries the agreed prefilled message', () {
      expect(VesopaBrand.whatsAppUrl, contains(VesopaBrand.whatsAppNumber));
      expect(VesopaBrand.whatsAppUrl, contains('text='));
    });

    test('every web link is absolute https', () {
      for (final url in [
        VesopaBrand.website,
        VesopaBrand.websiteAlt,
        VesopaBrand.linkedIn,
        VesopaBrand.x,
      ]) {
        expect(url, startsWith('https://'), reason: url);
      }
    });
  });

  group('print constants', () {
    test('roll widths are the two real thermal sizes', () {
      expect(PrintConstants.wideRollMm, 80);
      expect(PrintConstants.narrowRollMm, 58);
      expect(
        PrintConstants.defaultRollMm,
        anyOf(PrintConstants.wideRollMm, PrintConstants.narrowRollMm),
      );
    });
  });
}
