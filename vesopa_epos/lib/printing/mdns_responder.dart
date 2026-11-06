import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

/// Tells phones on this network that a printer is here (multicast DNS).
///
/// iPhones, iPads and Android look for `_ipp._tcp` when somebody presses Print.
/// A till answers for each drive that allows it, and the phone lists it like any
/// other printer. Our own small responder rather than a package, because all it
/// ever has to do is answer that one question.

const _a = 1, _ptr = 12, _txt = 16, _srv = 33, _any = 255;
const _flushClass = 0x8001; // IN, with the cache-flush bit
const _inClass = 0x0001;
const serviceType = '_ipp._tcp.local';
const universalType = '_universal._sub._ipp._tcp.local';
const browseType = '_services._dns-sd._udp.local';

/// One printer as the network sees it.
class AnnouncedPrinter {
  const AnnouncedPrinter({required this.name, required this.port, required this.path, required this.txt});
  final String name;
  final int port;
  final String path;
  final Map<String, String> txt;
  String get instance => '$name.$serviceType';
}

/// What a phone needs in the TXT record to take this for a printer.
Map<String, String> airPrintTxt({required String name, required String path, required String id}) => {
  'txtvers': '1',
  'qtotal': '1',
  'rp': path,
  'ty': name,
  'note': 'Vesopa',
  'product': '(Vesopa Print)',
  'pdl': 'application/pdf,image/urf,image/jpeg,image/png',
  'URF': 'CP1,MT1,RS300,SRGB24,W8,DM1,IS1',
  'Color': 'T',
  'Duplex': 'F',
  'Copies': 'T',
  'kind': 'document,envelope',
  'PaperMax': 'legal-A4',
  'printer-state': '3',
  'printer-type': '0x801046',
  'TLS': '',
  'UUID': id,
};

void _name(BytesBuilder out, String name) {
  for (final label in name.split('.')) {
    final bytes = utf8.encode(label);
    final cut = bytes.length > 63 ? bytes.sublist(0, 63) : bytes;
    out
      ..addByte(cut.length)
      ..add(cut);
  }
  out.addByte(0);
}

void _u16(BytesBuilder out, int v) => out.add([v >> 8 & 0xFF, v & 0xFF]);
void _u32(BytesBuilder out, int v) => out.add([v >> 24 & 0xFF, v >> 16 & 0xFF, v >> 8 & 0xFF, v & 0xFF]);

void _record(BytesBuilder out, String name, int type, int cls, int ttl, List<int> data) {
  _name(out, name);
  _u16(out, type);
  _u16(out, cls);
  _u32(out, ttl);
  _u16(out, data.length);
  out.add(data);
}

List<int> _nameBytes(String name) {
  final b = BytesBuilder();
  _name(b, name);
  return b.takeBytes();
}

List<int> _txtBytes(Map<String, String> txt) {
  final b = BytesBuilder();
  txt.forEach((k, v) {
    final item = utf8.encode('$k=$v');
    b
      ..addByte(item.length.clamp(0, 255))
      ..add(item.length > 255 ? item.sublist(0, 255) : item);
  });
  return b.takeBytes();
}

/// A full answer for [printers]. [ttl] 0 says goodbye.
Uint8List buildAnswer(List<AnnouncedPrinter> printers, String host, List<String> ips, {int ttl = 120}) {
  final body = BytesBuilder();
  var count = 0;
  void add(String name, int type, int cls, List<int> data) {
    _record(body, name, type, cls, ttl, data);
    count++;
  }

  for (final p in printers) {
    add(browseType, _ptr, _inClass, _nameBytes(serviceType));
    add(serviceType, _ptr, _inClass, _nameBytes(p.instance));
    add(universalType, _ptr, _inClass, _nameBytes(p.instance));
    final srv = BytesBuilder();
    _u16(srv, 0);
    _u16(srv, 0);
    _u16(srv, p.port);
    srv.add(_nameBytes(host));
    add(p.instance, _srv, _flushClass, srv.takeBytes());
    add(p.instance, _txt, _flushClass, _txtBytes(p.txt));
  }
  for (final ip in ips) {
    add(host, _a, _flushClass, InternetAddress(ip).rawAddress);
  }
  final head = BytesBuilder();
  _u16(head, 0);
  _u16(head, 0x8400);
  _u16(head, 0);
  _u16(head, count);
  _u16(head, 0);
  _u16(head, 0);
  head.add(body.takeBytes());
  return head.takeBytes();
}

/// The questions in a packet, as lower-case name and type. Empty if it is an
/// answer, or anything that does not parse.
List<(String, int)> parseQuestions(Uint8List p) {
  if (p.length < 12 || p[2] & 0x80 != 0) return const [];
  final count = p[4] << 8 | p[5];
  final out = <(String, int)>[];
  var at = 12;
  (String, int) name(int start) {
    final labels = <String>[];
    var i = start;
    var end = -1;
    var hops = 0;
    while (true) {
      if (i >= p.length || ++hops > 64) throw const FormatException();
      final len = p[i];
      if (len == 0) {
        i++;
        break;
      }
      if (len & 0xC0 == 0xC0) {
        if (i + 1 >= p.length) throw const FormatException();
        end = end < 0 ? i + 2 : end;
        i = (len & 0x3F) << 8 | p[i + 1];
        continue;
      }
      if (i + 1 + len > p.length) throw const FormatException();
      labels.add(utf8.decode(p.sublist(i + 1, i + 1 + len), allowMalformed: true));
      i += len + 1;
    }
    return (labels.join('.').toLowerCase(), end < 0 ? i : end);
  }

  try {
    for (var q = 0; q < count; q++) {
      final (n, next) = name(at);
      if (next + 4 > p.length) break;
      out.add((n, p[next] << 8 | p[next + 1]));
      at = next + 4;
    }
  } on FormatException {
    return const [];
  }
  return out;
}

/// Whether [questions] are asking about something a printer here answers.
bool asksForPrinters(List<(String, int)> questions, List<AnnouncedPrinter> printers, String host) {
  final names = {
    serviceType,
    universalType,
    browseType,
    host.toLowerCase(),
    for (final p in printers) p.instance.toLowerCase(),
  };
  return questions.any((q) => names.contains(q.$1) && {_ptr, _srv, _txt, _a, _any}.contains(q.$2));
}

class MdnsResponder {
  static final _group = InternetAddress('224.0.0.251');
  static const _port = 5353;

  List<AnnouncedPrinter> printers = const [];
  RawDatagramSocket? _socket;
  Timer? _announce;
  String _host = 'vesopa-print.local';
  List<String> _ips = const [];

  /// Starts, or changes what is announced. Never throws: a till that cannot
  /// announce still prints, and its drives still work by link.
  Future<void> update(List<AnnouncedPrinter> next, String hostLabel) async {
    printers = next;
    _host = '$hostLabel.local';
    if (next.isEmpty) return stop();
    try {
      await _refreshAddresses();
      _socket ??= await _open();
      _announce ??= Timer.periodic(const Duration(seconds: 60), (_) => _send());
      _send();
    } catch (_) {
      // Port 5353 refused: nothing more to do here.
    }
  }

  Future<RawDatagramSocket> _open() async {
    final s = await RawDatagramSocket.bind(InternetAddress.anyIPv4, _port, reuseAddress: true);
    s.multicastHops = 255;
    for (final nic in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
      try {
        s.joinMulticast(_group, nic);
      } catch (_) {
        // A virtual adapter that will not join: the others still answer.
      }
    }
    s.listen((event) {
      if (event != RawSocketEvent.read) return;
      final d = s.receive();
      if (d == null) return;
      if (asksForPrinters(parseQuestions(d.data), printers, _host)) _send();
    });
    return s;
  }

  Future<void> _refreshAddresses() async {
    _ips = [
      for (final nic in await NetworkInterface.list(type: InternetAddressType.IPv4))
        for (final a in nic.addresses)
          if (!a.isLoopback) a.address,
    ];
  }

  void _send({int ttl = 120}) {
    if (printers.isEmpty || _ips.isEmpty) return;
    _socket?.send(buildAnswer(printers, _host, _ips, ttl: ttl), _group, _port);
  }

  Future<void> stop() async {
    _send(ttl: 0);
    _announce?.cancel();
    _announce = null;
    _socket?.close();
    _socket = null;
  }
}
