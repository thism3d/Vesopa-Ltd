/// Putting the board on paper.
///
/// The printer key in the header exists for one moment, and it is worth being
/// explicit about which: **the screen is about to stop being usable.** The
/// machine needs restarting, the panel has failed, the venue is closing and the
/// last three orders still have to be cooked. In every one of those the food is
/// already ordered and already paid for, and a screen that cannot hand its
/// contents to a piece of paper leaves somebody copying it onto the back of a
/// docket.
///
/// So this deliberately goes through the **Windows print dialog** rather than
/// driving an ESC/POS printer directly, as the till does. The till knows which
/// printer is plugged into it because a manager set that up; a kitchen screen
/// has no printer of its own, and the one it wants is whichever is nearest —
/// which is a question only the person standing there can answer, and the
/// system dialog is where they are used to answering it.
///
/// Laid out for A4 rather than a receipt roll for the same reason: the printer
/// this reaches is an office printer.
library;

import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:intl/intl.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

import '../data/screen_profile.dart';
import '../data/ticket.dart';


final _clock = DateFormat('HH:mm');
final _stamp = DateFormat('EEE d MMM, HH:mm');

/// Print one ticket, or the whole board.
///
/// Never throws into the caller. Printing is a fallback for a screen that is
/// already in trouble, and a failure here must not take the board down with it
/// — the message goes to a snack bar and the orders stay on screen.
Future<void> printTickets(
  BuildContext context, {
  required List<Ticket> tickets,
  required ScreenProfile profile,
  required String Function(String station) labelFor,
  String? venueName,
  String heading = 'Kitchen board',
}) async {
  if (tickets.isEmpty) {
    _say(context, 'There is nothing on this board to print.');
    return;
  }

  try {
    await Printing.layoutPdf(
      onLayout: (format) => _document(
        format: format,
        tickets: tickets,
        profile: profile,
        labelFor: labelFor,
        venueName: venueName,
        heading: heading,
      ),
      name: heading,
    );
  } catch (e) {
    if (context.mounted) _say(context, 'Could not print: $e');
  }
}

Future<Uint8List> _document({
  required PdfPageFormat format,
  required List<Ticket> tickets,
  required ScreenProfile profile,
  required String Function(String station) labelFor,
  String? venueName,
  required String heading,
}) async {
  // The same face the board is set in, loaded from this app's own assets.
  //
  // Bundled, not fetched: `PdfGoogleFonts` would download these, and the moment
  // somebody reaches for this key is the moment the network is least likely to
  // be there. It also beats the PDF library's built-in Helvetica, which
  // silently drops "£" and every accented character a menu might carry.
  final regular = pw.Font.ttf(
    await rootBundle.load('assets/fonts/OpenSans-Regular.ttf'),
  );
  final bold = pw.Font.ttf(
    await rootBundle.load('assets/fonts/OpenSans-Bold.ttf'),
  );

  final document = pw.Document(
    theme: pw.ThemeData.withFont(base: regular, bold: bold),
  );

  document.addPage(
    pw.MultiPage(
      pageFormat: format,
      margin: const pw.EdgeInsets.all(28),
      header: (_) => pw.Container(
        padding: const pw.EdgeInsets.only(bottom: 10),
        margin: const pw.EdgeInsets.only(bottom: 12),
        decoration: const pw.BoxDecoration(
          border: pw.Border(bottom: pw.BorderSide(width: 0.8)),
        ),
        child: pw.Row(
          mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
          crossAxisAlignment: pw.CrossAxisAlignment.end,
          children: [
            pw.Column(
              crossAxisAlignment: pw.CrossAxisAlignment.start,
              children: [
                pw.Text(
                  heading,
                  style: pw.TextStyle(
                    fontSize: 17,
                    fontWeight: pw.FontWeight.bold,
                  ),
                ),
                pw.Text(
                  [
                    ?venueName,
                    profile.name,
                  ].join(' · '),
                  style: const pw.TextStyle(fontSize: 10.5),
                ),
              ],
            ),
            // When it was printed, because a printed board is a snapshot and
            // one without a time on it is indistinguishable from a current one
            // an hour later.
            pw.Text(
              'Printed ${_stamp.format(DateTime.now())}',
              style: const pw.TextStyle(fontSize: 10),
            ),
          ],
        ),
      ),
      build: (_) => [
        for (final ticket in tickets)
          _ticketBlock(ticket, profile, labelFor),
      ],
    ),
  );

  return document.save();
}

pw.Widget _ticketBlock(
  Ticket ticket,
  ScreenProfile profile,
  String Function(String station) labelFor,
) {
  final lines = ticket.linesFor(profile.stations);

  return pw.Container(
    margin: const pw.EdgeInsets.only(bottom: 14),
    padding: const pw.EdgeInsets.all(10),
    decoration: pw.BoxDecoration(
      border: pw.Border.all(width: 0.7),
      borderRadius: pw.BorderRadius.circular(4),
    ),
    child: pw.Column(
      crossAxisAlignment: pw.CrossAxisAlignment.start,
      children: [
        pw.Row(
          mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
          children: [
            pw.Text(
              ticket.destination,
              style: pw.TextStyle(fontSize: 14, fontWeight: pw.FontWeight.bold),
            ),
            pw.Text(
              ticket.ticketNo == null ? '' : 'Order ${ticket.ticketNo}',
              style: pw.TextStyle(fontSize: 13, fontWeight: pw.FontWeight.bold),
            ),
          ],
        ),
        pw.Row(
          mainAxisAlignment: pw.MainAxisAlignment.spaceBetween,
          children: [
            pw.Text(
              [
                if (ticket.roomName != null) ticket.roomName!,
                _clock.format(ticket.placedAt),
                if (ticket.rushed) 'RUSH',
              ].join(' · '),
              style: const pw.TextStyle(fontSize: 10),
            ),
            pw.Text(
              ticket.staffName ?? '',
              style: const pw.TextStyle(fontSize: 10),
            ),
          ],
        ),
        pw.SizedBox(height: 7),

        for (final line in lines) ...[
          pw.Row(
            crossAxisAlignment: pw.CrossAxisAlignment.start,
            children: [
              pw.SizedBox(
                width: 22,
                child: pw.Text(
                  line.quantityLabel,
                  textAlign: pw.TextAlign.right,
                  style: pw.TextStyle(
                    fontSize: 12,
                    fontWeight: pw.FontWeight.bold,
                  ),
                ),
              ),
              pw.SizedBox(width: 8),
              pw.Expanded(
                child: pw.Text(
                  // Indented under its dish, as on the board and on the
                  // till's own kitchen ticket.
                  line.isModifier ? '   + ${line.name}' : line.name,
                  style: const pw.TextStyle(fontSize: 12),
                ),
              ),
              pw.Text(
                line.stations.map(labelFor).join(', '),
                style: const pw.TextStyle(fontSize: 9),
              ),
            ],
          ),
          // Bold rather than red: this reaches a mono office printer as often
          // as not, and a modifier that disappears into grey is a modifier that
          // gets missed.
          if (line.note != null)
            pw.Padding(
              padding: const pw.EdgeInsets.only(left: 30, bottom: 2),
              child: pw.Text(
                line.note!,
                style: pw.TextStyle(
                  fontSize: 11,
                  fontWeight: pw.FontWeight.bold,
                ),
              ),
            ),
        ],

        if (ticket.note != null) ...[
          pw.SizedBox(height: 5),
          pw.Text(
            'Note: ${ticket.note}',
            style: pw.TextStyle(fontSize: 11, fontWeight: pw.FontWeight.bold),
          ),
        ],
      ],
    ),
  );
}

void _say(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..clearSnackBars()
    ..showSnackBar(SnackBar(content: Text(message)));
}
