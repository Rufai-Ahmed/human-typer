document.addEventListener('DOMContentLoaded', () => {
    // --- License gate elements ---
    const licenseGate = document.getElementById('license-gate');
    const appRoot = document.getElementById('app-root');
    const licenseInput = document.getElementById('license-key-input');
    const btnActivate = document.getElementById('btn-activate');
    const licenseError = document.getElementById('license-error');

    // --- Settings elements ---
    const speedSlider = document.getElementById('speed');
    const speedValue = document.getElementById('speed-value');
    const delaySlider = document.getElementById('delay');
    const delayValue = document.getElementById('delay-value');
    const humanizeCheckbox = document.getElementById('humanize');
    const typoGroup = document.getElementById('typo-group');
    const typosSlider = document.getElementById('typos');
    const typosValue = document.getElementById('typos-value');

    // --- Text + actions ---
    const textInput = document.getElementById('text-input');
    const charCount = document.getElementById('char-count');
    const wordCount = document.getElementById('word-count');
    const btnClipboard = document.getElementById('btn-clipboard');
    const btnStart = document.getElementById('btn-start');
    const btnAbort = document.getElementById('btn-abort');

    // --- Overlay ---
    const typingOverlay = document.getElementById('typing-overlay');
    const countdownTimer = document.getElementById('countdown-timer');
    const progressCircle = document.getElementById('progress-circle');
    const overlayTitle = document.getElementById('overlay-title');
    const overlayInstruction = document.getElementById('overlay-instruction');
    const overlayStats = document.getElementById('overlay-stats');
    const progressBar = document.getElementById('progress-bar');
    const progressPercent = document.getElementById('progress-percent');
    const progressCounts = document.getElementById('progress-counts');
    const statWpm = document.getElementById('stat-wpm');
    const statTime = document.getElementById('stat-time');
    const statChar = document.getElementById('stat-char');

    let pollInterval = null;
    let originalCountdown = 5.0;

    // ============================ License Gate ============================
    async function checkLicense() {
        try {
            const res = await fetch('/api/license');
            const data = await res.json();
            if (data.activated) { showApp(); } else { showGate(); }
        } catch (err) {
            showGate();
        }
    }

    function showApp() {
        licenseGate.classList.add('hidden');
        appRoot.classList.remove('hidden');
    }

    function showGate() {
        appRoot.classList.add('hidden');
        licenseGate.classList.remove('hidden');
        licenseInput.focus();
    }

    async function activate() {
        const key = licenseInput.value.trim();
        if (!key) { showLicenseError('Please enter your license key.'); return; }
        btnActivate.disabled = true;
        btnActivate.textContent = 'Activating…';
        try {
            const res = await fetch('/api/license/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key })
            });
            const data = await res.json();
            if (res.ok && data.activated) {
                licenseError.classList.add('hidden');
                showApp();
            } else {
                showLicenseError(reasonMessage(data.reason));
            }
        } catch (err) {
            showLicenseError('Could not reach the activation engine.');
        } finally {
            btnActivate.disabled = false;
            btnActivate.textContent = 'Activate';
        }
    }

    function reasonMessage(reason) {
        switch (reason) {
            case 'in_use':  return 'This key is already activated on another device.';
            case 'revoked': return 'This key has been disabled. Contact me@rufaiahmed.com.';
            case 'offline': return 'Could not reach the activation server. Check your internet and try again.';
            case 'missing': return 'Please enter your license key.';
            default:        return 'That license key is not valid.';
        }
    }

    function showLicenseError(msg) {
        licenseError.textContent = msg;
        licenseError.classList.remove('hidden');
    }

    btnActivate.addEventListener('click', activate);
    licenseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') activate(); });

    // ============================ Settings ============================
    speedSlider.addEventListener('input', (e) => {
        speedValue.textContent = `${e.target.value} ms`;
    });

    delaySlider.addEventListener('input', (e) => {
        delayValue.textContent = `${e.target.value}s`;
    });

    typosSlider.addEventListener('input', (e) => {
        typosValue.textContent = `${e.target.value}%`;
    });

    function syncHumanize() {
        if (humanizeCheckbox.checked) {
            typoGroup.classList.remove('disabled');
            typosSlider.disabled = false;
        } else {
            typoGroup.classList.add('disabled');
            typosSlider.disabled = true;
        }
    }
    humanizeCheckbox.addEventListener('change', syncHumanize);
    syncHumanize();

    // ============================ Counters ============================
    function updateCounters() {
        const text = textInput.value;
        charCount.textContent = `${text.length} character${text.length !== 1 ? 's' : ''}`;
        const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
        wordCount.textContent = `${words} word${words !== 1 ? 's' : ''}`;
    }
    textInput.addEventListener('input', updateCounters);

    // ============================ Clipboard ============================
    btnClipboard.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/clipboard');
            const data = await res.json();
            if (data.text) {
                textInput.value = data.text;
                updateCounters();
                btnClipboard.style.borderColor = 'var(--accent-green)';
                setTimeout(() => { btnClipboard.style.borderColor = ''; }, 1000);
            }
        } catch (err) {
            alert('Failed to read clipboard.');
        }
    });

    // ============================ Start Typing ============================
    btnStart.addEventListener('click', async () => {
        const text = textInput.value;
        if (!text.trim()) {
            alert('Please enter some text to type first.');
            return;
        }

        const delay_ms = parseFloat(speedSlider.value);
        const delay = parseFloat(delaySlider.value);
        const humanize = humanizeCheckbox.checked;
        const typos = humanize ? parseFloat(typosSlider.value) / 100.0 : 0.0;
        originalCountdown = delay;

        if (pollInterval) clearInterval(pollInterval);

        countdownTimer.textContent = Math.ceil(delay);
        overlayTitle.textContent = 'Get ready';
        overlayInstruction.textContent = 'Click into the target field now!';
        progressCircle.style.strokeDashoffset = '0';
        overlayStats.classList.add('hidden');
        typingOverlay.classList.remove('hidden');

        try {
            const response = await fetch('/api/type', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, delay_ms, humanize, typos, delay })
            });
            const data = await response.json();
            if (response.ok) {
                pollInterval = setInterval(pollStatus, 150);
            } else {
                alert(data.error || 'Failed to start typing.');
                typingOverlay.classList.add('hidden');
            }
        } catch (err) {
            alert('Error connecting to the typing engine.');
            typingOverlay.classList.add('hidden');
        }
    });

    // ============================ Abort ============================
    async function abort() {
        try {
            await fetch('/api/abort', { method: 'POST' });
        } catch (err) {
            /* ignore */
        }
    }
    btnAbort.addEventListener('click', abort);

    // In-window Esc fallback (the engine also listens globally via the OS).
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !typingOverlay.classList.contains('hidden')) {
            abort();
        }
    });

    // ============================ Status Polling ============================
    async function pollStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();

            if (data.state === 'countdown') {
                const remaining = data.countdown_remaining;
                countdownTimer.textContent = Math.ceil(remaining);
                const ratio = Math.max(0, Math.min(1, remaining / originalCountdown));
                progressCircle.style.strokeDashoffset = 314 * (1 - ratio);
                overlayTitle.textContent = 'Get ready';
                overlayInstruction.textContent = 'Click into the target field now!';
                overlayStats.classList.add('hidden');
            }
            else if (data.state === 'typing') {
                overlayTitle.textContent = 'Typing…';
                overlayInstruction.textContent = 'Keep the target window focused. Press Esc to stop.';
                countdownTimer.textContent = '⌨️';
                progressCircle.style.strokeDashoffset = '314';
                overlayStats.classList.remove('hidden');

                const percent = data.total_chars > 0 ? (data.typed_chars / data.total_chars) * 100 : 0;
                progressBar.style.width = `${percent}%`;
                progressPercent.textContent = `${Math.round(percent)}%`;
                progressCounts.textContent = `${data.typed_chars} / ${data.total_chars} chars`;

                statWpm.textContent = `${data.effective_wpm} WPM`;
                statTime.textContent = `${data.elapsed_time.toFixed(1)}s`;

                let currentChar = data.current_char;
                if (currentChar === '\n') currentChar = '↵ Enter';
                else if (currentChar === '\t') currentChar = '⇥ Tab';
                else if (currentChar === '\b') currentChar = '⌫ Back';
                else if (currentChar === ' ') currentChar = '␣ Space';
                statChar.textContent = currentChar || 'None';
            }
            else if (data.state === 'done') {
                cleanup('done');
            }
            else if (data.state === 'aborted') {
                cleanup('aborted');
            }
        } catch (err) {
            /* polling error ignored */
        }
    }

    function cleanup(finalState) {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        if (finalState === 'done') {
            overlayTitle.textContent = 'Done 🎉';
            overlayInstruction.textContent = 'Everything typed successfully.';
            progressBar.style.width = '100%';
            progressPercent.textContent = '100%';
            countdownTimer.textContent = '✓';
        } else if (finalState === 'aborted') {
            overlayTitle.textContent = 'Stopped 🛑';
            overlayInstruction.textContent = 'Typing halted.';
            countdownTimer.textContent = '✕';
        }
        setTimeout(() => { typingOverlay.classList.add('hidden'); }, 1600);
    }

    // ============================ Update check ============================
    async function checkForUpdate() {
        try {
            const res = await fetch('/api/update');
            const d = await res.json();
            if (d && d.update_available && d.url) {
                document.getElementById('update-text').textContent = `Version ${d.latest} is available.`;
                const banner = document.getElementById('update-banner');
                banner.classList.remove('hidden');
                document.getElementById('update-btn').onclick = () => {
                    fetch('/api/open-download', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: d.url }),
                    });
                };
            }
        } catch (err) { /* offline / no update info — ignore */ }
    }

    // ============================ Init ============================
    updateCounters();
    checkLicense();
    checkForUpdate();
});
