import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_go/nfc/staff_card.dart';

void main() {
  test('the SELECT asks for the Vesopa members card id', () {
    expect(StaffCardReader.selectMember, [0x00, 0xA4, 0x04, 0x00, 8, 0xF0, 0x56, 0x45, 0x53, 0x4F, 0x50, 0x41, 0x01, 0x00]);
  });

  test("a phone or watch's answer gives the code its QR shows", () {
    final answer = Uint8List.fromList([...utf8.encode('LRFC-000123'), 0x90, 0x00]);
    expect(StaffCardReader.memberCodeFrom(answer), 'LRFC-000123');
  });

  test('no card signed in (6A 82), or nonsense, gives nothing', () {
    expect(StaffCardReader.memberCodeFrom(Uint8List.fromList([0x6A, 0x82])), isNull);
    expect(StaffCardReader.memberCodeFrom(Uint8List.fromList([0x90, 0x00])), isNull);
    expect(StaffCardReader.memberCodeFrom(Uint8List.fromList([0xFF, 0xFE, 0x90, 0x00])), isNull);
  });
}
