import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../brand.dart';
import '../data/api.dart';
import '../data/session.dart';
import 'widgets.dart';

/// The member's cars: add one by registration, remove one.
class CarsPage extends ConsumerWidget {
  const CarsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final account = ref.watch(accountProvider);
    return account.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => ErrorNotice(e.toString(), onRetry: () => ref.invalidate(accountProvider)),
      data: (a) {
        final full = a.vehicles.length >= a.member.maxVehicles;
        return ListView(
          padding: pagePadding(context),
          children: [
            PageHero(
              icon: Icons.directions_car_rounded,
              overline: 'Registered vehicles',
              title: 'My cars',
              subtitle: 'The cameras read your plate, so enter it exactly as it is on the car.',
              trailing: _Allowance(used: a.vehicles.length, max: a.member.maxVehicles),
            ),
            const SizedBox(height: 18),
            if (a.vehicles.isEmpty)
              const Padding(
                padding: EdgeInsets.only(bottom: 14),
                child: EmptyState(
                  icon: Icons.no_crash_rounded,
                  title: 'No cars yet',
                  message: 'Add your registration and the barrier will know you next time you drive up.',
                ),
              ),
            ResponsiveGrid(
              minItemWidth: 380,
              children: [
                for (final v in a.vehicles)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(14),
                      child: Row(
                        children: [
                          const IconTile(Icons.directions_car_filled_rounded),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                NumberPlate(v.display, size: 20),
                                if (v.nickname.isNotEmpty || v.description.isNotEmpty) ...[
                                  const SizedBox(height: 8),
                                  Text(
                                    [if (v.nickname.isNotEmpty) v.nickname, if (v.description.isNotEmpty) v.description].join(' · '),
                                    style: Theme.of(context).textTheme.bodyMedium,
                                  ),
                                ],
                              ],
                            ),
                          ),
                          IconButton(
                            tooltip: 'Remove ${v.display}',
                            icon: const Icon(Icons.delete_outline),
                            onPressed: () => _remove(context, ref, v),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 16),
            // A button the width of a phone, not of a desktop window.
            Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                child: SizedBox(
                  width: double.infinity,
                  height: 54,
                  child: FilledButton.icon(
                    key: const Key('add-car'),
                    onPressed: full
                        ? null
                        : () {
                            ref.read(activityLogProvider).tap('open_add_car');
                            showModalBottomSheet<void>(
                              context: context,
                              isScrollControlled: true,
                              showDragHandle: true,
                              builder: (_) => const AddCarSheet(),
                            );
                          },
                    icon: const Icon(Icons.add),
                    label: Text(full ? 'Your membership is full' : 'Add a car'),
                  ),
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  Future<void> _remove(BuildContext context, WidgetRef ref, Vehicle v) async {
    final log = ref.read(activityLogProvider);
    log.tap('remove_car', {'plate': v.plate});
    final sure = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Remove ${v.display}?'),
        content: const Text('The barriers will stop opening for this car.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Remove')),
        ],
      ),
    );
    if (sure != true) {
      log.tap('remove_car_cancelled', {'plate': v.plate});
      return;
    }
    try {
      await ref.read(apiProvider).removeVehicle(v.id);
      ref.invalidate(accountProvider);
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${v.display} removed.')));
    } on ApiError catch (e) {
      log.event('remove_car_failed', {'plate': v.plate, 'error': e.message});
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }
}

class AddCarSheet extends ConsumerStatefulWidget {
  const AddCarSheet({super.key});

  @override
  ConsumerState<AddCarSheet> createState() => _AddCarSheetState();
}

class _AddCarSheetState extends ConsumerState<AddCarSheet> {
  final _plate = TextEditingController();
  final _make = TextEditingController();
  final _colour = TextEditingController();
  final _nickname = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _plate.dispose();
    _make.dispose();
    _colour.dispose();
    _nickname.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final log = ref.read(activityLogProvider);
    final plate = _plate.text.trim();
    log.tap('save_car');
    if (plate.replaceAll(RegExp(r'[^A-Za-z0-9]'), '').length < 2) {
      setState(() => _error = 'Enter the registration as it is on the car.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final v = await ref
          .read(apiProvider)
          .addVehicle(plate: plate, make: _make.text.trim(), colour: _colour.text.trim(), nickname: _nickname.text.trim());
      ref.invalidate(accountProvider);
      if (!mounted) return;
      Navigator.pop(context);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('${v.display} added. The barriers will know it within a few minutes.')));
    } on ApiError catch (e) {
      log.event('save_car_failed', {'code': e.code});
      setState(() {
        _busy = false;
        _error = e.message;
      });
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Add a car', textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 16),
        TextField(
          key: const Key('plate-field'),
          controller: _plate,
          autofocus: true,
          textCapitalization: TextCapitalization.characters,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[A-Za-z0-9 ]')),
            LengthLimitingTextInputFormatter(10),
            TextInputFormatter.withFunction((o, n) => n.copyWith(text: n.text.toUpperCase())),
          ],
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, letterSpacing: 3, color: MetricBrand.navy),
          decoration: InputDecoration(
            labelText: 'Registration',
            hintText: 'AB12 CDE',
            fillColor: Colors.white,
            prefixIcon: Container(
              width: 22,
              margin: const EdgeInsets.only(left: 8, right: 8, top: 10, bottom: 10),
              decoration: BoxDecoration(color: MetricBrand.navy, borderRadius: BorderRadius.circular(5)),
              alignment: Alignment.center,
              child: Container(
                width: 4,
                height: 18,
                decoration: BoxDecoration(color: MetricBrand.green, borderRadius: BorderRadius.circular(2)),
              ),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: MetricBrand.navy, width: 1.5),
            ),
          ),
          onSubmitted: (_) => _save(),
        ),
        const SizedBox(height: 12),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _make,
                decoration: const InputDecoration(labelText: 'Make (optional)'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: TextField(
                controller: _colour,
                decoration: const InputDecoration(labelText: 'Colour (optional)'),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _nickname,
          decoration: const InputDecoration(labelText: 'Name it (optional), e.g. Work van'),
        ),
        if (_error != null) ...[const SizedBox(height: 12), Text(_error!, style: const TextStyle(color: MetricBrand.red))],
        const SizedBox(height: 16),
        FilledButton(
          key: const Key('save-car'),
          onPressed: _busy ? null : _save,
          child: _busy
              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Text('Add car'),
        ),
      ],
    ),
  );
}

/// "2 of 3 cars" as a pill with a small meter.
class _Allowance extends StatelessWidget {
  const _Allowance({required this.used, required this.max});

  final int used;
  final int max;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(99),
      border: Border.all(color: MetricBrand.line),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var i = 0; i < max; i++)
          Container(
            margin: const EdgeInsets.only(right: 4),
            width: 18,
            height: 6,
            decoration: BoxDecoration(color: i < used ? MetricBrand.navy : MetricBrand.line, borderRadius: BorderRadius.circular(3)),
          ),
        const SizedBox(width: 6),
        Text(
          '$used of $max cars',
          style: const TextStyle(color: MetricBrand.navy, fontWeight: FontWeight.w700, fontSize: 13),
        ),
      ],
    ),
  );
}
