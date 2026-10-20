import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/app_update.dart';

/// When a device installs its venue's version (admin.vesopa.com Versions).
void main() {
  final sha = 'a' * 64;
  Map<String, Object?> offer(Map<String, Object?> extra) =>
      {'version': '1.16.22', 'url': 'https://admin.vesopa.com/dl/1/x/a.exe', 'sha256': sha, ...extra};

  test('no "when" is the old behaviour: ask on screen', () {
    final u = AppUpdate.fromJson(offer({}))!;
    expect(u.mode, 'ask');
    expect(u.permitted, isFalse);
  });

  test('install now is permitted and due', () {
    final u = AppUpdate.fromJson(offer({'mode': 'now'}))!;
    expect(u.permitted, isTrue);
    expect(u.due, isTrue);
  });

  test('install at a time waits for it', () {
    final later = DateTime.now().toUtc().add(const Duration(hours: 3)).toIso8601String();
    final soon = AppUpdate.fromJson(offer({'mode': 'at', 'install_at': later}))!;
    expect(soon.permitted, isTrue);
    expect(soon.due, isFalse);
    final past = DateTime.now().toUtc().subtract(const Duration(minutes: 1)).toIso8601String();
    expect(AppUpdate.fromJson(offer({'mode': 'at', 'install_at': past}))!.due, isTrue);
  });

  test('an unknown mode never installs without asking', () {
    expect(AppUpdate.fromJson(offer({'mode': 'whenever'}))!.permitted, isFalse);
    expect(AppUpdate.fromJson(offer({'mode': 'at'}))!.due, isFalse);
  });

  test('a Store offer carries the time too', () {
    final u = AppUpdate.fromJson({'version': '1.16.22', 'store': true, 'store_id': '9PDMNJXNFZCW', 'mode': 'now'})!;
    expect(u.viaStore, isTrue);
    expect(u.due, isTrue);
  });

  test('force comes through only with a time to install', () {
    expect(AppUpdate.fromJson(offer({'mode': 'now', 'force': true}))!.force, isTrue);
    expect(AppUpdate.fromJson(offer({'mode': 'now'}))!.force, isFalse);
  });
}
