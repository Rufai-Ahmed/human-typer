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

// --- Paystack one-time checkout (lifetime license) ---
(() => {
    const PAYSTACK_PUBLIC_KEY = 'pk_live_e4a3914a47bf7166a817304186e8168b54622deb';
    const PRICE_KOBO = 1000000;   // ₦10,000 (Paystack amounts are in kobo)

    const btnBuy = document.getElementById('btn-buy');
    const emailInput = document.getElementById('buyer-email');
    const msg = document.getElementById('buy-msg');
    if (!btnBuy) return;

    function showMsg(text, isError) {
        msg.textContent = text;
        msg.classList.remove('hidden');
        msg.classList.toggle('error', !!isError);
    }

    const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

    btnBuy.addEventListener('click', () => {
        const email = (emailInput.value || '').trim();
        if (!validEmail(email)) {
            showMsg('Please enter a valid email — that is where your license key is sent.', true);
            emailInput.focus();
            return;
        }
        if (typeof PaystackPop === 'undefined') {
            showMsg('The payment library could not load. Check your connection, refresh, and try again.', true);
            return;
        }

        const handler = PaystackPop.setup({
            key: PAYSTACK_PUBLIC_KEY,
            email: email,
            amount: PRICE_KOBO,
            currency: 'NGN',
            metadata: {
                custom_fields: [{
                    display_name: 'Product',
                    variable_name: 'product',
                    value: 'Human Typer — Lifetime license',
                }],
            },
            callback: function (response) {
                showMsg('Payment received — issuing your license key…', false);
                fetch('/api/claim', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reference: response.reference }),
                }).then((r) => r.json()).then((d) => {
                    if (d && d.ok && d.status === 'key_sent') {
                        showMsg('Done! Your license key was emailed to ' + email
                            + '. Check your inbox (and spam), then download below and paste it into the app.', false);
                    } else if (d && d.status === 'already_processed') {
                        showMsg('Your key was already emailed to ' + email + '. Check your inbox and spam folder.', false);
                    } else {
                        showMsg('Payment received (ref: ' + response.reference
                            + '). If your key does not arrive within a few minutes, email me@rufaiahmed.com with this reference.', false);
                    }
                }).catch(() => {
                    showMsg('Payment received (ref: ' + response.reference
                        + '). If your key does not arrive shortly, email me@rufaiahmed.com with this reference.', false);
                });
            },
            onClose: function () {
                showMsg('Checkout was closed before payment. You can start again whenever you are ready.', true);
            },
        });
        handler.openIframe();
    });
})();
