import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/session.dart';
import 'widgets.dart';

/// The venue's news: every notification it sent this member, kept here so a
/// message is not lost because notifications were off -- the "in-app" way of
/// reaching a customer, which works on every device with no permission at all.
class InboxPage extends ConsumerWidget {
  const InboxPage({super.key});

  Future<void> _open(BuildContext context, WidgetRef ref, Map<String, dynamic> m) async {
    if (m['read_at'] == null) {
      try {
        await ref.read(apiProvider).markRead('${m['id']}');
        ref.invalidate(messagesProvider);
      } catch (_) {
        // Still shown; marked next time.
      }
    }
    if (!context.mounted) return;
    final theme = Theme.of(context);
    final image = m['image_url'] as String?;
    final link = m['link_url'] as String?;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (image != null && image.isNotEmpty) ...[
                ClipRRect(
                  borderRadius: BorderRadius.circular(14),
                  child: Image.network(ref.read(apiProvider).resolve(image), fit: BoxFit.cover, errorBuilder: (_, _, _) => const SizedBox()),
                ),
                const SizedBox(height: 14),
              ],
              Text('${m['title'] ?? ''}', style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              Text(when(m['sent_at']), style: theme.textTheme.bodySmall),
              const SizedBox(height: 12),
              Text('${m['body'] ?? ''}', style: theme.textTheme.bodyLarge),
              if (link != null && link.isNotEmpty) ...[
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: () => launchUrl(Uri.parse(link), mode: LaunchMode.externalApplication),
                  icon: const Icon(Icons.open_in_new),
                  label: const Text('Find out more'),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messages = ref.watch(messagesProvider);
    final theme = Theme.of(context);
    return messages.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => LoadFailed(error: e, onRetry: () => ref.invalidate(messagesProvider)),
      data: (data) {
        final items = (data['items'] as List? ?? const []).cast<Map<String, dynamic>>();
        return RefreshIndicator(
          onRefresh: () => ref.refresh(messagesProvider.future),
          child: items.isEmpty
              ? ListView(
                  children: const [
                    SizedBox(height: 120),
                    Center(child: Text('No news yet. Offers and news from the venue will appear here.', textAlign: TextAlign.center)),
                  ],
                )
              : ListView.separated(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  itemCount: items.length,
                  separatorBuilder: (_, _) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final m = items[i];
                    final unread = m['read_at'] == null;
                    return ListTile(
                      onTap: () => _open(context, ref, m),
                      leading: Icon(unread ? Icons.mark_email_unread : Icons.drafts_outlined, color: unread ? theme.colorScheme.primary : null),
                      title: Text(
                        '${m['title'] ?? ''}',
                        style: TextStyle(fontWeight: unread ? FontWeight.w800 : FontWeight.w500),
                      ),
                      subtitle: Text('${m['body'] ?? ''}', maxLines: 2, overflow: TextOverflow.ellipsis),
                      trailing: Text(when(m['sent_at'], time: false), style: theme.textTheme.bodySmall),
                    );
                  },
                ),
        );
      },
    );
  }
}
