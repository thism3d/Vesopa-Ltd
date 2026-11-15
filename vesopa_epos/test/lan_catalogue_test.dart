import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:vesopa_epos/data/lan/lan_catalogue.dart';
import 'package:vesopa_epos/data/lan/lan_link.dart';

/// A slave till takes the menu, prices and staff from the master when the
/// back office cannot be reached (owner, 2026-11-15).
void main() {
  late Directory tmp;
  late LanCatalogue master;
  late LanCatalogue slave;
  final published = <String, Object?>{};

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('lan-cat');
    published.clear();
    master = LanCatalogue.forTest()
      ..directory = (() async => Directory('${tmp.path}/master'))
      ..linked = (() => true)
      ..isHub = (() => true)
      ..publish = (channel, data, {key}) {
        published[key ?? ''] = data;
        return true;
      };
    slave = LanCatalogue.forTest()
      ..directory = (() async => Directory('${tmp.path}/slave'))
      ..linked = (() => true)
      ..isHub = (() => false)
      ..publish = ((channel, data, {key}) => true)
      ..request = ((channel, data) => master.answer(data));
  });

  tearDown(() => tmp.delete(recursive: true));

  const menu = '[{"pluid":1,"product_name":"Café latte £","price":3.2}]';

  test('the master keeps the back office answer; a slave with no internet reads it from the master', () async {
    final fromCloud = await master.fetch('products', () async => http.Response.bytes(utf8.encode(menu), 200));
    expect(fromCloud.statusCode, 200);
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(published.containsKey('products'), isTrue, reason: 'the link hears there is a new menu');

    final res = await slave.fetch('products', () async => throw const SocketException('no internet'));
    expect(res.statusCode, 200);
    expect(jsonDecode(res.body), jsonDecode(menu), reason: 'the same words, accents and pound signs included');
  });

  test('with no link and no internet the failure is the one the till always had', () async {
    slave.linked = () => false;
    expect(
      () => slave.fetch('products', () async => throw const SocketException('no internet')),
      throwsA(isA<SocketException>()),
    );
  });

  test('a till refused by the back office is not handed the list by the master', () async {
    await master.fetch('staff', () async => http.Response('[{"pin":"1234"}]', 200));
    final res = await slave.fetch('staff', () async => http.Response('{"error":"signed out"}', 401));
    expect(res.statusCode, 401);
  });

  test('hearing the master has a newer list runs the downloads again, once', () async {
    final asked = <Set<String>>[];
    slave.onNewer = (keys) async => asked.add(keys);
    LanMessage note(String key) => LanMessage(channel: 'catalogue', key: key, data: const {'hash': 'new'}, from: 'till-m', at: 0);
    await slave.heard(note('products'));
    await slave.heard(note('staff'));
    await Future<void>.delayed(const Duration(milliseconds: 2400));
    expect(asked, [
      {'products', 'staff'},
    ]);
    // The master itself never chases its own notes.
    master.onNewer = (keys) async => fail('the master asked itself');
    await master.heard(note('products'));
    await Future<void>.delayed(const Duration(milliseconds: 2400));
  });
}
