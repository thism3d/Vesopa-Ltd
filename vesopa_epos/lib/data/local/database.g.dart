// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'database.dart';

// ignore_for_file: type=lint
class $ProductsTable extends Products with TableInfo<$ProductsTable, Product> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ProductsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _pluIdMeta = const VerificationMeta('pluId');
  @override
  late final GeneratedColumn<int> pluId = GeneratedColumn<int>(
    'plu_id',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _departmentNameMeta = const VerificationMeta(
    'departmentName',
  );
  @override
  late final GeneratedColumn<String> departmentName = GeneratedColumn<String>(
    'department_name',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _groupNameMeta = const VerificationMeta(
    'groupName',
  );
  @override
  late final GeneratedColumn<String> groupName = GeneratedColumn<String>(
    'group_name',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _accountingCodeMeta = const VerificationMeta(
    'accountingCode',
  );
  @override
  late final GeneratedColumn<String> accountingCode = GeneratedColumn<String>(
    'accounting_code',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _priceMinorMeta = const VerificationMeta(
    'priceMinor',
  );
  @override
  late final GeneratedColumn<int> priceMinor = GeneratedColumn<int>(
    'price_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _taxPercentageMeta = const VerificationMeta(
    'taxPercentage',
  );
  @override
  late final GeneratedColumn<double> taxPercentage = GeneratedColumn<double>(
    'tax_percentage',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _stockQuantityMeta = const VerificationMeta(
    'stockQuantity',
  );
  @override
  late final GeneratedColumn<double> stockQuantity = GeneratedColumn<double>(
    'stock_quantity',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _buttonPositionMeta = const VerificationMeta(
    'buttonPosition',
  );
  @override
  late final GeneratedColumn<int> buttonPosition = GeneratedColumn<int>(
    'button_position',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _buttonColorMeta = const VerificationMeta(
    'buttonColor',
  );
  @override
  late final GeneratedColumn<String> buttonColor = GeneratedColumn<String>(
    'button_color',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _printerRouteMeta = const VerificationMeta(
    'printerRoute',
  );
  @override
  late final GeneratedColumn<String> printerRoute = GeneratedColumn<String>(
    'printer_route',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _emojiMeta = const VerificationMeta('emoji');
  @override
  late final GeneratedColumn<String> emoji = GeneratedColumn<String>(
    'emoji',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _imageUrlMeta = const VerificationMeta(
    'imageUrl',
  );
  @override
  late final GeneratedColumn<String> imageUrl = GeneratedColumn<String>(
    'image_url',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    pluId,
    name,
    departmentName,
    groupName,
    accountingCode,
    priceMinor,
    taxPercentage,
    stockQuantity,
    buttonPosition,
    buttonColor,
    printerRoute,
    emoji,
    imageUrl,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'products';
  @override
  VerificationContext validateIntegrity(
    Insertable<Product> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('plu_id')) {
      context.handle(
        _pluIdMeta,
        pluId.isAcceptableOrUnknown(data['plu_id']!, _pluIdMeta),
      );
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('department_name')) {
      context.handle(
        _departmentNameMeta,
        departmentName.isAcceptableOrUnknown(
          data['department_name']!,
          _departmentNameMeta,
        ),
      );
    }
    if (data.containsKey('group_name')) {
      context.handle(
        _groupNameMeta,
        groupName.isAcceptableOrUnknown(data['group_name']!, _groupNameMeta),
      );
    }
    if (data.containsKey('accounting_code')) {
      context.handle(
        _accountingCodeMeta,
        accountingCode.isAcceptableOrUnknown(
          data['accounting_code']!,
          _accountingCodeMeta,
        ),
      );
    }
    if (data.containsKey('price_minor')) {
      context.handle(
        _priceMinorMeta,
        priceMinor.isAcceptableOrUnknown(data['price_minor']!, _priceMinorMeta),
      );
    } else if (isInserting) {
      context.missing(_priceMinorMeta);
    }
    if (data.containsKey('tax_percentage')) {
      context.handle(
        _taxPercentageMeta,
        taxPercentage.isAcceptableOrUnknown(
          data['tax_percentage']!,
          _taxPercentageMeta,
        ),
      );
    }
    if (data.containsKey('stock_quantity')) {
      context.handle(
        _stockQuantityMeta,
        stockQuantity.isAcceptableOrUnknown(
          data['stock_quantity']!,
          _stockQuantityMeta,
        ),
      );
    }
    if (data.containsKey('button_position')) {
      context.handle(
        _buttonPositionMeta,
        buttonPosition.isAcceptableOrUnknown(
          data['button_position']!,
          _buttonPositionMeta,
        ),
      );
    }
    if (data.containsKey('button_color')) {
      context.handle(
        _buttonColorMeta,
        buttonColor.isAcceptableOrUnknown(
          data['button_color']!,
          _buttonColorMeta,
        ),
      );
    }
    if (data.containsKey('printer_route')) {
      context.handle(
        _printerRouteMeta,
        printerRoute.isAcceptableOrUnknown(
          data['printer_route']!,
          _printerRouteMeta,
        ),
      );
    }
    if (data.containsKey('emoji')) {
      context.handle(
        _emojiMeta,
        emoji.isAcceptableOrUnknown(data['emoji']!, _emojiMeta),
      );
    }
    if (data.containsKey('image_url')) {
      context.handle(
        _imageUrlMeta,
        imageUrl.isAcceptableOrUnknown(data['image_url']!, _imageUrlMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {pluId};
  @override
  Product map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Product(
      pluId: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}plu_id'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      departmentName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}department_name'],
      ),
      groupName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}group_name'],
      ),
      accountingCode: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}accounting_code'],
      ),
      priceMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}price_minor'],
      )!,
      taxPercentage: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}tax_percentage'],
      )!,
      stockQuantity: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}stock_quantity'],
      )!,
      buttonPosition: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}button_position'],
      ),
      buttonColor: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}button_color'],
      ),
      printerRoute: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}printer_route'],
      ),
      emoji: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}emoji'],
      ),
      imageUrl: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}image_url'],
      ),
    );
  }

  @override
  $ProductsTable createAlias(String alias) {
    return $ProductsTable(attachedDatabase, alias);
  }
}

class Product extends DataClass implements Insertable<Product> {
  final int pluId;
  final String name;
  final String? departmentName;
  final String? groupName;
  final String? accountingCode;

  /// Minor units (pence). Money is never stored as a double.
  final int priceMinor;
  final double taxPercentage;
  final double stockQuantity;

  /// Where this product sits on the till grid. Null means "unassigned" — it
  /// still appears, just after the positioned ones.
  final int? buttonPosition;

  /// Overrides the department colour for this one button.
  final String? buttonColor;

  /// Which kitchen printer this item routes to (e.g. "kitchen", "bar").
  /// Null means it is not sent to the kitchen at all.
  final String? printerRoute;

  /// An emoji shown large on the till button, and an optional uploaded image
  /// which takes precedence over the emoji when present.
  final String? emoji;
  final String? imageUrl;
  const Product({
    required this.pluId,
    required this.name,
    this.departmentName,
    this.groupName,
    this.accountingCode,
    required this.priceMinor,
    required this.taxPercentage,
    required this.stockQuantity,
    this.buttonPosition,
    this.buttonColor,
    this.printerRoute,
    this.emoji,
    this.imageUrl,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['plu_id'] = Variable<int>(pluId);
    map['name'] = Variable<String>(name);
    if (!nullToAbsent || departmentName != null) {
      map['department_name'] = Variable<String>(departmentName);
    }
    if (!nullToAbsent || groupName != null) {
      map['group_name'] = Variable<String>(groupName);
    }
    if (!nullToAbsent || accountingCode != null) {
      map['accounting_code'] = Variable<String>(accountingCode);
    }
    map['price_minor'] = Variable<int>(priceMinor);
    map['tax_percentage'] = Variable<double>(taxPercentage);
    map['stock_quantity'] = Variable<double>(stockQuantity);
    if (!nullToAbsent || buttonPosition != null) {
      map['button_position'] = Variable<int>(buttonPosition);
    }
    if (!nullToAbsent || buttonColor != null) {
      map['button_color'] = Variable<String>(buttonColor);
    }
    if (!nullToAbsent || printerRoute != null) {
      map['printer_route'] = Variable<String>(printerRoute);
    }
    if (!nullToAbsent || emoji != null) {
      map['emoji'] = Variable<String>(emoji);
    }
    if (!nullToAbsent || imageUrl != null) {
      map['image_url'] = Variable<String>(imageUrl);
    }
    return map;
  }

  ProductsCompanion toCompanion(bool nullToAbsent) {
    return ProductsCompanion(
      pluId: Value(pluId),
      name: Value(name),
      departmentName: departmentName == null && nullToAbsent
          ? const Value.absent()
          : Value(departmentName),
      groupName: groupName == null && nullToAbsent
          ? const Value.absent()
          : Value(groupName),
      accountingCode: accountingCode == null && nullToAbsent
          ? const Value.absent()
          : Value(accountingCode),
      priceMinor: Value(priceMinor),
      taxPercentage: Value(taxPercentage),
      stockQuantity: Value(stockQuantity),
      buttonPosition: buttonPosition == null && nullToAbsent
          ? const Value.absent()
          : Value(buttonPosition),
      buttonColor: buttonColor == null && nullToAbsent
          ? const Value.absent()
          : Value(buttonColor),
      printerRoute: printerRoute == null && nullToAbsent
          ? const Value.absent()
          : Value(printerRoute),
      emoji: emoji == null && nullToAbsent
          ? const Value.absent()
          : Value(emoji),
      imageUrl: imageUrl == null && nullToAbsent
          ? const Value.absent()
          : Value(imageUrl),
    );
  }

  factory Product.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Product(
      pluId: serializer.fromJson<int>(json['pluId']),
      name: serializer.fromJson<String>(json['name']),
      departmentName: serializer.fromJson<String?>(json['departmentName']),
      groupName: serializer.fromJson<String?>(json['groupName']),
      accountingCode: serializer.fromJson<String?>(json['accountingCode']),
      priceMinor: serializer.fromJson<int>(json['priceMinor']),
      taxPercentage: serializer.fromJson<double>(json['taxPercentage']),
      stockQuantity: serializer.fromJson<double>(json['stockQuantity']),
      buttonPosition: serializer.fromJson<int?>(json['buttonPosition']),
      buttonColor: serializer.fromJson<String?>(json['buttonColor']),
      printerRoute: serializer.fromJson<String?>(json['printerRoute']),
      emoji: serializer.fromJson<String?>(json['emoji']),
      imageUrl: serializer.fromJson<String?>(json['imageUrl']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'pluId': serializer.toJson<int>(pluId),
      'name': serializer.toJson<String>(name),
      'departmentName': serializer.toJson<String?>(departmentName),
      'groupName': serializer.toJson<String?>(groupName),
      'accountingCode': serializer.toJson<String?>(accountingCode),
      'priceMinor': serializer.toJson<int>(priceMinor),
      'taxPercentage': serializer.toJson<double>(taxPercentage),
      'stockQuantity': serializer.toJson<double>(stockQuantity),
      'buttonPosition': serializer.toJson<int?>(buttonPosition),
      'buttonColor': serializer.toJson<String?>(buttonColor),
      'printerRoute': serializer.toJson<String?>(printerRoute),
      'emoji': serializer.toJson<String?>(emoji),
      'imageUrl': serializer.toJson<String?>(imageUrl),
    };
  }

  Product copyWith({
    int? pluId,
    String? name,
    Value<String?> departmentName = const Value.absent(),
    Value<String?> groupName = const Value.absent(),
    Value<String?> accountingCode = const Value.absent(),
    int? priceMinor,
    double? taxPercentage,
    double? stockQuantity,
    Value<int?> buttonPosition = const Value.absent(),
    Value<String?> buttonColor = const Value.absent(),
    Value<String?> printerRoute = const Value.absent(),
    Value<String?> emoji = const Value.absent(),
    Value<String?> imageUrl = const Value.absent(),
  }) => Product(
    pluId: pluId ?? this.pluId,
    name: name ?? this.name,
    departmentName: departmentName.present
        ? departmentName.value
        : this.departmentName,
    groupName: groupName.present ? groupName.value : this.groupName,
    accountingCode: accountingCode.present
        ? accountingCode.value
        : this.accountingCode,
    priceMinor: priceMinor ?? this.priceMinor,
    taxPercentage: taxPercentage ?? this.taxPercentage,
    stockQuantity: stockQuantity ?? this.stockQuantity,
    buttonPosition: buttonPosition.present
        ? buttonPosition.value
        : this.buttonPosition,
    buttonColor: buttonColor.present ? buttonColor.value : this.buttonColor,
    printerRoute: printerRoute.present ? printerRoute.value : this.printerRoute,
    emoji: emoji.present ? emoji.value : this.emoji,
    imageUrl: imageUrl.present ? imageUrl.value : this.imageUrl,
  );
  Product copyWithCompanion(ProductsCompanion data) {
    return Product(
      pluId: data.pluId.present ? data.pluId.value : this.pluId,
      name: data.name.present ? data.name.value : this.name,
      departmentName: data.departmentName.present
          ? data.departmentName.value
          : this.departmentName,
      groupName: data.groupName.present ? data.groupName.value : this.groupName,
      accountingCode: data.accountingCode.present
          ? data.accountingCode.value
          : this.accountingCode,
      priceMinor: data.priceMinor.present
          ? data.priceMinor.value
          : this.priceMinor,
      taxPercentage: data.taxPercentage.present
          ? data.taxPercentage.value
          : this.taxPercentage,
      stockQuantity: data.stockQuantity.present
          ? data.stockQuantity.value
          : this.stockQuantity,
      buttonPosition: data.buttonPosition.present
          ? data.buttonPosition.value
          : this.buttonPosition,
      buttonColor: data.buttonColor.present
          ? data.buttonColor.value
          : this.buttonColor,
      printerRoute: data.printerRoute.present
          ? data.printerRoute.value
          : this.printerRoute,
      emoji: data.emoji.present ? data.emoji.value : this.emoji,
      imageUrl: data.imageUrl.present ? data.imageUrl.value : this.imageUrl,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Product(')
          ..write('pluId: $pluId, ')
          ..write('name: $name, ')
          ..write('departmentName: $departmentName, ')
          ..write('groupName: $groupName, ')
          ..write('accountingCode: $accountingCode, ')
          ..write('priceMinor: $priceMinor, ')
          ..write('taxPercentage: $taxPercentage, ')
          ..write('stockQuantity: $stockQuantity, ')
          ..write('buttonPosition: $buttonPosition, ')
          ..write('buttonColor: $buttonColor, ')
          ..write('printerRoute: $printerRoute, ')
          ..write('emoji: $emoji, ')
          ..write('imageUrl: $imageUrl')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    pluId,
    name,
    departmentName,
    groupName,
    accountingCode,
    priceMinor,
    taxPercentage,
    stockQuantity,
    buttonPosition,
    buttonColor,
    printerRoute,
    emoji,
    imageUrl,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Product &&
          other.pluId == this.pluId &&
          other.name == this.name &&
          other.departmentName == this.departmentName &&
          other.groupName == this.groupName &&
          other.accountingCode == this.accountingCode &&
          other.priceMinor == this.priceMinor &&
          other.taxPercentage == this.taxPercentage &&
          other.stockQuantity == this.stockQuantity &&
          other.buttonPosition == this.buttonPosition &&
          other.buttonColor == this.buttonColor &&
          other.printerRoute == this.printerRoute &&
          other.emoji == this.emoji &&
          other.imageUrl == this.imageUrl);
}

class ProductsCompanion extends UpdateCompanion<Product> {
  final Value<int> pluId;
  final Value<String> name;
  final Value<String?> departmentName;
  final Value<String?> groupName;
  final Value<String?> accountingCode;
  final Value<int> priceMinor;
  final Value<double> taxPercentage;
  final Value<double> stockQuantity;
  final Value<int?> buttonPosition;
  final Value<String?> buttonColor;
  final Value<String?> printerRoute;
  final Value<String?> emoji;
  final Value<String?> imageUrl;
  const ProductsCompanion({
    this.pluId = const Value.absent(),
    this.name = const Value.absent(),
    this.departmentName = const Value.absent(),
    this.groupName = const Value.absent(),
    this.accountingCode = const Value.absent(),
    this.priceMinor = const Value.absent(),
    this.taxPercentage = const Value.absent(),
    this.stockQuantity = const Value.absent(),
    this.buttonPosition = const Value.absent(),
    this.buttonColor = const Value.absent(),
    this.printerRoute = const Value.absent(),
    this.emoji = const Value.absent(),
    this.imageUrl = const Value.absent(),
  });
  ProductsCompanion.insert({
    this.pluId = const Value.absent(),
    required String name,
    this.departmentName = const Value.absent(),
    this.groupName = const Value.absent(),
    this.accountingCode = const Value.absent(),
    required int priceMinor,
    this.taxPercentage = const Value.absent(),
    this.stockQuantity = const Value.absent(),
    this.buttonPosition = const Value.absent(),
    this.buttonColor = const Value.absent(),
    this.printerRoute = const Value.absent(),
    this.emoji = const Value.absent(),
    this.imageUrl = const Value.absent(),
  }) : name = Value(name),
       priceMinor = Value(priceMinor);
  static Insertable<Product> custom({
    Expression<int>? pluId,
    Expression<String>? name,
    Expression<String>? departmentName,
    Expression<String>? groupName,
    Expression<String>? accountingCode,
    Expression<int>? priceMinor,
    Expression<double>? taxPercentage,
    Expression<double>? stockQuantity,
    Expression<int>? buttonPosition,
    Expression<String>? buttonColor,
    Expression<String>? printerRoute,
    Expression<String>? emoji,
    Expression<String>? imageUrl,
  }) {
    return RawValuesInsertable({
      if (pluId != null) 'plu_id': pluId,
      if (name != null) 'name': name,
      if (departmentName != null) 'department_name': departmentName,
      if (groupName != null) 'group_name': groupName,
      if (accountingCode != null) 'accounting_code': accountingCode,
      if (priceMinor != null) 'price_minor': priceMinor,
      if (taxPercentage != null) 'tax_percentage': taxPercentage,
      if (stockQuantity != null) 'stock_quantity': stockQuantity,
      if (buttonPosition != null) 'button_position': buttonPosition,
      if (buttonColor != null) 'button_color': buttonColor,
      if (printerRoute != null) 'printer_route': printerRoute,
      if (emoji != null) 'emoji': emoji,
      if (imageUrl != null) 'image_url': imageUrl,
    });
  }

  ProductsCompanion copyWith({
    Value<int>? pluId,
    Value<String>? name,
    Value<String?>? departmentName,
    Value<String?>? groupName,
    Value<String?>? accountingCode,
    Value<int>? priceMinor,
    Value<double>? taxPercentage,
    Value<double>? stockQuantity,
    Value<int?>? buttonPosition,
    Value<String?>? buttonColor,
    Value<String?>? printerRoute,
    Value<String?>? emoji,
    Value<String?>? imageUrl,
  }) {
    return ProductsCompanion(
      pluId: pluId ?? this.pluId,
      name: name ?? this.name,
      departmentName: departmentName ?? this.departmentName,
      groupName: groupName ?? this.groupName,
      accountingCode: accountingCode ?? this.accountingCode,
      priceMinor: priceMinor ?? this.priceMinor,
      taxPercentage: taxPercentage ?? this.taxPercentage,
      stockQuantity: stockQuantity ?? this.stockQuantity,
      buttonPosition: buttonPosition ?? this.buttonPosition,
      buttonColor: buttonColor ?? this.buttonColor,
      printerRoute: printerRoute ?? this.printerRoute,
      emoji: emoji ?? this.emoji,
      imageUrl: imageUrl ?? this.imageUrl,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (pluId.present) {
      map['plu_id'] = Variable<int>(pluId.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (departmentName.present) {
      map['department_name'] = Variable<String>(departmentName.value);
    }
    if (groupName.present) {
      map['group_name'] = Variable<String>(groupName.value);
    }
    if (accountingCode.present) {
      map['accounting_code'] = Variable<String>(accountingCode.value);
    }
    if (priceMinor.present) {
      map['price_minor'] = Variable<int>(priceMinor.value);
    }
    if (taxPercentage.present) {
      map['tax_percentage'] = Variable<double>(taxPercentage.value);
    }
    if (stockQuantity.present) {
      map['stock_quantity'] = Variable<double>(stockQuantity.value);
    }
    if (buttonPosition.present) {
      map['button_position'] = Variable<int>(buttonPosition.value);
    }
    if (buttonColor.present) {
      map['button_color'] = Variable<String>(buttonColor.value);
    }
    if (printerRoute.present) {
      map['printer_route'] = Variable<String>(printerRoute.value);
    }
    if (emoji.present) {
      map['emoji'] = Variable<String>(emoji.value);
    }
    if (imageUrl.present) {
      map['image_url'] = Variable<String>(imageUrl.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ProductsCompanion(')
          ..write('pluId: $pluId, ')
          ..write('name: $name, ')
          ..write('departmentName: $departmentName, ')
          ..write('groupName: $groupName, ')
          ..write('accountingCode: $accountingCode, ')
          ..write('priceMinor: $priceMinor, ')
          ..write('taxPercentage: $taxPercentage, ')
          ..write('stockQuantity: $stockQuantity, ')
          ..write('buttonPosition: $buttonPosition, ')
          ..write('buttonColor: $buttonColor, ')
          ..write('printerRoute: $printerRoute, ')
          ..write('emoji: $emoji, ')
          ..write('imageUrl: $imageUrl')
          ..write(')'))
        .toString();
  }
}

class $OrdersTable extends Orders with TableInfo<$OrdersTable, Order> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $OrdersTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('open'),
  );
  static const VerificationMeta _tableNumberMeta = const VerificationMeta(
    'tableNumber',
  );
  @override
  late final GeneratedColumn<int> tableNumber = GeneratedColumn<int>(
    'table_number',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _clerkPinMeta = const VerificationMeta(
    'clerkPin',
  );
  @override
  late final GeneratedColumn<String> clerkPin = GeneratedColumn<String>(
    'clerk_pin',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _staffIdMeta = const VerificationMeta(
    'staffId',
  );
  @override
  late final GeneratedColumn<int> staffId = GeneratedColumn<int>(
    'staff_id',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _staffNameMeta = const VerificationMeta(
    'staffName',
  );
  @override
  late final GeneratedColumn<String> staffName = GeneratedColumn<String>(
    'staff_name',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _customerIdMeta = const VerificationMeta(
    'customerId',
  );
  @override
  late final GeneratedColumn<String> customerId = GeneratedColumn<String>(
    'customer_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _splitFromOrderIdMeta = const VerificationMeta(
    'splitFromOrderId',
  );
  @override
  late final GeneratedColumn<String> splitFromOrderId = GeneratedColumn<String>(
    'split_from_order_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _subtotalMinorMeta = const VerificationMeta(
    'subtotalMinor',
  );
  @override
  late final GeneratedColumn<int> subtotalMinor = GeneratedColumn<int>(
    'subtotal_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _manualDiscountMinorMeta =
      const VerificationMeta('manualDiscountMinor');
  @override
  late final GeneratedColumn<int> manualDiscountMinor = GeneratedColumn<int>(
    'manual_discount_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _discountMinorMeta = const VerificationMeta(
    'discountMinor',
  );
  @override
  late final GeneratedColumn<int> discountMinor = GeneratedColumn<int>(
    'discount_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _taxMinorMeta = const VerificationMeta(
    'taxMinor',
  );
  @override
  late final GeneratedColumn<int> taxMinor = GeneratedColumn<int>(
    'tax_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _totalMinorMeta = const VerificationMeta(
    'totalMinor',
  );
  @override
  late final GeneratedColumn<int> totalMinor = GeneratedColumn<int>(
    'total_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _coversMeta = const VerificationMeta('covers');
  @override
  late final GeneratedColumn<int> covers = GeneratedColumn<int>(
    'covers',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _notesMeta = const VerificationMeta('notes');
  @override
  late final GeneratedColumn<String> notes = GeneratedColumn<String>(
    'notes',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _customerNameMeta = const VerificationMeta(
    'customerName',
  );
  @override
  late final GeneratedColumn<String> customerName = GeneratedColumn<String>(
    'customer_name',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _customerDiscountTypeMeta =
      const VerificationMeta('customerDiscountType');
  @override
  late final GeneratedColumn<String> customerDiscountType =
      GeneratedColumn<String>(
        'customer_discount_type',
        aliasedName,
        false,
        type: DriftSqlType.string,
        requiredDuringInsert: false,
        defaultValue: const Constant('none'),
      );
  static const VerificationMeta _customerDiscountValueMeta =
      const VerificationMeta('customerDiscountValue');
  @override
  late final GeneratedColumn<int> customerDiscountValue = GeneratedColumn<int>(
    'customer_discount_value',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _closedAtMeta = const VerificationMeta(
    'closedAt',
  );
  @override
  late final GeneratedColumn<DateTime> closedAt = GeneratedColumn<DateTime>(
    'closed_at',
    aliasedName,
    true,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _syncedAtMeta = const VerificationMeta(
    'syncedAt',
  );
  @override
  late final GeneratedColumn<DateTime> syncedAt = GeneratedColumn<DateTime>(
    'synced_at',
    aliasedName,
    true,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    status,
    tableNumber,
    clerkPin,
    staffId,
    staffName,
    sessionId,
    customerId,
    splitFromOrderId,
    subtotalMinor,
    manualDiscountMinor,
    discountMinor,
    taxMinor,
    totalMinor,
    covers,
    notes,
    customerName,
    customerDiscountType,
    customerDiscountValue,
    createdAt,
    closedAt,
    syncedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'orders';
  @override
  VerificationContext validateIntegrity(
    Insertable<Order> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    }
    if (data.containsKey('table_number')) {
      context.handle(
        _tableNumberMeta,
        tableNumber.isAcceptableOrUnknown(
          data['table_number']!,
          _tableNumberMeta,
        ),
      );
    }
    if (data.containsKey('clerk_pin')) {
      context.handle(
        _clerkPinMeta,
        clerkPin.isAcceptableOrUnknown(data['clerk_pin']!, _clerkPinMeta),
      );
    }
    if (data.containsKey('staff_id')) {
      context.handle(
        _staffIdMeta,
        staffId.isAcceptableOrUnknown(data['staff_id']!, _staffIdMeta),
      );
    }
    if (data.containsKey('staff_name')) {
      context.handle(
        _staffNameMeta,
        staffName.isAcceptableOrUnknown(data['staff_name']!, _staffNameMeta),
      );
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    }
    if (data.containsKey('customer_id')) {
      context.handle(
        _customerIdMeta,
        customerId.isAcceptableOrUnknown(data['customer_id']!, _customerIdMeta),
      );
    }
    if (data.containsKey('split_from_order_id')) {
      context.handle(
        _splitFromOrderIdMeta,
        splitFromOrderId.isAcceptableOrUnknown(
          data['split_from_order_id']!,
          _splitFromOrderIdMeta,
        ),
      );
    }
    if (data.containsKey('subtotal_minor')) {
      context.handle(
        _subtotalMinorMeta,
        subtotalMinor.isAcceptableOrUnknown(
          data['subtotal_minor']!,
          _subtotalMinorMeta,
        ),
      );
    }
    if (data.containsKey('manual_discount_minor')) {
      context.handle(
        _manualDiscountMinorMeta,
        manualDiscountMinor.isAcceptableOrUnknown(
          data['manual_discount_minor']!,
          _manualDiscountMinorMeta,
        ),
      );
    }
    if (data.containsKey('discount_minor')) {
      context.handle(
        _discountMinorMeta,
        discountMinor.isAcceptableOrUnknown(
          data['discount_minor']!,
          _discountMinorMeta,
        ),
      );
    }
    if (data.containsKey('tax_minor')) {
      context.handle(
        _taxMinorMeta,
        taxMinor.isAcceptableOrUnknown(data['tax_minor']!, _taxMinorMeta),
      );
    }
    if (data.containsKey('total_minor')) {
      context.handle(
        _totalMinorMeta,
        totalMinor.isAcceptableOrUnknown(data['total_minor']!, _totalMinorMeta),
      );
    }
    if (data.containsKey('covers')) {
      context.handle(
        _coversMeta,
        covers.isAcceptableOrUnknown(data['covers']!, _coversMeta),
      );
    }
    if (data.containsKey('notes')) {
      context.handle(
        _notesMeta,
        notes.isAcceptableOrUnknown(data['notes']!, _notesMeta),
      );
    }
    if (data.containsKey('customer_name')) {
      context.handle(
        _customerNameMeta,
        customerName.isAcceptableOrUnknown(
          data['customer_name']!,
          _customerNameMeta,
        ),
      );
    }
    if (data.containsKey('customer_discount_type')) {
      context.handle(
        _customerDiscountTypeMeta,
        customerDiscountType.isAcceptableOrUnknown(
          data['customer_discount_type']!,
          _customerDiscountTypeMeta,
        ),
      );
    }
    if (data.containsKey('customer_discount_value')) {
      context.handle(
        _customerDiscountValueMeta,
        customerDiscountValue.isAcceptableOrUnknown(
          data['customer_discount_value']!,
          _customerDiscountValueMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('closed_at')) {
      context.handle(
        _closedAtMeta,
        closedAt.isAcceptableOrUnknown(data['closed_at']!, _closedAtMeta),
      );
    }
    if (data.containsKey('synced_at')) {
      context.handle(
        _syncedAtMeta,
        syncedAt.isAcceptableOrUnknown(data['synced_at']!, _syncedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  Order map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Order(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      )!,
      tableNumber: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}table_number'],
      ),
      clerkPin: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}clerk_pin'],
      ),
      staffId: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}staff_id'],
      ),
      staffName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}staff_name'],
      ),
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      ),
      customerId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}customer_id'],
      ),
      splitFromOrderId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}split_from_order_id'],
      ),
      subtotalMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}subtotal_minor'],
      )!,
      manualDiscountMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}manual_discount_minor'],
      )!,
      discountMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}discount_minor'],
      )!,
      taxMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}tax_minor'],
      )!,
      totalMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}total_minor'],
      )!,
      covers: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}covers'],
      ),
      notes: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}notes'],
      ),
      customerName: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}customer_name'],
      ),
      customerDiscountType: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}customer_discount_type'],
      )!,
      customerDiscountValue: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}customer_discount_value'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
      closedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}closed_at'],
      ),
      syncedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}synced_at'],
      ),
    );
  }

  @override
  $OrdersTable createAlias(String alias) {
    return $OrdersTable(attachedDatabase, alias);
  }
}

class Order extends DataClass implements Insertable<Order> {
  /// UUID, generated on the terminal. Doubles as the server-side idempotency
  /// key so a retried push can never book the same sale twice.
  final String id;

  /// open | closed | void | parked (saved to a table)
  final String status;
  final int? tableNumber;
  final String? clerkPin;

  /// Who settled the sale. Stamped at settlement rather than at open, for the
  /// same reason [sessionId] is: a bill parked across a shift change belongs to
  /// whoever actually took the money for it.
  ///
  /// The name is stored alongside the id because a receipt reprinted next year
  /// should still say who served it, even if that person has since been removed
  /// from the staff list.
  final int? staffId;
  final String? staffName;

  /// The trading period this sale belongs to. Fixed at settlement so a Z
  /// report can never be changed by a later sale.
  final String? sessionId;
  final String? customerId;

  /// Set when this order was split off another; both halves keep the link so
  /// the original bill can still be reconstructed.
  final String? splitFromOrderId;
  final int subtotalMinor;

  /// What the clerk keyed in by hand. Held separately from [discountMinor],
  /// which is the total including automatic mix & match savings — if the two
  /// shared a column, every recalculation would fold the deal saving back in on
  /// top of itself and the discount would grow without limit.
  final int manualDiscountMinor;

  /// Manual discount plus any mix & match savings. This is what the receipt and
  /// the reports show.
  final int discountMinor;
  final int taxMinor;
  final int totalMinor;

  /// Number of diners. Shown as "Covers" on the action bar.
  final int? covers;
  final String? notes;
  final String? customerName;

  /// The attached customer's standing discount, copied onto the order so it can
  /// fold into the total. 'none' | 'percent' | 'amount'; value is whole percent
  /// or pence depending on the type.
  final String customerDiscountType;
  final int customerDiscountValue;
  final DateTime createdAt;
  final DateTime? closedAt;
  final DateTime? syncedAt;
  const Order({
    required this.id,
    required this.status,
    this.tableNumber,
    this.clerkPin,
    this.staffId,
    this.staffName,
    this.sessionId,
    this.customerId,
    this.splitFromOrderId,
    required this.subtotalMinor,
    required this.manualDiscountMinor,
    required this.discountMinor,
    required this.taxMinor,
    required this.totalMinor,
    this.covers,
    this.notes,
    this.customerName,
    required this.customerDiscountType,
    required this.customerDiscountValue,
    required this.createdAt,
    this.closedAt,
    this.syncedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['status'] = Variable<String>(status);
    if (!nullToAbsent || tableNumber != null) {
      map['table_number'] = Variable<int>(tableNumber);
    }
    if (!nullToAbsent || clerkPin != null) {
      map['clerk_pin'] = Variable<String>(clerkPin);
    }
    if (!nullToAbsent || staffId != null) {
      map['staff_id'] = Variable<int>(staffId);
    }
    if (!nullToAbsent || staffName != null) {
      map['staff_name'] = Variable<String>(staffName);
    }
    if (!nullToAbsent || sessionId != null) {
      map['session_id'] = Variable<String>(sessionId);
    }
    if (!nullToAbsent || customerId != null) {
      map['customer_id'] = Variable<String>(customerId);
    }
    if (!nullToAbsent || splitFromOrderId != null) {
      map['split_from_order_id'] = Variable<String>(splitFromOrderId);
    }
    map['subtotal_minor'] = Variable<int>(subtotalMinor);
    map['manual_discount_minor'] = Variable<int>(manualDiscountMinor);
    map['discount_minor'] = Variable<int>(discountMinor);
    map['tax_minor'] = Variable<int>(taxMinor);
    map['total_minor'] = Variable<int>(totalMinor);
    if (!nullToAbsent || covers != null) {
      map['covers'] = Variable<int>(covers);
    }
    if (!nullToAbsent || notes != null) {
      map['notes'] = Variable<String>(notes);
    }
    if (!nullToAbsent || customerName != null) {
      map['customer_name'] = Variable<String>(customerName);
    }
    map['customer_discount_type'] = Variable<String>(customerDiscountType);
    map['customer_discount_value'] = Variable<int>(customerDiscountValue);
    map['created_at'] = Variable<DateTime>(createdAt);
    if (!nullToAbsent || closedAt != null) {
      map['closed_at'] = Variable<DateTime>(closedAt);
    }
    if (!nullToAbsent || syncedAt != null) {
      map['synced_at'] = Variable<DateTime>(syncedAt);
    }
    return map;
  }

  OrdersCompanion toCompanion(bool nullToAbsent) {
    return OrdersCompanion(
      id: Value(id),
      status: Value(status),
      tableNumber: tableNumber == null && nullToAbsent
          ? const Value.absent()
          : Value(tableNumber),
      clerkPin: clerkPin == null && nullToAbsent
          ? const Value.absent()
          : Value(clerkPin),
      staffId: staffId == null && nullToAbsent
          ? const Value.absent()
          : Value(staffId),
      staffName: staffName == null && nullToAbsent
          ? const Value.absent()
          : Value(staffName),
      sessionId: sessionId == null && nullToAbsent
          ? const Value.absent()
          : Value(sessionId),
      customerId: customerId == null && nullToAbsent
          ? const Value.absent()
          : Value(customerId),
      splitFromOrderId: splitFromOrderId == null && nullToAbsent
          ? const Value.absent()
          : Value(splitFromOrderId),
      subtotalMinor: Value(subtotalMinor),
      manualDiscountMinor: Value(manualDiscountMinor),
      discountMinor: Value(discountMinor),
      taxMinor: Value(taxMinor),
      totalMinor: Value(totalMinor),
      covers: covers == null && nullToAbsent
          ? const Value.absent()
          : Value(covers),
      notes: notes == null && nullToAbsent
          ? const Value.absent()
          : Value(notes),
      customerName: customerName == null && nullToAbsent
          ? const Value.absent()
          : Value(customerName),
      customerDiscountType: Value(customerDiscountType),
      customerDiscountValue: Value(customerDiscountValue),
      createdAt: Value(createdAt),
      closedAt: closedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(closedAt),
      syncedAt: syncedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(syncedAt),
    );
  }

  factory Order.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Order(
      id: serializer.fromJson<String>(json['id']),
      status: serializer.fromJson<String>(json['status']),
      tableNumber: serializer.fromJson<int?>(json['tableNumber']),
      clerkPin: serializer.fromJson<String?>(json['clerkPin']),
      staffId: serializer.fromJson<int?>(json['staffId']),
      staffName: serializer.fromJson<String?>(json['staffName']),
      sessionId: serializer.fromJson<String?>(json['sessionId']),
      customerId: serializer.fromJson<String?>(json['customerId']),
      splitFromOrderId: serializer.fromJson<String?>(json['splitFromOrderId']),
      subtotalMinor: serializer.fromJson<int>(json['subtotalMinor']),
      manualDiscountMinor: serializer.fromJson<int>(
        json['manualDiscountMinor'],
      ),
      discountMinor: serializer.fromJson<int>(json['discountMinor']),
      taxMinor: serializer.fromJson<int>(json['taxMinor']),
      totalMinor: serializer.fromJson<int>(json['totalMinor']),
      covers: serializer.fromJson<int?>(json['covers']),
      notes: serializer.fromJson<String?>(json['notes']),
      customerName: serializer.fromJson<String?>(json['customerName']),
      customerDiscountType: serializer.fromJson<String>(
        json['customerDiscountType'],
      ),
      customerDiscountValue: serializer.fromJson<int>(
        json['customerDiscountValue'],
      ),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
      closedAt: serializer.fromJson<DateTime?>(json['closedAt']),
      syncedAt: serializer.fromJson<DateTime?>(json['syncedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'status': serializer.toJson<String>(status),
      'tableNumber': serializer.toJson<int?>(tableNumber),
      'clerkPin': serializer.toJson<String?>(clerkPin),
      'staffId': serializer.toJson<int?>(staffId),
      'staffName': serializer.toJson<String?>(staffName),
      'sessionId': serializer.toJson<String?>(sessionId),
      'customerId': serializer.toJson<String?>(customerId),
      'splitFromOrderId': serializer.toJson<String?>(splitFromOrderId),
      'subtotalMinor': serializer.toJson<int>(subtotalMinor),
      'manualDiscountMinor': serializer.toJson<int>(manualDiscountMinor),
      'discountMinor': serializer.toJson<int>(discountMinor),
      'taxMinor': serializer.toJson<int>(taxMinor),
      'totalMinor': serializer.toJson<int>(totalMinor),
      'covers': serializer.toJson<int?>(covers),
      'notes': serializer.toJson<String?>(notes),
      'customerName': serializer.toJson<String?>(customerName),
      'customerDiscountType': serializer.toJson<String>(customerDiscountType),
      'customerDiscountValue': serializer.toJson<int>(customerDiscountValue),
      'createdAt': serializer.toJson<DateTime>(createdAt),
      'closedAt': serializer.toJson<DateTime?>(closedAt),
      'syncedAt': serializer.toJson<DateTime?>(syncedAt),
    };
  }

  Order copyWith({
    String? id,
    String? status,
    Value<int?> tableNumber = const Value.absent(),
    Value<String?> clerkPin = const Value.absent(),
    Value<int?> staffId = const Value.absent(),
    Value<String?> staffName = const Value.absent(),
    Value<String?> sessionId = const Value.absent(),
    Value<String?> customerId = const Value.absent(),
    Value<String?> splitFromOrderId = const Value.absent(),
    int? subtotalMinor,
    int? manualDiscountMinor,
    int? discountMinor,
    int? taxMinor,
    int? totalMinor,
    Value<int?> covers = const Value.absent(),
    Value<String?> notes = const Value.absent(),
    Value<String?> customerName = const Value.absent(),
    String? customerDiscountType,
    int? customerDiscountValue,
    DateTime? createdAt,
    Value<DateTime?> closedAt = const Value.absent(),
    Value<DateTime?> syncedAt = const Value.absent(),
  }) => Order(
    id: id ?? this.id,
    status: status ?? this.status,
    tableNumber: tableNumber.present ? tableNumber.value : this.tableNumber,
    clerkPin: clerkPin.present ? clerkPin.value : this.clerkPin,
    staffId: staffId.present ? staffId.value : this.staffId,
    staffName: staffName.present ? staffName.value : this.staffName,
    sessionId: sessionId.present ? sessionId.value : this.sessionId,
    customerId: customerId.present ? customerId.value : this.customerId,
    splitFromOrderId: splitFromOrderId.present
        ? splitFromOrderId.value
        : this.splitFromOrderId,
    subtotalMinor: subtotalMinor ?? this.subtotalMinor,
    manualDiscountMinor: manualDiscountMinor ?? this.manualDiscountMinor,
    discountMinor: discountMinor ?? this.discountMinor,
    taxMinor: taxMinor ?? this.taxMinor,
    totalMinor: totalMinor ?? this.totalMinor,
    covers: covers.present ? covers.value : this.covers,
    notes: notes.present ? notes.value : this.notes,
    customerName: customerName.present ? customerName.value : this.customerName,
    customerDiscountType: customerDiscountType ?? this.customerDiscountType,
    customerDiscountValue: customerDiscountValue ?? this.customerDiscountValue,
    createdAt: createdAt ?? this.createdAt,
    closedAt: closedAt.present ? closedAt.value : this.closedAt,
    syncedAt: syncedAt.present ? syncedAt.value : this.syncedAt,
  );
  Order copyWithCompanion(OrdersCompanion data) {
    return Order(
      id: data.id.present ? data.id.value : this.id,
      status: data.status.present ? data.status.value : this.status,
      tableNumber: data.tableNumber.present
          ? data.tableNumber.value
          : this.tableNumber,
      clerkPin: data.clerkPin.present ? data.clerkPin.value : this.clerkPin,
      staffId: data.staffId.present ? data.staffId.value : this.staffId,
      staffName: data.staffName.present ? data.staffName.value : this.staffName,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      customerId: data.customerId.present
          ? data.customerId.value
          : this.customerId,
      splitFromOrderId: data.splitFromOrderId.present
          ? data.splitFromOrderId.value
          : this.splitFromOrderId,
      subtotalMinor: data.subtotalMinor.present
          ? data.subtotalMinor.value
          : this.subtotalMinor,
      manualDiscountMinor: data.manualDiscountMinor.present
          ? data.manualDiscountMinor.value
          : this.manualDiscountMinor,
      discountMinor: data.discountMinor.present
          ? data.discountMinor.value
          : this.discountMinor,
      taxMinor: data.taxMinor.present ? data.taxMinor.value : this.taxMinor,
      totalMinor: data.totalMinor.present
          ? data.totalMinor.value
          : this.totalMinor,
      covers: data.covers.present ? data.covers.value : this.covers,
      notes: data.notes.present ? data.notes.value : this.notes,
      customerName: data.customerName.present
          ? data.customerName.value
          : this.customerName,
      customerDiscountType: data.customerDiscountType.present
          ? data.customerDiscountType.value
          : this.customerDiscountType,
      customerDiscountValue: data.customerDiscountValue.present
          ? data.customerDiscountValue.value
          : this.customerDiscountValue,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      closedAt: data.closedAt.present ? data.closedAt.value : this.closedAt,
      syncedAt: data.syncedAt.present ? data.syncedAt.value : this.syncedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Order(')
          ..write('id: $id, ')
          ..write('status: $status, ')
          ..write('tableNumber: $tableNumber, ')
          ..write('clerkPin: $clerkPin, ')
          ..write('staffId: $staffId, ')
          ..write('staffName: $staffName, ')
          ..write('sessionId: $sessionId, ')
          ..write('customerId: $customerId, ')
          ..write('splitFromOrderId: $splitFromOrderId, ')
          ..write('subtotalMinor: $subtotalMinor, ')
          ..write('manualDiscountMinor: $manualDiscountMinor, ')
          ..write('discountMinor: $discountMinor, ')
          ..write('taxMinor: $taxMinor, ')
          ..write('totalMinor: $totalMinor, ')
          ..write('covers: $covers, ')
          ..write('notes: $notes, ')
          ..write('customerName: $customerName, ')
          ..write('customerDiscountType: $customerDiscountType, ')
          ..write('customerDiscountValue: $customerDiscountValue, ')
          ..write('createdAt: $createdAt, ')
          ..write('closedAt: $closedAt, ')
          ..write('syncedAt: $syncedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hashAll([
    id,
    status,
    tableNumber,
    clerkPin,
    staffId,
    staffName,
    sessionId,
    customerId,
    splitFromOrderId,
    subtotalMinor,
    manualDiscountMinor,
    discountMinor,
    taxMinor,
    totalMinor,
    covers,
    notes,
    customerName,
    customerDiscountType,
    customerDiscountValue,
    createdAt,
    closedAt,
    syncedAt,
  ]);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Order &&
          other.id == this.id &&
          other.status == this.status &&
          other.tableNumber == this.tableNumber &&
          other.clerkPin == this.clerkPin &&
          other.staffId == this.staffId &&
          other.staffName == this.staffName &&
          other.sessionId == this.sessionId &&
          other.customerId == this.customerId &&
          other.splitFromOrderId == this.splitFromOrderId &&
          other.subtotalMinor == this.subtotalMinor &&
          other.manualDiscountMinor == this.manualDiscountMinor &&
          other.discountMinor == this.discountMinor &&
          other.taxMinor == this.taxMinor &&
          other.totalMinor == this.totalMinor &&
          other.covers == this.covers &&
          other.notes == this.notes &&
          other.customerName == this.customerName &&
          other.customerDiscountType == this.customerDiscountType &&
          other.customerDiscountValue == this.customerDiscountValue &&
          other.createdAt == this.createdAt &&
          other.closedAt == this.closedAt &&
          other.syncedAt == this.syncedAt);
}

class OrdersCompanion extends UpdateCompanion<Order> {
  final Value<String> id;
  final Value<String> status;
  final Value<int?> tableNumber;
  final Value<String?> clerkPin;
  final Value<int?> staffId;
  final Value<String?> staffName;
  final Value<String?> sessionId;
  final Value<String?> customerId;
  final Value<String?> splitFromOrderId;
  final Value<int> subtotalMinor;
  final Value<int> manualDiscountMinor;
  final Value<int> discountMinor;
  final Value<int> taxMinor;
  final Value<int> totalMinor;
  final Value<int?> covers;
  final Value<String?> notes;
  final Value<String?> customerName;
  final Value<String> customerDiscountType;
  final Value<int> customerDiscountValue;
  final Value<DateTime> createdAt;
  final Value<DateTime?> closedAt;
  final Value<DateTime?> syncedAt;
  final Value<int> rowid;
  const OrdersCompanion({
    this.id = const Value.absent(),
    this.status = const Value.absent(),
    this.tableNumber = const Value.absent(),
    this.clerkPin = const Value.absent(),
    this.staffId = const Value.absent(),
    this.staffName = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.customerId = const Value.absent(),
    this.splitFromOrderId = const Value.absent(),
    this.subtotalMinor = const Value.absent(),
    this.manualDiscountMinor = const Value.absent(),
    this.discountMinor = const Value.absent(),
    this.taxMinor = const Value.absent(),
    this.totalMinor = const Value.absent(),
    this.covers = const Value.absent(),
    this.notes = const Value.absent(),
    this.customerName = const Value.absent(),
    this.customerDiscountType = const Value.absent(),
    this.customerDiscountValue = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.closedAt = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  OrdersCompanion.insert({
    required String id,
    this.status = const Value.absent(),
    this.tableNumber = const Value.absent(),
    this.clerkPin = const Value.absent(),
    this.staffId = const Value.absent(),
    this.staffName = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.customerId = const Value.absent(),
    this.splitFromOrderId = const Value.absent(),
    this.subtotalMinor = const Value.absent(),
    this.manualDiscountMinor = const Value.absent(),
    this.discountMinor = const Value.absent(),
    this.taxMinor = const Value.absent(),
    this.totalMinor = const Value.absent(),
    this.covers = const Value.absent(),
    this.notes = const Value.absent(),
    this.customerName = const Value.absent(),
    this.customerDiscountType = const Value.absent(),
    this.customerDiscountValue = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.closedAt = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id);
  static Insertable<Order> custom({
    Expression<String>? id,
    Expression<String>? status,
    Expression<int>? tableNumber,
    Expression<String>? clerkPin,
    Expression<int>? staffId,
    Expression<String>? staffName,
    Expression<String>? sessionId,
    Expression<String>? customerId,
    Expression<String>? splitFromOrderId,
    Expression<int>? subtotalMinor,
    Expression<int>? manualDiscountMinor,
    Expression<int>? discountMinor,
    Expression<int>? taxMinor,
    Expression<int>? totalMinor,
    Expression<int>? covers,
    Expression<String>? notes,
    Expression<String>? customerName,
    Expression<String>? customerDiscountType,
    Expression<int>? customerDiscountValue,
    Expression<DateTime>? createdAt,
    Expression<DateTime>? closedAt,
    Expression<DateTime>? syncedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (status != null) 'status': status,
      if (tableNumber != null) 'table_number': tableNumber,
      if (clerkPin != null) 'clerk_pin': clerkPin,
      if (staffId != null) 'staff_id': staffId,
      if (staffName != null) 'staff_name': staffName,
      if (sessionId != null) 'session_id': sessionId,
      if (customerId != null) 'customer_id': customerId,
      if (splitFromOrderId != null) 'split_from_order_id': splitFromOrderId,
      if (subtotalMinor != null) 'subtotal_minor': subtotalMinor,
      if (manualDiscountMinor != null)
        'manual_discount_minor': manualDiscountMinor,
      if (discountMinor != null) 'discount_minor': discountMinor,
      if (taxMinor != null) 'tax_minor': taxMinor,
      if (totalMinor != null) 'total_minor': totalMinor,
      if (covers != null) 'covers': covers,
      if (notes != null) 'notes': notes,
      if (customerName != null) 'customer_name': customerName,
      if (customerDiscountType != null)
        'customer_discount_type': customerDiscountType,
      if (customerDiscountValue != null)
        'customer_discount_value': customerDiscountValue,
      if (createdAt != null) 'created_at': createdAt,
      if (closedAt != null) 'closed_at': closedAt,
      if (syncedAt != null) 'synced_at': syncedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  OrdersCompanion copyWith({
    Value<String>? id,
    Value<String>? status,
    Value<int?>? tableNumber,
    Value<String?>? clerkPin,
    Value<int?>? staffId,
    Value<String?>? staffName,
    Value<String?>? sessionId,
    Value<String?>? customerId,
    Value<String?>? splitFromOrderId,
    Value<int>? subtotalMinor,
    Value<int>? manualDiscountMinor,
    Value<int>? discountMinor,
    Value<int>? taxMinor,
    Value<int>? totalMinor,
    Value<int?>? covers,
    Value<String?>? notes,
    Value<String?>? customerName,
    Value<String>? customerDiscountType,
    Value<int>? customerDiscountValue,
    Value<DateTime>? createdAt,
    Value<DateTime?>? closedAt,
    Value<DateTime?>? syncedAt,
    Value<int>? rowid,
  }) {
    return OrdersCompanion(
      id: id ?? this.id,
      status: status ?? this.status,
      tableNumber: tableNumber ?? this.tableNumber,
      clerkPin: clerkPin ?? this.clerkPin,
      staffId: staffId ?? this.staffId,
      staffName: staffName ?? this.staffName,
      sessionId: sessionId ?? this.sessionId,
      customerId: customerId ?? this.customerId,
      splitFromOrderId: splitFromOrderId ?? this.splitFromOrderId,
      subtotalMinor: subtotalMinor ?? this.subtotalMinor,
      manualDiscountMinor: manualDiscountMinor ?? this.manualDiscountMinor,
      discountMinor: discountMinor ?? this.discountMinor,
      taxMinor: taxMinor ?? this.taxMinor,
      totalMinor: totalMinor ?? this.totalMinor,
      covers: covers ?? this.covers,
      notes: notes ?? this.notes,
      customerName: customerName ?? this.customerName,
      customerDiscountType: customerDiscountType ?? this.customerDiscountType,
      customerDiscountValue:
          customerDiscountValue ?? this.customerDiscountValue,
      createdAt: createdAt ?? this.createdAt,
      closedAt: closedAt ?? this.closedAt,
      syncedAt: syncedAt ?? this.syncedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (tableNumber.present) {
      map['table_number'] = Variable<int>(tableNumber.value);
    }
    if (clerkPin.present) {
      map['clerk_pin'] = Variable<String>(clerkPin.value);
    }
    if (staffId.present) {
      map['staff_id'] = Variable<int>(staffId.value);
    }
    if (staffName.present) {
      map['staff_name'] = Variable<String>(staffName.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (customerId.present) {
      map['customer_id'] = Variable<String>(customerId.value);
    }
    if (splitFromOrderId.present) {
      map['split_from_order_id'] = Variable<String>(splitFromOrderId.value);
    }
    if (subtotalMinor.present) {
      map['subtotal_minor'] = Variable<int>(subtotalMinor.value);
    }
    if (manualDiscountMinor.present) {
      map['manual_discount_minor'] = Variable<int>(manualDiscountMinor.value);
    }
    if (discountMinor.present) {
      map['discount_minor'] = Variable<int>(discountMinor.value);
    }
    if (taxMinor.present) {
      map['tax_minor'] = Variable<int>(taxMinor.value);
    }
    if (totalMinor.present) {
      map['total_minor'] = Variable<int>(totalMinor.value);
    }
    if (covers.present) {
      map['covers'] = Variable<int>(covers.value);
    }
    if (notes.present) {
      map['notes'] = Variable<String>(notes.value);
    }
    if (customerName.present) {
      map['customer_name'] = Variable<String>(customerName.value);
    }
    if (customerDiscountType.present) {
      map['customer_discount_type'] = Variable<String>(
        customerDiscountType.value,
      );
    }
    if (customerDiscountValue.present) {
      map['customer_discount_value'] = Variable<int>(
        customerDiscountValue.value,
      );
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (closedAt.present) {
      map['closed_at'] = Variable<DateTime>(closedAt.value);
    }
    if (syncedAt.present) {
      map['synced_at'] = Variable<DateTime>(syncedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('OrdersCompanion(')
          ..write('id: $id, ')
          ..write('status: $status, ')
          ..write('tableNumber: $tableNumber, ')
          ..write('clerkPin: $clerkPin, ')
          ..write('staffId: $staffId, ')
          ..write('staffName: $staffName, ')
          ..write('sessionId: $sessionId, ')
          ..write('customerId: $customerId, ')
          ..write('splitFromOrderId: $splitFromOrderId, ')
          ..write('subtotalMinor: $subtotalMinor, ')
          ..write('manualDiscountMinor: $manualDiscountMinor, ')
          ..write('discountMinor: $discountMinor, ')
          ..write('taxMinor: $taxMinor, ')
          ..write('totalMinor: $totalMinor, ')
          ..write('covers: $covers, ')
          ..write('notes: $notes, ')
          ..write('customerName: $customerName, ')
          ..write('customerDiscountType: $customerDiscountType, ')
          ..write('customerDiscountValue: $customerDiscountValue, ')
          ..write('createdAt: $createdAt, ')
          ..write('closedAt: $closedAt, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $OrderLinesTable extends OrderLines
    with TableInfo<$OrderLinesTable, OrderLine> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $OrderLinesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _orderIdMeta = const VerificationMeta(
    'orderId',
  );
  @override
  late final GeneratedColumn<String> orderId = GeneratedColumn<String>(
    'order_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES orders (id)',
    ),
  );
  static const VerificationMeta _pluIdMeta = const VerificationMeta('pluId');
  @override
  late final GeneratedColumn<int> pluId = GeneratedColumn<int>(
    'plu_id',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _quantityMeta = const VerificationMeta(
    'quantity',
  );
  @override
  late final GeneratedColumn<double> quantity = GeneratedColumn<double>(
    'quantity',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(1),
  );
  static const VerificationMeta _unitPriceMinorMeta = const VerificationMeta(
    'unitPriceMinor',
  );
  @override
  late final GeneratedColumn<int> unitPriceMinor = GeneratedColumn<int>(
    'unit_price_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _taxPercentageMeta = const VerificationMeta(
    'taxPercentage',
  );
  @override
  late final GeneratedColumn<double> taxPercentage = GeneratedColumn<double>(
    'tax_percentage',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _notesMeta = const VerificationMeta('notes');
  @override
  late final GeneratedColumn<String> notes = GeneratedColumn<String>(
    'notes',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lineDiscountMinorMeta = const VerificationMeta(
    'lineDiscountMinor',
  );
  @override
  late final GeneratedColumn<int> lineDiscountMinor = GeneratedColumn<int>(
    'line_discount_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _addedByMeta = const VerificationMeta(
    'addedBy',
  );
  @override
  late final GeneratedColumn<String> addedBy = GeneratedColumn<String>(
    'added_by',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _addedAtMeta = const VerificationMeta(
    'addedAt',
  );
  @override
  late final GeneratedColumn<DateTime> addedAt = GeneratedColumn<DateTime>(
    'added_at',
    aliasedName,
    true,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    orderId,
    pluId,
    name,
    quantity,
    unitPriceMinor,
    taxPercentage,
    notes,
    lineDiscountMinor,
    addedBy,
    addedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'order_lines';
  @override
  VerificationContext validateIntegrity(
    Insertable<OrderLine> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('order_id')) {
      context.handle(
        _orderIdMeta,
        orderId.isAcceptableOrUnknown(data['order_id']!, _orderIdMeta),
      );
    } else if (isInserting) {
      context.missing(_orderIdMeta);
    }
    if (data.containsKey('plu_id')) {
      context.handle(
        _pluIdMeta,
        pluId.isAcceptableOrUnknown(data['plu_id']!, _pluIdMeta),
      );
    } else if (isInserting) {
      context.missing(_pluIdMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('quantity')) {
      context.handle(
        _quantityMeta,
        quantity.isAcceptableOrUnknown(data['quantity']!, _quantityMeta),
      );
    }
    if (data.containsKey('unit_price_minor')) {
      context.handle(
        _unitPriceMinorMeta,
        unitPriceMinor.isAcceptableOrUnknown(
          data['unit_price_minor']!,
          _unitPriceMinorMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_unitPriceMinorMeta);
    }
    if (data.containsKey('tax_percentage')) {
      context.handle(
        _taxPercentageMeta,
        taxPercentage.isAcceptableOrUnknown(
          data['tax_percentage']!,
          _taxPercentageMeta,
        ),
      );
    }
    if (data.containsKey('notes')) {
      context.handle(
        _notesMeta,
        notes.isAcceptableOrUnknown(data['notes']!, _notesMeta),
      );
    }
    if (data.containsKey('line_discount_minor')) {
      context.handle(
        _lineDiscountMinorMeta,
        lineDiscountMinor.isAcceptableOrUnknown(
          data['line_discount_minor']!,
          _lineDiscountMinorMeta,
        ),
      );
    }
    if (data.containsKey('added_by')) {
      context.handle(
        _addedByMeta,
        addedBy.isAcceptableOrUnknown(data['added_by']!, _addedByMeta),
      );
    }
    if (data.containsKey('added_at')) {
      context.handle(
        _addedAtMeta,
        addedAt.isAcceptableOrUnknown(data['added_at']!, _addedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  OrderLine map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return OrderLine(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      orderId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}order_id'],
      )!,
      pluId: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}plu_id'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      quantity: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}quantity'],
      )!,
      unitPriceMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}unit_price_minor'],
      )!,
      taxPercentage: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}tax_percentage'],
      )!,
      notes: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}notes'],
      ),
      lineDiscountMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}line_discount_minor'],
      )!,
      addedBy: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}added_by'],
      ),
      addedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}added_at'],
      ),
    );
  }

  @override
  $OrderLinesTable createAlias(String alias) {
    return $OrderLinesTable(attachedDatabase, alias);
  }
}

class OrderLine extends DataClass implements Insertable<OrderLine> {
  final String id;
  final String orderId;
  final int pluId;
  final String name;
  final double quantity;
  final int unitPriceMinor;
  final double taxPercentage;
  final String? notes;

  /// A discount on this single line, keyed in by the clerk, in pence off the
  /// line total. Separate from the order-level discount.
  final int lineDiscountMinor;

  /// Who put this item on the bill, and when.
  ///
  /// A bill parked on a table and added to across a shift has no single author,
  /// so "who rang this up?" cannot be answered at the order level. The check
  /// view groups by these two and prints a `Sam · 19:42` header above each run
  /// of items.
  ///
  /// Nullable: lines already in the database, and any rung up before staff
  /// sign-on was switched on at the venue, simply have no attribution and are
  /// shown without a header.
  final String? addedBy;
  final DateTime? addedAt;
  const OrderLine({
    required this.id,
    required this.orderId,
    required this.pluId,
    required this.name,
    required this.quantity,
    required this.unitPriceMinor,
    required this.taxPercentage,
    this.notes,
    required this.lineDiscountMinor,
    this.addedBy,
    this.addedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['order_id'] = Variable<String>(orderId);
    map['plu_id'] = Variable<int>(pluId);
    map['name'] = Variable<String>(name);
    map['quantity'] = Variable<double>(quantity);
    map['unit_price_minor'] = Variable<int>(unitPriceMinor);
    map['tax_percentage'] = Variable<double>(taxPercentage);
    if (!nullToAbsent || notes != null) {
      map['notes'] = Variable<String>(notes);
    }
    map['line_discount_minor'] = Variable<int>(lineDiscountMinor);
    if (!nullToAbsent || addedBy != null) {
      map['added_by'] = Variable<String>(addedBy);
    }
    if (!nullToAbsent || addedAt != null) {
      map['added_at'] = Variable<DateTime>(addedAt);
    }
    return map;
  }

  OrderLinesCompanion toCompanion(bool nullToAbsent) {
    return OrderLinesCompanion(
      id: Value(id),
      orderId: Value(orderId),
      pluId: Value(pluId),
      name: Value(name),
      quantity: Value(quantity),
      unitPriceMinor: Value(unitPriceMinor),
      taxPercentage: Value(taxPercentage),
      notes: notes == null && nullToAbsent
          ? const Value.absent()
          : Value(notes),
      lineDiscountMinor: Value(lineDiscountMinor),
      addedBy: addedBy == null && nullToAbsent
          ? const Value.absent()
          : Value(addedBy),
      addedAt: addedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(addedAt),
    );
  }

  factory OrderLine.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return OrderLine(
      id: serializer.fromJson<String>(json['id']),
      orderId: serializer.fromJson<String>(json['orderId']),
      pluId: serializer.fromJson<int>(json['pluId']),
      name: serializer.fromJson<String>(json['name']),
      quantity: serializer.fromJson<double>(json['quantity']),
      unitPriceMinor: serializer.fromJson<int>(json['unitPriceMinor']),
      taxPercentage: serializer.fromJson<double>(json['taxPercentage']),
      notes: serializer.fromJson<String?>(json['notes']),
      lineDiscountMinor: serializer.fromJson<int>(json['lineDiscountMinor']),
      addedBy: serializer.fromJson<String?>(json['addedBy']),
      addedAt: serializer.fromJson<DateTime?>(json['addedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'orderId': serializer.toJson<String>(orderId),
      'pluId': serializer.toJson<int>(pluId),
      'name': serializer.toJson<String>(name),
      'quantity': serializer.toJson<double>(quantity),
      'unitPriceMinor': serializer.toJson<int>(unitPriceMinor),
      'taxPercentage': serializer.toJson<double>(taxPercentage),
      'notes': serializer.toJson<String?>(notes),
      'lineDiscountMinor': serializer.toJson<int>(lineDiscountMinor),
      'addedBy': serializer.toJson<String?>(addedBy),
      'addedAt': serializer.toJson<DateTime?>(addedAt),
    };
  }

  OrderLine copyWith({
    String? id,
    String? orderId,
    int? pluId,
    String? name,
    double? quantity,
    int? unitPriceMinor,
    double? taxPercentage,
    Value<String?> notes = const Value.absent(),
    int? lineDiscountMinor,
    Value<String?> addedBy = const Value.absent(),
    Value<DateTime?> addedAt = const Value.absent(),
  }) => OrderLine(
    id: id ?? this.id,
    orderId: orderId ?? this.orderId,
    pluId: pluId ?? this.pluId,
    name: name ?? this.name,
    quantity: quantity ?? this.quantity,
    unitPriceMinor: unitPriceMinor ?? this.unitPriceMinor,
    taxPercentage: taxPercentage ?? this.taxPercentage,
    notes: notes.present ? notes.value : this.notes,
    lineDiscountMinor: lineDiscountMinor ?? this.lineDiscountMinor,
    addedBy: addedBy.present ? addedBy.value : this.addedBy,
    addedAt: addedAt.present ? addedAt.value : this.addedAt,
  );
  OrderLine copyWithCompanion(OrderLinesCompanion data) {
    return OrderLine(
      id: data.id.present ? data.id.value : this.id,
      orderId: data.orderId.present ? data.orderId.value : this.orderId,
      pluId: data.pluId.present ? data.pluId.value : this.pluId,
      name: data.name.present ? data.name.value : this.name,
      quantity: data.quantity.present ? data.quantity.value : this.quantity,
      unitPriceMinor: data.unitPriceMinor.present
          ? data.unitPriceMinor.value
          : this.unitPriceMinor,
      taxPercentage: data.taxPercentage.present
          ? data.taxPercentage.value
          : this.taxPercentage,
      notes: data.notes.present ? data.notes.value : this.notes,
      lineDiscountMinor: data.lineDiscountMinor.present
          ? data.lineDiscountMinor.value
          : this.lineDiscountMinor,
      addedBy: data.addedBy.present ? data.addedBy.value : this.addedBy,
      addedAt: data.addedAt.present ? data.addedAt.value : this.addedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('OrderLine(')
          ..write('id: $id, ')
          ..write('orderId: $orderId, ')
          ..write('pluId: $pluId, ')
          ..write('name: $name, ')
          ..write('quantity: $quantity, ')
          ..write('unitPriceMinor: $unitPriceMinor, ')
          ..write('taxPercentage: $taxPercentage, ')
          ..write('notes: $notes, ')
          ..write('lineDiscountMinor: $lineDiscountMinor, ')
          ..write('addedBy: $addedBy, ')
          ..write('addedAt: $addedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    orderId,
    pluId,
    name,
    quantity,
    unitPriceMinor,
    taxPercentage,
    notes,
    lineDiscountMinor,
    addedBy,
    addedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is OrderLine &&
          other.id == this.id &&
          other.orderId == this.orderId &&
          other.pluId == this.pluId &&
          other.name == this.name &&
          other.quantity == this.quantity &&
          other.unitPriceMinor == this.unitPriceMinor &&
          other.taxPercentage == this.taxPercentage &&
          other.notes == this.notes &&
          other.lineDiscountMinor == this.lineDiscountMinor &&
          other.addedBy == this.addedBy &&
          other.addedAt == this.addedAt);
}

class OrderLinesCompanion extends UpdateCompanion<OrderLine> {
  final Value<String> id;
  final Value<String> orderId;
  final Value<int> pluId;
  final Value<String> name;
  final Value<double> quantity;
  final Value<int> unitPriceMinor;
  final Value<double> taxPercentage;
  final Value<String?> notes;
  final Value<int> lineDiscountMinor;
  final Value<String?> addedBy;
  final Value<DateTime?> addedAt;
  final Value<int> rowid;
  const OrderLinesCompanion({
    this.id = const Value.absent(),
    this.orderId = const Value.absent(),
    this.pluId = const Value.absent(),
    this.name = const Value.absent(),
    this.quantity = const Value.absent(),
    this.unitPriceMinor = const Value.absent(),
    this.taxPercentage = const Value.absent(),
    this.notes = const Value.absent(),
    this.lineDiscountMinor = const Value.absent(),
    this.addedBy = const Value.absent(),
    this.addedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  OrderLinesCompanion.insert({
    required String id,
    required String orderId,
    required int pluId,
    required String name,
    this.quantity = const Value.absent(),
    required int unitPriceMinor,
    this.taxPercentage = const Value.absent(),
    this.notes = const Value.absent(),
    this.lineDiscountMinor = const Value.absent(),
    this.addedBy = const Value.absent(),
    this.addedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       orderId = Value(orderId),
       pluId = Value(pluId),
       name = Value(name),
       unitPriceMinor = Value(unitPriceMinor);
  static Insertable<OrderLine> custom({
    Expression<String>? id,
    Expression<String>? orderId,
    Expression<int>? pluId,
    Expression<String>? name,
    Expression<double>? quantity,
    Expression<int>? unitPriceMinor,
    Expression<double>? taxPercentage,
    Expression<String>? notes,
    Expression<int>? lineDiscountMinor,
    Expression<String>? addedBy,
    Expression<DateTime>? addedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (orderId != null) 'order_id': orderId,
      if (pluId != null) 'plu_id': pluId,
      if (name != null) 'name': name,
      if (quantity != null) 'quantity': quantity,
      if (unitPriceMinor != null) 'unit_price_minor': unitPriceMinor,
      if (taxPercentage != null) 'tax_percentage': taxPercentage,
      if (notes != null) 'notes': notes,
      if (lineDiscountMinor != null) 'line_discount_minor': lineDiscountMinor,
      if (addedBy != null) 'added_by': addedBy,
      if (addedAt != null) 'added_at': addedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  OrderLinesCompanion copyWith({
    Value<String>? id,
    Value<String>? orderId,
    Value<int>? pluId,
    Value<String>? name,
    Value<double>? quantity,
    Value<int>? unitPriceMinor,
    Value<double>? taxPercentage,
    Value<String?>? notes,
    Value<int>? lineDiscountMinor,
    Value<String?>? addedBy,
    Value<DateTime?>? addedAt,
    Value<int>? rowid,
  }) {
    return OrderLinesCompanion(
      id: id ?? this.id,
      orderId: orderId ?? this.orderId,
      pluId: pluId ?? this.pluId,
      name: name ?? this.name,
      quantity: quantity ?? this.quantity,
      unitPriceMinor: unitPriceMinor ?? this.unitPriceMinor,
      taxPercentage: taxPercentage ?? this.taxPercentage,
      notes: notes ?? this.notes,
      lineDiscountMinor: lineDiscountMinor ?? this.lineDiscountMinor,
      addedBy: addedBy ?? this.addedBy,
      addedAt: addedAt ?? this.addedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (orderId.present) {
      map['order_id'] = Variable<String>(orderId.value);
    }
    if (pluId.present) {
      map['plu_id'] = Variable<int>(pluId.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (quantity.present) {
      map['quantity'] = Variable<double>(quantity.value);
    }
    if (unitPriceMinor.present) {
      map['unit_price_minor'] = Variable<int>(unitPriceMinor.value);
    }
    if (taxPercentage.present) {
      map['tax_percentage'] = Variable<double>(taxPercentage.value);
    }
    if (notes.present) {
      map['notes'] = Variable<String>(notes.value);
    }
    if (lineDiscountMinor.present) {
      map['line_discount_minor'] = Variable<int>(lineDiscountMinor.value);
    }
    if (addedBy.present) {
      map['added_by'] = Variable<String>(addedBy.value);
    }
    if (addedAt.present) {
      map['added_at'] = Variable<DateTime>(addedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('OrderLinesCompanion(')
          ..write('id: $id, ')
          ..write('orderId: $orderId, ')
          ..write('pluId: $pluId, ')
          ..write('name: $name, ')
          ..write('quantity: $quantity, ')
          ..write('unitPriceMinor: $unitPriceMinor, ')
          ..write('taxPercentage: $taxPercentage, ')
          ..write('notes: $notes, ')
          ..write('lineDiscountMinor: $lineDiscountMinor, ')
          ..write('addedBy: $addedBy, ')
          ..write('addedAt: $addedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $PaymentsTable extends Payments with TableInfo<$PaymentsTable, Payment> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $PaymentsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _orderIdMeta = const VerificationMeta(
    'orderId',
  );
  @override
  late final GeneratedColumn<String> orderId = GeneratedColumn<String>(
    'order_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES orders (id)',
    ),
  );
  static const VerificationMeta _methodMeta = const VerificationMeta('method');
  @override
  late final GeneratedColumn<String> method = GeneratedColumn<String>(
    'method',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _amountMinorMeta = const VerificationMeta(
    'amountMinor',
  );
  @override
  late final GeneratedColumn<int> amountMinor = GeneratedColumn<int>(
    'amount_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _takenAtMeta = const VerificationMeta(
    'takenAt',
  );
  @override
  late final GeneratedColumn<DateTime> takenAt = GeneratedColumn<DateTime>(
    'taken_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _cashBreakdownMeta = const VerificationMeta(
    'cashBreakdown',
  );
  @override
  late final GeneratedColumn<String> cashBreakdown = GeneratedColumn<String>(
    'cash_breakdown',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    orderId,
    method,
    amountMinor,
    takenAt,
    cashBreakdown,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'payments';
  @override
  VerificationContext validateIntegrity(
    Insertable<Payment> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('order_id')) {
      context.handle(
        _orderIdMeta,
        orderId.isAcceptableOrUnknown(data['order_id']!, _orderIdMeta),
      );
    } else if (isInserting) {
      context.missing(_orderIdMeta);
    }
    if (data.containsKey('method')) {
      context.handle(
        _methodMeta,
        method.isAcceptableOrUnknown(data['method']!, _methodMeta),
      );
    } else if (isInserting) {
      context.missing(_methodMeta);
    }
    if (data.containsKey('amount_minor')) {
      context.handle(
        _amountMinorMeta,
        amountMinor.isAcceptableOrUnknown(
          data['amount_minor']!,
          _amountMinorMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_amountMinorMeta);
    }
    if (data.containsKey('taken_at')) {
      context.handle(
        _takenAtMeta,
        takenAt.isAcceptableOrUnknown(data['taken_at']!, _takenAtMeta),
      );
    }
    if (data.containsKey('cash_breakdown')) {
      context.handle(
        _cashBreakdownMeta,
        cashBreakdown.isAcceptableOrUnknown(
          data['cash_breakdown']!,
          _cashBreakdownMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  Payment map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Payment(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      orderId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}order_id'],
      )!,
      method: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}method'],
      )!,
      amountMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}amount_minor'],
      )!,
      takenAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}taken_at'],
      )!,
      cashBreakdown: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}cash_breakdown'],
      ),
    );
  }

  @override
  $PaymentsTable createAlias(String alias) {
    return $PaymentsTable(attachedDatabase, alias);
  }
}

class Payment extends DataClass implements Insertable<Payment> {
  final String id;
  final String orderId;

  /// cash | card | voucher
  final String method;
  final int amountMinor;
  final DateTime takenAt;

  /// The notes and coins actually handed over, when the clerk counted them in
  /// on the cash keys — e.g. `2000x2,500x1` for two twenties and a five.
  ///
  /// Kept as a compact string rather than a related table: it is written once,
  /// read back only to reprint the same receipt, and never queried across
  /// sales. Null for card, and for cash simply keyed as an amount.
  final String? cashBreakdown;
  const Payment({
    required this.id,
    required this.orderId,
    required this.method,
    required this.amountMinor,
    required this.takenAt,
    this.cashBreakdown,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['order_id'] = Variable<String>(orderId);
    map['method'] = Variable<String>(method);
    map['amount_minor'] = Variable<int>(amountMinor);
    map['taken_at'] = Variable<DateTime>(takenAt);
    if (!nullToAbsent || cashBreakdown != null) {
      map['cash_breakdown'] = Variable<String>(cashBreakdown);
    }
    return map;
  }

  PaymentsCompanion toCompanion(bool nullToAbsent) {
    return PaymentsCompanion(
      id: Value(id),
      orderId: Value(orderId),
      method: Value(method),
      amountMinor: Value(amountMinor),
      takenAt: Value(takenAt),
      cashBreakdown: cashBreakdown == null && nullToAbsent
          ? const Value.absent()
          : Value(cashBreakdown),
    );
  }

  factory Payment.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Payment(
      id: serializer.fromJson<String>(json['id']),
      orderId: serializer.fromJson<String>(json['orderId']),
      method: serializer.fromJson<String>(json['method']),
      amountMinor: serializer.fromJson<int>(json['amountMinor']),
      takenAt: serializer.fromJson<DateTime>(json['takenAt']),
      cashBreakdown: serializer.fromJson<String?>(json['cashBreakdown']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'orderId': serializer.toJson<String>(orderId),
      'method': serializer.toJson<String>(method),
      'amountMinor': serializer.toJson<int>(amountMinor),
      'takenAt': serializer.toJson<DateTime>(takenAt),
      'cashBreakdown': serializer.toJson<String?>(cashBreakdown),
    };
  }

  Payment copyWith({
    String? id,
    String? orderId,
    String? method,
    int? amountMinor,
    DateTime? takenAt,
    Value<String?> cashBreakdown = const Value.absent(),
  }) => Payment(
    id: id ?? this.id,
    orderId: orderId ?? this.orderId,
    method: method ?? this.method,
    amountMinor: amountMinor ?? this.amountMinor,
    takenAt: takenAt ?? this.takenAt,
    cashBreakdown: cashBreakdown.present
        ? cashBreakdown.value
        : this.cashBreakdown,
  );
  Payment copyWithCompanion(PaymentsCompanion data) {
    return Payment(
      id: data.id.present ? data.id.value : this.id,
      orderId: data.orderId.present ? data.orderId.value : this.orderId,
      method: data.method.present ? data.method.value : this.method,
      amountMinor: data.amountMinor.present
          ? data.amountMinor.value
          : this.amountMinor,
      takenAt: data.takenAt.present ? data.takenAt.value : this.takenAt,
      cashBreakdown: data.cashBreakdown.present
          ? data.cashBreakdown.value
          : this.cashBreakdown,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Payment(')
          ..write('id: $id, ')
          ..write('orderId: $orderId, ')
          ..write('method: $method, ')
          ..write('amountMinor: $amountMinor, ')
          ..write('takenAt: $takenAt, ')
          ..write('cashBreakdown: $cashBreakdown')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(id, orderId, method, amountMinor, takenAt, cashBreakdown);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Payment &&
          other.id == this.id &&
          other.orderId == this.orderId &&
          other.method == this.method &&
          other.amountMinor == this.amountMinor &&
          other.takenAt == this.takenAt &&
          other.cashBreakdown == this.cashBreakdown);
}

class PaymentsCompanion extends UpdateCompanion<Payment> {
  final Value<String> id;
  final Value<String> orderId;
  final Value<String> method;
  final Value<int> amountMinor;
  final Value<DateTime> takenAt;
  final Value<String?> cashBreakdown;
  final Value<int> rowid;
  const PaymentsCompanion({
    this.id = const Value.absent(),
    this.orderId = const Value.absent(),
    this.method = const Value.absent(),
    this.amountMinor = const Value.absent(),
    this.takenAt = const Value.absent(),
    this.cashBreakdown = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  PaymentsCompanion.insert({
    required String id,
    required String orderId,
    required String method,
    required int amountMinor,
    this.takenAt = const Value.absent(),
    this.cashBreakdown = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       orderId = Value(orderId),
       method = Value(method),
       amountMinor = Value(amountMinor);
  static Insertable<Payment> custom({
    Expression<String>? id,
    Expression<String>? orderId,
    Expression<String>? method,
    Expression<int>? amountMinor,
    Expression<DateTime>? takenAt,
    Expression<String>? cashBreakdown,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (orderId != null) 'order_id': orderId,
      if (method != null) 'method': method,
      if (amountMinor != null) 'amount_minor': amountMinor,
      if (takenAt != null) 'taken_at': takenAt,
      if (cashBreakdown != null) 'cash_breakdown': cashBreakdown,
      if (rowid != null) 'rowid': rowid,
    });
  }

  PaymentsCompanion copyWith({
    Value<String>? id,
    Value<String>? orderId,
    Value<String>? method,
    Value<int>? amountMinor,
    Value<DateTime>? takenAt,
    Value<String?>? cashBreakdown,
    Value<int>? rowid,
  }) {
    return PaymentsCompanion(
      id: id ?? this.id,
      orderId: orderId ?? this.orderId,
      method: method ?? this.method,
      amountMinor: amountMinor ?? this.amountMinor,
      takenAt: takenAt ?? this.takenAt,
      cashBreakdown: cashBreakdown ?? this.cashBreakdown,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (orderId.present) {
      map['order_id'] = Variable<String>(orderId.value);
    }
    if (method.present) {
      map['method'] = Variable<String>(method.value);
    }
    if (amountMinor.present) {
      map['amount_minor'] = Variable<int>(amountMinor.value);
    }
    if (takenAt.present) {
      map['taken_at'] = Variable<DateTime>(takenAt.value);
    }
    if (cashBreakdown.present) {
      map['cash_breakdown'] = Variable<String>(cashBreakdown.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('PaymentsCompanion(')
          ..write('id: $id, ')
          ..write('orderId: $orderId, ')
          ..write('method: $method, ')
          ..write('amountMinor: $amountMinor, ')
          ..write('takenAt: $takenAt, ')
          ..write('cashBreakdown: $cashBreakdown, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $OutboxEntriesTable extends OutboxEntries
    with TableInfo<$OutboxEntriesTable, OutboxEntry> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $OutboxEntriesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _entityMeta = const VerificationMeta('entity');
  @override
  late final GeneratedColumn<String> entity = GeneratedColumn<String>(
    'entity',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _entityIdMeta = const VerificationMeta(
    'entityId',
  );
  @override
  late final GeneratedColumn<String> entityId = GeneratedColumn<String>(
    'entity_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadMeta = const VerificationMeta(
    'payload',
  );
  @override
  late final GeneratedColumn<String> payload = GeneratedColumn<String>(
    'payload',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _attemptsMeta = const VerificationMeta(
    'attempts',
  );
  @override
  late final GeneratedColumn<int> attempts = GeneratedColumn<int>(
    'attempts',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _lastErrorMeta = const VerificationMeta(
    'lastError',
  );
  @override
  late final GeneratedColumn<String> lastError = GeneratedColumn<String>(
    'last_error',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    entity,
    entityId,
    payload,
    attempts,
    lastError,
    createdAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'outbox_entries';
  @override
  VerificationContext validateIntegrity(
    Insertable<OutboxEntry> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('entity')) {
      context.handle(
        _entityMeta,
        entity.isAcceptableOrUnknown(data['entity']!, _entityMeta),
      );
    } else if (isInserting) {
      context.missing(_entityMeta);
    }
    if (data.containsKey('entity_id')) {
      context.handle(
        _entityIdMeta,
        entityId.isAcceptableOrUnknown(data['entity_id']!, _entityIdMeta),
      );
    } else if (isInserting) {
      context.missing(_entityIdMeta);
    }
    if (data.containsKey('payload')) {
      context.handle(
        _payloadMeta,
        payload.isAcceptableOrUnknown(data['payload']!, _payloadMeta),
      );
    } else if (isInserting) {
      context.missing(_payloadMeta);
    }
    if (data.containsKey('attempts')) {
      context.handle(
        _attemptsMeta,
        attempts.isAcceptableOrUnknown(data['attempts']!, _attemptsMeta),
      );
    }
    if (data.containsKey('last_error')) {
      context.handle(
        _lastErrorMeta,
        lastError.isAcceptableOrUnknown(data['last_error']!, _lastErrorMeta),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  OutboxEntry map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return OutboxEntry(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      entity: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}entity'],
      )!,
      entityId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}entity_id'],
      )!,
      payload: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload'],
      )!,
      attempts: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}attempts'],
      )!,
      lastError: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}last_error'],
      ),
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
    );
  }

  @override
  $OutboxEntriesTable createAlias(String alias) {
    return $OutboxEntriesTable(attachedDatabase, alias);
  }
}

class OutboxEntry extends DataClass implements Insertable<OutboxEntry> {
  final String id;

  /// order | payment
  final String entity;
  final String entityId;
  final String payload;
  final int attempts;
  final String? lastError;
  final DateTime createdAt;
  const OutboxEntry({
    required this.id,
    required this.entity,
    required this.entityId,
    required this.payload,
    required this.attempts,
    this.lastError,
    required this.createdAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['entity'] = Variable<String>(entity);
    map['entity_id'] = Variable<String>(entityId);
    map['payload'] = Variable<String>(payload);
    map['attempts'] = Variable<int>(attempts);
    if (!nullToAbsent || lastError != null) {
      map['last_error'] = Variable<String>(lastError);
    }
    map['created_at'] = Variable<DateTime>(createdAt);
    return map;
  }

  OutboxEntriesCompanion toCompanion(bool nullToAbsent) {
    return OutboxEntriesCompanion(
      id: Value(id),
      entity: Value(entity),
      entityId: Value(entityId),
      payload: Value(payload),
      attempts: Value(attempts),
      lastError: lastError == null && nullToAbsent
          ? const Value.absent()
          : Value(lastError),
      createdAt: Value(createdAt),
    );
  }

  factory OutboxEntry.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return OutboxEntry(
      id: serializer.fromJson<String>(json['id']),
      entity: serializer.fromJson<String>(json['entity']),
      entityId: serializer.fromJson<String>(json['entityId']),
      payload: serializer.fromJson<String>(json['payload']),
      attempts: serializer.fromJson<int>(json['attempts']),
      lastError: serializer.fromJson<String?>(json['lastError']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'entity': serializer.toJson<String>(entity),
      'entityId': serializer.toJson<String>(entityId),
      'payload': serializer.toJson<String>(payload),
      'attempts': serializer.toJson<int>(attempts),
      'lastError': serializer.toJson<String?>(lastError),
      'createdAt': serializer.toJson<DateTime>(createdAt),
    };
  }

  OutboxEntry copyWith({
    String? id,
    String? entity,
    String? entityId,
    String? payload,
    int? attempts,
    Value<String?> lastError = const Value.absent(),
    DateTime? createdAt,
  }) => OutboxEntry(
    id: id ?? this.id,
    entity: entity ?? this.entity,
    entityId: entityId ?? this.entityId,
    payload: payload ?? this.payload,
    attempts: attempts ?? this.attempts,
    lastError: lastError.present ? lastError.value : this.lastError,
    createdAt: createdAt ?? this.createdAt,
  );
  OutboxEntry copyWithCompanion(OutboxEntriesCompanion data) {
    return OutboxEntry(
      id: data.id.present ? data.id.value : this.id,
      entity: data.entity.present ? data.entity.value : this.entity,
      entityId: data.entityId.present ? data.entityId.value : this.entityId,
      payload: data.payload.present ? data.payload.value : this.payload,
      attempts: data.attempts.present ? data.attempts.value : this.attempts,
      lastError: data.lastError.present ? data.lastError.value : this.lastError,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('OutboxEntry(')
          ..write('id: $id, ')
          ..write('entity: $entity, ')
          ..write('entityId: $entityId, ')
          ..write('payload: $payload, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    entity,
    entityId,
    payload,
    attempts,
    lastError,
    createdAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is OutboxEntry &&
          other.id == this.id &&
          other.entity == this.entity &&
          other.entityId == this.entityId &&
          other.payload == this.payload &&
          other.attempts == this.attempts &&
          other.lastError == this.lastError &&
          other.createdAt == this.createdAt);
}

class OutboxEntriesCompanion extends UpdateCompanion<OutboxEntry> {
  final Value<String> id;
  final Value<String> entity;
  final Value<String> entityId;
  final Value<String> payload;
  final Value<int> attempts;
  final Value<String?> lastError;
  final Value<DateTime> createdAt;
  final Value<int> rowid;
  const OutboxEntriesCompanion({
    this.id = const Value.absent(),
    this.entity = const Value.absent(),
    this.entityId = const Value.absent(),
    this.payload = const Value.absent(),
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  OutboxEntriesCompanion.insert({
    required String id,
    required String entity,
    required String entityId,
    required String payload,
    this.attempts = const Value.absent(),
    this.lastError = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       entity = Value(entity),
       entityId = Value(entityId),
       payload = Value(payload);
  static Insertable<OutboxEntry> custom({
    Expression<String>? id,
    Expression<String>? entity,
    Expression<String>? entityId,
    Expression<String>? payload,
    Expression<int>? attempts,
    Expression<String>? lastError,
    Expression<DateTime>? createdAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (entity != null) 'entity': entity,
      if (entityId != null) 'entity_id': entityId,
      if (payload != null) 'payload': payload,
      if (attempts != null) 'attempts': attempts,
      if (lastError != null) 'last_error': lastError,
      if (createdAt != null) 'created_at': createdAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  OutboxEntriesCompanion copyWith({
    Value<String>? id,
    Value<String>? entity,
    Value<String>? entityId,
    Value<String>? payload,
    Value<int>? attempts,
    Value<String?>? lastError,
    Value<DateTime>? createdAt,
    Value<int>? rowid,
  }) {
    return OutboxEntriesCompanion(
      id: id ?? this.id,
      entity: entity ?? this.entity,
      entityId: entityId ?? this.entityId,
      payload: payload ?? this.payload,
      attempts: attempts ?? this.attempts,
      lastError: lastError ?? this.lastError,
      createdAt: createdAt ?? this.createdAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (entity.present) {
      map['entity'] = Variable<String>(entity.value);
    }
    if (entityId.present) {
      map['entity_id'] = Variable<String>(entityId.value);
    }
    if (payload.present) {
      map['payload'] = Variable<String>(payload.value);
    }
    if (attempts.present) {
      map['attempts'] = Variable<int>(attempts.value);
    }
    if (lastError.present) {
      map['last_error'] = Variable<String>(lastError.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('OutboxEntriesCompanion(')
          ..write('id: $id, ')
          ..write('entity: $entity, ')
          ..write('entityId: $entityId, ')
          ..write('payload: $payload, ')
          ..write('attempts: $attempts, ')
          ..write('lastError: $lastError, ')
          ..write('createdAt: $createdAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $TillSessionsTable extends TillSessions
    with TableInfo<$TillSessionsTable, TillSession> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $TillSessionsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _openedAtMeta = const VerificationMeta(
    'openedAt',
  );
  @override
  late final GeneratedColumn<DateTime> openedAt = GeneratedColumn<DateTime>(
    'opened_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  static const VerificationMeta _closedAtMeta = const VerificationMeta(
    'closedAt',
  );
  @override
  late final GeneratedColumn<DateTime> closedAt = GeneratedColumn<DateTime>(
    'closed_at',
    aliasedName,
    true,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _zNumberMeta = const VerificationMeta(
    'zNumber',
  );
  @override
  late final GeneratedColumn<int> zNumber = GeneratedColumn<int>(
    'z_number',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _openingFloatMinorMeta = const VerificationMeta(
    'openingFloatMinor',
  );
  @override
  late final GeneratedColumn<int> openingFloatMinor = GeneratedColumn<int>(
    'opening_float_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    openedAt,
    closedAt,
    zNumber,
    openingFloatMinor,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'till_sessions';
  @override
  VerificationContext validateIntegrity(
    Insertable<TillSession> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('opened_at')) {
      context.handle(
        _openedAtMeta,
        openedAt.isAcceptableOrUnknown(data['opened_at']!, _openedAtMeta),
      );
    }
    if (data.containsKey('closed_at')) {
      context.handle(
        _closedAtMeta,
        closedAt.isAcceptableOrUnknown(data['closed_at']!, _closedAtMeta),
      );
    }
    if (data.containsKey('z_number')) {
      context.handle(
        _zNumberMeta,
        zNumber.isAcceptableOrUnknown(data['z_number']!, _zNumberMeta),
      );
    }
    if (data.containsKey('opening_float_minor')) {
      context.handle(
        _openingFloatMinorMeta,
        openingFloatMinor.isAcceptableOrUnknown(
          data['opening_float_minor']!,
          _openingFloatMinorMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  TillSession map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return TillSession(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      openedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}opened_at'],
      )!,
      closedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}closed_at'],
      ),
      zNumber: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}z_number'],
      ),
      openingFloatMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}opening_float_minor'],
      )!,
    );
  }

  @override
  $TillSessionsTable createAlias(String alias) {
    return $TillSessionsTable(attachedDatabase, alias);
  }
}

class TillSession extends DataClass implements Insertable<TillSession> {
  final String id;
  final DateTime openedAt;
  final DateTime? closedAt;

  /// Sequential Z number, assigned when the session is closed.
  final int? zNumber;

  /// Cash counted into the drawer at open.
  final int openingFloatMinor;
  const TillSession({
    required this.id,
    required this.openedAt,
    this.closedAt,
    this.zNumber,
    required this.openingFloatMinor,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['opened_at'] = Variable<DateTime>(openedAt);
    if (!nullToAbsent || closedAt != null) {
      map['closed_at'] = Variable<DateTime>(closedAt);
    }
    if (!nullToAbsent || zNumber != null) {
      map['z_number'] = Variable<int>(zNumber);
    }
    map['opening_float_minor'] = Variable<int>(openingFloatMinor);
    return map;
  }

  TillSessionsCompanion toCompanion(bool nullToAbsent) {
    return TillSessionsCompanion(
      id: Value(id),
      openedAt: Value(openedAt),
      closedAt: closedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(closedAt),
      zNumber: zNumber == null && nullToAbsent
          ? const Value.absent()
          : Value(zNumber),
      openingFloatMinor: Value(openingFloatMinor),
    );
  }

  factory TillSession.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return TillSession(
      id: serializer.fromJson<String>(json['id']),
      openedAt: serializer.fromJson<DateTime>(json['openedAt']),
      closedAt: serializer.fromJson<DateTime?>(json['closedAt']),
      zNumber: serializer.fromJson<int?>(json['zNumber']),
      openingFloatMinor: serializer.fromJson<int>(json['openingFloatMinor']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'openedAt': serializer.toJson<DateTime>(openedAt),
      'closedAt': serializer.toJson<DateTime?>(closedAt),
      'zNumber': serializer.toJson<int?>(zNumber),
      'openingFloatMinor': serializer.toJson<int>(openingFloatMinor),
    };
  }

  TillSession copyWith({
    String? id,
    DateTime? openedAt,
    Value<DateTime?> closedAt = const Value.absent(),
    Value<int?> zNumber = const Value.absent(),
    int? openingFloatMinor,
  }) => TillSession(
    id: id ?? this.id,
    openedAt: openedAt ?? this.openedAt,
    closedAt: closedAt.present ? closedAt.value : this.closedAt,
    zNumber: zNumber.present ? zNumber.value : this.zNumber,
    openingFloatMinor: openingFloatMinor ?? this.openingFloatMinor,
  );
  TillSession copyWithCompanion(TillSessionsCompanion data) {
    return TillSession(
      id: data.id.present ? data.id.value : this.id,
      openedAt: data.openedAt.present ? data.openedAt.value : this.openedAt,
      closedAt: data.closedAt.present ? data.closedAt.value : this.closedAt,
      zNumber: data.zNumber.present ? data.zNumber.value : this.zNumber,
      openingFloatMinor: data.openingFloatMinor.present
          ? data.openingFloatMinor.value
          : this.openingFloatMinor,
    );
  }

  @override
  String toString() {
    return (StringBuffer('TillSession(')
          ..write('id: $id, ')
          ..write('openedAt: $openedAt, ')
          ..write('closedAt: $closedAt, ')
          ..write('zNumber: $zNumber, ')
          ..write('openingFloatMinor: $openingFloatMinor')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(id, openedAt, closedAt, zNumber, openingFloatMinor);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is TillSession &&
          other.id == this.id &&
          other.openedAt == this.openedAt &&
          other.closedAt == this.closedAt &&
          other.zNumber == this.zNumber &&
          other.openingFloatMinor == this.openingFloatMinor);
}

class TillSessionsCompanion extends UpdateCompanion<TillSession> {
  final Value<String> id;
  final Value<DateTime> openedAt;
  final Value<DateTime?> closedAt;
  final Value<int?> zNumber;
  final Value<int> openingFloatMinor;
  final Value<int> rowid;
  const TillSessionsCompanion({
    this.id = const Value.absent(),
    this.openedAt = const Value.absent(),
    this.closedAt = const Value.absent(),
    this.zNumber = const Value.absent(),
    this.openingFloatMinor = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  TillSessionsCompanion.insert({
    required String id,
    this.openedAt = const Value.absent(),
    this.closedAt = const Value.absent(),
    this.zNumber = const Value.absent(),
    this.openingFloatMinor = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id);
  static Insertable<TillSession> custom({
    Expression<String>? id,
    Expression<DateTime>? openedAt,
    Expression<DateTime>? closedAt,
    Expression<int>? zNumber,
    Expression<int>? openingFloatMinor,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (openedAt != null) 'opened_at': openedAt,
      if (closedAt != null) 'closed_at': closedAt,
      if (zNumber != null) 'z_number': zNumber,
      if (openingFloatMinor != null) 'opening_float_minor': openingFloatMinor,
      if (rowid != null) 'rowid': rowid,
    });
  }

  TillSessionsCompanion copyWith({
    Value<String>? id,
    Value<DateTime>? openedAt,
    Value<DateTime?>? closedAt,
    Value<int?>? zNumber,
    Value<int>? openingFloatMinor,
    Value<int>? rowid,
  }) {
    return TillSessionsCompanion(
      id: id ?? this.id,
      openedAt: openedAt ?? this.openedAt,
      closedAt: closedAt ?? this.closedAt,
      zNumber: zNumber ?? this.zNumber,
      openingFloatMinor: openingFloatMinor ?? this.openingFloatMinor,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (openedAt.present) {
      map['opened_at'] = Variable<DateTime>(openedAt.value);
    }
    if (closedAt.present) {
      map['closed_at'] = Variable<DateTime>(closedAt.value);
    }
    if (zNumber.present) {
      map['z_number'] = Variable<int>(zNumber.value);
    }
    if (openingFloatMinor.present) {
      map['opening_float_minor'] = Variable<int>(openingFloatMinor.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('TillSessionsCompanion(')
          ..write('id: $id, ')
          ..write('openedAt: $openedAt, ')
          ..write('closedAt: $closedAt, ')
          ..write('zNumber: $zNumber, ')
          ..write('openingFloatMinor: $openingFloatMinor, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $DiningTablesTable extends DiningTables
    with TableInfo<$DiningTablesTable, DiningTable> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $DiningTablesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _numberMeta = const VerificationMeta('number');
  @override
  late final GeneratedColumn<int> number = GeneratedColumn<int>(
    'number',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _labelMeta = const VerificationMeta('label');
  @override
  late final GeneratedColumn<String> label = GeneratedColumn<String>(
    'label',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [number, label];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'dining_tables';
  @override
  VerificationContext validateIntegrity(
    Insertable<DiningTable> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('number')) {
      context.handle(
        _numberMeta,
        number.isAcceptableOrUnknown(data['number']!, _numberMeta),
      );
    }
    if (data.containsKey('label')) {
      context.handle(
        _labelMeta,
        label.isAcceptableOrUnknown(data['label']!, _labelMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {number};
  @override
  DiningTable map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return DiningTable(
      number: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}number'],
      )!,
      label: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}label'],
      ),
    );
  }

  @override
  $DiningTablesTable createAlias(String alias) {
    return $DiningTablesTable(attachedDatabase, alias);
  }
}

class DiningTable extends DataClass implements Insertable<DiningTable> {
  final int number;
  final String? label;
  const DiningTable({required this.number, this.label});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['number'] = Variable<int>(number);
    if (!nullToAbsent || label != null) {
      map['label'] = Variable<String>(label);
    }
    return map;
  }

  DiningTablesCompanion toCompanion(bool nullToAbsent) {
    return DiningTablesCompanion(
      number: Value(number),
      label: label == null && nullToAbsent
          ? const Value.absent()
          : Value(label),
    );
  }

  factory DiningTable.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return DiningTable(
      number: serializer.fromJson<int>(json['number']),
      label: serializer.fromJson<String?>(json['label']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'number': serializer.toJson<int>(number),
      'label': serializer.toJson<String?>(label),
    };
  }

  DiningTable copyWith({
    int? number,
    Value<String?> label = const Value.absent(),
  }) => DiningTable(
    number: number ?? this.number,
    label: label.present ? label.value : this.label,
  );
  DiningTable copyWithCompanion(DiningTablesCompanion data) {
    return DiningTable(
      number: data.number.present ? data.number.value : this.number,
      label: data.label.present ? data.label.value : this.label,
    );
  }

  @override
  String toString() {
    return (StringBuffer('DiningTable(')
          ..write('number: $number, ')
          ..write('label: $label')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(number, label);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is DiningTable &&
          other.number == this.number &&
          other.label == this.label);
}

class DiningTablesCompanion extends UpdateCompanion<DiningTable> {
  final Value<int> number;
  final Value<String?> label;
  const DiningTablesCompanion({
    this.number = const Value.absent(),
    this.label = const Value.absent(),
  });
  DiningTablesCompanion.insert({
    this.number = const Value.absent(),
    this.label = const Value.absent(),
  });
  static Insertable<DiningTable> custom({
    Expression<int>? number,
    Expression<String>? label,
  }) {
    return RawValuesInsertable({
      if (number != null) 'number': number,
      if (label != null) 'label': label,
    });
  }

  DiningTablesCompanion copyWith({Value<int>? number, Value<String?>? label}) {
    return DiningTablesCompanion(
      number: number ?? this.number,
      label: label ?? this.label,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (number.present) {
      map['number'] = Variable<int>(number.value);
    }
    if (label.present) {
      map['label'] = Variable<String>(label.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('DiningTablesCompanion(')
          ..write('number: $number, ')
          ..write('label: $label')
          ..write(')'))
        .toString();
  }
}

class $CustomersTable extends Customers
    with TableInfo<$CustomersTable, Customer> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CustomersTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _phoneMeta = const VerificationMeta('phone');
  @override
  late final GeneratedColumn<String> phone = GeneratedColumn<String>(
    'phone',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _emailMeta = const VerificationMeta('email');
  @override
  late final GeneratedColumn<String> email = GeneratedColumn<String>(
    'email',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _cardNumberMeta = const VerificationMeta(
    'cardNumber',
  );
  @override
  late final GeneratedColumn<String> cardNumber = GeneratedColumn<String>(
    'card_number',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _pointsBalanceMeta = const VerificationMeta(
    'pointsBalance',
  );
  @override
  late final GeneratedColumn<int> pointsBalance = GeneratedColumn<int>(
    'points_balance',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _membershipExpiryMeta = const VerificationMeta(
    'membershipExpiry',
  );
  @override
  late final GeneratedColumn<DateTime> membershipExpiry =
      GeneratedColumn<DateTime>(
        'membership_expiry',
        aliasedName,
        true,
        type: DriftSqlType.dateTime,
        requiredDuringInsert: false,
      );
  static const VerificationMeta _syncedAtMeta = const VerificationMeta(
    'syncedAt',
  );
  @override
  late final GeneratedColumn<DateTime> syncedAt = GeneratedColumn<DateTime>(
    'synced_at',
    aliasedName,
    true,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    name,
    phone,
    email,
    cardNumber,
    pointsBalance,
    membershipExpiry,
    syncedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'customers';
  @override
  VerificationContext validateIntegrity(
    Insertable<Customer> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('phone')) {
      context.handle(
        _phoneMeta,
        phone.isAcceptableOrUnknown(data['phone']!, _phoneMeta),
      );
    }
    if (data.containsKey('email')) {
      context.handle(
        _emailMeta,
        email.isAcceptableOrUnknown(data['email']!, _emailMeta),
      );
    }
    if (data.containsKey('card_number')) {
      context.handle(
        _cardNumberMeta,
        cardNumber.isAcceptableOrUnknown(data['card_number']!, _cardNumberMeta),
      );
    }
    if (data.containsKey('points_balance')) {
      context.handle(
        _pointsBalanceMeta,
        pointsBalance.isAcceptableOrUnknown(
          data['points_balance']!,
          _pointsBalanceMeta,
        ),
      );
    }
    if (data.containsKey('membership_expiry')) {
      context.handle(
        _membershipExpiryMeta,
        membershipExpiry.isAcceptableOrUnknown(
          data['membership_expiry']!,
          _membershipExpiryMeta,
        ),
      );
    }
    if (data.containsKey('synced_at')) {
      context.handle(
        _syncedAtMeta,
        syncedAt.isAcceptableOrUnknown(data['synced_at']!, _syncedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  Customer map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Customer(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      phone: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}phone'],
      ),
      email: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}email'],
      ),
      cardNumber: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}card_number'],
      ),
      pointsBalance: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}points_balance'],
      )!,
      membershipExpiry: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}membership_expiry'],
      ),
      syncedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}synced_at'],
      ),
    );
  }

  @override
  $CustomersTable createAlias(String alias) {
    return $CustomersTable(attachedDatabase, alias);
  }
}

class Customer extends DataClass implements Insertable<Customer> {
  final String id;
  final String name;
  final String? phone;
  final String? email;

  /// Card/fob number swiped at the till.
  final String? cardNumber;
  final int pointsBalance;
  final DateTime? membershipExpiry;
  final DateTime? syncedAt;
  const Customer({
    required this.id,
    required this.name,
    this.phone,
    this.email,
    this.cardNumber,
    required this.pointsBalance,
    this.membershipExpiry,
    this.syncedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['name'] = Variable<String>(name);
    if (!nullToAbsent || phone != null) {
      map['phone'] = Variable<String>(phone);
    }
    if (!nullToAbsent || email != null) {
      map['email'] = Variable<String>(email);
    }
    if (!nullToAbsent || cardNumber != null) {
      map['card_number'] = Variable<String>(cardNumber);
    }
    map['points_balance'] = Variable<int>(pointsBalance);
    if (!nullToAbsent || membershipExpiry != null) {
      map['membership_expiry'] = Variable<DateTime>(membershipExpiry);
    }
    if (!nullToAbsent || syncedAt != null) {
      map['synced_at'] = Variable<DateTime>(syncedAt);
    }
    return map;
  }

  CustomersCompanion toCompanion(bool nullToAbsent) {
    return CustomersCompanion(
      id: Value(id),
      name: Value(name),
      phone: phone == null && nullToAbsent
          ? const Value.absent()
          : Value(phone),
      email: email == null && nullToAbsent
          ? const Value.absent()
          : Value(email),
      cardNumber: cardNumber == null && nullToAbsent
          ? const Value.absent()
          : Value(cardNumber),
      pointsBalance: Value(pointsBalance),
      membershipExpiry: membershipExpiry == null && nullToAbsent
          ? const Value.absent()
          : Value(membershipExpiry),
      syncedAt: syncedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(syncedAt),
    );
  }

  factory Customer.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Customer(
      id: serializer.fromJson<String>(json['id']),
      name: serializer.fromJson<String>(json['name']),
      phone: serializer.fromJson<String?>(json['phone']),
      email: serializer.fromJson<String?>(json['email']),
      cardNumber: serializer.fromJson<String?>(json['cardNumber']),
      pointsBalance: serializer.fromJson<int>(json['pointsBalance']),
      membershipExpiry: serializer.fromJson<DateTime?>(
        json['membershipExpiry'],
      ),
      syncedAt: serializer.fromJson<DateTime?>(json['syncedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'name': serializer.toJson<String>(name),
      'phone': serializer.toJson<String?>(phone),
      'email': serializer.toJson<String?>(email),
      'cardNumber': serializer.toJson<String?>(cardNumber),
      'pointsBalance': serializer.toJson<int>(pointsBalance),
      'membershipExpiry': serializer.toJson<DateTime?>(membershipExpiry),
      'syncedAt': serializer.toJson<DateTime?>(syncedAt),
    };
  }

  Customer copyWith({
    String? id,
    String? name,
    Value<String?> phone = const Value.absent(),
    Value<String?> email = const Value.absent(),
    Value<String?> cardNumber = const Value.absent(),
    int? pointsBalance,
    Value<DateTime?> membershipExpiry = const Value.absent(),
    Value<DateTime?> syncedAt = const Value.absent(),
  }) => Customer(
    id: id ?? this.id,
    name: name ?? this.name,
    phone: phone.present ? phone.value : this.phone,
    email: email.present ? email.value : this.email,
    cardNumber: cardNumber.present ? cardNumber.value : this.cardNumber,
    pointsBalance: pointsBalance ?? this.pointsBalance,
    membershipExpiry: membershipExpiry.present
        ? membershipExpiry.value
        : this.membershipExpiry,
    syncedAt: syncedAt.present ? syncedAt.value : this.syncedAt,
  );
  Customer copyWithCompanion(CustomersCompanion data) {
    return Customer(
      id: data.id.present ? data.id.value : this.id,
      name: data.name.present ? data.name.value : this.name,
      phone: data.phone.present ? data.phone.value : this.phone,
      email: data.email.present ? data.email.value : this.email,
      cardNumber: data.cardNumber.present
          ? data.cardNumber.value
          : this.cardNumber,
      pointsBalance: data.pointsBalance.present
          ? data.pointsBalance.value
          : this.pointsBalance,
      membershipExpiry: data.membershipExpiry.present
          ? data.membershipExpiry.value
          : this.membershipExpiry,
      syncedAt: data.syncedAt.present ? data.syncedAt.value : this.syncedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Customer(')
          ..write('id: $id, ')
          ..write('name: $name, ')
          ..write('phone: $phone, ')
          ..write('email: $email, ')
          ..write('cardNumber: $cardNumber, ')
          ..write('pointsBalance: $pointsBalance, ')
          ..write('membershipExpiry: $membershipExpiry, ')
          ..write('syncedAt: $syncedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    id,
    name,
    phone,
    email,
    cardNumber,
    pointsBalance,
    membershipExpiry,
    syncedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Customer &&
          other.id == this.id &&
          other.name == this.name &&
          other.phone == this.phone &&
          other.email == this.email &&
          other.cardNumber == this.cardNumber &&
          other.pointsBalance == this.pointsBalance &&
          other.membershipExpiry == this.membershipExpiry &&
          other.syncedAt == this.syncedAt);
}

class CustomersCompanion extends UpdateCompanion<Customer> {
  final Value<String> id;
  final Value<String> name;
  final Value<String?> phone;
  final Value<String?> email;
  final Value<String?> cardNumber;
  final Value<int> pointsBalance;
  final Value<DateTime?> membershipExpiry;
  final Value<DateTime?> syncedAt;
  final Value<int> rowid;
  const CustomersCompanion({
    this.id = const Value.absent(),
    this.name = const Value.absent(),
    this.phone = const Value.absent(),
    this.email = const Value.absent(),
    this.cardNumber = const Value.absent(),
    this.pointsBalance = const Value.absent(),
    this.membershipExpiry = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CustomersCompanion.insert({
    required String id,
    required String name,
    this.phone = const Value.absent(),
    this.email = const Value.absent(),
    this.cardNumber = const Value.absent(),
    this.pointsBalance = const Value.absent(),
    this.membershipExpiry = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       name = Value(name);
  static Insertable<Customer> custom({
    Expression<String>? id,
    Expression<String>? name,
    Expression<String>? phone,
    Expression<String>? email,
    Expression<String>? cardNumber,
    Expression<int>? pointsBalance,
    Expression<DateTime>? membershipExpiry,
    Expression<DateTime>? syncedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (name != null) 'name': name,
      if (phone != null) 'phone': phone,
      if (email != null) 'email': email,
      if (cardNumber != null) 'card_number': cardNumber,
      if (pointsBalance != null) 'points_balance': pointsBalance,
      if (membershipExpiry != null) 'membership_expiry': membershipExpiry,
      if (syncedAt != null) 'synced_at': syncedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CustomersCompanion copyWith({
    Value<String>? id,
    Value<String>? name,
    Value<String?>? phone,
    Value<String?>? email,
    Value<String?>? cardNumber,
    Value<int>? pointsBalance,
    Value<DateTime?>? membershipExpiry,
    Value<DateTime?>? syncedAt,
    Value<int>? rowid,
  }) {
    return CustomersCompanion(
      id: id ?? this.id,
      name: name ?? this.name,
      phone: phone ?? this.phone,
      email: email ?? this.email,
      cardNumber: cardNumber ?? this.cardNumber,
      pointsBalance: pointsBalance ?? this.pointsBalance,
      membershipExpiry: membershipExpiry ?? this.membershipExpiry,
      syncedAt: syncedAt ?? this.syncedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (phone.present) {
      map['phone'] = Variable<String>(phone.value);
    }
    if (email.present) {
      map['email'] = Variable<String>(email.value);
    }
    if (cardNumber.present) {
      map['card_number'] = Variable<String>(cardNumber.value);
    }
    if (pointsBalance.present) {
      map['points_balance'] = Variable<int>(pointsBalance.value);
    }
    if (membershipExpiry.present) {
      map['membership_expiry'] = Variable<DateTime>(membershipExpiry.value);
    }
    if (syncedAt.present) {
      map['synced_at'] = Variable<DateTime>(syncedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CustomersCompanion(')
          ..write('id: $id, ')
          ..write('name: $name, ')
          ..write('phone: $phone, ')
          ..write('email: $email, ')
          ..write('cardNumber: $cardNumber, ')
          ..write('pointsBalance: $pointsBalance, ')
          ..write('membershipExpiry: $membershipExpiry, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $LoyaltyEntriesTable extends LoyaltyEntries
    with TableInfo<$LoyaltyEntriesTable, LoyaltyEntry> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $LoyaltyEntriesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<String> id = GeneratedColumn<String>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _customerIdMeta = const VerificationMeta(
    'customerId',
  );
  @override
  late final GeneratedColumn<String> customerId = GeneratedColumn<String>(
    'customer_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'REFERENCES customers (id)',
    ),
  );
  static const VerificationMeta _orderIdMeta = const VerificationMeta(
    'orderId',
  );
  @override
  late final GeneratedColumn<String> orderId = GeneratedColumn<String>(
    'order_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _pointsMeta = const VerificationMeta('points');
  @override
  late final GeneratedColumn<int> points = GeneratedColumn<int>(
    'points',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _reasonMeta = const VerificationMeta('reason');
  @override
  late final GeneratedColumn<String> reason = GeneratedColumn<String>(
    'reason',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<DateTime> createdAt = GeneratedColumn<DateTime>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.dateTime,
    requiredDuringInsert: false,
    defaultValue: currentDateAndTime,
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    customerId,
    orderId,
    points,
    reason,
    createdAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'loyalty_entries';
  @override
  VerificationContext validateIntegrity(
    Insertable<LoyaltyEntry> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    } else if (isInserting) {
      context.missing(_idMeta);
    }
    if (data.containsKey('customer_id')) {
      context.handle(
        _customerIdMeta,
        customerId.isAcceptableOrUnknown(data['customer_id']!, _customerIdMeta),
      );
    } else if (isInserting) {
      context.missing(_customerIdMeta);
    }
    if (data.containsKey('order_id')) {
      context.handle(
        _orderIdMeta,
        orderId.isAcceptableOrUnknown(data['order_id']!, _orderIdMeta),
      );
    }
    if (data.containsKey('points')) {
      context.handle(
        _pointsMeta,
        points.isAcceptableOrUnknown(data['points']!, _pointsMeta),
      );
    } else if (isInserting) {
      context.missing(_pointsMeta);
    }
    if (data.containsKey('reason')) {
      context.handle(
        _reasonMeta,
        reason.isAcceptableOrUnknown(data['reason']!, _reasonMeta),
      );
    } else if (isInserting) {
      context.missing(_reasonMeta);
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  LoyaltyEntry map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return LoyaltyEntry(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}id'],
      )!,
      customerId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}customer_id'],
      )!,
      orderId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}order_id'],
      ),
      points: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}points'],
      )!,
      reason: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}reason'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.dateTime,
        data['${effectivePrefix}created_at'],
      )!,
    );
  }

  @override
  $LoyaltyEntriesTable createAlias(String alias) {
    return $LoyaltyEntriesTable(attachedDatabase, alias);
  }
}

class LoyaltyEntry extends DataClass implements Insertable<LoyaltyEntry> {
  final String id;
  final String customerId;
  final String? orderId;

  /// Positive when earned, negative when redeemed.
  final int points;
  final String reason;
  final DateTime createdAt;
  const LoyaltyEntry({
    required this.id,
    required this.customerId,
    this.orderId,
    required this.points,
    required this.reason,
    required this.createdAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<String>(id);
    map['customer_id'] = Variable<String>(customerId);
    if (!nullToAbsent || orderId != null) {
      map['order_id'] = Variable<String>(orderId);
    }
    map['points'] = Variable<int>(points);
    map['reason'] = Variable<String>(reason);
    map['created_at'] = Variable<DateTime>(createdAt);
    return map;
  }

  LoyaltyEntriesCompanion toCompanion(bool nullToAbsent) {
    return LoyaltyEntriesCompanion(
      id: Value(id),
      customerId: Value(customerId),
      orderId: orderId == null && nullToAbsent
          ? const Value.absent()
          : Value(orderId),
      points: Value(points),
      reason: Value(reason),
      createdAt: Value(createdAt),
    );
  }

  factory LoyaltyEntry.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return LoyaltyEntry(
      id: serializer.fromJson<String>(json['id']),
      customerId: serializer.fromJson<String>(json['customerId']),
      orderId: serializer.fromJson<String?>(json['orderId']),
      points: serializer.fromJson<int>(json['points']),
      reason: serializer.fromJson<String>(json['reason']),
      createdAt: serializer.fromJson<DateTime>(json['createdAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<String>(id),
      'customerId': serializer.toJson<String>(customerId),
      'orderId': serializer.toJson<String?>(orderId),
      'points': serializer.toJson<int>(points),
      'reason': serializer.toJson<String>(reason),
      'createdAt': serializer.toJson<DateTime>(createdAt),
    };
  }

  LoyaltyEntry copyWith({
    String? id,
    String? customerId,
    Value<String?> orderId = const Value.absent(),
    int? points,
    String? reason,
    DateTime? createdAt,
  }) => LoyaltyEntry(
    id: id ?? this.id,
    customerId: customerId ?? this.customerId,
    orderId: orderId.present ? orderId.value : this.orderId,
    points: points ?? this.points,
    reason: reason ?? this.reason,
    createdAt: createdAt ?? this.createdAt,
  );
  LoyaltyEntry copyWithCompanion(LoyaltyEntriesCompanion data) {
    return LoyaltyEntry(
      id: data.id.present ? data.id.value : this.id,
      customerId: data.customerId.present
          ? data.customerId.value
          : this.customerId,
      orderId: data.orderId.present ? data.orderId.value : this.orderId,
      points: data.points.present ? data.points.value : this.points,
      reason: data.reason.present ? data.reason.value : this.reason,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('LoyaltyEntry(')
          ..write('id: $id, ')
          ..write('customerId: $customerId, ')
          ..write('orderId: $orderId, ')
          ..write('points: $points, ')
          ..write('reason: $reason, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(id, customerId, orderId, points, reason, createdAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is LoyaltyEntry &&
          other.id == this.id &&
          other.customerId == this.customerId &&
          other.orderId == this.orderId &&
          other.points == this.points &&
          other.reason == this.reason &&
          other.createdAt == this.createdAt);
}

class LoyaltyEntriesCompanion extends UpdateCompanion<LoyaltyEntry> {
  final Value<String> id;
  final Value<String> customerId;
  final Value<String?> orderId;
  final Value<int> points;
  final Value<String> reason;
  final Value<DateTime> createdAt;
  final Value<int> rowid;
  const LoyaltyEntriesCompanion({
    this.id = const Value.absent(),
    this.customerId = const Value.absent(),
    this.orderId = const Value.absent(),
    this.points = const Value.absent(),
    this.reason = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  LoyaltyEntriesCompanion.insert({
    required String id,
    required String customerId,
    this.orderId = const Value.absent(),
    required int points,
    required String reason,
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : id = Value(id),
       customerId = Value(customerId),
       points = Value(points),
       reason = Value(reason);
  static Insertable<LoyaltyEntry> custom({
    Expression<String>? id,
    Expression<String>? customerId,
    Expression<String>? orderId,
    Expression<int>? points,
    Expression<String>? reason,
    Expression<DateTime>? createdAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (customerId != null) 'customer_id': customerId,
      if (orderId != null) 'order_id': orderId,
      if (points != null) 'points': points,
      if (reason != null) 'reason': reason,
      if (createdAt != null) 'created_at': createdAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  LoyaltyEntriesCompanion copyWith({
    Value<String>? id,
    Value<String>? customerId,
    Value<String?>? orderId,
    Value<int>? points,
    Value<String>? reason,
    Value<DateTime>? createdAt,
    Value<int>? rowid,
  }) {
    return LoyaltyEntriesCompanion(
      id: id ?? this.id,
      customerId: customerId ?? this.customerId,
      orderId: orderId ?? this.orderId,
      points: points ?? this.points,
      reason: reason ?? this.reason,
      createdAt: createdAt ?? this.createdAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<String>(id.value);
    }
    if (customerId.present) {
      map['customer_id'] = Variable<String>(customerId.value);
    }
    if (orderId.present) {
      map['order_id'] = Variable<String>(orderId.value);
    }
    if (points.present) {
      map['points'] = Variable<int>(points.value);
    }
    if (reason.present) {
      map['reason'] = Variable<String>(reason.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<DateTime>(createdAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('LoyaltyEntriesCompanion(')
          ..write('id: $id, ')
          ..write('customerId: $customerId, ')
          ..write('orderId: $orderId, ')
          ..write('points: $points, ')
          ..write('reason: $reason, ')
          ..write('createdAt: $createdAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $MixMatchDealsTable extends MixMatchDeals
    with TableInfo<$MixMatchDealsTable, MixMatchDeal> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $MixMatchDealsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _triggerQtyMeta = const VerificationMeta(
    'triggerQty',
  );
  @override
  late final GeneratedColumn<int> triggerQty = GeneratedColumn<int>(
    'trigger_qty',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(2),
  );
  static const VerificationMeta _dealPriceMinorMeta = const VerificationMeta(
    'dealPriceMinor',
  );
  @override
  late final GeneratedColumn<int> dealPriceMinor = GeneratedColumn<int>(
    'deal_price_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _activeMeta = const VerificationMeta('active');
  @override
  late final GeneratedColumn<bool> active = GeneratedColumn<bool>(
    'active',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("active" IN (0, 1))',
    ),
    defaultValue: const Constant(true),
  );
  @override
  List<GeneratedColumn> get $columns => [
    id,
    name,
    triggerQty,
    dealPriceMinor,
    active,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'mix_match_deals';
  @override
  VerificationContext validateIntegrity(
    Insertable<MixMatchDeal> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('trigger_qty')) {
      context.handle(
        _triggerQtyMeta,
        triggerQty.isAcceptableOrUnknown(data['trigger_qty']!, _triggerQtyMeta),
      );
    }
    if (data.containsKey('deal_price_minor')) {
      context.handle(
        _dealPriceMinorMeta,
        dealPriceMinor.isAcceptableOrUnknown(
          data['deal_price_minor']!,
          _dealPriceMinorMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_dealPriceMinorMeta);
    }
    if (data.containsKey('active')) {
      context.handle(
        _activeMeta,
        active.isAcceptableOrUnknown(data['active']!, _activeMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  MixMatchDeal map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return MixMatchDeal(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      triggerQty: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}trigger_qty'],
      )!,
      dealPriceMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}deal_price_minor'],
      )!,
      active: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}active'],
      )!,
    );
  }

  @override
  $MixMatchDealsTable createAlias(String alias) {
    return $MixMatchDealsTable(attachedDatabase, alias);
  }
}

class MixMatchDeal extends DataClass implements Insertable<MixMatchDeal> {
  final int id;
  final String name;
  final int triggerQty;
  final int dealPriceMinor;
  final bool active;
  const MixMatchDeal({
    required this.id,
    required this.name,
    required this.triggerQty,
    required this.dealPriceMinor,
    required this.active,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    map['name'] = Variable<String>(name);
    map['trigger_qty'] = Variable<int>(triggerQty);
    map['deal_price_minor'] = Variable<int>(dealPriceMinor);
    map['active'] = Variable<bool>(active);
    return map;
  }

  MixMatchDealsCompanion toCompanion(bool nullToAbsent) {
    return MixMatchDealsCompanion(
      id: Value(id),
      name: Value(name),
      triggerQty: Value(triggerQty),
      dealPriceMinor: Value(dealPriceMinor),
      active: Value(active),
    );
  }

  factory MixMatchDeal.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return MixMatchDeal(
      id: serializer.fromJson<int>(json['id']),
      name: serializer.fromJson<String>(json['name']),
      triggerQty: serializer.fromJson<int>(json['triggerQty']),
      dealPriceMinor: serializer.fromJson<int>(json['dealPriceMinor']),
      active: serializer.fromJson<bool>(json['active']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'name': serializer.toJson<String>(name),
      'triggerQty': serializer.toJson<int>(triggerQty),
      'dealPriceMinor': serializer.toJson<int>(dealPriceMinor),
      'active': serializer.toJson<bool>(active),
    };
  }

  MixMatchDeal copyWith({
    int? id,
    String? name,
    int? triggerQty,
    int? dealPriceMinor,
    bool? active,
  }) => MixMatchDeal(
    id: id ?? this.id,
    name: name ?? this.name,
    triggerQty: triggerQty ?? this.triggerQty,
    dealPriceMinor: dealPriceMinor ?? this.dealPriceMinor,
    active: active ?? this.active,
  );
  MixMatchDeal copyWithCompanion(MixMatchDealsCompanion data) {
    return MixMatchDeal(
      id: data.id.present ? data.id.value : this.id,
      name: data.name.present ? data.name.value : this.name,
      triggerQty: data.triggerQty.present
          ? data.triggerQty.value
          : this.triggerQty,
      dealPriceMinor: data.dealPriceMinor.present
          ? data.dealPriceMinor.value
          : this.dealPriceMinor,
      active: data.active.present ? data.active.value : this.active,
    );
  }

  @override
  String toString() {
    return (StringBuffer('MixMatchDeal(')
          ..write('id: $id, ')
          ..write('name: $name, ')
          ..write('triggerQty: $triggerQty, ')
          ..write('dealPriceMinor: $dealPriceMinor, ')
          ..write('active: $active')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(id, name, triggerQty, dealPriceMinor, active);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is MixMatchDeal &&
          other.id == this.id &&
          other.name == this.name &&
          other.triggerQty == this.triggerQty &&
          other.dealPriceMinor == this.dealPriceMinor &&
          other.active == this.active);
}

class MixMatchDealsCompanion extends UpdateCompanion<MixMatchDeal> {
  final Value<int> id;
  final Value<String> name;
  final Value<int> triggerQty;
  final Value<int> dealPriceMinor;
  final Value<bool> active;
  const MixMatchDealsCompanion({
    this.id = const Value.absent(),
    this.name = const Value.absent(),
    this.triggerQty = const Value.absent(),
    this.dealPriceMinor = const Value.absent(),
    this.active = const Value.absent(),
  });
  MixMatchDealsCompanion.insert({
    this.id = const Value.absent(),
    required String name,
    this.triggerQty = const Value.absent(),
    required int dealPriceMinor,
    this.active = const Value.absent(),
  }) : name = Value(name),
       dealPriceMinor = Value(dealPriceMinor);
  static Insertable<MixMatchDeal> custom({
    Expression<int>? id,
    Expression<String>? name,
    Expression<int>? triggerQty,
    Expression<int>? dealPriceMinor,
    Expression<bool>? active,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (name != null) 'name': name,
      if (triggerQty != null) 'trigger_qty': triggerQty,
      if (dealPriceMinor != null) 'deal_price_minor': dealPriceMinor,
      if (active != null) 'active': active,
    });
  }

  MixMatchDealsCompanion copyWith({
    Value<int>? id,
    Value<String>? name,
    Value<int>? triggerQty,
    Value<int>? dealPriceMinor,
    Value<bool>? active,
  }) {
    return MixMatchDealsCompanion(
      id: id ?? this.id,
      name: name ?? this.name,
      triggerQty: triggerQty ?? this.triggerQty,
      dealPriceMinor: dealPriceMinor ?? this.dealPriceMinor,
      active: active ?? this.active,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (triggerQty.present) {
      map['trigger_qty'] = Variable<int>(triggerQty.value);
    }
    if (dealPriceMinor.present) {
      map['deal_price_minor'] = Variable<int>(dealPriceMinor.value);
    }
    if (active.present) {
      map['active'] = Variable<bool>(active.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('MixMatchDealsCompanion(')
          ..write('id: $id, ')
          ..write('name: $name, ')
          ..write('triggerQty: $triggerQty, ')
          ..write('dealPriceMinor: $dealPriceMinor, ')
          ..write('active: $active')
          ..write(')'))
        .toString();
  }
}

class $MixMatchProductsTable extends MixMatchProducts
    with TableInfo<$MixMatchProductsTable, MixMatchProduct> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $MixMatchProductsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _dealIdMeta = const VerificationMeta('dealId');
  @override
  late final GeneratedColumn<int> dealId = GeneratedColumn<int>(
    'deal_id',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _pluIdMeta = const VerificationMeta('pluId');
  @override
  late final GeneratedColumn<int> pluId = GeneratedColumn<int>(
    'plu_id',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [dealId, pluId];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'mix_match_products';
  @override
  VerificationContext validateIntegrity(
    Insertable<MixMatchProduct> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('deal_id')) {
      context.handle(
        _dealIdMeta,
        dealId.isAcceptableOrUnknown(data['deal_id']!, _dealIdMeta),
      );
    } else if (isInserting) {
      context.missing(_dealIdMeta);
    }
    if (data.containsKey('plu_id')) {
      context.handle(
        _pluIdMeta,
        pluId.isAcceptableOrUnknown(data['plu_id']!, _pluIdMeta),
      );
    } else if (isInserting) {
      context.missing(_pluIdMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {dealId, pluId};
  @override
  MixMatchProduct map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return MixMatchProduct(
      dealId: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}deal_id'],
      )!,
      pluId: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}plu_id'],
      )!,
    );
  }

  @override
  $MixMatchProductsTable createAlias(String alias) {
    return $MixMatchProductsTable(attachedDatabase, alias);
  }
}

class MixMatchProduct extends DataClass implements Insertable<MixMatchProduct> {
  final int dealId;
  final int pluId;
  const MixMatchProduct({required this.dealId, required this.pluId});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['deal_id'] = Variable<int>(dealId);
    map['plu_id'] = Variable<int>(pluId);
    return map;
  }

  MixMatchProductsCompanion toCompanion(bool nullToAbsent) {
    return MixMatchProductsCompanion(
      dealId: Value(dealId),
      pluId: Value(pluId),
    );
  }

  factory MixMatchProduct.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return MixMatchProduct(
      dealId: serializer.fromJson<int>(json['dealId']),
      pluId: serializer.fromJson<int>(json['pluId']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'dealId': serializer.toJson<int>(dealId),
      'pluId': serializer.toJson<int>(pluId),
    };
  }

  MixMatchProduct copyWith({int? dealId, int? pluId}) => MixMatchProduct(
    dealId: dealId ?? this.dealId,
    pluId: pluId ?? this.pluId,
  );
  MixMatchProduct copyWithCompanion(MixMatchProductsCompanion data) {
    return MixMatchProduct(
      dealId: data.dealId.present ? data.dealId.value : this.dealId,
      pluId: data.pluId.present ? data.pluId.value : this.pluId,
    );
  }

  @override
  String toString() {
    return (StringBuffer('MixMatchProduct(')
          ..write('dealId: $dealId, ')
          ..write('pluId: $pluId')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(dealId, pluId);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is MixMatchProduct &&
          other.dealId == this.dealId &&
          other.pluId == this.pluId);
}

class MixMatchProductsCompanion extends UpdateCompanion<MixMatchProduct> {
  final Value<int> dealId;
  final Value<int> pluId;
  final Value<int> rowid;
  const MixMatchProductsCompanion({
    this.dealId = const Value.absent(),
    this.pluId = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  MixMatchProductsCompanion.insert({
    required int dealId,
    required int pluId,
    this.rowid = const Value.absent(),
  }) : dealId = Value(dealId),
       pluId = Value(pluId);
  static Insertable<MixMatchProduct> custom({
    Expression<int>? dealId,
    Expression<int>? pluId,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (dealId != null) 'deal_id': dealId,
      if (pluId != null) 'plu_id': pluId,
      if (rowid != null) 'rowid': rowid,
    });
  }

  MixMatchProductsCompanion copyWith({
    Value<int>? dealId,
    Value<int>? pluId,
    Value<int>? rowid,
  }) {
    return MixMatchProductsCompanion(
      dealId: dealId ?? this.dealId,
      pluId: pluId ?? this.pluId,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (dealId.present) {
      map['deal_id'] = Variable<int>(dealId.value);
    }
    if (pluId.present) {
      map['plu_id'] = Variable<int>(pluId.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('MixMatchProductsCompanion(')
          ..write('dealId: $dealId, ')
          ..write('pluId: $pluId, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $DepartmentsTable extends Departments
    with TableInfo<$DepartmentsTable, Department> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $DepartmentsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _emojiMeta = const VerificationMeta('emoji');
  @override
  late final GeneratedColumn<String> emoji = GeneratedColumn<String>(
    'emoji',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _imageUrlMeta = const VerificationMeta(
    'imageUrl',
  );
  @override
  late final GeneratedColumn<String> imageUrl = GeneratedColumn<String>(
    'image_url',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _buttonColorMeta = const VerificationMeta(
    'buttonColor',
  );
  @override
  late final GeneratedColumn<String> buttonColor = GeneratedColumn<String>(
    'button_color',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _sortOrderMeta = const VerificationMeta(
    'sortOrder',
  );
  @override
  late final GeneratedColumn<int> sortOrder = GeneratedColumn<int>(
    'sort_order',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  @override
  List<GeneratedColumn> get $columns => [
    name,
    emoji,
    imageUrl,
    buttonColor,
    sortOrder,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'departments';
  @override
  VerificationContext validateIntegrity(
    Insertable<Department> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('emoji')) {
      context.handle(
        _emojiMeta,
        emoji.isAcceptableOrUnknown(data['emoji']!, _emojiMeta),
      );
    }
    if (data.containsKey('image_url')) {
      context.handle(
        _imageUrlMeta,
        imageUrl.isAcceptableOrUnknown(data['image_url']!, _imageUrlMeta),
      );
    }
    if (data.containsKey('button_color')) {
      context.handle(
        _buttonColorMeta,
        buttonColor.isAcceptableOrUnknown(
          data['button_color']!,
          _buttonColorMeta,
        ),
      );
    }
    if (data.containsKey('sort_order')) {
      context.handle(
        _sortOrderMeta,
        sortOrder.isAcceptableOrUnknown(data['sort_order']!, _sortOrderMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {name};
  @override
  Department map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return Department(
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      emoji: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}emoji'],
      ),
      imageUrl: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}image_url'],
      ),
      buttonColor: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}button_color'],
      ),
      sortOrder: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}sort_order'],
      )!,
    );
  }

  @override
  $DepartmentsTable createAlias(String alias) {
    return $DepartmentsTable(attachedDatabase, alias);
  }
}

class Department extends DataClass implements Insertable<Department> {
  final String name;
  final String? emoji;
  final String? imageUrl;

  /// Overrides the till's built-in per-name colour.
  final String? buttonColor;
  final int sortOrder;
  const Department({
    required this.name,
    this.emoji,
    this.imageUrl,
    this.buttonColor,
    required this.sortOrder,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['name'] = Variable<String>(name);
    if (!nullToAbsent || emoji != null) {
      map['emoji'] = Variable<String>(emoji);
    }
    if (!nullToAbsent || imageUrl != null) {
      map['image_url'] = Variable<String>(imageUrl);
    }
    if (!nullToAbsent || buttonColor != null) {
      map['button_color'] = Variable<String>(buttonColor);
    }
    map['sort_order'] = Variable<int>(sortOrder);
    return map;
  }

  DepartmentsCompanion toCompanion(bool nullToAbsent) {
    return DepartmentsCompanion(
      name: Value(name),
      emoji: emoji == null && nullToAbsent
          ? const Value.absent()
          : Value(emoji),
      imageUrl: imageUrl == null && nullToAbsent
          ? const Value.absent()
          : Value(imageUrl),
      buttonColor: buttonColor == null && nullToAbsent
          ? const Value.absent()
          : Value(buttonColor),
      sortOrder: Value(sortOrder),
    );
  }

  factory Department.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return Department(
      name: serializer.fromJson<String>(json['name']),
      emoji: serializer.fromJson<String?>(json['emoji']),
      imageUrl: serializer.fromJson<String?>(json['imageUrl']),
      buttonColor: serializer.fromJson<String?>(json['buttonColor']),
      sortOrder: serializer.fromJson<int>(json['sortOrder']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'name': serializer.toJson<String>(name),
      'emoji': serializer.toJson<String?>(emoji),
      'imageUrl': serializer.toJson<String?>(imageUrl),
      'buttonColor': serializer.toJson<String?>(buttonColor),
      'sortOrder': serializer.toJson<int>(sortOrder),
    };
  }

  Department copyWith({
    String? name,
    Value<String?> emoji = const Value.absent(),
    Value<String?> imageUrl = const Value.absent(),
    Value<String?> buttonColor = const Value.absent(),
    int? sortOrder,
  }) => Department(
    name: name ?? this.name,
    emoji: emoji.present ? emoji.value : this.emoji,
    imageUrl: imageUrl.present ? imageUrl.value : this.imageUrl,
    buttonColor: buttonColor.present ? buttonColor.value : this.buttonColor,
    sortOrder: sortOrder ?? this.sortOrder,
  );
  Department copyWithCompanion(DepartmentsCompanion data) {
    return Department(
      name: data.name.present ? data.name.value : this.name,
      emoji: data.emoji.present ? data.emoji.value : this.emoji,
      imageUrl: data.imageUrl.present ? data.imageUrl.value : this.imageUrl,
      buttonColor: data.buttonColor.present
          ? data.buttonColor.value
          : this.buttonColor,
      sortOrder: data.sortOrder.present ? data.sortOrder.value : this.sortOrder,
    );
  }

  @override
  String toString() {
    return (StringBuffer('Department(')
          ..write('name: $name, ')
          ..write('emoji: $emoji, ')
          ..write('imageUrl: $imageUrl, ')
          ..write('buttonColor: $buttonColor, ')
          ..write('sortOrder: $sortOrder')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(name, emoji, imageUrl, buttonColor, sortOrder);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is Department &&
          other.name == this.name &&
          other.emoji == this.emoji &&
          other.imageUrl == this.imageUrl &&
          other.buttonColor == this.buttonColor &&
          other.sortOrder == this.sortOrder);
}

class DepartmentsCompanion extends UpdateCompanion<Department> {
  final Value<String> name;
  final Value<String?> emoji;
  final Value<String?> imageUrl;
  final Value<String?> buttonColor;
  final Value<int> sortOrder;
  final Value<int> rowid;
  const DepartmentsCompanion({
    this.name = const Value.absent(),
    this.emoji = const Value.absent(),
    this.imageUrl = const Value.absent(),
    this.buttonColor = const Value.absent(),
    this.sortOrder = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  DepartmentsCompanion.insert({
    required String name,
    this.emoji = const Value.absent(),
    this.imageUrl = const Value.absent(),
    this.buttonColor = const Value.absent(),
    this.sortOrder = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : name = Value(name);
  static Insertable<Department> custom({
    Expression<String>? name,
    Expression<String>? emoji,
    Expression<String>? imageUrl,
    Expression<String>? buttonColor,
    Expression<int>? sortOrder,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (name != null) 'name': name,
      if (emoji != null) 'emoji': emoji,
      if (imageUrl != null) 'image_url': imageUrl,
      if (buttonColor != null) 'button_color': buttonColor,
      if (sortOrder != null) 'sort_order': sortOrder,
      if (rowid != null) 'rowid': rowid,
    });
  }

  DepartmentsCompanion copyWith({
    Value<String>? name,
    Value<String?>? emoji,
    Value<String?>? imageUrl,
    Value<String?>? buttonColor,
    Value<int>? sortOrder,
    Value<int>? rowid,
  }) {
    return DepartmentsCompanion(
      name: name ?? this.name,
      emoji: emoji ?? this.emoji,
      imageUrl: imageUrl ?? this.imageUrl,
      buttonColor: buttonColor ?? this.buttonColor,
      sortOrder: sortOrder ?? this.sortOrder,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (emoji.present) {
      map['emoji'] = Variable<String>(emoji.value);
    }
    if (imageUrl.present) {
      map['image_url'] = Variable<String>(imageUrl.value);
    }
    if (buttonColor.present) {
      map['button_color'] = Variable<String>(buttonColor.value);
    }
    if (sortOrder.present) {
      map['sort_order'] = Variable<int>(sortOrder.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('DepartmentsCompanion(')
          ..write('name: $name, ')
          ..write('emoji: $emoji, ')
          ..write('imageUrl: $imageUrl, ')
          ..write('buttonColor: $buttonColor, ')
          ..write('sortOrder: $sortOrder, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CashDenominationsTable extends CashDenominations
    with TableInfo<$CashDenominationsTable, CashDenomination> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CashDenominationsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _valueMinorMeta = const VerificationMeta(
    'valueMinor',
  );
  @override
  late final GeneratedColumn<int> valueMinor = GeneratedColumn<int>(
    'value_minor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _labelMeta = const VerificationMeta('label');
  @override
  late final GeneratedColumn<String> label = GeneratedColumn<String>(
    'label',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _imageUrlMeta = const VerificationMeta(
    'imageUrl',
  );
  @override
  late final GeneratedColumn<String> imageUrl = GeneratedColumn<String>(
    'image_url',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _sortOrderMeta = const VerificationMeta(
    'sortOrder',
  );
  @override
  late final GeneratedColumn<int> sortOrder = GeneratedColumn<int>(
    'sort_order',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  @override
  List<GeneratedColumn> get $columns => [
    valueMinor,
    label,
    imageUrl,
    sortOrder,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cash_denominations';
  @override
  VerificationContext validateIntegrity(
    Insertable<CashDenomination> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('value_minor')) {
      context.handle(
        _valueMinorMeta,
        valueMinor.isAcceptableOrUnknown(data['value_minor']!, _valueMinorMeta),
      );
    }
    if (data.containsKey('label')) {
      context.handle(
        _labelMeta,
        label.isAcceptableOrUnknown(data['label']!, _labelMeta),
      );
    } else if (isInserting) {
      context.missing(_labelMeta);
    }
    if (data.containsKey('image_url')) {
      context.handle(
        _imageUrlMeta,
        imageUrl.isAcceptableOrUnknown(data['image_url']!, _imageUrlMeta),
      );
    }
    if (data.containsKey('sort_order')) {
      context.handle(
        _sortOrderMeta,
        sortOrder.isAcceptableOrUnknown(data['sort_order']!, _sortOrderMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {valueMinor};
  @override
  CashDenomination map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CashDenomination(
      valueMinor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}value_minor'],
      )!,
      label: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}label'],
      )!,
      imageUrl: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}image_url'],
      ),
      sortOrder: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}sort_order'],
      )!,
    );
  }

  @override
  $CashDenominationsTable createAlias(String alias) {
    return $CashDenominationsTable(attachedDatabase, alias);
  }
}

class CashDenomination extends DataClass
    implements Insertable<CashDenomination> {
  /// Pence. £20 is 2000; the value doubles as the key, since two keys for the
  /// same amount would only be a way to miscount the drawer.
  final int valueMinor;

  /// What the key says when the picture is missing.
  final String label;

  /// Absolute URL of the note artwork, resolved against the server at sync
  /// time so the widget does not have to know where the server lives.
  final String? imageUrl;
  final int sortOrder;
  const CashDenomination({
    required this.valueMinor,
    required this.label,
    this.imageUrl,
    required this.sortOrder,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['value_minor'] = Variable<int>(valueMinor);
    map['label'] = Variable<String>(label);
    if (!nullToAbsent || imageUrl != null) {
      map['image_url'] = Variable<String>(imageUrl);
    }
    map['sort_order'] = Variable<int>(sortOrder);
    return map;
  }

  CashDenominationsCompanion toCompanion(bool nullToAbsent) {
    return CashDenominationsCompanion(
      valueMinor: Value(valueMinor),
      label: Value(label),
      imageUrl: imageUrl == null && nullToAbsent
          ? const Value.absent()
          : Value(imageUrl),
      sortOrder: Value(sortOrder),
    );
  }

  factory CashDenomination.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CashDenomination(
      valueMinor: serializer.fromJson<int>(json['valueMinor']),
      label: serializer.fromJson<String>(json['label']),
      imageUrl: serializer.fromJson<String?>(json['imageUrl']),
      sortOrder: serializer.fromJson<int>(json['sortOrder']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'valueMinor': serializer.toJson<int>(valueMinor),
      'label': serializer.toJson<String>(label),
      'imageUrl': serializer.toJson<String?>(imageUrl),
      'sortOrder': serializer.toJson<int>(sortOrder),
    };
  }

  CashDenomination copyWith({
    int? valueMinor,
    String? label,
    Value<String?> imageUrl = const Value.absent(),
    int? sortOrder,
  }) => CashDenomination(
    valueMinor: valueMinor ?? this.valueMinor,
    label: label ?? this.label,
    imageUrl: imageUrl.present ? imageUrl.value : this.imageUrl,
    sortOrder: sortOrder ?? this.sortOrder,
  );
  CashDenomination copyWithCompanion(CashDenominationsCompanion data) {
    return CashDenomination(
      valueMinor: data.valueMinor.present
          ? data.valueMinor.value
          : this.valueMinor,
      label: data.label.present ? data.label.value : this.label,
      imageUrl: data.imageUrl.present ? data.imageUrl.value : this.imageUrl,
      sortOrder: data.sortOrder.present ? data.sortOrder.value : this.sortOrder,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CashDenomination(')
          ..write('valueMinor: $valueMinor, ')
          ..write('label: $label, ')
          ..write('imageUrl: $imageUrl, ')
          ..write('sortOrder: $sortOrder')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(valueMinor, label, imageUrl, sortOrder);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CashDenomination &&
          other.valueMinor == this.valueMinor &&
          other.label == this.label &&
          other.imageUrl == this.imageUrl &&
          other.sortOrder == this.sortOrder);
}

class CashDenominationsCompanion extends UpdateCompanion<CashDenomination> {
  final Value<int> valueMinor;
  final Value<String> label;
  final Value<String?> imageUrl;
  final Value<int> sortOrder;
  const CashDenominationsCompanion({
    this.valueMinor = const Value.absent(),
    this.label = const Value.absent(),
    this.imageUrl = const Value.absent(),
    this.sortOrder = const Value.absent(),
  });
  CashDenominationsCompanion.insert({
    this.valueMinor = const Value.absent(),
    required String label,
    this.imageUrl = const Value.absent(),
    this.sortOrder = const Value.absent(),
  }) : label = Value(label);
  static Insertable<CashDenomination> custom({
    Expression<int>? valueMinor,
    Expression<String>? label,
    Expression<String>? imageUrl,
    Expression<int>? sortOrder,
  }) {
    return RawValuesInsertable({
      if (valueMinor != null) 'value_minor': valueMinor,
      if (label != null) 'label': label,
      if (imageUrl != null) 'image_url': imageUrl,
      if (sortOrder != null) 'sort_order': sortOrder,
    });
  }

  CashDenominationsCompanion copyWith({
    Value<int>? valueMinor,
    Value<String>? label,
    Value<String?>? imageUrl,
    Value<int>? sortOrder,
  }) {
    return CashDenominationsCompanion(
      valueMinor: valueMinor ?? this.valueMinor,
      label: label ?? this.label,
      imageUrl: imageUrl ?? this.imageUrl,
      sortOrder: sortOrder ?? this.sortOrder,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (valueMinor.present) {
      map['value_minor'] = Variable<int>(valueMinor.value);
    }
    if (label.present) {
      map['label'] = Variable<String>(label.value);
    }
    if (imageUrl.present) {
      map['image_url'] = Variable<String>(imageUrl.value);
    }
    if (sortOrder.present) {
      map['sort_order'] = Variable<int>(sortOrder.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CashDenominationsCompanion(')
          ..write('valueMinor: $valueMinor, ')
          ..write('label: $label, ')
          ..write('imageUrl: $imageUrl, ')
          ..write('sortOrder: $sortOrder')
          ..write(')'))
        .toString();
  }
}

class $StaffTable extends Staff with TableInfo<$StaffTable, StaffData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $StaffTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _idMeta = const VerificationMeta('id');
  @override
  late final GeneratedColumn<int> id = GeneratedColumn<int>(
    'id',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _pluidMeta = const VerificationMeta('pluid');
  @override
  late final GeneratedColumn<int> pluid = GeneratedColumn<int>(
    'pluid',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _pinMeta = const VerificationMeta('pin');
  @override
  late final GeneratedColumn<String> pin = GeneratedColumn<String>(
    'pin',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [id, pluid, name, pin];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'staff';
  @override
  VerificationContext validateIntegrity(
    Insertable<StaffData> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('id')) {
      context.handle(_idMeta, id.isAcceptableOrUnknown(data['id']!, _idMeta));
    }
    if (data.containsKey('pluid')) {
      context.handle(
        _pluidMeta,
        pluid.isAcceptableOrUnknown(data['pluid']!, _pluidMeta),
      );
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('pin')) {
      context.handle(
        _pinMeta,
        pin.isAcceptableOrUnknown(data['pin']!, _pinMeta),
      );
    } else if (isInserting) {
      context.missing(_pinMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {id};
  @override
  StaffData map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return StaffData(
      id: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}id'],
      )!,
      pluid: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}pluid'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      pin: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}pin'],
      )!,
    );
  }

  @override
  $StaffTable createAlias(String alias) {
    return $StaffTable(attachedDatabase, alias);
  }
}

class StaffData extends DataClass implements Insertable<StaffData> {
  /// bo_clarks.id from the back office. The stable key a report groups by.
  final int id;

  /// The operator number a venue puts on a rota, not a database key.
  final int pluid;
  final String name;

  /// The PIN as the back office holds it. See the class note above.
  final String pin;
  const StaffData({
    required this.id,
    required this.pluid,
    required this.name,
    required this.pin,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['id'] = Variable<int>(id);
    map['pluid'] = Variable<int>(pluid);
    map['name'] = Variable<String>(name);
    map['pin'] = Variable<String>(pin);
    return map;
  }

  StaffCompanion toCompanion(bool nullToAbsent) {
    return StaffCompanion(
      id: Value(id),
      pluid: Value(pluid),
      name: Value(name),
      pin: Value(pin),
    );
  }

  factory StaffData.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return StaffData(
      id: serializer.fromJson<int>(json['id']),
      pluid: serializer.fromJson<int>(json['pluid']),
      name: serializer.fromJson<String>(json['name']),
      pin: serializer.fromJson<String>(json['pin']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'id': serializer.toJson<int>(id),
      'pluid': serializer.toJson<int>(pluid),
      'name': serializer.toJson<String>(name),
      'pin': serializer.toJson<String>(pin),
    };
  }

  StaffData copyWith({int? id, int? pluid, String? name, String? pin}) =>
      StaffData(
        id: id ?? this.id,
        pluid: pluid ?? this.pluid,
        name: name ?? this.name,
        pin: pin ?? this.pin,
      );
  StaffData copyWithCompanion(StaffCompanion data) {
    return StaffData(
      id: data.id.present ? data.id.value : this.id,
      pluid: data.pluid.present ? data.pluid.value : this.pluid,
      name: data.name.present ? data.name.value : this.name,
      pin: data.pin.present ? data.pin.value : this.pin,
    );
  }

  @override
  String toString() {
    return (StringBuffer('StaffData(')
          ..write('id: $id, ')
          ..write('pluid: $pluid, ')
          ..write('name: $name, ')
          ..write('pin: $pin')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(id, pluid, name, pin);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is StaffData &&
          other.id == this.id &&
          other.pluid == this.pluid &&
          other.name == this.name &&
          other.pin == this.pin);
}

class StaffCompanion extends UpdateCompanion<StaffData> {
  final Value<int> id;
  final Value<int> pluid;
  final Value<String> name;
  final Value<String> pin;
  const StaffCompanion({
    this.id = const Value.absent(),
    this.pluid = const Value.absent(),
    this.name = const Value.absent(),
    this.pin = const Value.absent(),
  });
  StaffCompanion.insert({
    this.id = const Value.absent(),
    this.pluid = const Value.absent(),
    required String name,
    required String pin,
  }) : name = Value(name),
       pin = Value(pin);
  static Insertable<StaffData> custom({
    Expression<int>? id,
    Expression<int>? pluid,
    Expression<String>? name,
    Expression<String>? pin,
  }) {
    return RawValuesInsertable({
      if (id != null) 'id': id,
      if (pluid != null) 'pluid': pluid,
      if (name != null) 'name': name,
      if (pin != null) 'pin': pin,
    });
  }

  StaffCompanion copyWith({
    Value<int>? id,
    Value<int>? pluid,
    Value<String>? name,
    Value<String>? pin,
  }) {
    return StaffCompanion(
      id: id ?? this.id,
      pluid: pluid ?? this.pluid,
      name: name ?? this.name,
      pin: pin ?? this.pin,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (id.present) {
      map['id'] = Variable<int>(id.value);
    }
    if (pluid.present) {
      map['pluid'] = Variable<int>(pluid.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (pin.present) {
      map['pin'] = Variable<String>(pin.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('StaffCompanion(')
          ..write('id: $id, ')
          ..write('pluid: $pluid, ')
          ..write('name: $name, ')
          ..write('pin: $pin')
          ..write(')'))
        .toString();
  }
}

abstract class _$AppDatabase extends GeneratedDatabase {
  _$AppDatabase(QueryExecutor e) : super(e);
  $AppDatabaseManager get managers => $AppDatabaseManager(this);
  late final $ProductsTable products = $ProductsTable(this);
  late final $OrdersTable orders = $OrdersTable(this);
  late final $OrderLinesTable orderLines = $OrderLinesTable(this);
  late final $PaymentsTable payments = $PaymentsTable(this);
  late final $OutboxEntriesTable outboxEntries = $OutboxEntriesTable(this);
  late final $TillSessionsTable tillSessions = $TillSessionsTable(this);
  late final $DiningTablesTable diningTables = $DiningTablesTable(this);
  late final $CustomersTable customers = $CustomersTable(this);
  late final $LoyaltyEntriesTable loyaltyEntries = $LoyaltyEntriesTable(this);
  late final $MixMatchDealsTable mixMatchDeals = $MixMatchDealsTable(this);
  late final $MixMatchProductsTable mixMatchProducts = $MixMatchProductsTable(
    this,
  );
  late final $DepartmentsTable departments = $DepartmentsTable(this);
  late final $CashDenominationsTable cashDenominations =
      $CashDenominationsTable(this);
  late final $StaffTable staff = $StaffTable(this);
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    products,
    orders,
    orderLines,
    payments,
    outboxEntries,
    tillSessions,
    diningTables,
    customers,
    loyaltyEntries,
    mixMatchDeals,
    mixMatchProducts,
    departments,
    cashDenominations,
    staff,
  ];
}

typedef $$ProductsTableCreateCompanionBuilder =
    ProductsCompanion Function({
      Value<int> pluId,
      required String name,
      Value<String?> departmentName,
      Value<String?> groupName,
      Value<String?> accountingCode,
      required int priceMinor,
      Value<double> taxPercentage,
      Value<double> stockQuantity,
      Value<int?> buttonPosition,
      Value<String?> buttonColor,
      Value<String?> printerRoute,
      Value<String?> emoji,
      Value<String?> imageUrl,
    });
typedef $$ProductsTableUpdateCompanionBuilder =
    ProductsCompanion Function({
      Value<int> pluId,
      Value<String> name,
      Value<String?> departmentName,
      Value<String?> groupName,
      Value<String?> accountingCode,
      Value<int> priceMinor,
      Value<double> taxPercentage,
      Value<double> stockQuantity,
      Value<int?> buttonPosition,
      Value<String?> buttonColor,
      Value<String?> printerRoute,
      Value<String?> emoji,
      Value<String?> imageUrl,
    });

class $$ProductsTableFilterComposer
    extends Composer<_$AppDatabase, $ProductsTable> {
  $$ProductsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get pluId => $composableBuilder(
    column: $table.pluId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get departmentName => $composableBuilder(
    column: $table.departmentName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get groupName => $composableBuilder(
    column: $table.groupName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get accountingCode => $composableBuilder(
    column: $table.accountingCode,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get priceMinor => $composableBuilder(
    column: $table.priceMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get taxPercentage => $composableBuilder(
    column: $table.taxPercentage,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get stockQuantity => $composableBuilder(
    column: $table.stockQuantity,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get buttonPosition => $composableBuilder(
    column: $table.buttonPosition,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get buttonColor => $composableBuilder(
    column: $table.buttonColor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get printerRoute => $composableBuilder(
    column: $table.printerRoute,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get emoji => $composableBuilder(
    column: $table.emoji,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get imageUrl => $composableBuilder(
    column: $table.imageUrl,
    builder: (column) => ColumnFilters(column),
  );
}

class $$ProductsTableOrderingComposer
    extends Composer<_$AppDatabase, $ProductsTable> {
  $$ProductsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get pluId => $composableBuilder(
    column: $table.pluId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get departmentName => $composableBuilder(
    column: $table.departmentName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get groupName => $composableBuilder(
    column: $table.groupName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get accountingCode => $composableBuilder(
    column: $table.accountingCode,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get priceMinor => $composableBuilder(
    column: $table.priceMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get taxPercentage => $composableBuilder(
    column: $table.taxPercentage,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get stockQuantity => $composableBuilder(
    column: $table.stockQuantity,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get buttonPosition => $composableBuilder(
    column: $table.buttonPosition,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get buttonColor => $composableBuilder(
    column: $table.buttonColor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get printerRoute => $composableBuilder(
    column: $table.printerRoute,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get emoji => $composableBuilder(
    column: $table.emoji,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get imageUrl => $composableBuilder(
    column: $table.imageUrl,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$ProductsTableAnnotationComposer
    extends Composer<_$AppDatabase, $ProductsTable> {
  $$ProductsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get pluId =>
      $composableBuilder(column: $table.pluId, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get departmentName => $composableBuilder(
    column: $table.departmentName,
    builder: (column) => column,
  );

  GeneratedColumn<String> get groupName =>
      $composableBuilder(column: $table.groupName, builder: (column) => column);

  GeneratedColumn<String> get accountingCode => $composableBuilder(
    column: $table.accountingCode,
    builder: (column) => column,
  );

  GeneratedColumn<int> get priceMinor => $composableBuilder(
    column: $table.priceMinor,
    builder: (column) => column,
  );

  GeneratedColumn<double> get taxPercentage => $composableBuilder(
    column: $table.taxPercentage,
    builder: (column) => column,
  );

  GeneratedColumn<double> get stockQuantity => $composableBuilder(
    column: $table.stockQuantity,
    builder: (column) => column,
  );

  GeneratedColumn<int> get buttonPosition => $composableBuilder(
    column: $table.buttonPosition,
    builder: (column) => column,
  );

  GeneratedColumn<String> get buttonColor => $composableBuilder(
    column: $table.buttonColor,
    builder: (column) => column,
  );

  GeneratedColumn<String> get printerRoute => $composableBuilder(
    column: $table.printerRoute,
    builder: (column) => column,
  );

  GeneratedColumn<String> get emoji =>
      $composableBuilder(column: $table.emoji, builder: (column) => column);

  GeneratedColumn<String> get imageUrl =>
      $composableBuilder(column: $table.imageUrl, builder: (column) => column);
}

class $$ProductsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $ProductsTable,
          Product,
          $$ProductsTableFilterComposer,
          $$ProductsTableOrderingComposer,
          $$ProductsTableAnnotationComposer,
          $$ProductsTableCreateCompanionBuilder,
          $$ProductsTableUpdateCompanionBuilder,
          (Product, BaseReferences<_$AppDatabase, $ProductsTable, Product>),
          Product,
          PrefetchHooks Function()
        > {
  $$ProductsTableTableManager(_$AppDatabase db, $ProductsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ProductsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ProductsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ProductsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<int> pluId = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<String?> departmentName = const Value.absent(),
                Value<String?> groupName = const Value.absent(),
                Value<String?> accountingCode = const Value.absent(),
                Value<int> priceMinor = const Value.absent(),
                Value<double> taxPercentage = const Value.absent(),
                Value<double> stockQuantity = const Value.absent(),
                Value<int?> buttonPosition = const Value.absent(),
                Value<String?> buttonColor = const Value.absent(),
                Value<String?> printerRoute = const Value.absent(),
                Value<String?> emoji = const Value.absent(),
                Value<String?> imageUrl = const Value.absent(),
              }) => ProductsCompanion(
                pluId: pluId,
                name: name,
                departmentName: departmentName,
                groupName: groupName,
                accountingCode: accountingCode,
                priceMinor: priceMinor,
                taxPercentage: taxPercentage,
                stockQuantity: stockQuantity,
                buttonPosition: buttonPosition,
                buttonColor: buttonColor,
                printerRoute: printerRoute,
                emoji: emoji,
                imageUrl: imageUrl,
              ),
          createCompanionCallback:
              ({
                Value<int> pluId = const Value.absent(),
                required String name,
                Value<String?> departmentName = const Value.absent(),
                Value<String?> groupName = const Value.absent(),
                Value<String?> accountingCode = const Value.absent(),
                required int priceMinor,
                Value<double> taxPercentage = const Value.absent(),
                Value<double> stockQuantity = const Value.absent(),
                Value<int?> buttonPosition = const Value.absent(),
                Value<String?> buttonColor = const Value.absent(),
                Value<String?> printerRoute = const Value.absent(),
                Value<String?> emoji = const Value.absent(),
                Value<String?> imageUrl = const Value.absent(),
              }) => ProductsCompanion.insert(
                pluId: pluId,
                name: name,
                departmentName: departmentName,
                groupName: groupName,
                accountingCode: accountingCode,
                priceMinor: priceMinor,
                taxPercentage: taxPercentage,
                stockQuantity: stockQuantity,
                buttonPosition: buttonPosition,
                buttonColor: buttonColor,
                printerRoute: printerRoute,
                emoji: emoji,
                imageUrl: imageUrl,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$ProductsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $ProductsTable,
      Product,
      $$ProductsTableFilterComposer,
      $$ProductsTableOrderingComposer,
      $$ProductsTableAnnotationComposer,
      $$ProductsTableCreateCompanionBuilder,
      $$ProductsTableUpdateCompanionBuilder,
      (Product, BaseReferences<_$AppDatabase, $ProductsTable, Product>),
      Product,
      PrefetchHooks Function()
    >;
typedef $$OrdersTableCreateCompanionBuilder =
    OrdersCompanion Function({
      required String id,
      Value<String> status,
      Value<int?> tableNumber,
      Value<String?> clerkPin,
      Value<int?> staffId,
      Value<String?> staffName,
      Value<String?> sessionId,
      Value<String?> customerId,
      Value<String?> splitFromOrderId,
      Value<int> subtotalMinor,
      Value<int> manualDiscountMinor,
      Value<int> discountMinor,
      Value<int> taxMinor,
      Value<int> totalMinor,
      Value<int?> covers,
      Value<String?> notes,
      Value<String?> customerName,
      Value<String> customerDiscountType,
      Value<int> customerDiscountValue,
      Value<DateTime> createdAt,
      Value<DateTime?> closedAt,
      Value<DateTime?> syncedAt,
      Value<int> rowid,
    });
typedef $$OrdersTableUpdateCompanionBuilder =
    OrdersCompanion Function({
      Value<String> id,
      Value<String> status,
      Value<int?> tableNumber,
      Value<String?> clerkPin,
      Value<int?> staffId,
      Value<String?> staffName,
      Value<String?> sessionId,
      Value<String?> customerId,
      Value<String?> splitFromOrderId,
      Value<int> subtotalMinor,
      Value<int> manualDiscountMinor,
      Value<int> discountMinor,
      Value<int> taxMinor,
      Value<int> totalMinor,
      Value<int?> covers,
      Value<String?> notes,
      Value<String?> customerName,
      Value<String> customerDiscountType,
      Value<int> customerDiscountValue,
      Value<DateTime> createdAt,
      Value<DateTime?> closedAt,
      Value<DateTime?> syncedAt,
      Value<int> rowid,
    });

final class $$OrdersTableReferences
    extends BaseReferences<_$AppDatabase, $OrdersTable, Order> {
  $$OrdersTableReferences(super.$_db, super.$_table, super.$_typedResult);

  static MultiTypedResultKey<$OrderLinesTable, List<OrderLine>>
  _orderLinesRefsTable(_$AppDatabase db) => MultiTypedResultKey.fromTable(
    db.orderLines,
    aliasName: 'orders__id__order_lines__order_id',
  );

  $$OrderLinesTableProcessedTableManager get orderLinesRefs {
    final manager = $$OrderLinesTableTableManager(
      $_db,
      $_db.orderLines,
    ).filter((f) => f.orderId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(_orderLinesRefsTable($_db));
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }

  static MultiTypedResultKey<$PaymentsTable, List<Payment>> _paymentsRefsTable(
    _$AppDatabase db,
  ) => MultiTypedResultKey.fromTable(
    db.payments,
    aliasName: 'orders__id__payments__order_id',
  );

  $$PaymentsTableProcessedTableManager get paymentsRefs {
    final manager = $$PaymentsTableTableManager(
      $_db,
      $_db.payments,
    ).filter((f) => f.orderId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(_paymentsRefsTable($_db));
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }
}

class $$OrdersTableFilterComposer
    extends Composer<_$AppDatabase, $OrdersTable> {
  $$OrdersTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get tableNumber => $composableBuilder(
    column: $table.tableNumber,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get clerkPin => $composableBuilder(
    column: $table.clerkPin,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get staffId => $composableBuilder(
    column: $table.staffId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get staffName => $composableBuilder(
    column: $table.staffName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get customerId => $composableBuilder(
    column: $table.customerId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get splitFromOrderId => $composableBuilder(
    column: $table.splitFromOrderId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get subtotalMinor => $composableBuilder(
    column: $table.subtotalMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get manualDiscountMinor => $composableBuilder(
    column: $table.manualDiscountMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get discountMinor => $composableBuilder(
    column: $table.discountMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get taxMinor => $composableBuilder(
    column: $table.taxMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get totalMinor => $composableBuilder(
    column: $table.totalMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get covers => $composableBuilder(
    column: $table.covers,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get notes => $composableBuilder(
    column: $table.notes,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get customerName => $composableBuilder(
    column: $table.customerName,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get customerDiscountType => $composableBuilder(
    column: $table.customerDiscountType,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get customerDiscountValue => $composableBuilder(
    column: $table.customerDiscountValue,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get closedAt => $composableBuilder(
    column: $table.closedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnFilters(column),
  );

  Expression<bool> orderLinesRefs(
    Expression<bool> Function($$OrderLinesTableFilterComposer f) f,
  ) {
    final $$OrderLinesTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.orderLines,
      getReferencedColumn: (t) => t.orderId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$OrderLinesTableFilterComposer(
            $db: $db,
            $table: $db.orderLines,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<bool> paymentsRefs(
    Expression<bool> Function($$PaymentsTableFilterComposer f) f,
  ) {
    final $$PaymentsTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.payments,
      getReferencedColumn: (t) => t.orderId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$PaymentsTableFilterComposer(
            $db: $db,
            $table: $db.payments,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }
}

class $$OrdersTableOrderingComposer
    extends Composer<_$AppDatabase, $OrdersTable> {
  $$OrdersTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get tableNumber => $composableBuilder(
    column: $table.tableNumber,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get clerkPin => $composableBuilder(
    column: $table.clerkPin,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get staffId => $composableBuilder(
    column: $table.staffId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get staffName => $composableBuilder(
    column: $table.staffName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get customerId => $composableBuilder(
    column: $table.customerId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get splitFromOrderId => $composableBuilder(
    column: $table.splitFromOrderId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get subtotalMinor => $composableBuilder(
    column: $table.subtotalMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get manualDiscountMinor => $composableBuilder(
    column: $table.manualDiscountMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get discountMinor => $composableBuilder(
    column: $table.discountMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get taxMinor => $composableBuilder(
    column: $table.taxMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get totalMinor => $composableBuilder(
    column: $table.totalMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get covers => $composableBuilder(
    column: $table.covers,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get notes => $composableBuilder(
    column: $table.notes,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get customerName => $composableBuilder(
    column: $table.customerName,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get customerDiscountType => $composableBuilder(
    column: $table.customerDiscountType,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get customerDiscountValue => $composableBuilder(
    column: $table.customerDiscountValue,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get closedAt => $composableBuilder(
    column: $table.closedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$OrdersTableAnnotationComposer
    extends Composer<_$AppDatabase, $OrdersTable> {
  $$OrdersTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<int> get tableNumber => $composableBuilder(
    column: $table.tableNumber,
    builder: (column) => column,
  );

  GeneratedColumn<String> get clerkPin =>
      $composableBuilder(column: $table.clerkPin, builder: (column) => column);

  GeneratedColumn<int> get staffId =>
      $composableBuilder(column: $table.staffId, builder: (column) => column);

  GeneratedColumn<String> get staffName =>
      $composableBuilder(column: $table.staffName, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get customerId => $composableBuilder(
    column: $table.customerId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get splitFromOrderId => $composableBuilder(
    column: $table.splitFromOrderId,
    builder: (column) => column,
  );

  GeneratedColumn<int> get subtotalMinor => $composableBuilder(
    column: $table.subtotalMinor,
    builder: (column) => column,
  );

  GeneratedColumn<int> get manualDiscountMinor => $composableBuilder(
    column: $table.manualDiscountMinor,
    builder: (column) => column,
  );

  GeneratedColumn<int> get discountMinor => $composableBuilder(
    column: $table.discountMinor,
    builder: (column) => column,
  );

  GeneratedColumn<int> get taxMinor =>
      $composableBuilder(column: $table.taxMinor, builder: (column) => column);

  GeneratedColumn<int> get totalMinor => $composableBuilder(
    column: $table.totalMinor,
    builder: (column) => column,
  );

  GeneratedColumn<int> get covers =>
      $composableBuilder(column: $table.covers, builder: (column) => column);

  GeneratedColumn<String> get notes =>
      $composableBuilder(column: $table.notes, builder: (column) => column);

  GeneratedColumn<String> get customerName => $composableBuilder(
    column: $table.customerName,
    builder: (column) => column,
  );

  GeneratedColumn<String> get customerDiscountType => $composableBuilder(
    column: $table.customerDiscountType,
    builder: (column) => column,
  );

  GeneratedColumn<int> get customerDiscountValue => $composableBuilder(
    column: $table.customerDiscountValue,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<DateTime> get closedAt =>
      $composableBuilder(column: $table.closedAt, builder: (column) => column);

  GeneratedColumn<DateTime> get syncedAt =>
      $composableBuilder(column: $table.syncedAt, builder: (column) => column);

  Expression<T> orderLinesRefs<T extends Object>(
    Expression<T> Function($$OrderLinesTableAnnotationComposer a) f,
  ) {
    final $$OrderLinesTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.orderLines,
      getReferencedColumn: (t) => t.orderId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$OrderLinesTableAnnotationComposer(
            $db: $db,
            $table: $db.orderLines,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }

  Expression<T> paymentsRefs<T extends Object>(
    Expression<T> Function($$PaymentsTableAnnotationComposer a) f,
  ) {
    final $$PaymentsTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.payments,
      getReferencedColumn: (t) => t.orderId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$PaymentsTableAnnotationComposer(
            $db: $db,
            $table: $db.payments,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }
}

class $$OrdersTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $OrdersTable,
          Order,
          $$OrdersTableFilterComposer,
          $$OrdersTableOrderingComposer,
          $$OrdersTableAnnotationComposer,
          $$OrdersTableCreateCompanionBuilder,
          $$OrdersTableUpdateCompanionBuilder,
          (Order, $$OrdersTableReferences),
          Order,
          PrefetchHooks Function({bool orderLinesRefs, bool paymentsRefs})
        > {
  $$OrdersTableTableManager(_$AppDatabase db, $OrdersTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$OrdersTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$OrdersTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$OrdersTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> status = const Value.absent(),
                Value<int?> tableNumber = const Value.absent(),
                Value<String?> clerkPin = const Value.absent(),
                Value<int?> staffId = const Value.absent(),
                Value<String?> staffName = const Value.absent(),
                Value<String?> sessionId = const Value.absent(),
                Value<String?> customerId = const Value.absent(),
                Value<String?> splitFromOrderId = const Value.absent(),
                Value<int> subtotalMinor = const Value.absent(),
                Value<int> manualDiscountMinor = const Value.absent(),
                Value<int> discountMinor = const Value.absent(),
                Value<int> taxMinor = const Value.absent(),
                Value<int> totalMinor = const Value.absent(),
                Value<int?> covers = const Value.absent(),
                Value<String?> notes = const Value.absent(),
                Value<String?> customerName = const Value.absent(),
                Value<String> customerDiscountType = const Value.absent(),
                Value<int> customerDiscountValue = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime?> closedAt = const Value.absent(),
                Value<DateTime?> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OrdersCompanion(
                id: id,
                status: status,
                tableNumber: tableNumber,
                clerkPin: clerkPin,
                staffId: staffId,
                staffName: staffName,
                sessionId: sessionId,
                customerId: customerId,
                splitFromOrderId: splitFromOrderId,
                subtotalMinor: subtotalMinor,
                manualDiscountMinor: manualDiscountMinor,
                discountMinor: discountMinor,
                taxMinor: taxMinor,
                totalMinor: totalMinor,
                covers: covers,
                notes: notes,
                customerName: customerName,
                customerDiscountType: customerDiscountType,
                customerDiscountValue: customerDiscountValue,
                createdAt: createdAt,
                closedAt: closedAt,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                Value<String> status = const Value.absent(),
                Value<int?> tableNumber = const Value.absent(),
                Value<String?> clerkPin = const Value.absent(),
                Value<int?> staffId = const Value.absent(),
                Value<String?> staffName = const Value.absent(),
                Value<String?> sessionId = const Value.absent(),
                Value<String?> customerId = const Value.absent(),
                Value<String?> splitFromOrderId = const Value.absent(),
                Value<int> subtotalMinor = const Value.absent(),
                Value<int> manualDiscountMinor = const Value.absent(),
                Value<int> discountMinor = const Value.absent(),
                Value<int> taxMinor = const Value.absent(),
                Value<int> totalMinor = const Value.absent(),
                Value<int?> covers = const Value.absent(),
                Value<String?> notes = const Value.absent(),
                Value<String?> customerName = const Value.absent(),
                Value<String> customerDiscountType = const Value.absent(),
                Value<int> customerDiscountValue = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<DateTime?> closedAt = const Value.absent(),
                Value<DateTime?> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OrdersCompanion.insert(
                id: id,
                status: status,
                tableNumber: tableNumber,
                clerkPin: clerkPin,
                staffId: staffId,
                staffName: staffName,
                sessionId: sessionId,
                customerId: customerId,
                splitFromOrderId: splitFromOrderId,
                subtotalMinor: subtotalMinor,
                manualDiscountMinor: manualDiscountMinor,
                discountMinor: discountMinor,
                taxMinor: taxMinor,
                totalMinor: totalMinor,
                covers: covers,
                notes: notes,
                customerName: customerName,
                customerDiscountType: customerDiscountType,
                customerDiscountValue: customerDiscountValue,
                createdAt: createdAt,
                closedAt: closedAt,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) =>
                    (e.readTable(table), $$OrdersTableReferences(db, table, e)),
              )
              .toList(),
          prefetchHooksCallback:
              ({orderLinesRefs = false, paymentsRefs = false}) {
                return PrefetchHooks(
                  db: db,
                  explicitlyWatchedTables: [
                    if (orderLinesRefs) db.orderLines,
                    if (paymentsRefs) db.payments,
                  ],
                  addJoins: null,
                  getPrefetchedDataCallback: (items) async {
                    return [
                      if (orderLinesRefs)
                        await $_getPrefetchedData<
                          Order,
                          $OrdersTable,
                          OrderLine
                        >(
                          currentTable: table,
                          referencedTable: $$OrdersTableReferences
                              ._orderLinesRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$OrdersTableReferences(
                                db,
                                table,
                                p0,
                              ).orderLinesRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.orderId == item.id,
                              ),
                          typedResults: items,
                        ),
                      if (paymentsRefs)
                        await $_getPrefetchedData<Order, $OrdersTable, Payment>(
                          currentTable: table,
                          referencedTable: $$OrdersTableReferences
                              ._paymentsRefsTable(db),
                          managerFromTypedResult: (p0) =>
                              $$OrdersTableReferences(
                                db,
                                table,
                                p0,
                              ).paymentsRefs,
                          referencedItemsForCurrentItem:
                              (item, referencedItems) => referencedItems.where(
                                (e) => e.orderId == item.id,
                              ),
                          typedResults: items,
                        ),
                    ];
                  },
                );
              },
        ),
      );
}

typedef $$OrdersTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $OrdersTable,
      Order,
      $$OrdersTableFilterComposer,
      $$OrdersTableOrderingComposer,
      $$OrdersTableAnnotationComposer,
      $$OrdersTableCreateCompanionBuilder,
      $$OrdersTableUpdateCompanionBuilder,
      (Order, $$OrdersTableReferences),
      Order,
      PrefetchHooks Function({bool orderLinesRefs, bool paymentsRefs})
    >;
typedef $$OrderLinesTableCreateCompanionBuilder =
    OrderLinesCompanion Function({
      required String id,
      required String orderId,
      required int pluId,
      required String name,
      Value<double> quantity,
      required int unitPriceMinor,
      Value<double> taxPercentage,
      Value<String?> notes,
      Value<int> lineDiscountMinor,
      Value<String?> addedBy,
      Value<DateTime?> addedAt,
      Value<int> rowid,
    });
typedef $$OrderLinesTableUpdateCompanionBuilder =
    OrderLinesCompanion Function({
      Value<String> id,
      Value<String> orderId,
      Value<int> pluId,
      Value<String> name,
      Value<double> quantity,
      Value<int> unitPriceMinor,
      Value<double> taxPercentage,
      Value<String?> notes,
      Value<int> lineDiscountMinor,
      Value<String?> addedBy,
      Value<DateTime?> addedAt,
      Value<int> rowid,
    });

final class $$OrderLinesTableReferences
    extends BaseReferences<_$AppDatabase, $OrderLinesTable, OrderLine> {
  $$OrderLinesTableReferences(super.$_db, super.$_table, super.$_typedResult);

  static $OrdersTable _orderIdTable(_$AppDatabase db) =>
      db.orders.createAlias('order_lines__order_id__orders__id');

  $$OrdersTableProcessedTableManager get orderId {
    final $_column = $_itemColumn<String>('order_id')!;

    final manager = $$OrdersTableTableManager(
      $_db,
      $_db.orders,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_orderIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$OrderLinesTableFilterComposer
    extends Composer<_$AppDatabase, $OrderLinesTable> {
  $$OrderLinesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get pluId => $composableBuilder(
    column: $table.pluId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get quantity => $composableBuilder(
    column: $table.quantity,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get unitPriceMinor => $composableBuilder(
    column: $table.unitPriceMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get taxPercentage => $composableBuilder(
    column: $table.taxPercentage,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get notes => $composableBuilder(
    column: $table.notes,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get lineDiscountMinor => $composableBuilder(
    column: $table.lineDiscountMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get addedBy => $composableBuilder(
    column: $table.addedBy,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get addedAt => $composableBuilder(
    column: $table.addedAt,
    builder: (column) => ColumnFilters(column),
  );

  $$OrdersTableFilterComposer get orderId {
    final $$OrdersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.orderId,
      referencedTable: $db.orders,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$OrdersTableFilterComposer(
            $db: $db,
            $table: $db.orders,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$OrderLinesTableOrderingComposer
    extends Composer<_$AppDatabase, $OrderLinesTable> {
  $$OrderLinesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get pluId => $composableBuilder(
    column: $table.pluId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get quantity => $composableBuilder(
    column: $table.quantity,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get unitPriceMinor => $composableBuilder(
    column: $table.unitPriceMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get taxPercentage => $composableBuilder(
    column: $table.taxPercentage,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get notes => $composableBuilder(
    column: $table.notes,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get lineDiscountMinor => $composableBuilder(
    column: $table.lineDiscountMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get addedBy => $composableBuilder(
    column: $table.addedBy,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get addedAt => $composableBuilder(
    column: $table.addedAt,
    builder: (column) => ColumnOrderings(column),
  );

  $$OrdersTableOrderingComposer get orderId {
    final $$OrdersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.orderId,
      referencedTable: $db.orders,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$OrdersTableOrderingComposer(
            $db: $db,
            $table: $db.orders,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$OrderLinesTableAnnotationComposer
    extends Composer<_$AppDatabase, $OrderLinesTable> {
  $$OrderLinesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<int> get pluId =>
      $composableBuilder(column: $table.pluId, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<double> get quantity =>
      $composableBuilder(column: $table.quantity, builder: (column) => column);

  GeneratedColumn<int> get unitPriceMinor => $composableBuilder(
    column: $table.unitPriceMinor,
    builder: (column) => column,
  );

  GeneratedColumn<double> get taxPercentage => $composableBuilder(
    column: $table.taxPercentage,
    builder: (column) => column,
  );

  GeneratedColumn<String> get notes =>
      $composableBuilder(column: $table.notes, builder: (column) => column);

  GeneratedColumn<int> get lineDiscountMinor => $composableBuilder(
    column: $table.lineDiscountMinor,
    builder: (column) => column,
  );

  GeneratedColumn<String> get addedBy =>
      $composableBuilder(column: $table.addedBy, builder: (column) => column);

  GeneratedColumn<DateTime> get addedAt =>
      $composableBuilder(column: $table.addedAt, builder: (column) => column);

  $$OrdersTableAnnotationComposer get orderId {
    final $$OrdersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.orderId,
      referencedTable: $db.orders,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$OrdersTableAnnotationComposer(
            $db: $db,
            $table: $db.orders,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$OrderLinesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $OrderLinesTable,
          OrderLine,
          $$OrderLinesTableFilterComposer,
          $$OrderLinesTableOrderingComposer,
          $$OrderLinesTableAnnotationComposer,
          $$OrderLinesTableCreateCompanionBuilder,
          $$OrderLinesTableUpdateCompanionBuilder,
          (OrderLine, $$OrderLinesTableReferences),
          OrderLine,
          PrefetchHooks Function({bool orderId})
        > {
  $$OrderLinesTableTableManager(_$AppDatabase db, $OrderLinesTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$OrderLinesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$OrderLinesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$OrderLinesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> orderId = const Value.absent(),
                Value<int> pluId = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<double> quantity = const Value.absent(),
                Value<int> unitPriceMinor = const Value.absent(),
                Value<double> taxPercentage = const Value.absent(),
                Value<String?> notes = const Value.absent(),
                Value<int> lineDiscountMinor = const Value.absent(),
                Value<String?> addedBy = const Value.absent(),
                Value<DateTime?> addedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OrderLinesCompanion(
                id: id,
                orderId: orderId,
                pluId: pluId,
                name: name,
                quantity: quantity,
                unitPriceMinor: unitPriceMinor,
                taxPercentage: taxPercentage,
                notes: notes,
                lineDiscountMinor: lineDiscountMinor,
                addedBy: addedBy,
                addedAt: addedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String orderId,
                required int pluId,
                required String name,
                Value<double> quantity = const Value.absent(),
                required int unitPriceMinor,
                Value<double> taxPercentage = const Value.absent(),
                Value<String?> notes = const Value.absent(),
                Value<int> lineDiscountMinor = const Value.absent(),
                Value<String?> addedBy = const Value.absent(),
                Value<DateTime?> addedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OrderLinesCompanion.insert(
                id: id,
                orderId: orderId,
                pluId: pluId,
                name: name,
                quantity: quantity,
                unitPriceMinor: unitPriceMinor,
                taxPercentage: taxPercentage,
                notes: notes,
                lineDiscountMinor: lineDiscountMinor,
                addedBy: addedBy,
                addedAt: addedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$OrderLinesTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({orderId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (orderId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.orderId,
                                referencedTable: $$OrderLinesTableReferences
                                    ._orderIdTable(db),
                                referencedColumn: $$OrderLinesTableReferences
                                    ._orderIdTable(db)
                                    .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$OrderLinesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $OrderLinesTable,
      OrderLine,
      $$OrderLinesTableFilterComposer,
      $$OrderLinesTableOrderingComposer,
      $$OrderLinesTableAnnotationComposer,
      $$OrderLinesTableCreateCompanionBuilder,
      $$OrderLinesTableUpdateCompanionBuilder,
      (OrderLine, $$OrderLinesTableReferences),
      OrderLine,
      PrefetchHooks Function({bool orderId})
    >;
typedef $$PaymentsTableCreateCompanionBuilder =
    PaymentsCompanion Function({
      required String id,
      required String orderId,
      required String method,
      required int amountMinor,
      Value<DateTime> takenAt,
      Value<String?> cashBreakdown,
      Value<int> rowid,
    });
typedef $$PaymentsTableUpdateCompanionBuilder =
    PaymentsCompanion Function({
      Value<String> id,
      Value<String> orderId,
      Value<String> method,
      Value<int> amountMinor,
      Value<DateTime> takenAt,
      Value<String?> cashBreakdown,
      Value<int> rowid,
    });

final class $$PaymentsTableReferences
    extends BaseReferences<_$AppDatabase, $PaymentsTable, Payment> {
  $$PaymentsTableReferences(super.$_db, super.$_table, super.$_typedResult);

  static $OrdersTable _orderIdTable(_$AppDatabase db) =>
      db.orders.createAlias('payments__order_id__orders__id');

  $$OrdersTableProcessedTableManager get orderId {
    final $_column = $_itemColumn<String>('order_id')!;

    final manager = $$OrdersTableTableManager(
      $_db,
      $_db.orders,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_orderIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$PaymentsTableFilterComposer
    extends Composer<_$AppDatabase, $PaymentsTable> {
  $$PaymentsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get method => $composableBuilder(
    column: $table.method,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get amountMinor => $composableBuilder(
    column: $table.amountMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get takenAt => $composableBuilder(
    column: $table.takenAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get cashBreakdown => $composableBuilder(
    column: $table.cashBreakdown,
    builder: (column) => ColumnFilters(column),
  );

  $$OrdersTableFilterComposer get orderId {
    final $$OrdersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.orderId,
      referencedTable: $db.orders,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$OrdersTableFilterComposer(
            $db: $db,
            $table: $db.orders,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$PaymentsTableOrderingComposer
    extends Composer<_$AppDatabase, $PaymentsTable> {
  $$PaymentsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get method => $composableBuilder(
    column: $table.method,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get amountMinor => $composableBuilder(
    column: $table.amountMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get takenAt => $composableBuilder(
    column: $table.takenAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get cashBreakdown => $composableBuilder(
    column: $table.cashBreakdown,
    builder: (column) => ColumnOrderings(column),
  );

  $$OrdersTableOrderingComposer get orderId {
    final $$OrdersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.orderId,
      referencedTable: $db.orders,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$OrdersTableOrderingComposer(
            $db: $db,
            $table: $db.orders,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$PaymentsTableAnnotationComposer
    extends Composer<_$AppDatabase, $PaymentsTable> {
  $$PaymentsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get method =>
      $composableBuilder(column: $table.method, builder: (column) => column);

  GeneratedColumn<int> get amountMinor => $composableBuilder(
    column: $table.amountMinor,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get takenAt =>
      $composableBuilder(column: $table.takenAt, builder: (column) => column);

  GeneratedColumn<String> get cashBreakdown => $composableBuilder(
    column: $table.cashBreakdown,
    builder: (column) => column,
  );

  $$OrdersTableAnnotationComposer get orderId {
    final $$OrdersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.orderId,
      referencedTable: $db.orders,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$OrdersTableAnnotationComposer(
            $db: $db,
            $table: $db.orders,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$PaymentsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $PaymentsTable,
          Payment,
          $$PaymentsTableFilterComposer,
          $$PaymentsTableOrderingComposer,
          $$PaymentsTableAnnotationComposer,
          $$PaymentsTableCreateCompanionBuilder,
          $$PaymentsTableUpdateCompanionBuilder,
          (Payment, $$PaymentsTableReferences),
          Payment,
          PrefetchHooks Function({bool orderId})
        > {
  $$PaymentsTableTableManager(_$AppDatabase db, $PaymentsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$PaymentsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$PaymentsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$PaymentsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> orderId = const Value.absent(),
                Value<String> method = const Value.absent(),
                Value<int> amountMinor = const Value.absent(),
                Value<DateTime> takenAt = const Value.absent(),
                Value<String?> cashBreakdown = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => PaymentsCompanion(
                id: id,
                orderId: orderId,
                method: method,
                amountMinor: amountMinor,
                takenAt: takenAt,
                cashBreakdown: cashBreakdown,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String orderId,
                required String method,
                required int amountMinor,
                Value<DateTime> takenAt = const Value.absent(),
                Value<String?> cashBreakdown = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => PaymentsCompanion.insert(
                id: id,
                orderId: orderId,
                method: method,
                amountMinor: amountMinor,
                takenAt: takenAt,
                cashBreakdown: cashBreakdown,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$PaymentsTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({orderId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (orderId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.orderId,
                                referencedTable: $$PaymentsTableReferences
                                    ._orderIdTable(db),
                                referencedColumn: $$PaymentsTableReferences
                                    ._orderIdTable(db)
                                    .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$PaymentsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $PaymentsTable,
      Payment,
      $$PaymentsTableFilterComposer,
      $$PaymentsTableOrderingComposer,
      $$PaymentsTableAnnotationComposer,
      $$PaymentsTableCreateCompanionBuilder,
      $$PaymentsTableUpdateCompanionBuilder,
      (Payment, $$PaymentsTableReferences),
      Payment,
      PrefetchHooks Function({bool orderId})
    >;
typedef $$OutboxEntriesTableCreateCompanionBuilder =
    OutboxEntriesCompanion Function({
      required String id,
      required String entity,
      required String entityId,
      required String payload,
      Value<int> attempts,
      Value<String?> lastError,
      Value<DateTime> createdAt,
      Value<int> rowid,
    });
typedef $$OutboxEntriesTableUpdateCompanionBuilder =
    OutboxEntriesCompanion Function({
      Value<String> id,
      Value<String> entity,
      Value<String> entityId,
      Value<String> payload,
      Value<int> attempts,
      Value<String?> lastError,
      Value<DateTime> createdAt,
      Value<int> rowid,
    });

class $$OutboxEntriesTableFilterComposer
    extends Composer<_$AppDatabase, $OutboxEntriesTable> {
  $$OutboxEntriesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get entity => $composableBuilder(
    column: $table.entity,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get entityId => $composableBuilder(
    column: $table.entityId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$OutboxEntriesTableOrderingComposer
    extends Composer<_$AppDatabase, $OutboxEntriesTable> {
  $$OutboxEntriesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get entity => $composableBuilder(
    column: $table.entity,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get entityId => $composableBuilder(
    column: $table.entityId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payload => $composableBuilder(
    column: $table.payload,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get attempts => $composableBuilder(
    column: $table.attempts,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get lastError => $composableBuilder(
    column: $table.lastError,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$OutboxEntriesTableAnnotationComposer
    extends Composer<_$AppDatabase, $OutboxEntriesTable> {
  $$OutboxEntriesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get entity =>
      $composableBuilder(column: $table.entity, builder: (column) => column);

  GeneratedColumn<String> get entityId =>
      $composableBuilder(column: $table.entityId, builder: (column) => column);

  GeneratedColumn<String> get payload =>
      $composableBuilder(column: $table.payload, builder: (column) => column);

  GeneratedColumn<int> get attempts =>
      $composableBuilder(column: $table.attempts, builder: (column) => column);

  GeneratedColumn<String> get lastError =>
      $composableBuilder(column: $table.lastError, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);
}

class $$OutboxEntriesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $OutboxEntriesTable,
          OutboxEntry,
          $$OutboxEntriesTableFilterComposer,
          $$OutboxEntriesTableOrderingComposer,
          $$OutboxEntriesTableAnnotationComposer,
          $$OutboxEntriesTableCreateCompanionBuilder,
          $$OutboxEntriesTableUpdateCompanionBuilder,
          (
            OutboxEntry,
            BaseReferences<_$AppDatabase, $OutboxEntriesTable, OutboxEntry>,
          ),
          OutboxEntry,
          PrefetchHooks Function()
        > {
  $$OutboxEntriesTableTableManager(_$AppDatabase db, $OutboxEntriesTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$OutboxEntriesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$OutboxEntriesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$OutboxEntriesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> entity = const Value.absent(),
                Value<String> entityId = const Value.absent(),
                Value<String> payload = const Value.absent(),
                Value<int> attempts = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OutboxEntriesCompanion(
                id: id,
                entity: entity,
                entityId: entityId,
                payload: payload,
                attempts: attempts,
                lastError: lastError,
                createdAt: createdAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String entity,
                required String entityId,
                required String payload,
                Value<int> attempts = const Value.absent(),
                Value<String?> lastError = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => OutboxEntriesCompanion.insert(
                id: id,
                entity: entity,
                entityId: entityId,
                payload: payload,
                attempts: attempts,
                lastError: lastError,
                createdAt: createdAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$OutboxEntriesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $OutboxEntriesTable,
      OutboxEntry,
      $$OutboxEntriesTableFilterComposer,
      $$OutboxEntriesTableOrderingComposer,
      $$OutboxEntriesTableAnnotationComposer,
      $$OutboxEntriesTableCreateCompanionBuilder,
      $$OutboxEntriesTableUpdateCompanionBuilder,
      (
        OutboxEntry,
        BaseReferences<_$AppDatabase, $OutboxEntriesTable, OutboxEntry>,
      ),
      OutboxEntry,
      PrefetchHooks Function()
    >;
typedef $$TillSessionsTableCreateCompanionBuilder =
    TillSessionsCompanion Function({
      required String id,
      Value<DateTime> openedAt,
      Value<DateTime?> closedAt,
      Value<int?> zNumber,
      Value<int> openingFloatMinor,
      Value<int> rowid,
    });
typedef $$TillSessionsTableUpdateCompanionBuilder =
    TillSessionsCompanion Function({
      Value<String> id,
      Value<DateTime> openedAt,
      Value<DateTime?> closedAt,
      Value<int?> zNumber,
      Value<int> openingFloatMinor,
      Value<int> rowid,
    });

class $$TillSessionsTableFilterComposer
    extends Composer<_$AppDatabase, $TillSessionsTable> {
  $$TillSessionsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get openedAt => $composableBuilder(
    column: $table.openedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get closedAt => $composableBuilder(
    column: $table.closedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get zNumber => $composableBuilder(
    column: $table.zNumber,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get openingFloatMinor => $composableBuilder(
    column: $table.openingFloatMinor,
    builder: (column) => ColumnFilters(column),
  );
}

class $$TillSessionsTableOrderingComposer
    extends Composer<_$AppDatabase, $TillSessionsTable> {
  $$TillSessionsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get openedAt => $composableBuilder(
    column: $table.openedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get closedAt => $composableBuilder(
    column: $table.closedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get zNumber => $composableBuilder(
    column: $table.zNumber,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get openingFloatMinor => $composableBuilder(
    column: $table.openingFloatMinor,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$TillSessionsTableAnnotationComposer
    extends Composer<_$AppDatabase, $TillSessionsTable> {
  $$TillSessionsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<DateTime> get openedAt =>
      $composableBuilder(column: $table.openedAt, builder: (column) => column);

  GeneratedColumn<DateTime> get closedAt =>
      $composableBuilder(column: $table.closedAt, builder: (column) => column);

  GeneratedColumn<int> get zNumber =>
      $composableBuilder(column: $table.zNumber, builder: (column) => column);

  GeneratedColumn<int> get openingFloatMinor => $composableBuilder(
    column: $table.openingFloatMinor,
    builder: (column) => column,
  );
}

class $$TillSessionsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $TillSessionsTable,
          TillSession,
          $$TillSessionsTableFilterComposer,
          $$TillSessionsTableOrderingComposer,
          $$TillSessionsTableAnnotationComposer,
          $$TillSessionsTableCreateCompanionBuilder,
          $$TillSessionsTableUpdateCompanionBuilder,
          (
            TillSession,
            BaseReferences<_$AppDatabase, $TillSessionsTable, TillSession>,
          ),
          TillSession,
          PrefetchHooks Function()
        > {
  $$TillSessionsTableTableManager(_$AppDatabase db, $TillSessionsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$TillSessionsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$TillSessionsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$TillSessionsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<DateTime> openedAt = const Value.absent(),
                Value<DateTime?> closedAt = const Value.absent(),
                Value<int?> zNumber = const Value.absent(),
                Value<int> openingFloatMinor = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => TillSessionsCompanion(
                id: id,
                openedAt: openedAt,
                closedAt: closedAt,
                zNumber: zNumber,
                openingFloatMinor: openingFloatMinor,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                Value<DateTime> openedAt = const Value.absent(),
                Value<DateTime?> closedAt = const Value.absent(),
                Value<int?> zNumber = const Value.absent(),
                Value<int> openingFloatMinor = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => TillSessionsCompanion.insert(
                id: id,
                openedAt: openedAt,
                closedAt: closedAt,
                zNumber: zNumber,
                openingFloatMinor: openingFloatMinor,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$TillSessionsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $TillSessionsTable,
      TillSession,
      $$TillSessionsTableFilterComposer,
      $$TillSessionsTableOrderingComposer,
      $$TillSessionsTableAnnotationComposer,
      $$TillSessionsTableCreateCompanionBuilder,
      $$TillSessionsTableUpdateCompanionBuilder,
      (
        TillSession,
        BaseReferences<_$AppDatabase, $TillSessionsTable, TillSession>,
      ),
      TillSession,
      PrefetchHooks Function()
    >;
typedef $$DiningTablesTableCreateCompanionBuilder =
    DiningTablesCompanion Function({Value<int> number, Value<String?> label});
typedef $$DiningTablesTableUpdateCompanionBuilder =
    DiningTablesCompanion Function({Value<int> number, Value<String?> label});

class $$DiningTablesTableFilterComposer
    extends Composer<_$AppDatabase, $DiningTablesTable> {
  $$DiningTablesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get number => $composableBuilder(
    column: $table.number,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get label => $composableBuilder(
    column: $table.label,
    builder: (column) => ColumnFilters(column),
  );
}

class $$DiningTablesTableOrderingComposer
    extends Composer<_$AppDatabase, $DiningTablesTable> {
  $$DiningTablesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get number => $composableBuilder(
    column: $table.number,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get label => $composableBuilder(
    column: $table.label,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$DiningTablesTableAnnotationComposer
    extends Composer<_$AppDatabase, $DiningTablesTable> {
  $$DiningTablesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get number =>
      $composableBuilder(column: $table.number, builder: (column) => column);

  GeneratedColumn<String> get label =>
      $composableBuilder(column: $table.label, builder: (column) => column);
}

class $$DiningTablesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $DiningTablesTable,
          DiningTable,
          $$DiningTablesTableFilterComposer,
          $$DiningTablesTableOrderingComposer,
          $$DiningTablesTableAnnotationComposer,
          $$DiningTablesTableCreateCompanionBuilder,
          $$DiningTablesTableUpdateCompanionBuilder,
          (
            DiningTable,
            BaseReferences<_$AppDatabase, $DiningTablesTable, DiningTable>,
          ),
          DiningTable,
          PrefetchHooks Function()
        > {
  $$DiningTablesTableTableManager(_$AppDatabase db, $DiningTablesTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$DiningTablesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$DiningTablesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$DiningTablesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<int> number = const Value.absent(),
                Value<String?> label = const Value.absent(),
              }) => DiningTablesCompanion(number: number, label: label),
          createCompanionCallback:
              ({
                Value<int> number = const Value.absent(),
                Value<String?> label = const Value.absent(),
              }) => DiningTablesCompanion.insert(number: number, label: label),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$DiningTablesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $DiningTablesTable,
      DiningTable,
      $$DiningTablesTableFilterComposer,
      $$DiningTablesTableOrderingComposer,
      $$DiningTablesTableAnnotationComposer,
      $$DiningTablesTableCreateCompanionBuilder,
      $$DiningTablesTableUpdateCompanionBuilder,
      (
        DiningTable,
        BaseReferences<_$AppDatabase, $DiningTablesTable, DiningTable>,
      ),
      DiningTable,
      PrefetchHooks Function()
    >;
typedef $$CustomersTableCreateCompanionBuilder =
    CustomersCompanion Function({
      required String id,
      required String name,
      Value<String?> phone,
      Value<String?> email,
      Value<String?> cardNumber,
      Value<int> pointsBalance,
      Value<DateTime?> membershipExpiry,
      Value<DateTime?> syncedAt,
      Value<int> rowid,
    });
typedef $$CustomersTableUpdateCompanionBuilder =
    CustomersCompanion Function({
      Value<String> id,
      Value<String> name,
      Value<String?> phone,
      Value<String?> email,
      Value<String?> cardNumber,
      Value<int> pointsBalance,
      Value<DateTime?> membershipExpiry,
      Value<DateTime?> syncedAt,
      Value<int> rowid,
    });

final class $$CustomersTableReferences
    extends BaseReferences<_$AppDatabase, $CustomersTable, Customer> {
  $$CustomersTableReferences(super.$_db, super.$_table, super.$_typedResult);

  static MultiTypedResultKey<$LoyaltyEntriesTable, List<LoyaltyEntry>>
  _loyaltyEntriesRefsTable(_$AppDatabase db) => MultiTypedResultKey.fromTable(
    db.loyaltyEntries,
    aliasName: 'customers__id__loyalty_entries__customer_id',
  );

  $$LoyaltyEntriesTableProcessedTableManager get loyaltyEntriesRefs {
    final manager = $$LoyaltyEntriesTableTableManager(
      $_db,
      $_db.loyaltyEntries,
    ).filter((f) => f.customerId.id.sqlEquals($_itemColumn<String>('id')!));

    final cache = $_typedResult.readTableOrNull(_loyaltyEntriesRefsTable($_db));
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: cache),
    );
  }
}

class $$CustomersTableFilterComposer
    extends Composer<_$AppDatabase, $CustomersTable> {
  $$CustomersTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get phone => $composableBuilder(
    column: $table.phone,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get email => $composableBuilder(
    column: $table.email,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get cardNumber => $composableBuilder(
    column: $table.cardNumber,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get pointsBalance => $composableBuilder(
    column: $table.pointsBalance,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get membershipExpiry => $composableBuilder(
    column: $table.membershipExpiry,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnFilters(column),
  );

  Expression<bool> loyaltyEntriesRefs(
    Expression<bool> Function($$LoyaltyEntriesTableFilterComposer f) f,
  ) {
    final $$LoyaltyEntriesTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.loyaltyEntries,
      getReferencedColumn: (t) => t.customerId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$LoyaltyEntriesTableFilterComposer(
            $db: $db,
            $table: $db.loyaltyEntries,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }
}

class $$CustomersTableOrderingComposer
    extends Composer<_$AppDatabase, $CustomersTable> {
  $$CustomersTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get phone => $composableBuilder(
    column: $table.phone,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get email => $composableBuilder(
    column: $table.email,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get cardNumber => $composableBuilder(
    column: $table.cardNumber,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get pointsBalance => $composableBuilder(
    column: $table.pointsBalance,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get membershipExpiry => $composableBuilder(
    column: $table.membershipExpiry,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CustomersTableAnnotationComposer
    extends Composer<_$AppDatabase, $CustomersTable> {
  $$CustomersTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get phone =>
      $composableBuilder(column: $table.phone, builder: (column) => column);

  GeneratedColumn<String> get email =>
      $composableBuilder(column: $table.email, builder: (column) => column);

  GeneratedColumn<String> get cardNumber => $composableBuilder(
    column: $table.cardNumber,
    builder: (column) => column,
  );

  GeneratedColumn<int> get pointsBalance => $composableBuilder(
    column: $table.pointsBalance,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get membershipExpiry => $composableBuilder(
    column: $table.membershipExpiry,
    builder: (column) => column,
  );

  GeneratedColumn<DateTime> get syncedAt =>
      $composableBuilder(column: $table.syncedAt, builder: (column) => column);

  Expression<T> loyaltyEntriesRefs<T extends Object>(
    Expression<T> Function($$LoyaltyEntriesTableAnnotationComposer a) f,
  ) {
    final $$LoyaltyEntriesTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.id,
      referencedTable: $db.loyaltyEntries,
      getReferencedColumn: (t) => t.customerId,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$LoyaltyEntriesTableAnnotationComposer(
            $db: $db,
            $table: $db.loyaltyEntries,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return f(composer);
  }
}

class $$CustomersTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CustomersTable,
          Customer,
          $$CustomersTableFilterComposer,
          $$CustomersTableOrderingComposer,
          $$CustomersTableAnnotationComposer,
          $$CustomersTableCreateCompanionBuilder,
          $$CustomersTableUpdateCompanionBuilder,
          (Customer, $$CustomersTableReferences),
          Customer,
          PrefetchHooks Function({bool loyaltyEntriesRefs})
        > {
  $$CustomersTableTableManager(_$AppDatabase db, $CustomersTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CustomersTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CustomersTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CustomersTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<String?> phone = const Value.absent(),
                Value<String?> email = const Value.absent(),
                Value<String?> cardNumber = const Value.absent(),
                Value<int> pointsBalance = const Value.absent(),
                Value<DateTime?> membershipExpiry = const Value.absent(),
                Value<DateTime?> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CustomersCompanion(
                id: id,
                name: name,
                phone: phone,
                email: email,
                cardNumber: cardNumber,
                pointsBalance: pointsBalance,
                membershipExpiry: membershipExpiry,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String name,
                Value<String?> phone = const Value.absent(),
                Value<String?> email = const Value.absent(),
                Value<String?> cardNumber = const Value.absent(),
                Value<int> pointsBalance = const Value.absent(),
                Value<DateTime?> membershipExpiry = const Value.absent(),
                Value<DateTime?> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CustomersCompanion.insert(
                id: id,
                name: name,
                phone: phone,
                email: email,
                cardNumber: cardNumber,
                pointsBalance: pointsBalance,
                membershipExpiry: membershipExpiry,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$CustomersTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({loyaltyEntriesRefs = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [
                if (loyaltyEntriesRefs) db.loyaltyEntries,
              ],
              addJoins: null,
              getPrefetchedDataCallback: (items) async {
                return [
                  if (loyaltyEntriesRefs)
                    await $_getPrefetchedData<
                      Customer,
                      $CustomersTable,
                      LoyaltyEntry
                    >(
                      currentTable: table,
                      referencedTable: $$CustomersTableReferences
                          ._loyaltyEntriesRefsTable(db),
                      managerFromTypedResult: (p0) =>
                          $$CustomersTableReferences(
                            db,
                            table,
                            p0,
                          ).loyaltyEntriesRefs,
                      referencedItemsForCurrentItem: (item, referencedItems) =>
                          referencedItems.where((e) => e.customerId == item.id),
                      typedResults: items,
                    ),
                ];
              },
            );
          },
        ),
      );
}

typedef $$CustomersTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CustomersTable,
      Customer,
      $$CustomersTableFilterComposer,
      $$CustomersTableOrderingComposer,
      $$CustomersTableAnnotationComposer,
      $$CustomersTableCreateCompanionBuilder,
      $$CustomersTableUpdateCompanionBuilder,
      (Customer, $$CustomersTableReferences),
      Customer,
      PrefetchHooks Function({bool loyaltyEntriesRefs})
    >;
typedef $$LoyaltyEntriesTableCreateCompanionBuilder =
    LoyaltyEntriesCompanion Function({
      required String id,
      required String customerId,
      Value<String?> orderId,
      required int points,
      required String reason,
      Value<DateTime> createdAt,
      Value<int> rowid,
    });
typedef $$LoyaltyEntriesTableUpdateCompanionBuilder =
    LoyaltyEntriesCompanion Function({
      Value<String> id,
      Value<String> customerId,
      Value<String?> orderId,
      Value<int> points,
      Value<String> reason,
      Value<DateTime> createdAt,
      Value<int> rowid,
    });

final class $$LoyaltyEntriesTableReferences
    extends BaseReferences<_$AppDatabase, $LoyaltyEntriesTable, LoyaltyEntry> {
  $$LoyaltyEntriesTableReferences(
    super.$_db,
    super.$_table,
    super.$_typedResult,
  );

  static $CustomersTable _customerIdTable(_$AppDatabase db) =>
      db.customers.createAlias('loyalty_entries__customer_id__customers__id');

  $$CustomersTableProcessedTableManager get customerId {
    final $_column = $_itemColumn<String>('customer_id')!;

    final manager = $$CustomersTableTableManager(
      $_db,
      $_db.customers,
    ).filter((f) => f.id.sqlEquals($_column));
    final item = $_typedResult.readTableOrNull(_customerIdTable($_db));
    if (item == null) return manager;
    return ProcessedTableManager(
      manager.$state.copyWith(prefetchedData: [item]),
    );
  }
}

class $$LoyaltyEntriesTableFilterComposer
    extends Composer<_$AppDatabase, $LoyaltyEntriesTable> {
  $$LoyaltyEntriesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get orderId => $composableBuilder(
    column: $table.orderId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get points => $composableBuilder(
    column: $table.points,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  $$CustomersTableFilterComposer get customerId {
    final $$CustomersTableFilterComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.customerId,
      referencedTable: $db.customers,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CustomersTableFilterComposer(
            $db: $db,
            $table: $db.customers,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$LoyaltyEntriesTableOrderingComposer
    extends Composer<_$AppDatabase, $LoyaltyEntriesTable> {
  $$LoyaltyEntriesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get orderId => $composableBuilder(
    column: $table.orderId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get points => $composableBuilder(
    column: $table.points,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get reason => $composableBuilder(
    column: $table.reason,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<DateTime> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  $$CustomersTableOrderingComposer get customerId {
    final $$CustomersTableOrderingComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.customerId,
      referencedTable: $db.customers,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CustomersTableOrderingComposer(
            $db: $db,
            $table: $db.customers,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$LoyaltyEntriesTableAnnotationComposer
    extends Composer<_$AppDatabase, $LoyaltyEntriesTable> {
  $$LoyaltyEntriesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get orderId =>
      $composableBuilder(column: $table.orderId, builder: (column) => column);

  GeneratedColumn<int> get points =>
      $composableBuilder(column: $table.points, builder: (column) => column);

  GeneratedColumn<String> get reason =>
      $composableBuilder(column: $table.reason, builder: (column) => column);

  GeneratedColumn<DateTime> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  $$CustomersTableAnnotationComposer get customerId {
    final $$CustomersTableAnnotationComposer composer = $composerBuilder(
      composer: this,
      getCurrentColumn: (t) => t.customerId,
      referencedTable: $db.customers,
      getReferencedColumn: (t) => t.id,
      builder:
          (
            joinBuilder, {
            $addJoinBuilderToRootComposer,
            $removeJoinBuilderFromRootComposer,
          }) => $$CustomersTableAnnotationComposer(
            $db: $db,
            $table: $db.customers,
            $addJoinBuilderToRootComposer: $addJoinBuilderToRootComposer,
            joinBuilder: joinBuilder,
            $removeJoinBuilderFromRootComposer:
                $removeJoinBuilderFromRootComposer,
          ),
    );
    return composer;
  }
}

class $$LoyaltyEntriesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $LoyaltyEntriesTable,
          LoyaltyEntry,
          $$LoyaltyEntriesTableFilterComposer,
          $$LoyaltyEntriesTableOrderingComposer,
          $$LoyaltyEntriesTableAnnotationComposer,
          $$LoyaltyEntriesTableCreateCompanionBuilder,
          $$LoyaltyEntriesTableUpdateCompanionBuilder,
          (LoyaltyEntry, $$LoyaltyEntriesTableReferences),
          LoyaltyEntry,
          PrefetchHooks Function({bool customerId})
        > {
  $$LoyaltyEntriesTableTableManager(
    _$AppDatabase db,
    $LoyaltyEntriesTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$LoyaltyEntriesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$LoyaltyEntriesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$LoyaltyEntriesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> id = const Value.absent(),
                Value<String> customerId = const Value.absent(),
                Value<String?> orderId = const Value.absent(),
                Value<int> points = const Value.absent(),
                Value<String> reason = const Value.absent(),
                Value<DateTime> createdAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LoyaltyEntriesCompanion(
                id: id,
                customerId: customerId,
                orderId: orderId,
                points: points,
                reason: reason,
                createdAt: createdAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String id,
                required String customerId,
                Value<String?> orderId = const Value.absent(),
                required int points,
                required String reason,
                Value<DateTime> createdAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LoyaltyEntriesCompanion.insert(
                id: id,
                customerId: customerId,
                orderId: orderId,
                points: points,
                reason: reason,
                createdAt: createdAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map(
                (e) => (
                  e.readTable(table),
                  $$LoyaltyEntriesTableReferences(db, table, e),
                ),
              )
              .toList(),
          prefetchHooksCallback: ({customerId = false}) {
            return PrefetchHooks(
              db: db,
              explicitlyWatchedTables: [],
              addJoins:
                  <
                    T extends TableManagerState<
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic,
                      dynamic
                    >
                  >(state) {
                    if (customerId) {
                      state =
                          state.withJoin(
                                currentTable: table,
                                currentColumn: table.customerId,
                                referencedTable: $$LoyaltyEntriesTableReferences
                                    ._customerIdTable(db),
                                referencedColumn:
                                    $$LoyaltyEntriesTableReferences
                                        ._customerIdTable(db)
                                        .id,
                              )
                              as T;
                    }

                    return state;
                  },
              getPrefetchedDataCallback: (items) async {
                return [];
              },
            );
          },
        ),
      );
}

typedef $$LoyaltyEntriesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $LoyaltyEntriesTable,
      LoyaltyEntry,
      $$LoyaltyEntriesTableFilterComposer,
      $$LoyaltyEntriesTableOrderingComposer,
      $$LoyaltyEntriesTableAnnotationComposer,
      $$LoyaltyEntriesTableCreateCompanionBuilder,
      $$LoyaltyEntriesTableUpdateCompanionBuilder,
      (LoyaltyEntry, $$LoyaltyEntriesTableReferences),
      LoyaltyEntry,
      PrefetchHooks Function({bool customerId})
    >;
typedef $$MixMatchDealsTableCreateCompanionBuilder =
    MixMatchDealsCompanion Function({
      Value<int> id,
      required String name,
      Value<int> triggerQty,
      required int dealPriceMinor,
      Value<bool> active,
    });
typedef $$MixMatchDealsTableUpdateCompanionBuilder =
    MixMatchDealsCompanion Function({
      Value<int> id,
      Value<String> name,
      Value<int> triggerQty,
      Value<int> dealPriceMinor,
      Value<bool> active,
    });

class $$MixMatchDealsTableFilterComposer
    extends Composer<_$AppDatabase, $MixMatchDealsTable> {
  $$MixMatchDealsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get triggerQty => $composableBuilder(
    column: $table.triggerQty,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get dealPriceMinor => $composableBuilder(
    column: $table.dealPriceMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get active => $composableBuilder(
    column: $table.active,
    builder: (column) => ColumnFilters(column),
  );
}

class $$MixMatchDealsTableOrderingComposer
    extends Composer<_$AppDatabase, $MixMatchDealsTable> {
  $$MixMatchDealsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get triggerQty => $composableBuilder(
    column: $table.triggerQty,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get dealPriceMinor => $composableBuilder(
    column: $table.dealPriceMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get active => $composableBuilder(
    column: $table.active,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$MixMatchDealsTableAnnotationComposer
    extends Composer<_$AppDatabase, $MixMatchDealsTable> {
  $$MixMatchDealsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<int> get triggerQty => $composableBuilder(
    column: $table.triggerQty,
    builder: (column) => column,
  );

  GeneratedColumn<int> get dealPriceMinor => $composableBuilder(
    column: $table.dealPriceMinor,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get active =>
      $composableBuilder(column: $table.active, builder: (column) => column);
}

class $$MixMatchDealsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $MixMatchDealsTable,
          MixMatchDeal,
          $$MixMatchDealsTableFilterComposer,
          $$MixMatchDealsTableOrderingComposer,
          $$MixMatchDealsTableAnnotationComposer,
          $$MixMatchDealsTableCreateCompanionBuilder,
          $$MixMatchDealsTableUpdateCompanionBuilder,
          (
            MixMatchDeal,
            BaseReferences<_$AppDatabase, $MixMatchDealsTable, MixMatchDeal>,
          ),
          MixMatchDeal,
          PrefetchHooks Function()
        > {
  $$MixMatchDealsTableTableManager(_$AppDatabase db, $MixMatchDealsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$MixMatchDealsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$MixMatchDealsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$MixMatchDealsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<int> triggerQty = const Value.absent(),
                Value<int> dealPriceMinor = const Value.absent(),
                Value<bool> active = const Value.absent(),
              }) => MixMatchDealsCompanion(
                id: id,
                name: name,
                triggerQty: triggerQty,
                dealPriceMinor: dealPriceMinor,
                active: active,
              ),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                required String name,
                Value<int> triggerQty = const Value.absent(),
                required int dealPriceMinor,
                Value<bool> active = const Value.absent(),
              }) => MixMatchDealsCompanion.insert(
                id: id,
                name: name,
                triggerQty: triggerQty,
                dealPriceMinor: dealPriceMinor,
                active: active,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$MixMatchDealsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $MixMatchDealsTable,
      MixMatchDeal,
      $$MixMatchDealsTableFilterComposer,
      $$MixMatchDealsTableOrderingComposer,
      $$MixMatchDealsTableAnnotationComposer,
      $$MixMatchDealsTableCreateCompanionBuilder,
      $$MixMatchDealsTableUpdateCompanionBuilder,
      (
        MixMatchDeal,
        BaseReferences<_$AppDatabase, $MixMatchDealsTable, MixMatchDeal>,
      ),
      MixMatchDeal,
      PrefetchHooks Function()
    >;
typedef $$MixMatchProductsTableCreateCompanionBuilder =
    MixMatchProductsCompanion Function({
      required int dealId,
      required int pluId,
      Value<int> rowid,
    });
typedef $$MixMatchProductsTableUpdateCompanionBuilder =
    MixMatchProductsCompanion Function({
      Value<int> dealId,
      Value<int> pluId,
      Value<int> rowid,
    });

class $$MixMatchProductsTableFilterComposer
    extends Composer<_$AppDatabase, $MixMatchProductsTable> {
  $$MixMatchProductsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get dealId => $composableBuilder(
    column: $table.dealId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get pluId => $composableBuilder(
    column: $table.pluId,
    builder: (column) => ColumnFilters(column),
  );
}

class $$MixMatchProductsTableOrderingComposer
    extends Composer<_$AppDatabase, $MixMatchProductsTable> {
  $$MixMatchProductsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get dealId => $composableBuilder(
    column: $table.dealId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get pluId => $composableBuilder(
    column: $table.pluId,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$MixMatchProductsTableAnnotationComposer
    extends Composer<_$AppDatabase, $MixMatchProductsTable> {
  $$MixMatchProductsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get dealId =>
      $composableBuilder(column: $table.dealId, builder: (column) => column);

  GeneratedColumn<int> get pluId =>
      $composableBuilder(column: $table.pluId, builder: (column) => column);
}

class $$MixMatchProductsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $MixMatchProductsTable,
          MixMatchProduct,
          $$MixMatchProductsTableFilterComposer,
          $$MixMatchProductsTableOrderingComposer,
          $$MixMatchProductsTableAnnotationComposer,
          $$MixMatchProductsTableCreateCompanionBuilder,
          $$MixMatchProductsTableUpdateCompanionBuilder,
          (
            MixMatchProduct,
            BaseReferences<
              _$AppDatabase,
              $MixMatchProductsTable,
              MixMatchProduct
            >,
          ),
          MixMatchProduct,
          PrefetchHooks Function()
        > {
  $$MixMatchProductsTableTableManager(
    _$AppDatabase db,
    $MixMatchProductsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$MixMatchProductsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$MixMatchProductsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$MixMatchProductsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<int> dealId = const Value.absent(),
                Value<int> pluId = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => MixMatchProductsCompanion(
                dealId: dealId,
                pluId: pluId,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required int dealId,
                required int pluId,
                Value<int> rowid = const Value.absent(),
              }) => MixMatchProductsCompanion.insert(
                dealId: dealId,
                pluId: pluId,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$MixMatchProductsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $MixMatchProductsTable,
      MixMatchProduct,
      $$MixMatchProductsTableFilterComposer,
      $$MixMatchProductsTableOrderingComposer,
      $$MixMatchProductsTableAnnotationComposer,
      $$MixMatchProductsTableCreateCompanionBuilder,
      $$MixMatchProductsTableUpdateCompanionBuilder,
      (
        MixMatchProduct,
        BaseReferences<_$AppDatabase, $MixMatchProductsTable, MixMatchProduct>,
      ),
      MixMatchProduct,
      PrefetchHooks Function()
    >;
typedef $$DepartmentsTableCreateCompanionBuilder =
    DepartmentsCompanion Function({
      required String name,
      Value<String?> emoji,
      Value<String?> imageUrl,
      Value<String?> buttonColor,
      Value<int> sortOrder,
      Value<int> rowid,
    });
typedef $$DepartmentsTableUpdateCompanionBuilder =
    DepartmentsCompanion Function({
      Value<String> name,
      Value<String?> emoji,
      Value<String?> imageUrl,
      Value<String?> buttonColor,
      Value<int> sortOrder,
      Value<int> rowid,
    });

class $$DepartmentsTableFilterComposer
    extends Composer<_$AppDatabase, $DepartmentsTable> {
  $$DepartmentsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get emoji => $composableBuilder(
    column: $table.emoji,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get imageUrl => $composableBuilder(
    column: $table.imageUrl,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get buttonColor => $composableBuilder(
    column: $table.buttonColor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get sortOrder => $composableBuilder(
    column: $table.sortOrder,
    builder: (column) => ColumnFilters(column),
  );
}

class $$DepartmentsTableOrderingComposer
    extends Composer<_$AppDatabase, $DepartmentsTable> {
  $$DepartmentsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get emoji => $composableBuilder(
    column: $table.emoji,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get imageUrl => $composableBuilder(
    column: $table.imageUrl,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get buttonColor => $composableBuilder(
    column: $table.buttonColor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get sortOrder => $composableBuilder(
    column: $table.sortOrder,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$DepartmentsTableAnnotationComposer
    extends Composer<_$AppDatabase, $DepartmentsTable> {
  $$DepartmentsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get emoji =>
      $composableBuilder(column: $table.emoji, builder: (column) => column);

  GeneratedColumn<String> get imageUrl =>
      $composableBuilder(column: $table.imageUrl, builder: (column) => column);

  GeneratedColumn<String> get buttonColor => $composableBuilder(
    column: $table.buttonColor,
    builder: (column) => column,
  );

  GeneratedColumn<int> get sortOrder =>
      $composableBuilder(column: $table.sortOrder, builder: (column) => column);
}

class $$DepartmentsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $DepartmentsTable,
          Department,
          $$DepartmentsTableFilterComposer,
          $$DepartmentsTableOrderingComposer,
          $$DepartmentsTableAnnotationComposer,
          $$DepartmentsTableCreateCompanionBuilder,
          $$DepartmentsTableUpdateCompanionBuilder,
          (
            Department,
            BaseReferences<_$AppDatabase, $DepartmentsTable, Department>,
          ),
          Department,
          PrefetchHooks Function()
        > {
  $$DepartmentsTableTableManager(_$AppDatabase db, $DepartmentsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$DepartmentsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$DepartmentsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$DepartmentsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> name = const Value.absent(),
                Value<String?> emoji = const Value.absent(),
                Value<String?> imageUrl = const Value.absent(),
                Value<String?> buttonColor = const Value.absent(),
                Value<int> sortOrder = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => DepartmentsCompanion(
                name: name,
                emoji: emoji,
                imageUrl: imageUrl,
                buttonColor: buttonColor,
                sortOrder: sortOrder,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String name,
                Value<String?> emoji = const Value.absent(),
                Value<String?> imageUrl = const Value.absent(),
                Value<String?> buttonColor = const Value.absent(),
                Value<int> sortOrder = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => DepartmentsCompanion.insert(
                name: name,
                emoji: emoji,
                imageUrl: imageUrl,
                buttonColor: buttonColor,
                sortOrder: sortOrder,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$DepartmentsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $DepartmentsTable,
      Department,
      $$DepartmentsTableFilterComposer,
      $$DepartmentsTableOrderingComposer,
      $$DepartmentsTableAnnotationComposer,
      $$DepartmentsTableCreateCompanionBuilder,
      $$DepartmentsTableUpdateCompanionBuilder,
      (
        Department,
        BaseReferences<_$AppDatabase, $DepartmentsTable, Department>,
      ),
      Department,
      PrefetchHooks Function()
    >;
typedef $$CashDenominationsTableCreateCompanionBuilder =
    CashDenominationsCompanion Function({
      Value<int> valueMinor,
      required String label,
      Value<String?> imageUrl,
      Value<int> sortOrder,
    });
typedef $$CashDenominationsTableUpdateCompanionBuilder =
    CashDenominationsCompanion Function({
      Value<int> valueMinor,
      Value<String> label,
      Value<String?> imageUrl,
      Value<int> sortOrder,
    });

class $$CashDenominationsTableFilterComposer
    extends Composer<_$AppDatabase, $CashDenominationsTable> {
  $$CashDenominationsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get valueMinor => $composableBuilder(
    column: $table.valueMinor,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get label => $composableBuilder(
    column: $table.label,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get imageUrl => $composableBuilder(
    column: $table.imageUrl,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get sortOrder => $composableBuilder(
    column: $table.sortOrder,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CashDenominationsTableOrderingComposer
    extends Composer<_$AppDatabase, $CashDenominationsTable> {
  $$CashDenominationsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get valueMinor => $composableBuilder(
    column: $table.valueMinor,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get label => $composableBuilder(
    column: $table.label,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get imageUrl => $composableBuilder(
    column: $table.imageUrl,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get sortOrder => $composableBuilder(
    column: $table.sortOrder,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CashDenominationsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CashDenominationsTable> {
  $$CashDenominationsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get valueMinor => $composableBuilder(
    column: $table.valueMinor,
    builder: (column) => column,
  );

  GeneratedColumn<String> get label =>
      $composableBuilder(column: $table.label, builder: (column) => column);

  GeneratedColumn<String> get imageUrl =>
      $composableBuilder(column: $table.imageUrl, builder: (column) => column);

  GeneratedColumn<int> get sortOrder =>
      $composableBuilder(column: $table.sortOrder, builder: (column) => column);
}

class $$CashDenominationsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CashDenominationsTable,
          CashDenomination,
          $$CashDenominationsTableFilterComposer,
          $$CashDenominationsTableOrderingComposer,
          $$CashDenominationsTableAnnotationComposer,
          $$CashDenominationsTableCreateCompanionBuilder,
          $$CashDenominationsTableUpdateCompanionBuilder,
          (
            CashDenomination,
            BaseReferences<
              _$AppDatabase,
              $CashDenominationsTable,
              CashDenomination
            >,
          ),
          CashDenomination,
          PrefetchHooks Function()
        > {
  $$CashDenominationsTableTableManager(
    _$AppDatabase db,
    $CashDenominationsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CashDenominationsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CashDenominationsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CashDenominationsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<int> valueMinor = const Value.absent(),
                Value<String> label = const Value.absent(),
                Value<String?> imageUrl = const Value.absent(),
                Value<int> sortOrder = const Value.absent(),
              }) => CashDenominationsCompanion(
                valueMinor: valueMinor,
                label: label,
                imageUrl: imageUrl,
                sortOrder: sortOrder,
              ),
          createCompanionCallback:
              ({
                Value<int> valueMinor = const Value.absent(),
                required String label,
                Value<String?> imageUrl = const Value.absent(),
                Value<int> sortOrder = const Value.absent(),
              }) => CashDenominationsCompanion.insert(
                valueMinor: valueMinor,
                label: label,
                imageUrl: imageUrl,
                sortOrder: sortOrder,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CashDenominationsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CashDenominationsTable,
      CashDenomination,
      $$CashDenominationsTableFilterComposer,
      $$CashDenominationsTableOrderingComposer,
      $$CashDenominationsTableAnnotationComposer,
      $$CashDenominationsTableCreateCompanionBuilder,
      $$CashDenominationsTableUpdateCompanionBuilder,
      (
        CashDenomination,
        BaseReferences<
          _$AppDatabase,
          $CashDenominationsTable,
          CashDenomination
        >,
      ),
      CashDenomination,
      PrefetchHooks Function()
    >;
typedef $$StaffTableCreateCompanionBuilder =
    StaffCompanion Function({
      Value<int> id,
      Value<int> pluid,
      required String name,
      required String pin,
    });
typedef $$StaffTableUpdateCompanionBuilder =
    StaffCompanion Function({
      Value<int> id,
      Value<int> pluid,
      Value<String> name,
      Value<String> pin,
    });

class $$StaffTableFilterComposer extends Composer<_$AppDatabase, $StaffTable> {
  $$StaffTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get pluid => $composableBuilder(
    column: $table.pluid,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get pin => $composableBuilder(
    column: $table.pin,
    builder: (column) => ColumnFilters(column),
  );
}

class $$StaffTableOrderingComposer
    extends Composer<_$AppDatabase, $StaffTable> {
  $$StaffTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<int> get id => $composableBuilder(
    column: $table.id,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get pluid => $composableBuilder(
    column: $table.pluid,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get pin => $composableBuilder(
    column: $table.pin,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$StaffTableAnnotationComposer
    extends Composer<_$AppDatabase, $StaffTable> {
  $$StaffTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<int> get id =>
      $composableBuilder(column: $table.id, builder: (column) => column);

  GeneratedColumn<int> get pluid =>
      $composableBuilder(column: $table.pluid, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get pin =>
      $composableBuilder(column: $table.pin, builder: (column) => column);
}

class $$StaffTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $StaffTable,
          StaffData,
          $$StaffTableFilterComposer,
          $$StaffTableOrderingComposer,
          $$StaffTableAnnotationComposer,
          $$StaffTableCreateCompanionBuilder,
          $$StaffTableUpdateCompanionBuilder,
          (StaffData, BaseReferences<_$AppDatabase, $StaffTable, StaffData>),
          StaffData,
          PrefetchHooks Function()
        > {
  $$StaffTableTableManager(_$AppDatabase db, $StaffTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$StaffTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$StaffTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$StaffTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<int> pluid = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<String> pin = const Value.absent(),
              }) => StaffCompanion(id: id, pluid: pluid, name: name, pin: pin),
          createCompanionCallback:
              ({
                Value<int> id = const Value.absent(),
                Value<int> pluid = const Value.absent(),
                required String name,
                required String pin,
              }) => StaffCompanion.insert(
                id: id,
                pluid: pluid,
                name: name,
                pin: pin,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$StaffTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $StaffTable,
      StaffData,
      $$StaffTableFilterComposer,
      $$StaffTableOrderingComposer,
      $$StaffTableAnnotationComposer,
      $$StaffTableCreateCompanionBuilder,
      $$StaffTableUpdateCompanionBuilder,
      (StaffData, BaseReferences<_$AppDatabase, $StaffTable, StaffData>),
      StaffData,
      PrefetchHooks Function()
    >;

class $AppDatabaseManager {
  final _$AppDatabase _db;
  $AppDatabaseManager(this._db);
  $$ProductsTableTableManager get products =>
      $$ProductsTableTableManager(_db, _db.products);
  $$OrdersTableTableManager get orders =>
      $$OrdersTableTableManager(_db, _db.orders);
  $$OrderLinesTableTableManager get orderLines =>
      $$OrderLinesTableTableManager(_db, _db.orderLines);
  $$PaymentsTableTableManager get payments =>
      $$PaymentsTableTableManager(_db, _db.payments);
  $$OutboxEntriesTableTableManager get outboxEntries =>
      $$OutboxEntriesTableTableManager(_db, _db.outboxEntries);
  $$TillSessionsTableTableManager get tillSessions =>
      $$TillSessionsTableTableManager(_db, _db.tillSessions);
  $$DiningTablesTableTableManager get diningTables =>
      $$DiningTablesTableTableManager(_db, _db.diningTables);
  $$CustomersTableTableManager get customers =>
      $$CustomersTableTableManager(_db, _db.customers);
  $$LoyaltyEntriesTableTableManager get loyaltyEntries =>
      $$LoyaltyEntriesTableTableManager(_db, _db.loyaltyEntries);
  $$MixMatchDealsTableTableManager get mixMatchDeals =>
      $$MixMatchDealsTableTableManager(_db, _db.mixMatchDeals);
  $$MixMatchProductsTableTableManager get mixMatchProducts =>
      $$MixMatchProductsTableTableManager(_db, _db.mixMatchProducts);
  $$DepartmentsTableTableManager get departments =>
      $$DepartmentsTableTableManager(_db, _db.departments);
  $$CashDenominationsTableTableManager get cashDenominations =>
      $$CashDenominationsTableTableManager(_db, _db.cashDenominations);
  $$StaffTableTableManager get staff =>
      $$StaffTableTableManager(_db, _db.staff);
}
