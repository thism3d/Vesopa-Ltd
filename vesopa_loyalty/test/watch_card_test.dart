import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_loyalty/data/brand.dart';
import 'package:vesopa_loyalty/data/watch_card.dart';

void main() {
  const brand = Brand(
    slug: 'thevesopakitchen',
    name: 'The Vesopa Kitchen',
    venue: 'The Vesopa Kitchen',
    welcome: '',
    primary: Color(0xFFA5C715),
    accent: Color(0xFF111111),
    background: Colors.white,
    text: Colors.black,
    minRedeem: 100,
  );

  test('the demo card reads on the watch as the screenshots show it', () {
    final card = watchCard(
      brand: brand,
      me: {
        'qr': '999800122',
        'card_number': '999800122',
        'points': 2014,
        'points_value_minor': 2014,
        'tier': 'Platinum',
        'visits': 17,
        'last_visit': '2026-09-13T12:00:00Z',
        'membership': {'expiry': '2027-05-26', 'expired': false},
      },
      messages: {
        'items': [
          {'title': 'Five pounds off at 500 points', 'sent_at': '2026-09-13T09:00:00Z', 'read_at': null},
          {'title': 'Kitchen open late on Fridays', 'sent_at': '2026-09-12T09:00:00Z', 'read_at': '2026-09-12T10:00:00Z'},
          {'title': 'New on the menu', 'sent_at': '2026-09-12T08:00:00Z', 'read_at': '2026-09-12T10:00:00Z'},
          {'title': 'A fourth', 'sent_at': '2026-09-11T08:00:00Z', 'read_at': null},
        ],
      },
    );
    expect(card['title'], 'Kitchen');
    expect(card['number'], '9998 0012 2');
    expect(card['worth'], 'worth £20.14');
    expect(card['canSpend'], true);
    expect(card['spendNote'], 'Enough to spend');
    expect(card['rows'], [
      ['Visits', '17'],
      ['Last visit', '13 Sep'],
      ['Until', '26 May 2027'],
      ['Spend from', '100 pts'],
    ]);
    final news = card['news'] as List;
    expect(news, hasLength(3));
    expect((news.first as Map)['unread'], true);
    expect((news[1] as Map)['unread'], false);
  });

  test('short of spending says how far', () {
    final card = watchCard(brand: brand, me: {'points': 60, 'qr': '1'});
    expect(card['canSpend'], false);
    expect(card['spendNote'], '40 more to spend');
  });

  test('watch titles fit about ten letters', () {
    expect(watchTitle('The Vesopa Kitchen'), 'Kitchen');
    expect(watchTitle('Pontardawe RFC'), 'Pontardawe');
    expect(watchTitle('The Anchor'), 'Anchor');
  });
}
