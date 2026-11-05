import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';

/// This PC's network and hardware, for Settings > Network and hardware: the
/// adapters, Wi-Fi, mobile hotspot and who is on it, Bluetooth, USB and serial
/// devices, and Windows file and printer sharing.
///
/// Reading and the switches Windows lets any app use (hotspot, Bluetooth and
/// Wi-Fi radios) go straight to Windows (windows/runner/hardware.cpp). The
/// rest needs an administrator, so it goes to the network helper service
/// (windows/nethelper), which someone allows once.
class Hardware {
  Hardware._();
  static final instance = Hardware._();

  static const _channel = MethodChannel('vesopa/hardware');

  /// The helper this build carries; nethelper.cpp's kVersion.
  static const helperVersion = '2';

  static bool get supported => Platform.isWindows;

  /// A scan still running in Windows. Only ever one at a time: a query Windows
  /// never answers must cost one stuck thread, not a new one every ten minutes
  /// on a till that runs all day.
  Future<Map<Object?, Object?>?>? _scan;

  /// Whether a scan is still waiting on Windows.
  bool get scanning => _scan != null;

  /// What Windows reports about this PC.
  ///
  /// [light] is the background report: adapters and Wi-Fi only. It leaves out
  /// the radios, the hotspot, every device on the PC and PowerShell, which are
  /// for a person looking at the page and are too heavy to run all day on the
  /// PC that is taking the money (Pontardawe's lounge till, 2026-11-05).
  ///
  /// Throws [TimeoutException] when Windows does not answer, or is still
  /// working on the last scan.
  Future<HardwareSnapshot> snapshot({bool light = false}) async {
    if (_scan != null) throw TimeoutException('Still waiting on the last scan');
    final scan = _channel.invokeMethod<Map<Object?, Object?>>('snapshot', {'light': light});
    _scan = scan;
    unawaited(scan.then<void>((_) {}, onError: (_) {}).whenComplete(() => _scan = null));
    final raw = await scan.timeout(const Duration(seconds: 20));
    if (light) {
      return HardwareSnapshot.fromMap(
        raw ?? const {},
        const SharingState(files: null, discovery: null, profiles: {}),
        null,
      );
    }
    final sharing = await _sharing();
    final helper = await helperState();
    return HardwareSnapshot.fromMap(raw ?? const {}, sharing, helper);
  }

  /// "ok", or what Windows said.
  Future<String> setHotspot({required bool on, String? ssid, String? passphrase}) async =>
      await _channel.invokeMethod<String>('hotspot', {
        'on': on,
        'ssid': ?ssid,
        'passphrase': ?passphrase,
      }) ??
      'no answer';

  Future<String> setRadio(String kind, bool on) async =>
      await _channel.invokeMethod<String>('radio', {'kind': kind, 'on': on}) ?? 'no answer';

  /// "ok", "ok reboot", "missing" (no helper), or "error ...".
  Future<String> helper(String request) async =>
      await _channel.invokeMethod<String>('helper', {'request': request}) ?? 'error no answer';

  Future<String> restartAdapter(int index) => helper('adapter-restart $index');
  Future<String> setAdapter(int index, bool on) => helper('${on ? 'adapter-on' : 'adapter-off'} $index');
  Future<String> restartDevice(String id) => helper('device-restart $id');
  Future<String> setSharing(String what, bool on) => helper('sharing $what ${on ? 'on' : 'off'}');
  Future<String> makePrivate(int index) => helper('network-private $index');

  /// null when no helper answers; otherwise the version it reports.
  Future<String?> helperState() async {
    try {
      final r = await helper('ping');
      return r.startsWith('ok ') ? r.substring(3).trim() : null;
    } catch (_) {
      return null;
    }
  }

  /// Copies the helper out of the till's folder and runs its installer with
  /// the administrator's say-so, once. A Store copy's folder cannot be run
  /// elevated from, hence the copy. True when the helper answers afterwards.
  Future<bool> installHelper() async {
    final source = File('${File(Platform.resolvedExecutable).parent.path}\\vesopa_nethelper.exe');
    if (!await source.exists()) return false;
    final dir = await Directory.systemTemp.createTemp('vesopa-helper');
    final copy = await source.copy('${dir.path}\\vesopa_nethelper.exe');
    try {
      await Process.run('powershell', [
        '-NoProfile',
        '-Command',
        "Start-Process -FilePath '${copy.path}' -ArgumentList install -Verb RunAs -WindowStyle Hidden -Wait",
      ]).timeout(const Duration(minutes: 3));
    } catch (_) {}
    for (var i = 0; i < 10; i++) {
      if (await helperState() != null) return true;
      await Future<void>.delayed(const Duration(milliseconds: 500));
    }
    return false;
  }

  /// Windows restarts in [seconds]; anything the till has not sent yet waits
  /// in its outbox and goes when it is back.
  Future<void> restartPc({int seconds = 10}) async {
    await Process.run('shutdown', ['/r', '/t', '$seconds', '/c', 'Vesopa EPOS is restarting this PC.']);
  }

  Future<void> cancelPcRestart() async {
    await Process.run('shutdown', ['/a']);
  }

  /// File and printer sharing and network discovery on private networks, and
  /// each network's kind, in one PowerShell call (the group names are the
  /// resource ones, the same in every Windows language).
  Future<SharingState> _sharing() async {
    try {
      final shell = await Process.start('powershell', [
        '-NoProfile',
        '-Command',
        r"$f = @(Get-NetFirewallRule -Group '@FirewallAPI.dll,-28502' -Direction Inbound -ErrorAction SilentlyContinue | ? { $_.Profile -match 'Private|Any' -and $_.Enabled -eq 'True' }).Count; "
            r"$d = @(Get-NetFirewallRule -Group '@FirewallAPI.dll,-32752' -Direction Inbound -ErrorAction SilentlyContinue | ? { $_.Profile -match 'Private|Any' -and $_.Enabled -eq 'True' }).Count; "
            r"$p = @(Get-NetConnectionProfile | % { @{ index = $_.InterfaceIndex; name = $_.Name; category = [string]$_.NetworkCategory } }); "
            r"@{ files = $f -gt 0; discovery = $d -gt 0; profiles = $p } | ConvertTo-Json -Depth 4 -Compress",
      ]);
      final output = shell.stdout.transform(utf8.decoder).join();
      unawaited(shell.stderr.drain<void>());
      // Killed, not just abandoned: left running, one that hangs stays on the
      // PC for good, and there would be another one the next time round.
      await shell.exitCode.timeout(const Duration(seconds: 20), onTimeout: () {
        shell.kill(ProcessSignal.sigkill);
        throw TimeoutException('Windows did not answer about sharing');
      });
      final m = jsonDecode((await output).trim()) as Map<String, dynamic>;
      final profiles = <int, NetworkProfile>{};
      final list = m['profiles'];
      for (final p in list is List ? list : [list]) {
        if (p is! Map) continue;
        final index = (p['index'] as num?)?.toInt();
        if (index == null) continue;
        profiles[index] = NetworkProfile('${p['name'] ?? ''}', '${p['category'] ?? ''}');
      }
      return SharingState(files: m['files'] == true, discovery: m['discovery'] == true, profiles: profiles);
    } catch (_) {
      return const SharingState(files: null, discovery: null, profiles: {});
    }
  }
}

class NetworkProfile {
  const NetworkProfile(this.name, this.category);
  final String name;

  /// Public, Private or DomainAuthenticated.
  final String category;
  bool get isPublic => category == 'Public';
}

class SharingState {
  const SharingState({required this.files, required this.discovery, required this.profiles});

  /// null when Windows would not say.
  final bool? files;
  final bool? discovery;
  final Map<int, NetworkProfile> profiles;
}

class NetAdapter {
  NetAdapter.fromMap(Map<Object?, Object?> m)
      : index = (m['index'] as int?) ?? 0,
        name = '${m['name'] ?? ''}',
        description = '${m['description'] ?? ''}',
        kind = '${m['kind'] ?? 'ethernet'}',
        up = m['up'] == true,
        mac = '${m['mac'] ?? ''}',
        speedMbps = (m['speed_mbps'] as int?) ?? 0,
        ips = [for (final ip in (m['ips'] as List? ?? const [])) '$ip'],
        gateway = '${m['gateway'] ?? ''}';

  final int index;
  final String name;
  final String description;

  /// ethernet, wifi, bluetooth, hotspot or virtual.
  final String kind;
  final bool up;
  final String mac;
  final int speedMbps;
  final List<String> ips;
  final String gateway;

  /// The one carrying the default route: turning it off takes the till off
  /// the internet.
  bool get carriesInternet => up && gateway.isNotEmpty;
}

class HotspotClient {
  HotspotClient(this.mac, this.names);
  final String mac;
  final List<String> names;
  String get label => names.firstWhere((n) => !RegExp(r'^[\d.:]+$').hasMatch(n), orElse: () => names.isEmpty ? mac : names.first);
  String? get address => names.where((n) => RegExp(r'^\d+\.\d+\.\d+\.\d+$').hasMatch(n)).firstOrNull;
}

class HotspotState {
  HotspotState.fromMap(Map<Object?, Object?> m)
      : supported = m['supported'] == true,
        why = m['why'] as String?,
        state = '${m['state'] ?? 'unknown'}',
        ssid = '${m['ssid'] ?? ''}',
        passphrase = '${m['passphrase'] ?? ''}',
        shares = '${m['shares'] ?? ''}',
        maxClients = (m['max_clients'] as int?) ?? 0,
        clients = [
          for (final c in (m['clients'] as List? ?? const []))
            if (c is Map) HotspotClient('${c['mac'] ?? ''}', [for (final n in (c['names'] as List? ?? const [])) '$n']),
        ];

  final bool supported;
  final String? why;

  /// on, off, changing or unknown.
  final String state;
  final String ssid;
  final String passphrase;

  /// The network it passes on.
  final String shares;
  final int maxClients;
  final List<HotspotClient> clients;
  bool get on => state == 'on';
}

class RadioState {
  RadioState(this.kind, this.name, this.on);
  final String kind;
  final String name;
  final bool on;
}

class HardwareDevice {
  HardwareDevice.fromMap(Map<Object?, Object?> m)
      : id = '${m['id'] ?? ''}',
        name = '${m['name'] ?? ''}',
        kind = '${m['kind'] ?? ''}',
        cls = '${m['class'] ?? ''}',
        working = m['working'] == true,
        problem = (m['problem'] as int?) ?? 0;

  final String id;
  final String name;

  /// usb, usb-printer, serial, bluetooth or bluetooth-radio.
  final String kind;
  final String cls;
  final bool working;

  /// Device Manager's problem code; 22 is "turned off", 28 "no driver".
  final int problem;

  String get problemText => switch (problem) {
        0 => working ? 'Working' : 'Not started',
        10 => 'Will not start',
        22 => 'Turned off in Device Manager',
        28 => 'No driver installed',
        43 => 'Windows stopped it after it reported a fault',
        45 => 'Not plugged in',
        _ => 'Problem $problem in Device Manager',
      };
}

class HardwareSnapshot {
  HardwareSnapshot({
    required this.adapters,
    required this.wifiSsid,
    required this.wifiSignal,
    required this.radios,
    required this.hotspot,
    required this.devices,
    required this.sharing,
    required this.helperVersion,
  });

  factory HardwareSnapshot.fromMap(Map<Object?, Object?> m, SharingState sharing, String? helper) {
    final wifi = m['wifi'] is Map ? m['wifi'] as Map : null;
    return HardwareSnapshot(
      adapters: [for (final a in (m['adapters'] as List? ?? const [])) if (a is Map) NetAdapter.fromMap(a)],
      wifiSsid: wifi == null ? null : '${wifi['ssid'] ?? ''}'.isNotEmpty ? '${wifi['ssid']}' : '${wifi['profile'] ?? ''}',
      wifiSignal: wifi == null ? null : wifi['signal'] as int?,
      radios: [
        for (final r in (m['radios'] as List? ?? const []))
          if (r is Map) RadioState('${r['kind']}', '${r['name'] ?? ''}', r['on'] == true),
      ],
      hotspot: HotspotState.fromMap(m['hotspot'] is Map ? m['hotspot'] as Map : const {}),
      devices: [for (final d in (m['devices'] as List? ?? const [])) if (d is Map) HardwareDevice.fromMap(d)],
      sharing: sharing,
      helperVersion: helper,
    );
  }

  final List<NetAdapter> adapters;
  final String? wifiSsid;
  final int? wifiSignal;
  final List<RadioState> radios;
  final HotspotState hotspot;
  final List<HardwareDevice> devices;
  final SharingState sharing;
  final String? helperVersion;

  RadioState? radio(String kind) => radios.where((r) => r.kind == kind).firstOrNull;
  bool get helperInstalled => helperVersion != null;
  bool get helperOutdated => helperVersion != null && helperVersion != Hardware.helperVersion;

  List<NetAdapter> get internet => adapters.where((a) => a.carriesInternet).toList();

  /// What needs a look, in words: the page's warning box and the report the
  /// back office and admin.vesopa.com show (HardwareReporter).
  List<String> get warnings => [
        if (internet.isEmpty) 'No network is carrying the internet. Sales wait on the till and go when it is back.',
        for (final a in internet)
          if (sharing.profiles[a.index]?.isPublic ?? false)
            '${a.name} is set as a Public network, so Windows keeps the other tills and Go phones out. Make it Private below.',
        if (wifiSignal != null && wifiSignal! < 40)
          'The Wi-Fi signal is weak ($wifiSignal%). A cable, or the router nearer the till, keeps card payments steady.',
        for (final d in devices)
          // Only real faults: a paired Bluetooth device out of range, or one
          // Windows remembers but is unplugged (45), is not one.
          if (d.problem != 0 && d.problem != 45 && d.kind != 'bluetooth') '${d.name}: ${d.problemText}.',
      ];

  /// The report for the back office (POST /till/health): what this page
  /// shows, with no MAC addresses and no hotspot passphrase.
  Map<String, Object?> toReport({String? localLink}) => {
        'os': '${Platform.operatingSystem} ${Platform.operatingSystemVersion}'.trim(),
        'cpu': '${Platform.numberOfProcessors} cores',
        'online_via': internet.isEmpty ? 'offline' : internet.first.name,
        'adapters': [
          for (final a in adapters)
            {
              'name': a.name,
              'kind': a.kind,
              'status': a.up ? 'up' : 'down',
              'ipv4': a.ips.where((ip) => ip.contains('.')).firstOrNull,
              'gateway': a.gateway,
              'speed': a.speedMbps > 0 ? '${a.speedMbps} Mb/s' : null,
              'category': sharing.profiles[a.index]?.category,
              if (a.kind == 'wifi' && wifiSsid != null) 'ssid': wifiSsid,
              if (a.kind == 'wifi' && wifiSignal != null) 'signal': wifiSignal,
            },
        ],
        if (radios.isNotEmpty) 'bluetooth': radio('bluetooth') == null ? 'none' : radio('bluetooth')!.on ? 'on' : 'off',
        'devices': [
          for (final d in devices)
            {'name': d.name, 'kind': d.kind, 'status': d.working ? 'ok' : 'fault', if (d.problem != 0 && d.problem != 45) 'problem': d.problemText},
        ],
        'warnings': warnings,
        'helper': helperVersion ?? 'not installed',
        'local_link': ?localLink,
      };
}

/// Sends this PC's hardware report to the back office every ten minutes, and
/// soon after a start, so admin.vesopa.com and the venue's Devices page show
/// what Settings > Network and hardware shows. Best effort: offline, or an
/// older back office, and nothing is sent until the next turn.
class HardwareReporter {
  HardwareReporter._();
  static Timer? _timer;

  static void start({
    required String apiBase,
    required String token,
    required String deviceId,
    required String app,
    required String appVersion,
    String? deviceName,
    String? Function()? localLink,
  }) {
    if (!Hardware.supported || token.isEmpty) return;
    _timer?.cancel();
    var sending = false;
    Future<void> send() async {
      // The last report is still going: this one is skipped, not stacked.
      if (sending) return;
      sending = true;
      try {
        final s = await Hardware.instance.snapshot(light: true);
        final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
        try {
          final req = await client.postUrl(Uri.parse('$apiBase/till/health'));
          req.headers
            ..contentType = ContentType.json
            ..set(HttpHeaders.authorizationHeader, 'Bearer $token');
          req.write(jsonEncode({
            'device_id': deviceId,
            'app': app,
            'app_version': appVersion,
            'device_name': deviceName ?? Platform.localHostname,
            'snapshot': s.toReport(localLink: localLink?.call()),
          }));
          await (await req.close().timeout(const Duration(seconds: 15))).drain<void>();
        } finally {
          client.close();
        }
      } catch (_) {
      } finally {
        sending = false;
      }
    }

    Timer(const Duration(seconds: 45), send);
    _timer = Timer.periodic(const Duration(minutes: 10), (_) => send());
  }

  static void stop() {
    _timer?.cancel();
    _timer = null;
  }
}
