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

// --- Paystack checkout: lifetime (one-time, single + team packs) OR monthly pass ---
(() => {
    const PAYSTACK_PUBLIC_KEY = 'pk_live_e4a3914a47bf7166a817304186e8168b54622deb';

    // Per-seat price in kobo for each seat count (₦1 = 100 kobo). A seat is one
    // ordinary 1-device key; buying more seats just lowers the per-seat price.
    // The server re-derives the seat count from the Paystack-verified amount, so
    // this MUST stay in sync with the amount->tier map in api/claim.js.
    const PER_SEAT_KOBO = { 1: 1000000, 5: 800000, 10: 700000, 25: 600000 };
    // Monthly pass: one payment buys 30 days. MUST match MONTHLY_KOBO in api/claim.js.
    const MONTHLY_KOBO = 200000;

    const btnBuy = document.getElementById('btn-buy');
    const emailInput = document.getElementById('buyer-email');
    const msg = document.getElementById('buy-msg');
    const priceAmount = document.getElementById('price-amount');
    const priceBadge = document.getElementById('price-badge');
    const seatOptions = document.getElementById('seat-options');
    const seatPick = document.getElementById('seat-pick');
    const planToggle = document.getElementById('plan-toggle');
    if (!btnBuy) return;

    let plan = 'lifetime';   // 'lifetime' | 'monthly'
    let seats = 1;
    const naira = (kobo) => '₦' + Math.round(kobo / 100).toLocaleString('en-NG');
    const totalKobo = () => (plan === 'monthly' ? MONTHLY_KOBO : PER_SEAT_KOBO[seats] * seats);

    function setActive(group, match) {
        if (!group) return;
        group.querySelectorAll('button').forEach((b) => {
            const on = match(b);
            b.classList.toggle('is-active', on);
            b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
    }

    function refresh() {
        const total = totalKobo();
        if (plan === 'monthly') {
            if (priceAmount) priceAmount.innerHTML = naira(total) + '<span class="price-once"> / month</span>';
            if (priceBadge) priceBadge.textContent = 'Monthly pass';
            if (seatPick) seatPick.classList.add('hidden');
            btnBuy.textContent = 'Get 30 days for ' + naira(total);
        } else {
            const tail = seats === 1 ? ' once' : ' for ' + seats + ' seats';
            if (priceAmount) priceAmount.innerHTML = naira(total) + '<span class="price-once">' + tail + '</span>';
            if (priceBadge) priceBadge.textContent = 'Lifetime license';
            if (seatPick) seatPick.classList.remove('hidden');
            btnBuy.textContent = seats === 1
                ? 'Buy lifetime access for ' + naira(total)
                : 'Buy ' + seats + ' seats for ' + naira(total);
        }
    }

    if (planToggle) {
        planToggle.addEventListener('click', (e) => {
            const opt = e.target.closest('.plan-opt');
            if (!opt || !planToggle.contains(opt)) return;
            const p = opt.getAttribute('data-plan');
            if (p !== 'monthly' && p !== 'lifetime') return;
            plan = p;
            if (plan === 'monthly') seats = 1;   // monthly is a single device
            setActive(planToggle, (b) => b === opt);
            if (plan === 'monthly') setActive(seatOptions, (b) => b.getAttribute('data-seats') === '1');
            refresh();
        });
    }

    if (seatOptions) {
        seatOptions.addEventListener('click', (e) => {
            const opt = e.target.closest('.seat-opt');
            if (!opt || !seatOptions.contains(opt)) return;
            const n = parseInt(opt.getAttribute('data-seats'), 10);
            if (!PER_SEAT_KOBO[n]) return;
            plan = 'lifetime';   // picking seats means the lifetime plan
            seats = n;
            setActive(seatOptions, (b) => b === opt);
            setActive(planToggle, (b) => b.getAttribute('data-plan') === 'lifetime');
            refresh();
        });
    }
    refresh();

    function showMsg(text, isError) {
        msg.textContent = text;
        msg.classList.remove('hidden');
        msg.classList.toggle('error', !!isError);
    }

    const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

    btnBuy.addEventListener('click', () => {
        const email = (emailInput.value || '').trim();
        if (!validEmail(email)) {
            showMsg('Please enter a valid email. That is where your license key is sent.', true);
            emailInput.focus();
            return;
        }
        if (typeof PaystackPop === 'undefined') {
            showMsg('The payment library could not load. Check your connection, refresh, and try again.', true);
            return;
        }

        const buyingPlan = plan;
        const buyingSeats = plan === 'monthly' ? 1 : seats;
        const productLabel = plan === 'monthly'
            ? 'Human Typer Monthly pass (30 days)'
            : 'Human Typer Lifetime license';

        const handler = PaystackPop.setup({
            key: PAYSTACK_PUBLIC_KEY,
            email: email,
            amount: totalKobo(),
            currency: 'NGN',
            metadata: {
                custom_fields: [
                    { display_name: 'Product', variable_name: 'product', value: productLabel },
                    { display_name: 'Plan', variable_name: 'plan', value: buyingPlan },
                    { display_name: 'Seats', variable_name: 'seats', value: String(buyingSeats) },
                ],
            },
            callback: function (response) {
                const isMonthly = buyingPlan === 'monthly';
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
    });
})();
