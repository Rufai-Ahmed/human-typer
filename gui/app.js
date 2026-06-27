document.addEventListener('DOMContentLoaded', () => {
    // --- License gate elements ---
    const licenseGate = document.getElementById('license-gate');
    const appRoot = document.getElementById('app-root');
    const licenseInput = document.getElementById('license-key-input');
    const btnActivate = document.getElementById('btn-activate');
    const licenseError = document.getElementById('license-error');

    // --- Accessibility gate ---
    const accessGate = document.getElementById('access-gate');
    const btnOpenAccess = document.getElementById('btn-open-access');
    const accessStatus = document.getElementById('access-status');

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

    // --- Test field (sandbox) ---
    const sandboxInput = document.getElementById('sandbox-input');
    const btnTest = document.getElementById('btn-test');
    const sandboxStatus = document.getElementById('sandbox-status');
    const sandboxStatusText = document.getElementById('sandbox-status-text');
    const btnTestStop = document.getElementById('btn-test-stop');

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
    let sandboxMode = false;
    let accessPoll = null;

    // ============================ License Gate ============================
    async function checkLicense() {
        try {
            const res = await fetch('/api/license');
            const data = await res.json();
            if (data.activated) { checkAccess(); } else { showGate(); }
        } catch (err) {
            showGate();
        }
    }

    // ===== Accessibility permission gate =====
    async function checkAccess() {
        let granted = true;
        try {
            const res = await fetch('/api/permissions');
            const data = await res.json();
            granted = !!data.accessibility;
        } catch (err) { granted = true; }   // fail-open if the probe is unreachable
        if (granted) { showApp(); } else { showAccessGate(); }
    }

    function showAccessGate() {
        licenseGate.classList.add('hidden');
        appRoot.classList.add('hidden');
        accessGate.classList.remove('hidden');
        if (accessPoll) clearInterval(accessPoll);
        accessPoll = setInterval(async () => {
            try {
                const res = await fetch('/api/permissions');
                const data = await res.json();
                if (data && data.accessibility) showApp();
            } catch (err) { /* keep waiting */ }
        }, 1500);
    }

    if (btnOpenAccess) btnOpenAccess.addEventListener('click', () => {
        fetch('/api/open-accessibility', { method: 'POST' });
        accessStatus.textContent = 'Opened System Settings. Toggle Human Typer on, then come back; this unlocks automatically.';
    });

    function showApp() {
        licenseGate.classList.add('hidden');
        accessGate.classList.add('hidden');
        if (accessPoll) { clearInterval(accessPoll); accessPoll = null; }
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
        typosValue.classList.toggle('warn', parseFloat(e.target.value) > 5);
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
                btnClipboard.style.borderColor = 'var(--accent)';
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
        sandboxMode = false;

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
        progressBar.style.transform = 'scaleX(0)';
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

    // ============================ Test Field (in-window preview) ============================
    // Types into the in-window field WITHOUT the full-screen overlay, so the field
    // stays visible while it fills. The main Start button keeps the overlay (you switch apps).
    async function startSandbox() {
        const text = textInput.value;
        if (!text.trim()) { alert('Type some text in the buffer above first, then Test here to preview it.'); return; }
        if (sandboxMode) return;
        const delay_ms = parseFloat(speedSlider.value);
        const humanize = humanizeCheckbox.checked;
        const typos = humanize ? parseFloat(typosSlider.value) / 100.0 : 0.0;
        if (pollInterval) clearInterval(pollInterval);
        sandboxMode = true;
        sandboxInput.value = '';
        sandboxInput.focus();
        sandboxStatus.classList.remove('hidden');
        sandboxStatusText.textContent = 'get ready';
        try {
            const res = await fetch('/api/type', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, delay_ms, humanize, typos, delay: 1 })
            });
            const data = await res.json();
            if (res.ok) {
                sandboxInput.focus();   // keep the field focused so keystrokes land here
                pollInterval = setInterval(pollStatus, 150);
            } else {
                endSandbox(data.error === 'accessibility_required' ? 'blocked' : 'failed');
                alert(data.error === 'accessibility_required'
                    ? 'Enable Accessibility first (see the gate steps).'
                    : (data.error || 'Could not start the test.'));
            }
        } catch (err) {
            endSandbox('error');
            alert('Error connecting to the typing engine.');
        }
    }

    function endSandbox(finalText) {
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        if (finalText) sandboxStatusText.textContent = finalText;
        setTimeout(() => { sandboxStatus.classList.add('hidden'); sandboxMode = false; }, 1200);
    }

    if (btnTest) btnTest.addEventListener('click', startSandbox);
    if (btnTestStop) btnTestStop.addEventListener('click', abort);

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
        if (e.key === 'Escape' && (sandboxMode || !typingOverlay.classList.contains('hidden'))) {
            abort();
        }
    });

    // ============================ Status Polling ============================
    async function pollStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();

            if (sandboxMode) {
                if (data.state === 'countdown') {
                    sandboxStatusText.textContent = `starting in ${Math.ceil(data.countdown_remaining)}`;
                } else if (data.state === 'typing') {
                    const pct = data.total_chars > 0 ? Math.round(data.typed_chars / data.total_chars * 100) : 0;
                    sandboxStatusText.textContent = `typing ${pct}%`;
                } else if (data.state === 'done') {
                    endSandbox('done');
                } else if (data.state === 'aborted') {
                    endSandbox('stopped');
                }
                return;
            }

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
                countdownTimer.textContent = '▸';
                progressCircle.style.strokeDashoffset = '314';
                overlayStats.classList.remove('hidden');

                const percent = data.total_chars > 0 ? (data.typed_chars / data.total_chars) * 100 : 0;
                progressBar.style.transform = `scaleX(${Math.max(0, Math.min(1, percent / 100))})`;
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
            overlayTitle.textContent = 'done';
            overlayInstruction.textContent = 'Everything typed successfully.';
            progressBar.style.transform = 'scaleX(1)';
            progressPercent.textContent = '100%';
            countdownTimer.textContent = '✓';
        } else if (finalState === 'aborted') {
            overlayTitle.textContent = 'stopped';
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
