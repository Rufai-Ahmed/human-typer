// Footer year
document.getElementById('year').textContent = new Date().getFullYear();

// --- Hero typing demo (cheap, single line, loops gently) ---
(() => {
    const el = document.getElementById('type-demo');
    if (!el) return;
    const phrases = [
        "Dear team, thanks for the quick turnaround on this...",
        "Hi! Just following up on my application for the role.",
        "Once upon a time, in a repo far, far away...",
        "Meeting notes: shipped the build, fixed the lag, next up...",
    ];
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = phrases[0];
        return;
    }
    let pi = 0, ci = 0, deleting = false;

    function tick() {
        const full = phrases[pi];
        if (!deleting) {
            ci++;
            if (ci > full.length) { deleting = true; setTimeout(tick, 1400); return; }
        } else {
            ci--;
            if (ci === 0) { deleting = false; pi = (pi + 1) % phrases.length; }
        }
        el.textContent = full.slice(0, ci);
        const base = deleting ? 28 : 70;
        setTimeout(tick, base + Math.random() * 80);
    }
    tick();
})();

// --- Checkout: Flutterwave in naira, Bachs in USD for crypto buyers ---
(() => {
    // Per-seat prices for DISPLAY are defined per-card below; the server
    // (api/checkout.js) recomputes the real amount and api/claim.js grades it.
    const naira = (kobo) => '₦' + Math.round(kobo / 100).toLocaleString('en-NG');
    const nairaFromN = (n) => '₦' + Number(n).toLocaleString('en-NG');
    const usd = (cents) => '$' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
    const isMonthlyPlan = (plan) => plan === 'monthly' || plan === 'ai_monthly';
    const msgIdFor = (plan) => plan === 'monthly' ? 'buy-msg-monthly'
        : plan === 'ai_monthly' ? 'buy-msg-ai-monthly' : 'buy-msg-ai-lifetime';
    // Umami funnel events; never let analytics break checkout.
    const track = (name, data) => { try { if (window.umami) window.umami.track(name, data); } catch (e) {} };

    function makeShowMsg(msgEl) {
        return (text, isError) => {
            if (!msgEl) return;
            msgEl.textContent = text;
            msgEl.classList.remove('hidden');
            msgEl.classList.toggle('error', !!isError);
        };
    }

    function setActive(group, match) {
        if (!group) return;
        group.querySelectorAll('button').forEach((b) => {
            const on = match(b);
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }

    // One pending transfer at a time; starting a new checkout replaces it.
    let activeRun = { stop: null, panel: null };
    function clearActiveRun() {
        if (activeRun.stop) { clearInterval(activeRun.stop.poll); clearInterval(activeRun.stop.tick); }
        if (activeRun.panel) activeRun.panel.remove();
        activeRun = { stop: null, panel: null };
    }

    function successText({ isMonthly, email, count, seats }) {
        if (isMonthly) {
            return 'Done! Your monthly pass key was emailed to ' + email
                + '. Check your inbox (and spam), download below, and paste it into the app. '
                + 'Pay again anytime with this email to extend, no new key needed.';
        }
        const n = count || seats;
        return 'Done! Your ' + n + ' license ' + (n === 1 ? 'key was' : 'keys were')
            + ' emailed to ' + email + '. Check your inbox (and spam), then download below and paste '
            + (n === 1 ? 'it' : 'each one') + ' into the app.';
    }

    // Start a payment. Crypto and the hosted Flutterwave page both redirect away
    // and finish in the return handler at the bottom; the bank-transfer fallback
    // shows account details here and polls until the transfer lands or expires.
    function runCheckout({ email, plan, seats, method, showMsg, msgEl }) {
        const isMonthly = isMonthlyPlan(plan);
        clearActiveRun();
        showMsg(method === 'crypto'
            ? 'Opening the crypto checkout…'
            : 'Preparing your payment details…', false);
        fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, plan, seats, method }),
        }).then((r) => r.json()).then((d) => {
            if (!d || !d.ok) {
                showMsg((d && d.error) || 'Could not start the payment. Please try again.', true);
                return;
            }
            track('checkout-started', {
                plan,
                mode: d.mode === 'bachs' ? 'crypto' : d.mode === 'hosted' ? 'hosted' : 'transfer',
            });
            if (d.mode === 'bachs' && d.link) {
                // Bachs hosted checkout (crypto or USD card). It sends the buyer
                // back here with ?checkout_id=… when done.
                try {
                    sessionStorage.setItem('ht-pending', JSON.stringify(
                        { email, plan, seats, reference: d.reference, checkout_id: d.checkout_id }));
                } catch (e) { /* private mode: return flow degrades gracefully */ }
                showMsg('Taking you to the secure Bachs checkout to pay ' + d.amount + ' ' + d.currency + '…', false);
                window.location.href = d.link;
                return;
            }
            if (d.mode === 'hosted' && d.link) {
                // Flutterwave's hosted page (card / transfer / USSD); it sends
                // the buyer back here with ?status=...&tx_ref=... when done.
                try {
                    sessionStorage.setItem('ht-pending',
                        JSON.stringify({ email, plan, seats, reference: d.reference }));
                } catch (e) { /* private mode: return flow degrades gracefully */ }
                showMsg('Taking you to the secure Flutterwave checkout…', false);
                window.location.href = d.link;
                return;
            }
            showMsg('Transfer the exact amount below. Your key ships the moment it lands.', false);

            const panel = document.createElement('div');
            panel.className = 'transfer-panel';
            panel.innerHTML =
                '<div class="tp-row tp-amount-row"><span class="tp-label">Send exactly</span>' +
                '<span class="tp-amount">' + nairaFromN(d.amount) + '</span></div>' +
                '<div class="tp-row"><span class="tp-label">Bank</span>' +
                '<span class="tp-value">' + (d.bank_name || '—') + '</span></div>' +
                '<div class="tp-row"><span class="tp-label">Account</span>' +
                '<span class="tp-value tp-account">' + d.account_number + '</span>' +
                '<button type="button" class="tp-copy">Copy</button></div>' +
                '<div class="tp-row"><span class="tp-label">Name</span>' +
                '<span class="tp-value">Human Typer</span></div>' +
                '<div class="tp-status"><span class="dot"></span> Waiting for your transfer… ' +
                '<span class="tp-timer"></span></div>' +
                '<p class="tp-hint">Use your banking app. This account is for this payment only. ' +
                'Keep this page open; it updates by itself. Ref: <span class="tp-ref">' + d.reference + '</span></p>';
            msgEl.insertAdjacentElement('afterend', panel);

            panel.querySelector('.tp-copy').addEventListener('click', () => {
                const btn = panel.querySelector('.tp-copy');
                const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(d.account_number).then(done).catch(done);
                } else { done(); }
            });

            const statusEl = panel.querySelector('.tp-status');
            const timerEl = panel.querySelector('.tp-timer');
            const expiresAt = d.expires_at ? new Date(d.expires_at).getTime() : Date.now() + 3600000;

            const tick = setInterval(() => {
                const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
                const m = Math.floor(left / 60), s = left % 60;
                timerEl.textContent = '(' + m + ':' + String(s).padStart(2, '0') + ' left)';
                if (left <= 0) {
                    clearActiveRun();
                    showMsg('That account expired before a transfer arrived. No money moved; press Buy to get a fresh one.', true);
                }
            }, 1000);

            const poll = setInterval(() => {
                fetch('/api/claim', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reference: d.reference }),
                }).then((r) => r.json()).then((c) => {
                    if (c && c.ok && c.status === 'key_sent') {
                        clearActiveRun();
                        track('payment-completed', { plan: isMonthly ? 'monthly' : 'lifetime' });
                        showMsg(successText({ isMonthly, email, count: c.count, seats }), false);
                    } else if (c && c.status === 'already_processed') {
                        clearActiveRun();
                        showMsg(isMonthly
                            ? 'Your monthly pass was already emailed to ' + email + '. Check your inbox and spam folder.'
                            : 'Your key was already emailed to ' + email + '. Check your inbox and spam folder.', false);
                    } else if (c && (c.status === 'out_of_keys' || c.status === 'unrecognized_amount')) {
                        clearActiveRun();
                        showMsg('Payment received (ref: ' + d.reference + '). Your key needs a manual touch; '
                            + 'it will be emailed shortly. Questions? me@rufaiahmed.com with that reference.', false);
                    } else if (statusEl) {
                        statusEl.classList.add('tp-live');
                    }
                }).catch(() => {});
            }, 6000);

            activeRun = { stop: { poll, tick }, panel };
        }).catch(() => {
            showMsg('Could not reach the server. Check your connection and try again.', true);
        });
    }

    // ---- AI Lifetime card (single + team seats) ----
    (() => {
        const btn = document.getElementById('btn-buy-ai-lifetime');
        const emailInput = document.getElementById('buyer-email-ai-lifetime');
        const seatOptions = document.getElementById('seat-options-ai');
        const priceAmount = document.getElementById('price-amount-ai-lifetime');
        if (!btn) return;
        const msgEl = document.getElementById('buy-msg-ai-lifetime');
        const showMsg = makeShowMsg(msgEl);
        const cryptoBtn = document.getElementById('btn-crypto-ai-lifetime');
        const usdLabel = document.getElementById('usd-ai-lifetime');
        // Per-seat AI Lifetime price in kobo; MUST match PER_SEAT_AI_NAIRA in api/checkout.js.
        const PER_SEAT_AI_KOBO = { 1: 1500000, 5: 1200000, 10: 1050000, 25: 900000 };
        // Per-seat AI Lifetime price in US cents; MUST match usdTables() in api/_bachs.js.
        const PER_SEAT_AI_USD = { 1: 1900, 5: 1600, 10: 1400, 25: 1200 };
        let seats = 1;

        function refresh() {
            const total = PER_SEAT_AI_KOBO[seats] * seats;
            if (priceAmount) {
                const tail = seats === 1 ? ' once' : ' for ' + seats + ' seats';
                priceAmount.innerHTML = naira(total) + '<span class="price-once">' + tail + '</span>';
            }
            btn.textContent = seats === 1
                ? 'Buy AI Lifetime for ' + naira(total)
                : 'Buy ' + seats + ' AI seats for ' + naira(total);
            if (usdLabel) usdLabel.textContent = usd(PER_SEAT_AI_USD[seats] * seats);
        }

        if (seatOptions) {
            seatOptions.addEventListener('click', (e) => {
                const opt = e.target.closest('.seat-opt');
                if (!opt || !seatOptions.contains(opt)) return;
                const n = parseInt(opt.getAttribute('data-seats'), 10);
                if (!PER_SEAT_AI_KOBO[n]) return;
                seats = n;
                setActive(seatOptions, (b) => b === opt);
                refresh();
            });
        }
        refresh();

        const buy = (method) => {
            track('buy-clicked', { plan: 'ai_lifetime', seats, method: method || 'naira' });
            const email = (emailInput.value || '').trim();
            if (!validEmail(email)) {
                showMsg('Please enter a valid email. That is where your key is sent.', true);
                emailInput.focus();
                return;
            }
            runCheckout({ email, plan: 'ai_lifetime', seats, method, showMsg, msgEl });
        };
        btn.addEventListener('click', () => buy(null));
        if (cryptoBtn) cryptoBtn.addEventListener('click', () => buy('crypto'));
    })();

    // ---- AI Monthly + Monthly cards (single email + buy, no seats) ----
    [
        { btn: 'btn-buy-ai-monthly', crypto: 'btn-crypto-ai-monthly', email: 'buyer-email-ai-monthly', msg: 'buy-msg-ai-monthly', plan: 'ai_monthly' },
        { btn: 'btn-buy-monthly', crypto: 'btn-crypto-monthly', email: 'buyer-email-monthly', msg: 'buy-msg-monthly', plan: 'monthly' },
    ].forEach((c) => {
        const btn = document.getElementById(c.btn);
        const emailInput = document.getElementById(c.email);
        if (!btn) return;
        const msgEl = document.getElementById(c.msg);
        const showMsg = makeShowMsg(msgEl);
        const buy = (method) => {
            track('buy-clicked', { plan: c.plan, method: method || 'naira' });
            const email = (emailInput.value || '').trim();
            if (!validEmail(email)) {
                showMsg('Please enter a valid email. That is where your key is sent.', true);
                emailInput.focus();
                return;
            }
            runCheckout({ email, plan: c.plan, seats: 1, method, showMsg, msgEl });
        };
        btn.addEventListener('click', () => buy(null));
        const cryptoBtn = document.getElementById(c.crypto);
        if (cryptoBtn) cryptoBtn.addEventListener('click', () => buy('crypto'));
    });

    // ---- Return from a hosted checkout: Flutterwave (?status=…&tx_ref=…) or
    //      Bachs (?checkout_id=…) ----
    (() => {
        const params = new URLSearchParams(window.location.search);
        const txRef = params.get('tx_ref');
        const checkoutId = params.get('checkout_id');
        if (!txRef && !checkoutId) return;
        const status = (params.get('status') || '').toLowerCase();
        history.replaceState(null, '', window.location.pathname + '#pricing');

        let ctx = {};
        try { ctx = JSON.parse(sessionStorage.getItem('ht-pending') || '{}'); } catch (e) {}
        const isMonthly = isMonthlyPlan(ctx.plan);
        const email = ctx.email || 'your email';
        const seats = ctx.seats || 1;
        // What to show in the "needs a manual touch" message: our own reference
        // when we still have it, else whatever the provider sent us back with.
        const ref = txRef || ctx.reference || checkoutId;
        const msgEl = document.getElementById(msgIdFor(ctx.plan));
        const showMsg = makeShowMsg(msgEl);
        const pricing = document.getElementById('pricing');
        if (pricing) pricing.scrollIntoView();

        if (status && status !== 'successful' && status !== 'completed') {
            showMsg('The payment was ' + status + '. Nothing was charged; try again whenever you are ready.', true);
            return;
        }
        showMsg(isMonthly
            ? 'Payment received. Issuing your monthly pass…'
            : 'Payment received. Issuing your license key(s)…', false);

        // Bank transfers and on-chain confirmations can lag the redirect a
        // little: retry the claim.
        const claimBody = checkoutId
            ? { checkout_id: checkoutId, reference: ctx.reference }
            : { reference: txRef };
        let tries = 0;
        const attempt = () => {
            tries += 1;
            fetch('/api/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(claimBody),
            }).then((r) => r.json()).then((c) => {
                if (c && c.ok && c.status === 'key_sent') {
                    try { sessionStorage.removeItem('ht-pending'); } catch (e) {}
                    track('payment-completed', { plan: isMonthly ? 'monthly' : 'lifetime' });
                    showMsg(successText({ isMonthly, email, count: c.count, seats }), false);
                } else if (c && c.status === 'already_processed') {
                    try { sessionStorage.removeItem('ht-pending'); } catch (e) {}
                    showMsg('Your ' + (isMonthly ? 'monthly pass' : 'key') + ' was already emailed to '
                        + email + '. Check your inbox and spam folder.', false);
                } else if (c && (c.status === 'out_of_keys' || c.status === 'unrecognized_amount')) {
                    showMsg('Payment received (ref: ' + ref + '). Your key needs a manual touch and will '
                        + 'be emailed shortly. Questions? me@rufaiahmed.com with that reference.', false);
                } else if (tries < 8) {
                    setTimeout(attempt, 4000);
                } else {
                    showMsg('Payment is confirming (ref: ' + ref + '). Your key is emailed the moment it '
                        + 'settles. If nothing arrives in a few minutes, email me@rufaiahmed.com with that reference.', false);
                }
            }).catch(() => { if (tries < 8) setTimeout(attempt, 4000); });
        };
        attempt();
    })();
})();

// --- Hero CTA price-rotator: alternate the label between the lifetime and monthly price ---
(() => {
    const cta = document.getElementById('hero-cta');
    if (!cta) return;
    const text = cta.querySelector('.cta-text');
    if (!text) return;
    const labels = ['Get it from ₦2,000/month', 'Lifetime + AI for ₦15,000'];
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let i = 0;
    setInterval(() => {
        i = (i + 1) % labels.length;
        text.classList.add('cta-swap');     // fade/slide out
        setTimeout(() => {
            text.textContent = labels[i];
            text.classList.remove('cta-swap');   // fade/slide the new price in
        }, 240);
    }, 3000);
})();
