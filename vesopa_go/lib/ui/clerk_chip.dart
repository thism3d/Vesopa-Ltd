/// Who is signed on, at the top right as the till shows it: their photo (back
/// office, Staff > Photo; initials until there is one) and name. Tapping it
/// offers what the till's name key does: hand the device to someone else with
/// their PIN, or sign off.
library;

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/clerk_auth.dart';
import '../data/models.dart';
import '../data/session.dart';
import 'product_photo.dart' show photoUrl;
import 'theme.dart';

const _avatarColours = [0xFFA5C715, 0xFF4BA3F5, 0xFFF5B301, 0xFF3FBBD6, 0xFFF4633A, 0xFFC2569B, 0xFF2E9E5B, 0xFFBB6BD9];

String initialsOf(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  return (parts.first[0] + (parts.length > 1 ? parts.last[0] : '')).toUpperCase();
}

/// A member of staff's face: their photo, else their initials on their colour.
class StaffAvatar extends ConsumerWidget {
  const StaffAvatar({super.key, required this.clerk, this.radius = 16});
  final Clerk clerk;
  final double radius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final url = ref.watch(tapProvider.select((s) => s.config.staffPhotos['${clerk.id}']));
    final initials = Text(initialsOf(clerk.name), style: TextStyle(fontSize: radius * 0.8, fontWeight: FontWeight.w800, color: Tp.onLime));
    final colour = Color(_avatarColours[clerk.id.abs() % _avatarColours.length]);
    if (url == null || url.isEmpty) return CircleAvatar(radius: radius, backgroundColor: colour, child: initials);
    return CircleAvatar(
      radius: radius,
      backgroundColor: colour,
      foregroundImage: CachedNetworkImageProvider(photoUrl(url)),
      child: initials,
    );
  }
}

class ClerkChip extends ConsumerWidget {
  const ClerkChip({super.key});

  Future<void> _handOver(BuildContext context, WidgetRef ref) async {
    final pin = await showDialog<String>(
      context: context,
      builder: (c) {
        final ctl = TextEditingController();
        return AlertDialog(
          title: const Text('Sign on'),
          content: TextField(
            controller: ctl,
            autofocus: true,
            obscureText: true,
            keyboardType: TextInputType.number,
            maxLength: 6,
            onSubmitted: (v) => Navigator.pop(c, v.trim()),
            decoration: const InputDecoration(labelText: 'Your PIN', counterText: ''),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(c), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text('Sign on')),
          ],
        );
      },
    );
    if (pin == null || pin.isEmpty || !context.mounted) return;
    final clerk = ClerkAuth.byPin(ref.read(tapProvider).staff, pin);
    if (clerk == null) {
      HapticFeedback.heavyImpact();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('That PIN is not on this venue\'s staff list')));
      return;
    }
    ref.read(tapProvider.notifier).signOn(clerk);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final clerk = ref.watch(tapProvider.select((s) => s.clerk));
    if (clerk == null) return const SizedBox.shrink();
    final wide = MediaQuery.sizeOf(context).width >= 600;
    return PopupMenuButton<String>(
      tooltip: clerk.name,
      position: PopupMenuPosition.under,
      onSelected: (v) => v == 'off' ? ref.read(tapProvider.notifier).lock() : _handOver(context, ref),
      itemBuilder: (_) => [
        PopupMenuItem(
          enabled: false,
          child: ListTile(
            leading: StaffAvatar(clerk: clerk),
            title: Text(clerk.name, style: const TextStyle(fontWeight: FontWeight.w700)),
            subtitle: (clerk.group ?? '').isEmpty ? null : Text(clerk.group!),
          ),
        ),
        const PopupMenuDivider(),
        const PopupMenuItem(value: 'on', child: ListTile(leading: Icon(Icons.swap_horiz_rounded), title: Text('Sign on someone else'))),
        const PopupMenuItem(value: 'off', child: ListTile(leading: Icon(Icons.logout_rounded), title: Text('Sign off'))),
      ],
      // Less on the bar (owner, 2026-10-28): the face on a phone, the face
      // and first name on a tablet; the whole name is in the menu.
      child: AnimatedSwitcher(
        duration: const Duration(milliseconds: 250),
        child: Container(
          key: ValueKey(clerk.id),
          padding: EdgeInsets.fromLTRB(3, 3, wide ? 12 : 3, 3),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(999), border: Border.all(color: Tp.inkLine), color: Tp.inkCard),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            StaffAvatar(clerk: clerk, radius: 15),
            if (wide) ...[
              const SizedBox(width: 8),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 120),
                child: Text(clerk.name.split(' ').first, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14)),
              ),
            ],
          ]),
        ),
      ),
    );
  }
}
