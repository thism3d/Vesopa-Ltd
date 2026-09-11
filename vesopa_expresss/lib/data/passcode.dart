/// Checking the exit passcode, with or without a network.
///
/// The back office stores the passcode as PBKDF2-SHA256 and hands the kiosk
/// the salt, the hash and the iteration count with its config. So the check
/// happens here, on the kiosk -- a kiosk whose passcode only worked online
/// would be a kiosk nobody could leave on the day the broadband failed, which
/// is the day somebody most needs to.
///
/// PBKDF2 rather than bcrypt because it is four lines on top of HMAC, which the
/// `crypto` package already has, and because the server's
/// `crypto.pbkdf2Sync(passcode, salt, iterations, 32, 'sha256')` can be
/// reproduced here byte for byte. test/passcode_test.dart holds a vector
/// computed by Node to prove it.
library;

import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';

/// What the config says about the passcode. Null on a venue with none set.
@immutable
class ExitCheck {
  const ExitCheck({
    required this.salt,
    required this.hash,
    required this.iterations,
  });

  final String salt;
  final String hash;
  final int iterations;

  static ExitCheck? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final salt = raw['salt'];
    final hash = raw['hash'];
    final iterations = raw['iterations'];
    if (salt is! String || hash is! String || iterations is! num) return null;
    return ExitCheck(salt: salt, hash: hash, iterations: iterations.toInt());
  }

  Map<String, Object> toJson() => {
    'salt': salt,
    'hash': hash,
    'iterations': iterations,
    'algorithm': 'pbkdf2-sha256',
  };
}

/// PBKDF2-HMAC-SHA256 for one 32-byte block, as hex.
///
/// One block is all a 32-byte key needs with SHA-256, so the block counter is
/// always 1. The salt is the hex STRING's own bytes, not the bytes it spells:
/// that is what Node does with a string salt, and matching it is the point.
String pbkdf2Hex(String password, String salt, int iterations) {
  final hmac = Hmac(sha256, utf8.encode(password));
  final first = Uint8List.fromList([...utf8.encode(salt), 0, 0, 0, 1]);
  var u = Uint8List.fromList(hmac.convert(first).bytes);
  final out = Uint8List.fromList(u);
  for (var i = 1; i < iterations; i++) {
    u = Uint8List.fromList(hmac.convert(u).bytes);
    for (var j = 0; j < out.length; j++) {
      out[j] ^= u[j];
    }
  }
  final hex = StringBuffer();
  for (final b in out) {
    hex.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return hex.toString();
}

/// Whether [passcode] opens this kiosk. Constant-time on the comparison.
bool passcodeMatches(String passcode, ExitCheck check) {
  final given = pbkdf2Hex(passcode, check.salt, check.iterations);
  if (given.length != check.hash.length) return false;
  var diff = 0;
  for (var i = 0; i < given.length; i++) {
    diff |= given.codeUnitAt(i) ^ check.hash.toLowerCase().codeUnitAt(i);
  }
  return diff == 0;
}

/// The same check off the UI thread: 120,000 rounds of HMAC is a visible
/// stutter on a low-end kiosk if it runs where the animation does.
Future<bool> passcodeMatchesAsync(String passcode, ExitCheck check) =>
    compute(_matches, (passcode, check.salt, check.hash, check.iterations));

bool _matches((String, String, String, int) args) => passcodeMatches(
  args.$1,
  ExitCheck(salt: args.$2, hash: args.$3, iterations: args.$4),
);
