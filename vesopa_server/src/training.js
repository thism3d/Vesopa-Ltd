/**
 * Training mode, on the server's side.
 *
 * "Sales made in Training Mode should not be sent to the back office and should
 * not count towards the sales figures on the till."
 *
 * The till does the real work (1.7.3.0 and later): a bill rung up by a training
 * account is marked, kept on that till, left out of its X and Z, and never put
 * in the outbox. This file is the other half -- the server refusing to record
 * one anyway -- because "the till will not send it" is a promise about software
 * that is not always the latest version:
 *
 *   * an older till never heard of training accounts, so `/till/staff` does not
 *     give it any (see `staffFilter`) -- a trainee cannot sign on there at all;
 *   * anything that still arrives marked `training`, or rung up by a training
 *     account, is answered 200 and written nowhere (see `isTrainingSale`).
 *
 * 200 and not an error, on purpose. The till's outbox retries anything that is
 * not a success, so refusing a training sale would have a till retry it for
 * ever and report a sync fault that is not one.
 */

/** The answer to a training sale: taken, and recorded nowhere. */
const IGNORED = Object.freeze({ status: 'ignored', reason: 'training' });

/** Said to a till that asks to move money in training. */
const REFUSED =
  'Training mode: no gift card, deposit, voucher or points were used.';

/**
 * Whether this till understands training accounts.
 *
 * Asked by the till, not guessed from a version string: `/till/staff?features=
 * training`. A till that does not say so is given no training accounts, because
 * on it a trainee's sales would be real.
 */
function tillUnderstandsTraining(req) {
  const asked = String((req.query && req.query.features) || '');
  return asked.split(',').map((s) => s.trim()).includes('training');
}

/**
 * Whether a member of staff is a training account.
 *
 * A missing column (a server whose migration has not run) means nobody is, which
 * is exactly true: there is nowhere yet to have marked anybody.
 */
async function isTrainingStaff(db, office, staffId) {
  const id = Number(staffId);
  if (!office || !Number.isInteger(id) || id <= 0) return false;
  try {
    const [[row]] = await db.query(
      'SELECT training FROM bo_clarks WHERE id = ? AND email = ?',
      [id, office]
    );
    return !!(row && Number(row.training) === 1);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') return false;
    throw e;
  }
}

/** The same question, for the routes that carry a PIN rather than an id. */
async function isTrainingPin(db, office, pin) {
  if (!office || !pin) return false;
  try {
    const [[row]] = await db.query(
      'SELECT training FROM bo_clarks WHERE email = ? AND pin_code = ? LIMIT 1',
      [office, String(pin)]
    );
    return !!(row && Number(row.training) === 1);
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') return false;
    throw e;
  }
}

/**
 * Whether a sale, a void or a bill is a training one.
 *
 * Either the till said so, or it was rung up by a training account -- the
 * second catches a till that marks nothing, which is the whole reason for a
 * server-side check.
 */
async function isTrainingSale(db, office, body) {
  if (!body) return false;
  if (body.training === true || body.training === 1) return true;
  if (await isTrainingStaff(db, office, body.staff_id)) return true;
  if (await isTrainingPin(db, office, body.clerk_pin)) return true;
  return false;
}

module.exports = {
  IGNORED,
  REFUSED,
  tillUnderstandsTraining,
  isTrainingStaff,
  isTrainingPin,
  isTrainingSale,
};
