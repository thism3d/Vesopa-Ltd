/// Photos on every button (owner, 2026-10-28; the design at
/// claude.ai/artifact/HcweK3MxEk82nmnS2LjHha): each section and each product
/// shows its photo, the price sits on the photo, and the layout is each
/// device's own:
///
///   iPad        photo sections down the side, products four across, the ticket
///   iPhone      a large title, photo section chips across the top, square tiles,
///               the sale floating at the bottom
///   Android     photo sections down the side, products two across, View Sale / Pay
///
/// A product's photo is its back-office picture, else the one the venue's
/// online menu shows (/api/tap/photos); a product with neither shows its
/// section's photo. Only a manager changes a photo or a price
/// ([ProductEditSheet]), and the change goes to the back office product, so the
/// tills, every Go device and the online menu show it.
library;

import 'dart:convert';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../data/api.dart';
import '../data/models.dart';
import '../data/session.dart';
import 'product_photo.dart' show photoUrl;
import 'theme.dart';

/// The section's photo: the online menu section's of the same name, else the
/// first photo among its products.
String? sectionPhotoOf(TapState s, MenuCategory c) {
  for (final p in s.products) {
    if (p.category != c.id) continue;
    final ph = _ownPhoto(s, p);
    if (ph != null) return ph;
  }
  return null;
}

/// The product's back-office photo, the one the till shows (owner,
/// 2026-10-28: "back office item photos, like in the EPOS and Go both").
String? _ownPhoto(TapState s, Product p) => p.imageUrl.isNotEmpty ? p.imageUrl : null;

/// The photo a product's button shows: the back office's, as on the till.
String? photoOf(TapState s, Product p) => _ownPhoto(s, p);

class _Photo extends StatelessWidget {
  const _Photo({required this.url, required this.tint, this.radius = 0});
  final String? url;
  final Color tint;
  final double radius;

  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        child: url == null
            ? ColoredBox(color: tint.withValues(alpha: 0.35))
            : CachedNetworkImage(
                imageUrl: photoUrl(url!),
                fit: BoxFit.cover,
                fadeInDuration: const Duration(milliseconds: 200),
                memCacheWidth: 480,
                placeholder: (_, _) => ColoredBox(color: tint.withValues(alpha: 0.25)),
                errorWidget: (_, _, _) => ColoredBox(color: tint.withValues(alpha: 0.35)),
              ),
      );
}

/// A product's button: the photo, the price on it, the name under it.
class PhotoTile extends ConsumerWidget {
  const PhotoTile({super.key, required this.product, required this.tint, required this.onTap, this.onLongPress, this.square = false});
  final Product product;
  final Color tint;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final bool square;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    final p = product;
    final photos = s.config.go.productImages;
    return Opacity(
      opacity: p.outOfStock ? 0.45 : 1,
      child: Material(
        color: Tp.inkCard,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(square ? 18 : 14), side: const BorderSide(color: Tp.inkLine)),
        child: InkWell(
          key: ValueKey('item-${p.id}'),
          onTap: onTap,
          onLongPress: onLongPress,
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (photos)
              AspectRatio(
                aspectRatio: square ? 1 : 4 / 3,
                child: Stack(fit: StackFit.expand, children: [
                  _Photo(url: photoOf(s, p), tint: tint),
                  if (p.allergens.isNotEmpty)
                    const Positioned(left: 6, top: 6, child: Icon(Icons.back_hand_rounded, size: 16, color: Tp.amber, semanticLabel: 'Has allergens')),
                  Positioned(right: 6, bottom: 6, child: _PriceChip(text: p.outOfStock ? 'Sold out' : money(p.priceMinor))),
                ]),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(9, 7, 9, 9),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(p.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5, height: 1.15)),
                if (!photos) Text(money(p.priceMinor), style: const TextStyle(fontSize: 12, color: Tp.muted, fontFeatures: Tp.tabular)),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class _PriceChip extends StatelessWidget {
  const _PriceChip({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(color: const Color(0xB8000000), borderRadius: BorderRadius.circular(999)),
        child: Text(text, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 13, fontFeatures: Tp.tabular)),
      );
}

/// Products as photo tiles: [columns] across (0 = as many as fit).
class PhotoGrid extends StatelessWidget {
  const PhotoGrid({super.key, required this.items, required this.tint, required this.onPress, this.onLongPress, this.columns = 0, this.square = false, this.bottomPad = 8});
  final List<Product> items;
  final Color tint;
  final ValueChanged<Product> onPress;
  final ValueChanged<Product>? onLongPress;
  final int columns;
  final bool square;
  final double bottomPad;

  @override
  Widget build(BuildContext context) => LayoutBuilder(builder: (context, box) {
        final cols = columns > 0 ? columns : (box.maxWidth / 190).floor().clamp(2, 6);
        final w = (box.maxWidth - 16 - 10 * (cols - 1)) / cols;
        final h = w * (square ? 1 : 3 / 4) + 48;
        return GridView.builder(
          padding: EdgeInsets.fromLTRB(8, 8, 8, bottomPad),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: cols, mainAxisExtent: h, crossAxisSpacing: 10, mainAxisSpacing: 10),
          itemCount: items.length,
          itemBuilder: (_, i) => PhotoTile(
            product: items[i],
            tint: tint,
            square: square,
            onTap: () => onPress(items[i]),
            onLongPress: onLongPress == null ? null : () => onLongPress!(items[i]),
          ),
        );
      });
}

/// The sections down the side, each with its photo (Android and iPad).
class PhotoRail extends ConsumerWidget {
  const PhotoRail({super.key, required this.categories, required this.selected, required this.onSelect, this.width = 88});
  final List<MenuCategory> categories;
  final String selected;
  final ValueChanged<String> onSelect;
  final double width;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    return Container(
      width: width,
      decoration: const BoxDecoration(color: Tp.inkCard, border: Border(right: BorderSide(color: Tp.inkLine))),
      child: ListView(padding: const EdgeInsets.symmetric(vertical: 6), children: [
        for (final c in categories)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
            child: Material(
              color: c.id == selected ? Tp.lime.withValues(alpha: 0.18) : Colors.transparent,
              borderRadius: BorderRadius.circular(14),
              child: InkWell(
                key: ValueKey('cat-${c.id}'),
                borderRadius: BorderRadius.circular(14),
                onTap: () => onSelect(c.id),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
                  child: Column(children: [
                    AnimatedContainer(
                      duration: const Duration(milliseconds: 180),
                      width: 46,
                      height: 46,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(color: c.id == selected ? Tp.lime : Colors.transparent, width: 2),
                      ),
                      child: _Photo(url: sectionPhotoOf(s, c), tint: Color(c.colour), radius: 10),
                    ),
                    const SizedBox(height: 4),
                    Text(c.name,
                        maxLines: 2,
                        textAlign: TextAlign.center,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 11.5,
                            height: 1.15,
                            color: c.id == selected ? Tp.lime : null,
                            fontWeight: c.id == selected ? FontWeight.w800 : FontWeight.w600)),
                  ]),
                ),
              ),
            ),
          ),
      ]),
    );
  }
}

/// The sections across the top as photo chips (iPhone).
class PhotoChips extends ConsumerWidget {
  const PhotoChips({super.key, required this.categories, required this.selected, required this.onSelect});
  final List<MenuCategory> categories;
  final String selected;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(tapProvider);
    return SizedBox(
      height: 48,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        itemCount: categories.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (_, i) {
          final c = categories[i];
          final on = c.id == selected;
          return Material(
            color: on ? Tp.lime : Tp.inkCard,
            shape: StadiumBorder(side: BorderSide(color: on ? Tp.lime : Tp.inkLine)),
            child: InkWell(
              key: ValueKey('cat-${c.id}'),
              customBorder: const StadiumBorder(),
              onTap: () => onSelect(c.id),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(4, 4, 14, 4),
                child: Row(children: [
                  SizedBox(width: 32, height: 32, child: _Photo(url: sectionPhotoOf(s, c), tint: Color(c.colour), radius: 16)),
                  const SizedBox(width: 8),
                  Text(c.name, style: TextStyle(fontWeight: FontWeight.w700, color: on ? Tp.onLime : null)),
                ]),
              ),
            ),
          );
        },
      ),
    );
  }
}

/// A manager changes a product's photo and price (owner: managers only; the
/// change goes to the back office product, so it shows everywhere).
Future<void> editProduct(BuildContext context, WidgetRef ref, Product p) => showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      constraints: const BoxConstraints(maxWidth: 560),
      builder: (_) => _ProductEditSheet(product: p),
    );

class _ProductEditSheet extends ConsumerStatefulWidget {
  const _ProductEditSheet({required this.product});
  final Product product;
  @override
  ConsumerState<_ProductEditSheet> createState() => _ProductEditSheetState();
}

class _ProductEditSheetState extends ConsumerState<_ProductEditSheet> {
  late final _price = TextEditingController(text: (widget.product.priceMinor / 100).toStringAsFixed(2));
  String? _photo;
  Uint8List? _newBytes;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _photo = photoOf(ref.read(tapProvider), widget.product);
  }

  @override
  void dispose() {
    _price.dispose();
    super.dispose();
  }

  Future<void> _pick(ImageSource source) async {
    try {
      final f = await ImagePicker().pickImage(source: source, maxWidth: 1200, maxHeight: 1200, imageQuality: 82);
      if (f == null) return;
      final bytes = await f.readAsBytes();
      setState(() => _newBytes = bytes);
    } on PlatformException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not open the ${source == ImageSource.camera ? 'camera' : 'photos'}: ${e.message ?? e.code}')));
    }
  }

  Future<void> _menuPhoto() async {
    final s = ref.read(tapProvider);
    final all = {...s.config.productPhotos.values, ...s.config.sectionPhotos.values, for (final p in s.products) if (p.imageUrl.isNotEmpty) p.imageUrl}.toList();
    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (c) => SizedBox(
        height: 420,
        child: all.isEmpty
            ? const Center(child: Text('The venue has no menu photos yet.'))
            : GridView.count(
                crossAxisCount: 4,
                padding: const EdgeInsets.all(12),
                mainAxisSpacing: 8,
                crossAxisSpacing: 8,
                children: [
                  for (final u in all)
                    InkWell(onTap: () => Navigator.pop(c, u), child: _Photo(url: u, tint: Tp.lime, radius: 10)),
                ],
              ),
      ),
    );
    if (picked != null) {
      setState(() {
        _photo = picked;
        _newBytes = null;
      });
    }
  }

  Future<void> _save() async {
    final p = widget.product;
    final pounds = double.tryParse(_price.text.trim().replaceAll('£', ''));
    if (pounds == null || pounds < 0 || p.plu == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Give the product a price, like 4.50.')));
      return;
    }
    setState(() => _saving = true);
    final messenger = ScaffoldMessenger.of(context);
    final s = ref.read(tapProvider);
    try {
      if (s.demo) {
        messenger.showSnackBar(const SnackBar(content: Text('Demo: not saved')));
        if (mounted) Navigator.pop(context);
        return;
      }
      final api = ref.read(apiProvider);
      var url = _photo;
      if (_newBytes != null) {
        url = await api.uploadPhoto('data:image/jpeg;base64,${base64Encode(_newBytes!)}');
      }
      final photoChanged = url != null && url != photoOf(s, p);
      await api.updateProduct(p.plu!, price: pounds, imageUrl: photoChanged ? url : null);
      if (photoChanged) await api.menuPhoto(p.plu!, url).catchError((Object _) {});
      await ref.read(tapProvider.notifier).refresh();
      messenger.showSnackBar(SnackBar(content: Text('${p.name} saved: the tills and the online menu have it too')));
      if (mounted) Navigator.pop(context);
    } on TapApiError catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.viewInsetsOf(context).bottom),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Expanded(child: Text(widget.product.name, style: t.titleLarge?.copyWith(fontWeight: FontWeight.w800))),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
                decoration: BoxDecoration(color: Tp.lime, borderRadius: BorderRadius.circular(999)),
                child: const Text('Manager', style: TextStyle(color: Tp.onLime, fontWeight: FontWeight.w800, fontSize: 12)),
              ),
            ]),
            const SizedBox(height: 12),
            AspectRatio(
              aspectRatio: 16 / 10,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(16),
                child: _newBytes != null ? Image.memory(_newBytes!, fit: BoxFit.cover) : _Photo(url: _photo, tint: Tp.lime),
              ),
            ),
            const SizedBox(height: 12),
            Row(children: [
              for (final (icon, label, onTap) in [
                (Icons.photo_camera_rounded, 'Take a photo', () => _pick(ImageSource.camera)),
                (Icons.photo_library_rounded, 'Choose from Photos', () => _pick(ImageSource.gallery)),
                (Icons.restaurant_menu_rounded, 'Use a menu photo', _menuPhoto),
              ])
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, 64), padding: const EdgeInsets.all(6)),
                      onPressed: _saving ? null : onTap,
                      child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(icon), const SizedBox(height: 4), Text(label, textAlign: TextAlign.center, style: const TextStyle(fontSize: 12))]),
                    ),
                  ),
                ),
            ]),
            const SizedBox(height: 14),
            TextField(
              controller: _price,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, fontFeatures: Tp.tabular),
              decoration: const InputDecoration(labelText: 'Price', prefixText: '£ '),
            ),
            const SizedBox(height: 8),
            Text('Saved to the back office: the tills, every Vesopa Go device and the online menu change at once.', style: t.bodySmall),
            const SizedBox(height: 14),
            FilledButton(onPressed: _saving ? null : _save, child: Text(_saving ? 'Saving…' : 'Save')),
          ]),
        ),
      ),
    );
  }
}
