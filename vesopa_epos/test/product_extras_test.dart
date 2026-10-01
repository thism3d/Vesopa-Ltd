// The product fields the step-by-step editor added (2026-10-01), as the till
// keeps them from the catalogue sync.

import 'package:flutter_test/flutter_test.dart';
import 'package:vesopa_epos/data/product_extras.dart';

void main() {
  test('a catalogue row keeps only the extra fields, and reads back', () {
    final stored = ProductExtras.encodeFrom({
      'product_name': 'Cheddar',
      'short_description': 'Mature',
      'calories': 402,
      'dietary': '["vegetarian"]',
      'is_weighted': 1,
      'min_stock': '2.5',
    });
    expect(stored, isNot(contains('product_name')));
    final x = ProductExtras.decode(stored);
    expect(x.shortDescription, 'Mature');
    expect(x.calories, 402);
    expect(x.dietary, ['vegetarian']);
    expect(x.isWeighted, isTrue);
    expect(x.manualWeight, isFalse);
    expect(x.minStock, 2.5);
  });

  test('an older server with none of them stores nothing', () {
    expect(ProductExtras.encodeFrom({'product_name': 'Crisps'}), isNull);
    expect(ProductExtras.decode(null).isWeighted, isFalse);
    expect(ProductExtras.decode('not json').calories, isNull);
  });

  test('the description goes between the till box and the server safely', () {
    expect(ProductExtras.toHtml('Aged <12> months\nin caves\n\nServed cold'),
        '<p>Aged &lt;12&gt; months<br>in caves</p><p>Served cold</p>');
    expect(ProductExtras.plain('<p>Aged &lt;12&gt; months<br>in caves</p><p>Served cold</p>'),
        'Aged <12> months\nin caves\nServed cold');
    expect(ProductExtras.decodeCodes('["peanuts","milk"]'), ['peanuts', 'milk']);
  });
}
