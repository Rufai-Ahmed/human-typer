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

// --- Paystack one-time checkout (lifetime license + team/volume packs) ---
(() => {
    const PAYSTACK_PUBLIC_KEY = 'pk_live_e4a3914a47bf7166a817304186e8168b54622deb';

    // Per-seat price in kobo for each seat count (₦1 = 100 kobo). A seat is one
    // ordinary 1-device key; buying more seats just lowers the per-seat price.
    // The server re-derives the seat count from the Paystack-verified amount, so
    // this MUST stay in sync with the amount->tier map in api/claim.js.
    const PER_SEAT_KOBO = { 1: 1000000, 5: 800000, 10: 700000, 25: 600000 };

    const btnBuy = document.getElementById('btn-buy');
    const emailInput = document.getElementById('buyer-email');
    const msg = document.getElementById('buy-msg');
    const priceAmount = document.getElementById('price-amount');
    const seatOptions = document.getElementById('seat-options');
    if (!btnBuy) return;

    let seats = 1;
    const totalKobo = () => PER_SEAT_KOBO[seats] * seats;
    const naira = (kobo) => '₦' + Math.round(kobo / 100).toLocaleString('en-NG');

    function refresh() {
        const total = totalKobo();
        if (priceAmount) {
            const tail = seats === 1 ? ' once' : ' for ' + seats + ' seats';
            priceAmount.innerHTML = naira(total) + '<span class="price-once">' + tail + '</span>';
        }
        btnBuy.textContent = seats === 1
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
            seatOptions.querySelectorAll('.seat-opt').forEach((b) => {
                const on = b === opt;
                b.classList.toggle('is-active', on);
                b.setAttribute('aria-checked', on ? 'true' : 'false');
            });
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
            showMsg('Please enter a valid email. That is where your license keys are sent.', true);
            emailInput.focus();
            return;
        }
        if (typeof PaystackPop === 'undefined') {
            showMsg('The payment library could not load. Check your connection, refresh, and try again.', true);
            return;
        }

        const buyingSeats = seats;
        const handler = PaystackPop.setup({
            key: PAYSTACK_PUBLIC_KEY,
            email: email,
            amount: totalKobo(),
            currency: 'NGN',
            metadata: {
                custom_fields: [
                    {
                        display_name: 'Product',
                        variable_name: 'product',
                        value: 'Human Typer Lifetime license',
                    },
                    {
                        display_name: 'Seats',
                        variable_name: 'seats',
                        value: String(buyingSeats),
                    },
                ],
            },
            callback: function (response) {
                showMsg('Payment received. Issuing your license ' + (buyingSeats === 1 ? 'key' : 'keys') + '…', false);
                fetch('/api/claim', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reference: response.reference }),
                }).then((r) => r.json()).then((d) => {
                    const n = (d && d.count) || buyingSeats;
                    if (d && d.ok && d.status === 'key_sent') {
                        showMsg('Done! Your ' + n + ' license ' + (n === 1 ? 'key was' : 'keys were')
                            + ' emailed to ' + email + '. Check your inbox (and spam), then download below and paste '
                            + (n === 1 ? 'it' : 'each one') + ' into the app.', false);
                    } else if (d && d.status === 'already_processed') {
                        showMsg('Your ' + (n === 1 ? 'key was' : n + ' keys were')
                            + ' already emailed to ' + email + '. Check your inbox and spam folder.', false);
                    } else {
                        showMsg('Payment received (ref: ' + response.reference
                            + '). If your ' + (buyingSeats === 1 ? 'key does' : 'keys do')
                            + ' not arrive within a few minutes, email me@rufaiahmed.com with this reference.', false);
                    }
                }).catch(() => {
                    showMsg('Payment received (ref: ' + response.reference
                        + '). If your ' + (buyingSeats === 1 ? 'key does' : 'keys do')
                        + ' not arrive shortly, email me@rufaiahmed.com with this reference.', false);
                });
            },
            onClose: function () {
                showMsg('Checkout was closed before payment. You can start again whenever you are ready.', true);
            },
        });
        handler.openIframe();
    });
})();
