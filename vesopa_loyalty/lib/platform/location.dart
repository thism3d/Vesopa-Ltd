import 'package:geolocator/geolocator.dart';

/// Where the customer is, asked only when they have turned on "Offers when
/// I'm nearby" -- and only while the app is open. Nothing tracks them in the
/// background. The server compares the position with the venue's there and
/// then and keeps only whether they were near, for a few hours, to send a
/// venue's "near us now" notifications (src/loyalty_app.js, audience near).
/// The position itself is never stored.
///
/// On an iPhone this needs NSLocationWhenInUseUsageDescription in Info.plist;
/// without it the request is refused by iOS itself.
class Position2 {
  const Position2(this.latitude, this.longitude, this.accuracy);
  final double latitude;
  final double longitude;
  final double accuracy;
}

/// Null when location is off, refused, or does not answer in time.
Future<Position2?> currentPosition() async {
  try {
    if (!await Geolocator.isLocationServiceEnabled()) return null;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      return null;
    }
    final p = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.medium,
        timeLimit: Duration(seconds: 20),
      ),
    );
    return Position2(p.latitude, p.longitude, p.accuracy);
  } catch (_) {
    return null;
  }
}
