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
        // Human-ish jitter so the demo itself looks hand-typed.
        const base = deleting ? 28 : 70;
        setTimeout(tick, base + Math.random() * 80);
    }
    tick();
})();

// --- Password gate ---
(() => {
    const form = document.getElementById('unlock-form');
    const pw = document.getElementById('pw');
    const btn = document.getElementById('unlock-btn');
    const errEl = document.getElementById('unlock-error');
    const gate = document.getElementById('gate');
    const downloads = document.getElementById('downloads');
    const dlMac = document.getElementById('dl-mac');
    const dlWin = document.getElementById('dl-win');
    const dlMacIntel = document.getElementById('dl-mac-intel');

    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.classList.add('hidden');
        btn.disabled = true;
        const original = btn.textContent;
        btn.textContent = 'Checking…';

        try {
            const res = await fetch('/api/unlock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pw.value }),
            });
            const data = await res.json().catch(() => ({}));

            if (res.ok && data.ok && data.downloads) {
                dlMac.setAttribute('href', data.downloads.macArm);
                dlWin.setAttribute('href', data.downloads.windows);
                dlMacIntel.setAttribute('href', data.downloads.macIntel);
                gate.classList.add('hidden');
                downloads.classList.remove('hidden');
            } else {
                errEl.textContent = data.error || "That password didn't work. Check it and try again.";
                errEl.classList.remove('hidden');
            }
        } catch (err) {
            errEl.textContent = 'Could not reach the server. Please try again.';
            errEl.classList.remove('hidden');
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    });
})();
