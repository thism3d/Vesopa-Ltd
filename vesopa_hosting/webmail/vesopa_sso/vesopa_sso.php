<?php

/**
 * Vesopa Cloud — open your own inbox without typing a second password.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A customer clicks a mailbox in the panel they are already signed into and
 * expects to be reading it a second later. Proving who you are twice in ten
 * seconds is exactly the friction the panel exists to remove — and a second
 * password is one people write down, reuse, or lose.
 *
 * The panel used to solve this by keeping a sealed copy of the mailbox password
 * and replaying it into Roundcube's login form. That worked only for mailboxes
 * whose owner had opted in and typed the password into our form, which in
 * practice was almost none of them, and it meant holding a credential we had no
 * business holding.
 *
 * This replaces it. Nothing anywhere stores a customer's mailbox password.
 *
 * ---------------------------------------------------------------------------
 * HOW IT WORKS
 * ---------------------------------------------------------------------------
 * 1. The panel signs a short-lived, single-use link and redirects the browser.
 * 2. This plugin verifies the signature and spends the nonce.
 * 3. It logs the mailbox in using Dovecot MASTER USER authentication: SASL
 *    PLAIN carries the mailbox as the authorization identity and a dedicated
 *    master account as the authentication identity. Dovecot opens the mailbox
 *    without its password ever being involved.
 *
 * Roundcube supports step 3 through its own `storage_init` hook — `auth_cid`
 * and `auth_pw` are proxy-authentication options it already understands (see
 * rcube::storage_init and the PLAIN branch of rcube_imap_generic::authenticate).
 * Nothing here patches Roundcube.
 *
 * ---------------------------------------------------------------------------
 * THE SIGNATURE, AND WHY IT IS NOT THE ONE phpMyAdmin USES
 * ---------------------------------------------------------------------------
 * Hestia's phpMyAdmin handoff binds its token to the visitor's IP address as
 * the node's PHP computes it — which depends on how the app is fronted, cannot
 * be known from the panel, and has its own configuration setting for guessing.
 * Get it wrong and every customer lands on a login form.
 *
 * This binds to a NONCE instead, spent on first use. That is strictly stronger
 * — a captured link cannot be replayed even from the same address — and it has
 * no guesswork in it. HMAC-SHA256 rather than bcrypt, because both ends compute
 * it identically, it is constant-time comparable, and it is URL-safe with no
 * 72-byte truncation to reason about.
 *
 *     signature = HMAC-SHA256(key, "<address>\n<expiry>\n<nonce>")
 *
 * A link is dead sixty seconds after it is minted and dead permanently once it
 * has been followed once.
 *
 * ---------------------------------------------------------------------------
 * FAILING CLOSED
 * ---------------------------------------------------------------------------
 * Every refusal below falls through to Roundcube's ordinary login page. A bad
 * signature, a spent nonce, an expired link or an unconfigured plugin all end
 * with the customer typing their password, which is exactly where they were
 * before this file existed. Nothing here can leave somebody logged into the
 * wrong mailbox, and nothing here can leave the login page unreachable.
 */
class vesopa_sso extends rcube_plugin
{
    /** Every task: the handoff can arrive at any URL, and logout must clear up. */
    public $task = '.*';

    /** How long a nonce record is kept before it is pruned. */
    private const NONCE_TTL = 900;

    public function init()
    {
        $this->load_config();

        $this->add_hook('startup', [$this, 'on_startup']);
        $this->add_hook('storage_init', [$this, 'on_storage_init']);
        $this->add_hook('logout_after', [$this, 'on_logout']);
    }

    /**
     * Arm proxy authentication for an SSO session, on EVERY request.
     *
     * Not just at login. Roundcube reconnects to IMAP on each request using
     * the username and password in the session, and an SSO session has no real
     * password in it — so without this the first page after signing in would
     * work and the second would throw the customer back to the login form.
     */
    public function on_storage_init($args)
    {
        if (empty($_SESSION['vesopa_sso'])) {
            return $args;
        }

        $rcmail = rcmail::get_instance();
        $user = $rcmail->config->get('vesopa_sso_master_user');
        $pass = $rcmail->config->get('vesopa_sso_master_pass');

        if ($user && $pass) {
            // PLAIN is the only mechanism that carries an authorization
            // identity separate from the authentication one, which is the
            // whole mechanism. Naming it explicitly stops Roundcube's
            // capability sniffing from choosing something else.
            $args['auth_type'] = 'PLAIN';
            $args['auth_cid'] = $user;
            $args['auth_pw'] = $pass;
        }

        return $args;
    }

    /**
     * A signed link arriving at any URL.
     *
     * ---------------------------------------------------------------------
     * IT HAS TO BE ABLE TO SWITCH MAILBOXES, and the first version could not.
     * ---------------------------------------------------------------------
     * It returned early whenever a session already existed, on the reasoning
     * that an SSO link should not be a way to hop between mailboxes mid-session.
     * That is the right instinct about a link from a stranger and the wrong
     * answer for this product: a customer with four mailboxes clicks "Open
     * inbox" on the second one and the panel hands over a link for it. The old
     * code saw a live session, did nothing, and Roundcube showed them the FIRST
     * mailbox again — with no error, because as far as everything involved was
     * concerned nothing had gone wrong. Signing out and clicking again worked,
     * which is exactly the workaround somebody reports as a bug.
     *
     * So a verified link for a different mailbox now replaces the session. The
     * ORDER MATTERS AND IS THE SECURITY-RELEVANT PART: the signature, the
     * expiry and the nonce are all checked BEFORE anything touches the session.
     * A forged or replayed link must not be able to sign somebody out — that
     * would turn an unauthenticated request into a denial of service against a
     * live session.
     */
    public function on_startup($args)
    {
        $sig = rcube_utils::get_input_string('vs', rcube_utils::INPUT_GET);
        if (!$sig) {
            return $args;
        }

        $rcmail = rcmail::get_instance();
        $key = (string) $rcmail->config->get('vesopa_sso_key');
        $master = (string) $rcmail->config->get('vesopa_sso_master_user');
        $mpass = (string) $rcmail->config->get('vesopa_sso_master_pass');

        if ($key === '' || $master === '' || $mpass === '') {
            $this->refuse('not configured');
            return $args;
        }

        $address = (string) rcube_utils::get_input_string('vu', rcube_utils::INPUT_GET);
        $expiry = (string) rcube_utils::get_input_string('ve', rcube_utils::INPUT_GET);
        $nonce = (string) rcube_utils::get_input_string('vn', rcube_utils::INPUT_GET);

        if (!preg_match('/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i', $address)
            || !preg_match('/^[0-9]{1,12}$/', $expiry)
            || !preg_match('/^[a-f0-9]{24,64}$/', $nonce)
        ) {
            $this->refuse('malformed link');
            return $args;
        }

        $now = time();
        // A future expiry far beyond what the panel mints means somebody is
        // handing us a link they made up rather than one we signed.
        if ((int) $expiry <= $now || (int) $expiry > $now + 300) {
            $this->refuse('expired link');
            return $args;
        }

        $expected = hash_hmac('sha256', $address . "\n" . $expiry . "\n" . $nonce, $key);
        if (!hash_equals($expected, strtolower($sig))) {
            $this->refuse('bad signature');
            return $args;
        }

        // ---- verified from here on; only now may the session be touched ----

        /*
         * Already in the mailbox being asked for. Spend the nonce anyway — the
         * link has been used — and send them to the inbox rather than leaving
         * them on whatever URL the link happened to land on.
         */
        if (!empty($_SESSION['user_id']) && !empty($_SESSION['username'])
            && strcasecmp($_SESSION['username'], $address) === 0
        ) {
            $this->spend_nonce($nonce);
            rcube::write_log('vesopa_sso', 'already in ' . $address);
            $rcmail->output->redirect(['_task' => 'mail'], 0, true);
            return $args;
        }

        if (!$this->spend_nonce($nonce)) {
            $this->refuse('link already used');
            return $args;
        }

        /*
         * A different mailbox: end the old session before starting the new one.
         *
         * kill_session() rather than logout_actions() — the latter runs the
         * user's "empty trash on logout" and "expunge on logout" preferences,
         * and silently deleting somebody's mail because they clicked a link for
         * a different inbox would be an appalling thing to do.
         */
        if (!empty($_SESSION['user_id'])) {
            rcube::write_log('vesopa_sso', 'switching from '
                . (isset($_SESSION['username']) ? $_SESSION['username'] : '?') . ' to ' . $address);
            $rcmail->kill_session();
        }

        /*
         * The order matters: the session flag has to be set BEFORE login(),
         * because login() connects to storage and that is what fires the
         * storage_init hook above. Set it after and the login authenticates
         * as the mailbox with a password that is not its own, and fails.
         */
        $_SESSION['vesopa_sso'] = true;

        /*
         * A throwaway password, deliberately not the master one. Roundcube
         * keeps whatever is passed here in the session (encrypted) for the
         * reconnects that proxy auth now handles instead, so putting the real
         * master password there would scatter it through every session store
         * on the box for no gain. Random rather than empty because
         * login_input_checks() has opinions about empty.
         */
        $throwaway = bin2hex(random_bytes(12));

        $host = $rcmail->config->get('vesopa_sso_host') ?: $rcmail->config->get('imap_host');
        if (is_array($host)) {
            $host = key($host) ?: reset($host);
        }

        if (!$rcmail->login($address, $throwaway, $host, false)) {
            unset($_SESSION['vesopa_sso']);
            $this->refuse('imap refused ' . $address);
            return $args;
        }

        // The same sequence Roundcube's own login action performs.
        $rcmail->session->remove('temp');
        $rcmail->session->regenerate_id(false);
        $rcmail->session->set_auth_cookie();
        $rcmail->log_login();

        rcube::write_log('vesopa_sso', 'signed in ' . $address);

        $rcmail->output->redirect(['_task' => 'mail'], 0, true);

        return $args;
    }

    /** An SSO session ends completely; the flag must not outlive it. */
    public function on_logout($args)
    {
        unset($_SESSION['vesopa_sso']);
        return $args;
    }

    /**
     * Spend a nonce, or refuse.
     *
     * O_EXCL on a file in a directory only this process writes to is the whole
     * mechanism: the create succeeds exactly once, so the second visitor to the
     * same link loses the race and is refused. No database, no lock file, and
     * nothing to clean up by hand — old records are pruned in passing.
     */
    private function spend_nonce($nonce)
    {
        $rcmail = rcmail::get_instance();
        $dir = rtrim($rcmail->config->get('temp_dir', '/tmp'), '/') . '/vesopa-sso';

        if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
            return false;
        }

        $this->prune($dir);

        $path = $dir . '/' . $nonce;
        $handle = @fopen($path, 'x');
        if ($handle === false) {
            return false;
        }
        fclose($handle);

        return true;
    }

    private function prune($dir)
    {
        // Cheap and occasional. A directory of one-byte files is not worth a
        // cron entry, and doing it on every request would be a stat storm.
        if (random_int(1, 20) !== 1) {
            return;
        }
        $cutoff = time() - self::NONCE_TTL;
        foreach ((array) @scandir($dir) as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $path = $dir . '/' . $name;
            if (@filemtime($path) < $cutoff) {
                @unlink($path);
            }
        }
    }

    /**
     * Say why, in the log, and nothing at all to the browser.
     *
     * The visitor gets the ordinary login page. Telling them which check failed
     * would help somebody probing the endpoint and helps a real customer not at
     * all — they are already looking at the form they need.
     */
    private function refuse($why)
    {
        rcube::write_log('vesopa_sso', 'refused: ' . $why);
    }
}
