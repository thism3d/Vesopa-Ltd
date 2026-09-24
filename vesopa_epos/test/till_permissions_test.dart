/// What a member of staff may do at the counter.
///
/// The rule that matters more than any of the others is the one about absence.
/// Every member of staff at every venue trading today has no permission group,
/// because groups did not exist until this shipped — so an empty column has to
/// keep meaning "every key". A default of "no keys" would present as the whole
/// country losing the ability to process a refund on the morning of an update,
/// and nobody would find out until a customer asked for their money back.
///
/// The second is about failure. A till that could not read a permissions blob
/// must not answer by refusing everything: the failure would arrive mid-service
/// as every key going dead at once, for a reason nobody at the counter can see
/// or fix. Unreadable is treated exactly as absent.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/till_permissions.dart';

void main() {
  /// What the back office sends for a clerk in a group.
  ///
  /// Named `sent` rather than `group`, which is `flutter_test`'s own.
  String sent(Set<TillPermission> granted) => jsonEncode({
    for (final p in TillPermission.values) p.key: granted.contains(p),
  });

  group('somebody in no group', () {
    test('has every key, exactly as before groups existed', () {
      for (final stored in ['', '   ', null]) {
        final permissions = TillPermissions.parse(stored);
        expect(permissions.restricted, isFalse, reason: 'for "$stored"');
        for (final p in TillPermission.values) {
          expect(permissions.can(p), isTrue, reason: '${p.key} for "$stored"');
        }
      }
    });

    test('and the encoder says so, rather than writing an empty group', () {
      // The two have to be the same fact. If "no group" were stored as a blob
      // of eleven falses, the column's emptiness and unrestricted-ness could
      // disagree, and one of them would be wrong.
      expect(TillPermissions.encode(null, grouped: false), '');
      expect(
        TillPermissions.encode({'can_refund': true}, grouped: false),
        '',
      );
    });
  });

  group('somebody in a group', () {
    test('has what was ticked and nothing else', () {
      final supervisor = TillPermissions.parse(
        sent({TillPermission.voidLine, TillPermission.discount}),
      );

      expect(supervisor.restricted, isTrue);
      expect(supervisor.can(TillPermission.voidLine), isTrue);
      expect(supervisor.can(TillPermission.discount), isTrue);
      expect(supervisor.can(TillPermission.refund), isFalse);
      expect(supervisor.can(TillPermission.zReport), isFalse);
    });

    test('an empty group is a real answer, not a missing one', () {
      // "Staff" as the back office seeds it: no keys at all. This is the one
      // case that must NOT be read as unrestricted, and it is only
      // distinguishable from absence because the group was written out.
      final staff = TillPermissions.parse(sent({}));
      expect(staff.restricted, isTrue);
      for (final p in TillPermission.values) {
        expect(staff.can(p), isFalse, reason: p.key);
      }
    });

    test('a manager holds the lot', () {
      final manager = TillPermissions.parse(
        sent(TillPermission.values.toSet()),
      );
      for (final p in TillPermission.values) {
        expect(manager.can(p), isTrue, reason: p.key);
      }
    });
  });

  group('what arrives over the wire', () {
    test('is encoded key by key, so a rename cannot silently grant', () {
      final encoded = TillPermissions.encode(
        {'can_refund': true, 'can_void': false, 'can_invent': true},
        grouped: true,
      );
      final decoded = jsonDecode(encoded) as Map<String, dynamic>;

      expect(decoded.keys.toSet(), {
        for (final p in TillPermission.values) p.key,
      });
      expect(decoded['can_refund'], isTrue);
      expect(decoded['can_void'], isFalse);
      // A key the till does not know is not carried, so it cannot later be
      // read back as something it was never meant to be.
      expect(decoded.containsKey('can_invent'), isFalse);
    });

    test('a missing field is a key withheld, not a key granted', () {
      // A server sending a partial object — an older build, a new permission
      // this till has not heard of — must not have that read as permission.
      final partial = TillPermissions.parse('{"can_refund": true}');
      expect(partial.can(TillPermission.refund), isTrue);
      expect(partial.can(TillPermission.voidLine), isFalse);
    });

    test('a value that is not true is not true', () {
      // JSON from another system might carry 1, "yes" or "true". None of those
      // is a boolean, and guessing is how a permission system grants one.
      final loose = TillPermissions.parse(
        '{"can_refund": 1, "can_void": "true", "can_discount": true}',
      );
      expect(loose.can(TillPermission.refund), isFalse);
      expect(loose.can(TillPermission.voidLine), isFalse);
      expect(loose.can(TillPermission.discount), isTrue);
    });
  });

  group('when the blob cannot be read', () {
    test('the till does not respond by locking everybody out', () {
      for (final broken in ['not json', '[]', '42', '{', '"a string"']) {
        final permissions = TillPermissions.parse(broken);
        expect(
          permissions.restricted,
          isFalse,
          reason: '"$broken" should read as unrestricted, not as no keys',
        );
        expect(permissions.can(TillPermission.refund), isTrue);
      }
    });
  });

  group('the catalogue itself', () {
    test('is the eleven the venue asked for', () {
      expect(TillPermission.values, hasLength(11));
    });

    test('every key is unique, and matches the back office spelling', () {
      final keys = TillPermission.values.map((p) => p.key).toList();
      expect(keys.toSet().length, keys.length);
      // These strings are the wire format and the column names. A typo here is
      // a permission that silently never matches anything the server sends.
      expect(keys, [
        'is_manager',
        'can_refund',
        'can_void',
        'can_discount',
        'can_no_sale',
        'can_set_price',
        'can_x_report',
        'can_z_report',
        'can_unlock_tables',
        'can_expense',
        'can_wastage',
      ]);
    });

    test('every key reads back as itself', () {
      for (final p in TillPermission.values) {
        expect(TillPermission.byKey(p.key), p);
      }
      expect(TillPermission.byKey('can_fly'), isNull);
    });

    test('and every one has a verb a refusal can be written with', () {
      // The message is "Alex is not set up to <verb>", so a blank one produces
      // a sentence that stops in the middle.
      for (final p in TillPermission.values) {
        expect(p.verb.trim(), isNotEmpty, reason: p.key);
      }
    });
  });
}
