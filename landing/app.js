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

// --- Paystack checkout: two cards (lifetime one-time + team packs, and monthly pass) ---
(() => {
    const PAYSTACK_PUBLIC_KEY = 'pk_live_e4a3914a47bf7166a817304186e8168b54622deb';

    // Per-seat price in kobo (₦1 = 100 kobo). MUST match the amount->tier map in api/claim.js.
    const PER_SEAT_KOBO = { 1: 1000000, 5: 800000, 10: 700000, 25: 600000 };
    // Monthly pass: one payment buys 30 days. MUST match MONTHLY_KOBO in api/claim.js.
    const MONTHLY_KOBO = 200000;

    const naira = (kobo) => '₦' + Math.round(kobo / 100).toLocaleString('en-NG');
    const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

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

    // Open Paystack for one purchase and report the outcome via showMsg.
    function runCheckout({ email, amountKobo, plan, seats, showMsg }) {
        if (typeof PaystackPop === 'undefined') {
            showMsg('The payment library could not load. Check your connection, refresh, and try again.', true);
            return;
        }
        const isMonthly = plan === 'monthly';
        const buyingSeats = isMonthly ? 1 : seats;
        const handler = PaystackPop.setup({
            key: PAYSTACK_PUBLIC_KEY,
            email: email,
            amount: amountKobo,
            currency: 'NGN',
            metadata: {
                custom_fields: [
                    { display_name: 'Product', variable_name: 'product',
                      value: isMonthly ? 'Human Typer Monthly pass (30 days)' : 'Human Typer Lifetime license' },
                    { display_name: 'Plan', variable_name: 'plan', value: plan },
                    { display_name: 'Seats', variable_name: 'seats', value: String(buyingSeats) },
                ],
            },
            callback: function (response) {
                showMsg(isMonthly
                    ? 'Payment received. Issuing your monthly pass…'
                    : 'Payment received. Issuing your license ' + (buyingSeats === 1 ? 'key' : 'keys') + '…', false);
                fetch('/api/claim', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reference: response.reference }),
                }).then((r) => r.json()).then((d) => {
                    if (d && d.ok && d.status === 'key_sent') {
                        if (isMonthly) {
                            showMsg('Done! Your monthly pass key was emailed to ' + email
                                + '. Check your inbox (and spam), download below, and paste it into the app. '
                                + 'Pay again anytime with this email to extend, no new key needed.', false);
                        } else {
                            const n = (d && d.count) || buyingSeats;
                            showMsg('Done! Your ' + n + ' license ' + (n === 1 ? 'key was' : 'keys were')
                                + ' emailed to ' + email + '. Check your inbox (and spam), then download below and paste '
                                + (n === 1 ? 'it' : 'each one') + ' into the app.', false);
                        }
                    } else if (d && d.status === 'already_processed') {
                        showMsg(isMonthly
                            ? 'Your monthly pass was already emailed to ' + email + '. Check your inbox and spam folder.'
                            : 'Your key was already emailed to ' + email + '. Check your inbox and spam folder.', false);
                    } else {
                        showMsg('Payment received (ref: ' + response.reference
                            + '). If your ' + (isMonthly ? 'pass does' : (buyingSeats === 1 ? 'key does' : 'keys do'))
                            + ' not arrive within a few minutes, email me@rufaiahmed.com with this reference.', false);
                    }
                }).catch(() => {
                    showMsg('Payment received (ref: ' + response.reference
                        + '). If your access does not arrive shortly, email me@rufaiahmed.com with this reference.', false);
                });
            },
            onClose: function () {
                showMsg('Checkout was closed before payment. You can start again whenever you are ready.', true);
            },
        });
        handler.openIframe();
    }

    // ---- Lifetime card (single + team seats) ----
    (() => {
        const btn = document.getElementById('btn-buy-lifetime');
        const emailInput = document.getElementById('buyer-email-lifetime');
        const seatOptions = document.getElementById('seat-options');
        const priceAmount = document.getElementById('price-amount-lifetime');
        if (!btn) return;
        const showMsg = makeShowMsg(document.getElementById('buy-msg-lifetime'));
        let seats = 1;

        function refresh() {
            const total = PER_SEAT_KOBO[seats] * seats;
            if (priceAmount) {
                const tail = seats === 1 ? ' once' : ' for ' + seats + ' seats';
                priceAmount.innerHTML = naira(total) + '<span class="price-once">' + tail + '</span>';
            }
            btn.textContent = seats === 1
                ? 'Buy lifetime access for ' + naira(total)
                : 'Buy ' + seats + ' seats for ' + naira(total);
        }

        if (seatOptions) {
            seatOptions.addEventListener('click', (e) => {
                const opt = e.target.closest('.seat-opt');
                if (!opt || !seatOptions.contains(opt)) return;
                const n = parseInt(opt.getAttribute('data-seats'), 10);
                if (!PER_SEAT_KOBO[n]) return;
                seats = n;
                setActive(seatOptions, (b) => b === opt);
                refresh();
            });
        }
        refresh();

        btn.addEventListener('click', () => {
            const email = (emailInput.value || '').trim();
            if (!validEmail(email)) {
                showMsg('Please enter a valid email. That is where your key is sent.', true);
                emailInput.focus();
                return;
            }
            runCheckout({ email, amountKobo: PER_SEAT_KOBO[seats] * seats, plan: 'lifetime', seats, showMsg });
        });
    })();

    // ---- Monthly card ----
    (() => {
        const btn = document.getElementById('btn-buy-monthly');
        const emailInput = document.getElementById('buyer-email-monthly');
        if (!btn) return;
        const showMsg = makeShowMsg(document.getElementById('buy-msg-monthly'));

        btn.addEventListener('click', () => {
            const email = (emailInput.value || '').trim();
            if (!validEmail(email)) {
                showMsg('Please enter a valid email. That is where your key is sent.', true);
                emailInput.focus();
                return;
            }
            runCheckout({ email, amountKobo: MONTHLY_KOBO, plan: 'monthly', seats: 1, showMsg });
        });
    })();
})();

// --- Hero CTA price-rotator: alternate the label between the lifetime and monthly price ---
(() => {
    const cta = document.getElementById('hero-cta');
    if (!cta) return;
    const text = cta.querySelector('.cta-text');
    if (!text) return;
    const labels = ['Get it for ₦10,000 once', 'Get it for ₦2,000/month'];
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
