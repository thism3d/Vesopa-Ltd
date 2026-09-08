/// Dividing one line of a bill between several people.
///
/// THE FAULT THIS EXISTS FOR
///
/// Three glasses of prosecco rung up together are one line with a quantity of
/// three, and the split screen works in line ids — so the whole line went onto
/// one share and somebody had to pay for all three. The venue put it plainly:
/// "If there is 3 x Prosecco you can't split them off, someone must pay for the
/// 3 glasses if you get what i mean."
///
/// A round of drinks is the most ordinary thing on a bar bill, so this was not
/// an edge case; it was the common case.
///
/// HOW A PORTION IS REPRESENTED
///
/// As a line id with a suffix: `9f3c…#2` is the second of that line's units.
/// Everything downstream of the split screen already speaks in line ids — the
/// engine values a share by them, the share card lists by them, the printed
/// bill filters by them — and inventing a parallel object would have meant
/// teaching all four about it. A suffixed id passes through the parts that do
/// not care and is resolved by the parts that do, all of which resolve it
/// through this file so they cannot disagree about what one is worth.
///
/// The bill itself is never rewritten. A divided line is a *view* of the sale
/// held inside the split screen; the order keeps its `3 × Prosecco` row for the
/// kitchen, for a reprint, and for anybody who abandons the split.
library;

/// What separates a line id from the unit number after it.
///
/// A single character that cannot occur in a UUID, so `baseLineId` can never
/// truncate a real id — the ids the till mints are `crypto.randomUUID()` shaped
/// and hold nothing but hex and hyphens.
const portionMark = '#';

/// The id of unit [index] (1-based) of [lineId].
String portionId(String lineId, int index) => '$lineId$portionMark$index';

/// True when [id] names a unit of a line rather than a whole one.
bool isPortion(String id) => id.contains(portionMark);

/// The line a portion belongs to — or [id] itself when it is a whole line.
///
/// Every caller that looks a line up by id must go through this, or a portion
/// silently matches nothing and is valued at zero.
String baseLineId(String id) {
  final at = id.indexOf(portionMark);
  return at == -1 ? id : id.substring(0, at);
}

/// Which unit of its line a portion is, 1-based; 0 for a whole line.
int portionIndex(String id) {
  final at = id.indexOf(portionMark);
  if (at == -1) return 0;
  return int.tryParse(id.substring(at + 1)) ?? 0;
}

/// What one unit of a line is worth, when the line is divided [count] ways.
///
/// WHERE THE ODD PENNY GOES, AND WHY IT IS SAID OUT LOUD
///
/// £5.00 across three glasses is 166p, 167p and 167p — or it is 167p, 166p and
/// 166p, and the difference is a penny somebody pays. The whole of the
/// remainder is put on the **first** portion: deterministic, so the same glass
/// carries it however the operator drags them about, and the portions add back
/// to the line exactly whichever way they are grouped. A share is therefore
/// never a penny out, and the shares always sum to the bill.
///
/// Rejected: letting whichever share settles last absorb the rounding. The
/// bill's total would then appear to change depending on the order people paid
/// in, which is the one thing a split screen must never do in front of a table.
///
/// Written to hold for a negative [total] as well, because a line carrying a
/// discount larger than its gross is arithmetic this must not surprise: the
/// remainder is whatever the truncation left, of either sign, and it is placed
/// rather than dropped.
int portionValue(int total, int count, int index) {
  if (count <= 1) return total;
  final base = total ~/ count;
  final remainder = total - (base * count);
  return base + (index == 1 ? remainder : 0);
}
