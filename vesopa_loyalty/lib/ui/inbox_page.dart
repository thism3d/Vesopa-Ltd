import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../data/session.dart';
import 'widgets.dart';

/// The venue's news: every notification it sent this member, kept here so a
/// message is not lost because notifications were off — the "in-app" way of
/// reaching a customer, which works on every device with no permission at all.
///
/// CARDS, NOT A LIST OF LINES. A venue that has gone to the trouble of
/// photographing a dish deserves better than a 40×40 thumbnail beside two lines
/// of grey text. An item with a picture shows it; one without stays a compact
/// row, so a venue that only ever sends words does not get a page of empty
/// frames.
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
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (sheet) => _MessageSheet(message: m),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final messages = ref.watch(messagesProvider);
    return messages.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => LoadFailed(error: e, onRetry: () => ref.invalidate(messagesProvider)),
      data: (data) {
        final items = (data['items'] as List? ?? const []).cast<Map<String, dynamic>>();
        if (items.isEmpty) {
          return RefreshIndicator(
            onRefresh: () => ref.refresh(messagesProvider.future),
            child: ListView(
              children: const [
                SizedBox(height: 120),
                Center(
                  child: Text(
                    'No news yet. Offers and news from the venue will appear here.',
                    textAlign: TextAlign.center,
                  ),
                ),
              ],
            ),
          );
        }
        return RefreshIndicator(
          onRefresh: () => ref.refresh(messagesProvider.future),
          child: LayoutBuilder(
            builder: (context, box) {
              // On a wide window the cards go two abreast rather than becoming
              // one absurdly long line of text each.
              final columns = box.maxWidth >= 1100 ? 2 : 1;
              final list = ListView.builder(
                padding: const EdgeInsets.fromLTRB(14, 12, 14, 24),
                itemCount: (items.length / columns).ceil(),
                itemBuilder: (context, row) {
                  final slice = items.skip(row * columns).take(columns).toList();
                  if (columns == 1) {
                    return _NewsCard(message: slice.first, onTap: () => _open(context, ref, slice.first));
                  }
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final m in slice)
                        Expanded(child: _NewsCard(message: m, onTap: () => _open(context, ref, m))),
                      // Keeps a lone card on the last row at column width
                      // instead of letting it stretch across the whole page.
                      if (slice.length < columns) const Expanded(child: SizedBox()),
                    ],
                  );
                },
              );
              return Center(
                child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 1200), child: list),
              );
            },
          ),
        );
      },
    );
  }
}

class _NewsCard extends ConsumerWidget {
  const _NewsCard({required this.message, required this.onTap});

  final Map<String, dynamic> message;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final unread = message['read_at'] == null;
    final api = ref.read(apiProvider);
    final image = (message['image_url'] as String?)?.trim();
    final hasVideo = _videoOf(message) != null;

    return Card(
      margin: const EdgeInsets.all(6),
      clipBehavior: Clip.antiAlias,
      elevation: 0,
      color: unread
          ? theme.colorScheme.primaryContainer.withValues(alpha: 0.28)
          : theme.colorScheme.surfaceContainerHighest.withValues(alpha: 0.4),
      child: InkWell(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (image != null && image.isNotEmpty)
              _Media(url: api.resolve(image), showPlay: hasVideo)
            else if (hasVideo)
              // A video with no picture of its own still needs something to
              // press. A plain grey block with a play mark says "there is a
              // film here" without pretending to be a still from it.
              _MediaPlaceholder(colour: theme.colorScheme.primary),
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      if (unread)
                        Container(
                          width: 8,
                          height: 8,
                          margin: const EdgeInsets.only(right: 8),
                          decoration: BoxDecoration(color: theme.colorScheme.primary, shape: BoxShape.circle),
                        ),
                      Expanded(
                        child: Text(
                          '${message['title'] ?? ''}',
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontWeight: unread ? FontWeight.w800 : FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '${message['body'] ?? ''}',
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 8),
                  Text(when(message['sent_at'], time: false), style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A picture, at a fixed shape so a page of them does not jump about as each
/// one loads at its own size.
class _Media extends StatelessWidget {
  const _Media({required this.url, this.showPlay = false});

  final String url;
  final bool showPlay;

  @override
  Widget build(BuildContext context) => AspectRatio(
    aspectRatio: 16 / 9,
    child: Stack(
      fit: StackFit.expand,
      children: [
        Image.network(
          url,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => Container(color: Theme.of(context).colorScheme.surfaceContainerHighest),
          loadingBuilder: (context, child, progress) => progress == null
              ? child
              : Container(color: Theme.of(context).colorScheme.surfaceContainerHighest),
        ),
        if (showPlay) const _PlayMark(),
      ],
    ),
  );
}

class _MediaPlaceholder extends StatelessWidget {
  const _MediaPlaceholder({required this.colour});

  final Color colour;

  @override
  Widget build(BuildContext context) => AspectRatio(
    aspectRatio: 16 / 9,
    child: Container(
      color: colour.withValues(alpha: 0.12),
      child: const _PlayMark(),
    ),
  );
}

class _PlayMark extends StatelessWidget {
  const _PlayMark();

  @override
  Widget build(BuildContext context) => const Center(
    child: CircleAvatar(
      radius: 26,
      backgroundColor: Colors.black54,
      child: Icon(Icons.play_arrow, color: Colors.white, size: 32),
    ),
  );
}

/// The video on a message, whichever column it arrived in, or null.
String? _videoOf(Map<String, dynamic> m) {
  final embed = (m['video_embed_url'] as String?)?.trim();
  if (embed != null && embed.isNotEmpty) return embed;
  final file = (m['video_url'] as String?)?.trim();
  if (file != null && file.isNotEmpty) return file;
  return null;
}

/// One message, opened.
class _MessageSheet extends ConsumerWidget {
  const _MessageSheet({required this.message});

  final Map<String, dynamic> message;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final api = ref.read(apiProvider);
    final image = (message['image_url'] as String?)?.trim();
    final link = (message['link_url'] as String?)?.trim();
    final video = _videoOf(message);

    return SafeArea(
      child: ConstrainedBox(
        // Tall enough to be worth opening, never the whole screen.
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.86),
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 620),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (image != null && image.isNotEmpty) ...[
                    ClipRRect(
                      borderRadius: BorderRadius.circular(14),
                      child: _Media(url: api.resolve(image)),
                    ),
                    const SizedBox(height: 14),
                  ],
                  Text(
                    '${message['title'] ?? ''}',
                    style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 4),
                  Text(when(message['sent_at']), style: theme.textTheme.bodySmall),
                  const SizedBox(height: 12),
                  Text('${message['body'] ?? ''}', style: theme.textTheme.bodyLarge),
                  if (video != null) ...[
                    const SizedBox(height: 18),
                    /*
                     * THE VIDEO OPENS IN THE DEVICE'S OWN PLAYER, and does so on
                     * every platform rather than playing here on some of them.
                     *
                     * Flutter's video player does not support Windows, and a
                     * venue's Windows app going quiet where the phone plays
                     * would be the sort of difference nobody can explain down a
                     * telephone. The system player also already has the
                     * subtitles, the volume keys and the full-screen button —
                     * none of which this would have had.
                     */
                    FilledButton.icon(
                      onPressed: () => launchUrl(Uri.parse(video), mode: LaunchMode.externalApplication),
                      icon: const Icon(Icons.play_circle_outline),
                      label: const Text('Watch the video'),
                    ),
                  ],
                  if (link != null && link.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    OutlinedButton.icon(
                      onPressed: () => launchUrl(Uri.parse(link), mode: LaunchMode.externalApplication),
                      icon: const Icon(Icons.open_in_new),
                      label: const Text('Find out more'),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
