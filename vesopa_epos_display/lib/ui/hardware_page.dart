import 'dart:async';

import 'package:flutter/material.dart';

import '../data/hardware.dart';
import '../data/lan/lan_link.dart' show LanPeer;
import '../data/lan/lan_service.dart';

/// The same file in the till, kitchen and display apps (tool/sync_hardware.py
/// copies it with data/hardware.dart and the Windows code), so it carries its
/// own colours rather than each app's theme.
abstract class _C {
  static const brandDeep = Color(0xFF6E8A0E);
  static const graphite = Color(0xFF6B6B6A);
  static const red = Color(0xFFE8412C);
  static const blue = Color(0xFF4BA3F5);
  static const teal = Color(0xFF1E9184);
  static const amber = Color(0xFFF5B301);
  static const purple = Color(0xFFA435B0);
  static const indigo = Color(0xFF5C6BC0);
  static const green = Color(0xFF2E9E5B);
}

void _say(BuildContext context, String text, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text(text),
      behavior: SnackBarBehavior.floating,
      backgroundColor: error ? _C.red : null,
      duration: Duration(milliseconds: error ? 3500 : 2200),
    ));
}

/// Settings > Network and hardware: everything this PC is connected by, with
/// the switches to fix it from the till. Turning something off asks first and
/// says what stops working; anything needing an administrator goes through
/// the network helper, which is allowed once at the top of the page.
class HardwarePage extends StatefulWidget {
  const HardwarePage({super.key});

  @override
  State<HardwarePage> createState() => _HardwarePageState();
}

class _HardwarePageState extends State<HardwarePage> {
  HardwareSnapshot? _snap;
  Object? _error;
  Timer? _timer;
  StreamSubscription<void>? _lan;
  final Set<String> _busy = {};
  bool _showPass = false;

  Hardware get _hw => Hardware.instance;

  @override
  void initState() {
    super.initState();
    _load();
    // Devices come and go on the hotspot; five seconds keeps the list honest
    // without keeping PowerShell busy.
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => _load());
    _lan = LanService.instance.changes.listen((_) => _lanChanged());
  }

  @override
  void dispose() {
    _timer?.cancel();
    _lan?.cancel();
    super.dispose();
  }

  void _lanChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    if (!Hardware.supported) return;
    try {
      final s = await _hw.snapshot();
      if (mounted) {
        setState(() {
          _snap = s;
          _error = null;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  /// Runs [action] with its key shown busy; reports "ok" or what went wrong.
  Future<void> _do(String key, Future<String> Function() action, String done) async {
    if (_busy.contains(key)) return;
    setState(() => _busy.add(key));
    String result;
    try {
      result = await action();
    } catch (e) {
      result = '$e';
    }
    if (!mounted) return;
    setState(() => _busy.remove(key));
    if (result == 'ok') {
      _say(context, done);
    } else if (result == 'ok reboot') {
      _say(context, '$done Windows wants the PC restarted to finish.');
    } else if (result == 'missing') {
      _say(context, error: true, 'Allow the network helper first, at the top of this page.');
    } else {
      _say(context, error: true, result.startsWith('error ') ? 'Windows did not do it (${result.substring(6)}).' : result);
    }
    unawaited(_load());
  }

  Future<bool> _confirm(String title, String body, {String yes = 'Go ahead', bool danger = true}) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          icon: Icon(danger ? Icons.warning_amber_rounded : Icons.help_outline,
              size: 30, color: danger ? _C.amber : _C.brandDeep),
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              style: danger ? FilledButton.styleFrom(backgroundColor: _C.red) : null,
              child: Text(yes),
            ),
          ],
        ),
      ) ==
      true;

  @override
  Widget build(BuildContext context) {
    if (!Hardware.supported) {
      return const Center(child: Text('Network and hardware controls are on the Windows till.'));
    }
    final s = _snap;
    if (s == null) {
      return Center(
        child: _error == null
            ? const CircularProgressIndicator()
            : Text('Windows did not answer: $_error', textAlign: TextAlign.center),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          _summary(s),
          const SizedBox(height: 20),
          _helperCard(s),
          _section('Network adapters', Icons.settings_ethernet),
          _card([for (final a in _visibleAdapters(s)) _adapterTile(s, a)]),
          _section('Mobile hotspot', Icons.wifi_tethering),
          _card(_hotspot(s)),
          _section('Sharing on this network', Icons.folder_shared_outlined),
          _card(_sharing(s)),
          _section('Vesopa devices on the local link', Icons.lan),
          _card(_lanPeers(s)),
          _section('Bluetooth', Icons.bluetooth),
          _card(_bluetooth(s)),
          _section('USB and serial devices', Icons.usb),
          _card(_usb(s)),
          _section('Restart', Icons.restart_alt),
          _card(_restart()),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  // ---- summary -------------------------------------------------------------

  Widget _summary(HardwareSnapshot s) {
    final internet = s.internet;
    final warnings = s.warnings;
    final chips = <Widget>[
      _chip(Icons.public, internet.isEmpty ? 'Offline' : 'Online via ${internet.first.name}',
          internet.isEmpty ? _C.red : _C.green),
      if (s.wifiSsid != null) _chip(Icons.wifi, '${s.wifiSsid!.isEmpty ? 'Wi-Fi' : s.wifiSsid} · ${s.wifiSignal ?? 0}%', _C.blue),
      if (s.hotspot.on) _chip(Icons.wifi_tethering, 'Hotspot · ${s.hotspot.clients.length} on it', _C.teal),
      _chip(Icons.bluetooth, s.radio('bluetooth')?.on == true ? 'Bluetooth on' : 'Bluetooth off',
          s.radio('bluetooth')?.on == true ? _C.indigo : _C.graphite),
      _chip(Icons.usb, '${s.devices.where((d) => d.kind.startsWith('usb') || d.kind == 'serial').length} USB and serial', _C.purple),
      _chip(Icons.lan, LanService.instance.node?.linked == true || LanService.instance.node?.isHub == true
          ? 'Local link up'
          : 'Local link waiting', _C.brandDeep),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Network and hardware', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
        const SizedBox(height: 6),
        const Text(
          "Everything this PC is connected by. Changes here affect only this PC; the venue's "
          'settings stay in the back office.',
          style: TextStyle(fontSize: 13.5, height: 1.4),
        ),
        const SizedBox(height: 14),
        Wrap(spacing: 8, runSpacing: 8, children: chips),
        for (final w in warnings)
          Padding(
            padding: const EdgeInsets.only(top: 10),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Icon(Icons.warning_amber_rounded, color: _C.amber, size: 20),
              const SizedBox(width: 8),
              Expanded(child: Text(w, style: const TextStyle(fontSize: 13.5, height: 1.35))),
            ]),
          ),
      ],
    );
  }

  Widget _chip(IconData icon, String text, Color color) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.14),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: color.withValues(alpha: 0.4)),
        ),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 6),
          Text(text, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        ]),
      );

  Widget _section(String title, IconData icon) => Padding(
        padding: const EdgeInsets.only(top: 26, bottom: 10),
        child: Row(children: [
          Icon(icon, size: 16, color: Theme.of(context).hintColor),
          const SizedBox(width: 8),
          Text(title.toUpperCase(),
              style: TextStyle(
                  fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 1.1, color: Theme.of(context).hintColor)),
        ]),
      );

  Widget _card(List<Widget> children) => Card(
        margin: EdgeInsets.zero,
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0) const Divider(height: 1),
            children[i],
          ],
        ]),
      );

  Widget _busyOr(String key, Widget child) => _busy.contains(key)
      ? const Padding(
          padding: EdgeInsets.all(10),
          child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5)),
        )
      : child;

  // ---- helper --------------------------------------------------------------

  Widget _helperCard(HardwareSnapshot s) {
    if (s.helperInstalled && !s.helperOutdated) {
      return const SizedBox.shrink();
    }
    return Card(
      margin: EdgeInsets.zero,
      color: _C.amber.withValues(alpha: 0.12),
      child: ListTile(
        leading: const Icon(Icons.admin_panel_settings_outlined, color: _C.amber, size: 30),
        title: Text(s.helperOutdated ? 'Update the network helper' : 'Allow the network helper'),
        subtitle: const Text(
          'Restarting an adapter, Bluetooth or a USB device, sharing, and making a network Private need '
          "Windows' administrator. Allow the Vesopa network helper once and staff can use them without "
          'the administrator login. Windows asks for it now, this one time.',
        ),
        trailing: _busyOr(
          'helper',
          FilledButton(
            onPressed: () async {
              setState(() => _busy.add('helper'));
              final ok = await _hw.installHelper();
              if (!mounted) return;
              setState(() => _busy.remove('helper'));
              ok
                  ? _say(context, 'The network helper is on.')
                  : _say(context, error: true, 'Windows did not allow it. Someone with the administrator login needs to say Yes.');
              unawaited(_load());
            },
            child: Text(s.helperOutdated ? 'Update' : 'Allow'),
          ),
        ),
      ),
    );
  }

  // ---- adapters ------------------------------------------------------------

  List<NetAdapter> _visibleAdapters(HardwareSnapshot s) {
    final list = s.adapters.where((a) => (a.kind != 'virtual' || a.carriesInternet) && (a.up || a.kind != 'hotspot')).toList()
      ..sort((a, b) {
        if (a.carriesInternet != b.carriesInternet) return a.carriesInternet ? -1 : 1;
        if (a.up != b.up) return a.up ? -1 : 1;
        return a.name.compareTo(b.name);
      });
    return list;
  }

  IconData _adapterIcon(String kind) => switch (kind) {
        'wifi' => Icons.wifi,
        'bluetooth' => Icons.bluetooth,
        'hotspot' => Icons.wifi_tethering,
        _ => Icons.settings_ethernet,
      };

  Widget _adapterTile(HardwareSnapshot s, NetAdapter a) {
    final profile = s.sharing.profiles[a.index];
    final details = [
      a.up ? 'Connected' : 'Not connected',
      if (a.kind == 'wifi' && a.up && s.wifiSsid != null) '${s.wifiSsid} ${s.wifiSignal ?? 0}%',
      if (a.speedMbps > 0 && a.up) a.speedMbps >= 1000 ? '${a.speedMbps ~/ 1000} Gb/s' : '${a.speedMbps} Mb/s',
      ...a.ips,
      if (a.gateway.isNotEmpty) 'router ${a.gateway}',
      if (profile != null) '${profile.category} network',
      if (a.mac.isNotEmpty) a.mac,
    ].join('  ·  ');
    final key = 'adapter-${a.index}';
    return ListTile(
      leading: Icon(_adapterIcon(a.kind), color: a.up ? _C.green : _C.graphite),
      title: Text('${a.name}${a.carriesInternet ? '  ·  internet' : ''}'),
      subtitle: Text('${a.description}\n$details', style: const TextStyle(fontSize: 12.5, height: 1.35)),
      isThreeLine: true,
      trailing: _busyOr(
        key,
        PopupMenuButton<String>(
          tooltip: 'Options',
          onSelected: (v) => _adapterAction(a, v),
          itemBuilder: (_) => [
            const PopupMenuItem(value: 'restart', child: Text('Restart adapter')),
            PopupMenuItem(value: a.up ? 'off' : 'on', child: Text(a.up ? 'Turn off' : 'Turn on')),
            if (profile?.isPublic ?? false) const PopupMenuItem(value: 'private', child: Text('Make this network Private')),
          ],
        ),
      ),
    );
  }

  Future<void> _adapterAction(NetAdapter a, String v) async {
    final key = 'adapter-${a.index}';
    final cuts = a.carriesInternet
        ? ' It is the one carrying the internet, so card payments, the back office and the other devices '
            'drop off for '
        : ' Anything using it drops off for ';
    switch (v) {
      case 'restart':
        if (!await _confirm('Restart ${a.name}?', 'Windows turns it off and on again.${cuts}about 10 seconds.')) return;
        await _do(key, () => _hw.restartAdapter(a.index), '${a.name} restarted.');
      case 'off':
        if (!await _confirm('Turn off ${a.name}?', '${cuts.trim()} as long as it stays off. Turn it back on here.')) return;
        await _do(key, () => _hw.setAdapter(a.index, false), '${a.name} is off.');
      case 'on':
        await _do(key, () => _hw.setAdapter(a.index, true), '${a.name} is on.');
      case 'private':
        if (!await _confirm(
            'Make this network Private?',
            'Do this only for the venue\'s own network, never a public Wi-Fi. Windows then lets the other '
                'tills, kitchen screens and Go phones reach this till.',
            danger: false)) {
          return;
        }
        await _do(key, () => _hw.makePrivate(a.index), 'The network is Private now.');
    }
  }

  // ---- hotspot -------------------------------------------------------------

  List<Widget> _hotspot(HardwareSnapshot s) {
    final h = s.hotspot;
    if (!h.supported) {
      return [
        ListTile(
          leading: const Icon(Icons.wifi_tethering_off, color: _C.graphite),
          title: const Text('No hotspot on this PC'),
          subtitle: Text('Windows says: ${h.why ?? 'not available'}.'),
        ),
      ];
    }
    final peers = LanService.instance.node?.peers.values.toList() ?? const [];
    return [
      SwitchListTile(
        secondary: Icon(h.on ? Icons.wifi_tethering : Icons.wifi_tethering_off, color: h.on ? _C.teal : _C.graphite),
        title: Text(h.on ? 'Hotspot on: ${h.ssid}' : 'Share this till\'s network as Wi-Fi'),
        subtitle: Text(
          h.on
              ? 'Passing on ${h.shares}. ${h.clients.length} of ${h.maxClients} connected. Go phones, kitchen '
                  'screens and displays that join it stay on the local link even when the venue Wi-Fi is down.'
              : 'Go phones and screens join this till directly, e.g. when the venue Wi-Fi fails or puts them '
                  'on a separate network. Shares ${h.shares}.',
        ),
        value: h.on,
        onChanged: _busy.contains('hotspot')
            ? null
            : (on) async {
                if (!on &&
                    h.clients.isNotEmpty &&
                    !await _confirm('Turn the hotspot off?',
                        '${h.clients.length} device${h.clients.length == 1 ? ' is' : 's are'} on it and will drop off. '
                            'Go phones keep their orders and send them when they are back on a network.')) {
                  return;
                }
                await _do('hotspot', () => _hw.setHotspot(on: on), on ? 'Hotspot on.' : 'Hotspot off.');
              },
      ),
      ListTile(
        leading: const Icon(Icons.key_outlined),
        title: Text('Name: ${h.ssid}'),
        subtitle: Text('Password: ${_showPass ? h.passphrase : '••••••••'}'),
        trailing: Wrap(spacing: 4, children: [
          IconButton(
            tooltip: _showPass ? 'Hide password' : 'Show password',
            icon: Icon(_showPass ? Icons.visibility_off : Icons.visibility),
            onPressed: () => setState(() => _showPass = !_showPass),
          ),
          OutlinedButton(onPressed: () => _editHotspot(h), child: const Text('Change')),
        ]),
      ),
      if (h.on && h.clients.isEmpty)
        const ListTile(dense: true, title: Text('Nobody on it yet'), subtitle: Text(
            'Windows turns an empty hotspot off after a few minutes unless "Power saving" is off in '
            'Windows Settings > Network > Mobile hotspot.')),
      for (final c in h.clients)
        ListTile(
          dense: true,
          leading: const Icon(Icons.smartphone, size: 20),
          title: Text(_peerName(peers, c) ?? c.label),
          subtitle: Text([c.address, c.mac].whereType<String>().join('  ·  ')),
        ),
    ];
  }

  String? _peerName(List<LanPeer> peers, HotspotClient c) {
    final ip = c.address;
    if (ip == null) return null;
    for (final p in peers) {
      if (p.address.address == ip) return '${p.name} (Vesopa)';
    }
    return null;
  }

  Future<void> _editHotspot(HotspotState h) async {
    final name = TextEditingController(text: h.ssid);
    final pass = TextEditingController(text: h.passphrase);
    final saved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Hotspot name and password'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: name, decoration: const InputDecoration(labelText: 'Name')),
          TextField(
            controller: pass,
            decoration: const InputDecoration(labelText: 'Password', helperText: 'At least 8 characters.'),
          ),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Save')),
        ],
      ),
    );
    if (saved != true) return;
    if (pass.text.length < 8 || name.text.trim().isEmpty) {
      if (mounted) _say(context, error: true, 'A name, and a password of at least 8 characters.');
      return;
    }
    await _do('hotspot', () => _hw.setHotspot(on: h.on, ssid: name.text.trim(), passphrase: pass.text),
        'Saved. Devices on the old name need to join again.');
  }

  // ---- sharing -------------------------------------------------------------

  List<Widget> _sharing(HardwareSnapshot s) => [
        _sharingSwitch(
          'files',
          'File and printer sharing',
          'Lets the other PCs use a printer plugged into this till, and reach shared folders. On '
              'Private networks only.',
          s.sharing.files,
          Icons.print_outlined,
        ),
        _sharingSwitch(
          'discovery',
          'Network discovery',
          'This PC shows up in the other PCs\' Network list, and finds network printers. On Private '
              'networks only.',
          s.sharing.discovery,
          Icons.travel_explore,
        ),
      ];

  Widget _sharingSwitch(String what, String title, String body, bool? value, IconData icon) => SwitchListTile(
        secondary: Icon(icon),
        title: Text(title),
        subtitle: Text(value == null ? '$body\nWindows would not say whether it is on.' : body),
        value: value ?? false,
        onChanged: _busy.contains('share-$what')
            ? null
            : (on) async {
                if (!on &&
                    !await _confirm('Turn off $title?',
                        'Other PCs printing to, or reading from, this till stop being able to.')) {
                  return;
                }
                await _do('share-$what', () => _hw.setSharing(what, on), '$title ${on ? 'on' : 'off'}.');
              },
      );

  // ---- local link ----------------------------------------------------------

  List<Widget> _lanPeers(HardwareSnapshot s) {
    final node = LanService.instance.node;
    if (node == null) {
      return const [ListTile(title: Text('Starts once this till is signed in to the venue.'))];
    }
    final peers = node.peers.values.toList()..sort((a, b) => a.name.compareTo(b.name));
    return [
      ListTile(
        leading: Icon(node.isHub || node.linked ? Icons.lan : Icons.lan_outlined,
            color: node.isHub || node.linked ? _C.green : _C.amber),
        title: Text(node.isHub ? 'This is the main till · ${node.clientCount} connected' : node.linked ? 'Linked to the main till' : 'Looking for the main till'),
        subtitle: const Text('Tables, kitchen tickets and displays go between the venue\'s devices over this network.'),
      ),
      for (final p in peers)
        ListTile(
          dense: true,
          leading: Icon(p.claimsHub ? Icons.star : Icons.circle, size: 14, color: _C.brandDeep),
          title: Text(p.name),
          subtitle: Text('${p.role} · ${p.address.address}'),
        ),
    ];
  }

  // ---- bluetooth -----------------------------------------------------------

  List<Widget> _bluetooth(HardwareSnapshot s) {
    final radio = s.radio('bluetooth');
    final adapter = s.devices.where((d) => d.kind == 'bluetooth-radio').firstOrNull;
    final paired = s.devices.where((d) => d.kind == 'bluetooth').toList()..sort((a, b) => a.name.compareTo(b.name));
    return [
      if (radio == null)
        const ListTile(leading: Icon(Icons.bluetooth_disabled), title: Text('No Bluetooth on this PC'))
      else
        SwitchListTile(
          secondary: Icon(radio.on ? Icons.bluetooth : Icons.bluetooth_disabled, color: radio.on ? _C.indigo : _C.graphite),
          title: Text(radio.on ? 'Bluetooth on' : 'Bluetooth off'),
          subtitle: Text(adapter?.name ?? radio.name),
          value: radio.on,
          onChanged: _busy.contains('bt')
              ? null
              : (on) async {
                  if (!on &&
                      paired.isNotEmpty &&
                      !await _confirm('Turn Bluetooth off?',
                          'Bluetooth printers, scanners and card readers paired with this PC stop working until it is back on.')) {
                    return;
                  }
                  await _do('bt', () => _hw.setRadio('bluetooth', on), 'Bluetooth ${on ? 'on' : 'off'}.');
                },
        ),
      if (adapter != null)
        ListTile(
          leading: const Icon(Icons.restart_alt),
          title: const Text('Restart Bluetooth'),
          subtitle: Text('When a paired printer or reader will not connect. ${adapter.problemText}.'),
          trailing: _busyOr(
            'bt-restart',
            OutlinedButton(
              onPressed: () async {
                if (!await _confirm('Restart Bluetooth?', 'Paired devices drop off for a few seconds and connect again.')) return;
                await _do('bt-restart', () => _hw.restartDevice(adapter.id), 'Bluetooth restarted.');
              },
              child: const Text('Restart'),
            ),
          ),
        ),
      if (paired.isEmpty)
        const ListTile(dense: true, title: Text('Nothing paired'), subtitle: Text('Pair in Windows Settings > Bluetooth & devices.'))
      else
        for (final d in paired)
          ListTile(
            dense: true,
            leading: Icon(Icons.bluetooth_connected, size: 20, color: d.working ? _C.indigo : _C.graphite),
            title: Text(d.name),
            subtitle: Text(d.working ? 'Paired' : d.problemText),
          ),
    ];
  }

  // ---- usb -----------------------------------------------------------------

  List<Widget> _usb(HardwareSnapshot s) {
    final list = s.devices.where((d) => d.kind == 'usb' || d.kind == 'usb-printer' || d.kind == 'serial').toList()
      ..sort((a, b) {
        if (a.working != b.working) return a.working ? 1 : -1;
        return a.name.compareTo(b.name);
      });
    if (list.isEmpty) return const [ListTile(title: Text('Nothing plugged in by USB'))];
    return [
      for (final d in list)
        ListTile(
          dense: true,
          leading: Icon(
            switch (d.kind) { 'usb-printer' => Icons.print, 'serial' => Icons.cable, _ => _usbIcon(d.cls) },
            color: d.working ? _C.green : _C.red,
          ),
          title: Text(d.name),
          subtitle: Text('${d.cls.isEmpty ? 'USB' : d.cls} · ${d.problemText}'),
          trailing: _busyOr(
            'dev-${d.id}',
            IconButton(
              tooltip: 'Restart this device',
              icon: const Icon(Icons.restart_alt),
              onPressed: () async {
                if (!await _confirm('Restart ${d.name}?',
                    'Windows stops and starts it again, as if it were unplugged and plugged back in. Wait until nothing is printing.')) {
                  return;
                }
                await _do('dev-${d.id}', () => _hw.restartDevice(d.id), '${d.name} restarted.');
              },
            ),
          ),
        ),
    ];
  }

  IconData _usbIcon(String cls) => switch (cls) {
        'HIDClass' || 'Keyboard' => Icons.keyboard,
        'Mouse' => Icons.mouse,
        'Image' || 'Camera' => Icons.photo_camera,
        'Printer' => Icons.print,
        'MEDIA' || 'AudioEndpoint' => Icons.speaker,
        'DiskDrive' => Icons.sd_storage,
        _ => Icons.usb,
      };

  // ---- restart -------------------------------------------------------------

  List<Widget> _restart() => [
        ListTile(
          leading: const Icon(Icons.restart_alt, color: _C.red),
          title: const Text('Restart this PC'),
          subtitle: const Text('When nothing else has fixed it. The till starts again by itself; open bills stay open.'),
          trailing: OutlinedButton(
            onPressed: () async {
              if (!await _confirm('Restart this PC?',
                  'Windows restarts in 10 seconds. Finish any card payment first. Sales not yet sent wait on the till and go when it is back.',
                  yes: 'Restart')) {
                return;
              }
              await _hw.restartPc();
              if (!mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                content: const Text('Restarting in 10 seconds.'),
                duration: const Duration(seconds: 10),
                action: SnackBarAction(label: 'Stop', onPressed: _hw.cancelPcRestart),
              ));
            },
            child: const Text('Restart'),
          ),
        ),
      ];
}
