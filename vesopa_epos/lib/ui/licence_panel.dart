import 'package:flutter/material.dart';

import '../data/licence.dart';

/// The Licence section, the same in every product's settings.
///
/// Four facts, because those are the four questions somebody actually asks:
/// which licence is this, which machine is it on, how long does it run, and is
/// anything about to stop working.
///
/// ONE FILE, FOUR APPS, for the same reason as data/licence.dart: four copies
/// of a panel is four places for the wording to drift, and the wording here is
/// read down a telephone to somebody in a venue.
class LicencePanel extends StatelessWidget {
  const LicencePanel({required this.state, this.onRefresh, super.key});

  /// Null while it is being fetched, or where the server could not answer.
  final LicenceState? state;
  final VoidCallback? onRefresh;

  static String _day(DateTime d) =>
      '${d.day} ${const [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ][d.month - 1]} ${d.year}';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final s = state;

    /*
     * NOT AN ERROR, AND NOT SHOWN AS ONE.
     *
     * A server that could not be asked, or one too old to answer, is the
     * ordinary state of a venue with a flaky line — not a fault to alarm
     * somebody about on a settings page. It says what it knows, which is
     * nothing, and offers to ask again.
     */
    if (s == null) {
      return _Card(
        title: 'Licence',
        children: [
          Text(
            'The back office could not be asked about this licence just now.',
            style: theme.textTheme.bodyMedium,
          ),
          if (onRefresh != null) ...[
            const SizedBox(height: 12),
            OutlinedButton(onPressed: onRefresh, child: const Text('Check again')),
          ],
        ],
      );
    }

    final rows = <Widget>[];

    rows.add(_Row(
      label: 'Licence key',
      // A venue with no key is counted rather than keyed, which is most of them
      // and is not something to apologise for.
      value: s.keyPrefix == null ? 'Not issued' : '${s.keyPrefix}…',
      note: s.keyLabel,
    ));

    rows.add(_Row(
      label: 'Registered device',
      value: s.device ?? 'Not registered to a machine',
    ));

    if (s.hasSubscription) {
      final ends = s.endsAt;
      rows.add(_Row(
        label: 'Subscription',
        value: s.status == 'active'
            ? 'Active'
            : '${s.status![0].toUpperCase()}${s.status!.substring(1)}',
        note: ends == null ? null : 'Ends ${_day(ends)}',
      ));
    } else {
      rows.add(const _Row(
        label: 'Subscription',
        value: 'No limit set for this venue',
      ));
    }

    if (s.limit != null) {
      rows.add(_Row(label: 'Licensed devices', value: '${s.limit}'));
    }

    return _Card(
      title: 'Licence',
      children: [
        ...rows,
        // The warning, and only while there is something to warn about. A
        // renewal notice that is always on screen is a notice nobody reads on
        // the day it matters.
        if (s.lapsing) ...[
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: theme.colorScheme.errorContainer,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              'This subscription has ended. ${s.label} keeps working until '
              '${_day(s.renewBy!)}, then it will stop. Please renew it.',
              style: TextStyle(color: theme.colorScheme.onErrorContainer),
            ),
          ),
        ],
        if (onRefresh != null) ...[
          const SizedBox(height: 14),
          OutlinedButton(onPressed: onRefresh, child: const Text('Check again')),
        ],
      ],
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.title, required this.children});
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Card(
        margin: const EdgeInsets.symmetric(vertical: 8),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 10),
              ...children,
            ],
          ),
        ),
      );
}

class _Row extends StatelessWidget {
  const _Row({required this.label, required this.value, this.note});
  final String label;
  final String value;
  final String? note;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 150,
            child: Text(label, style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.textTheme.bodySmall?.color,
            )),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(value, style: theme.textTheme.bodyMedium),
                if (note != null)
                  Text(note!, style: theme.textTheme.bodySmall),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Shown INSTEAD of the product when its licence has lapsed past its grace.
///
/// It names the venue's product and says what to do. A lock that only says
/// "unavailable" is a support call; this is somebody's till at seven in the
/// morning and the sentence has to be enough to act on without ringing anybody.
class LicenceLockedPage extends StatelessWidget {
  const LicenceLockedPage({required this.state, this.onRetry, super.key});

  final LicenceState state;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${state.label} is locked', style: theme.textTheme.headlineMedium),
                const SizedBox(height: 14),
                Text(
                  'This venue\'s subscription for ${state.label.toLowerCase()} has ended, '
                  'so it can no longer be used.',
                  style: theme.textTheme.bodyLarge,
                ),
                const SizedBox(height: 10),
                Text(
                  'Renew it in the Vesopa back office, or contact Vesopa. '
                  'This screen unlocks itself as soon as the subscription is active again.',
                  style: theme.textTheme.bodyMedium,
                ),
                if (state.endsAt != null) ...[
                  const SizedBox(height: 10),
                  Text(
                    'Ended ${LicencePanel._day(state.endsAt!)}.',
                    style: theme.textTheme.bodySmall,
                  ),
                ],
                if (onRetry != null) ...[
                  const SizedBox(height: 26),
                  FilledButton(onPressed: onRetry, child: const Text('Check again')),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
