import 'package:flutter/foundation.dart';

/// A signed-in preview with sample data, for Store screenshots and
/// demonstrations: no Vesopa account, no server calls but /brand.
///
///   web:     https://metric.vesopa.com/?demo=1
///   native:  flutter run -d windows --dart-define=METRIC_DEMO=true
///
/// Nothing a member does in it leaves the device: cars added or removed live
/// in memory until the app closes, and nothing is logged. Signing out ends it.
const _demoDefine = bool.fromEnvironment('METRIC_DEMO');

final bool demoMode = _demoDefine || (kIsWeb && Uri.base.queryParameters['demo'] == '1');

const demoToken = 'demo';

String _day(int offset) => DateTime.now().add(Duration(days: offset)).toIso8601String().substring(0, 10);

String _at(int daysAgo, int hour, int minute) {
  final d = DateTime.now().subtract(Duration(days: daysAgo));
  return DateTime(d.year, d.month, d.day, hour, minute).toUtc().toIso8601String();
}

Map<String, dynamic> _member() => {
  'id': 1,
  'memberNo': 'MG-240118',
  'name': 'Alex Morgan',
  'email': 'alex.morgan@example.com',
  'phone': '07700 900123',
  'company': 'Northgate Logistics',
  'status': 'active',
  'standing': 'ok',
  'validFrom': _day(-120),
  'validTo': _day(245),
  'plan': {'name': 'Business', 'maxVehicles': 3},
};

final List<Map<String, dynamic>> _vehicles = [
  {
    'id': 1,
    'plate': 'MG24PAS',
    'display': 'MG24 PAS',
    'make': 'Tesla Model 3',
    'colour': 'Grey',
    'nickname': 'Work car',
    'lastSeen': {'direction': 'entry', 'at': _at(0, 8, 42), 'site': 'Kembrey Park, Swindon'},
  },
  {
    'id': 2,
    'plate': 'LR71KTE',
    'display': 'LR71 KTE',
    'make': 'Volkswagen Golf',
    'colour': 'White',
    'nickname': '',
    'lastSeen': {'direction': 'exit', 'at': _at(2, 17, 55), 'site': 'Delta Business Park'},
  },
];

int _nextId = 3;

List<Map<String, dynamic>> _visits() => [
  for (final v in [
    ['MG24PAS', 'MG24 PAS', 'entry', 0, 8, 42, 'Kembrey Park, Swindon', 'Main entrance'],
    ['MG24PAS', 'MG24 PAS', 'exit', 1, 18, 7, 'Kembrey Park, Swindon', 'Main exit'],
    ['MG24PAS', 'MG24 PAS', 'entry', 1, 8, 51, 'Kembrey Park, Swindon', 'Main entrance'],
    ['LR71KTE', 'LR71 KTE', 'exit', 2, 17, 55, 'Delta Business Park', 'Exit barrier'],
    ['LR71KTE', 'LR71 KTE', 'entry', 2, 9, 12, 'Delta Business Park', 'Entry barrier'],
    ['MG24PAS', 'MG24 PAS', 'exit', 3, 17, 31, 'Kembrey Park, Swindon', 'Main exit'],
    ['MG24PAS', 'MG24 PAS', 'entry', 3, 8, 38, 'Kembrey Park, Swindon', 'Main entrance'],
  ])
    {
      'plate': v[0],
      'display': v[1],
      'direction': v[2],
      'decision': 'open',
      'reason': 'member',
      'at': _at(v[3] as int, v[4] as int, v[5] as int),
      'site': v[6],
      'gate': v[7],
    },
];

/// What the server would have answered, or null for a call the preview
/// passes through (only /brand).
Map<String, dynamic>? demoAnswer(String method, String path, Object? body) {
  if (path == '/brand') return null;
  final b = body is Map<String, dynamic> ? body : const <String, dynamic>{};
  if (path == '/me' && method == 'GET') return {'member': _member(), 'vehicles': _vehicles};
  if (path == '/me' && method == 'PATCH') return {'member': {..._member(), ...b}};
  if (path == '/vehicles' && method == 'POST') {
    final plate = '${b['plate'] ?? ''}'.toUpperCase().replaceAll(RegExp('[^A-Z0-9]'), '');
    final display = plate.length > 4 ? '${plate.substring(0, plate.length - 3)} ${plate.substring(plate.length - 3)}' : plate;
    final v = {'id': _nextId++, 'plate': plate, 'display': display, 'make': b['make'] ?? '', 'colour': b['colour'] ?? '', 'nickname': b['nickname'] ?? ''};
    _vehicles.add(v);
    return {'vehicle': v};
  }
  if (path.startsWith('/vehicles/') && method == 'DELETE') {
    final id = int.tryParse(path.split('/').last);
    _vehicles.removeWhere((v) => v['id'] == id);
    return {'ok': true};
  }
  if (path == '/visits') return {'visits': _visits()};
  if (path == '/sites') {
    return {
      'sites': [
        {'id': 1, 'name': 'Kembrey Park, Swindon', 'address': 'Kembrey Park, Swindon SN2 8YS'},
        {'id': 2, 'name': 'Delta Business Park', 'address': 'Great Western Way, Swindon SN5 7XF'},
      ],
    };
  }
  return {'ok': true};
}
