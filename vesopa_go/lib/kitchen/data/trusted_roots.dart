/// What the copied kitchen client (tool/sync_go_modes.py) reads from the
/// Windows screen's trusted_roots.dart: plain words for a connection that
/// failed. A phone or iPad trusts the server through the system's own roots.
library;

import 'dart:async';
import 'dart:io';

String? connectionProblem(Object error) {
  if (error is HandshakeException || error is TlsException) {
    return 'This device could not check the back office\'s security certificate. '
        'Check the date and time on this device are right, then try again.';
  }
  if (error is SocketException) {
    return 'This device is not connected to the internet, or the back office '
        'cannot be found from this network. Check the Wi-Fi, then try again.';
  }
  if (error is TimeoutException) {
    return 'The back office took too long to answer. Check the internet connection, then try again.';
  }
  return null;
}
