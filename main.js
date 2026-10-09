"use strict";

// Each voice is a waveform plus a brightness that scales the filter.
const VOICES = {
    glass: { wave: "sine", brightness: 1.0 },
    wood: { wave: "triangle", brightness: 0.8 },
    air: { wave: "sawtooth", brightness: 0.5 }
};

const setupForm = document.getElementById("setup");
const beginBtn = document.getElementById("begin");
const endBtn = document.getElementById("end");
const warningEl = document.getElementById("warning");
const pad = document.getElementById("pad");
const pitchInput = setupForm.elements.pitch;
const brightnessInput = setupForm.elements.brightness;

let startInstant = null;
let totalDuration = null;
let audio = null;
let tickTimer = null;
let fadeOut = 5;
let preview = null;
let pressing = false;

// Need Temporal to work because Duhhhh.
if (typeof Temporal === "undefined") {
    warningEl.textContent = "Temporal is not available in this browser and the polyfill did not load.";
    beginBtn.disabled = true;
}

// The only visual thing JS does is set the state, and CSS handles the rest.
function setState(state) {
    document.body.dataset.state = state;
}

// Keeps a typed number whole and within range, using the minimum if it's empty.
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Math.round(value) || min));
}

// Pad position, 0 to 1 on each axis, turned into pitch (65 to 165 Hz) and brightness (0.5 to 1.5).
function setPad(x, y) {
    x = Math.min(1, Math.max(0, x));
    y = Math.min(1, Math.max(0, y));
    pad.style.setProperty("--x", x);
    pad.style.setProperty("--y", y);
    pitchInput.value = (65 * Math.pow(165 / 65, x)).toFixed(2);
    brightnessInput.value = (1.5 - y).toFixed(2);
    updatePreview();
}

// Where the pointer is inside the pad.
function padPoint(event) {
    const box = pad.getBoundingClientRect();
    setPad((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
}

// Browsers only allow sound after a click. If it still can't start within 3 seconds, report it instead of hanging.
async function startSound() {
    const giveUp = new Promise(resolve => setTimeout(resolve, 3000));
    await Promise.race([Tone.start(), giveUp]);
    return Tone.context.state === "running";
}

// A quiet preview of the sound while the pad is held.
async function startPreview() {
    if (document.body.dataset.state !== "idle" || preview) return;
    if (!(await startSound())) return;
    if (!pressing || preview) return;

    const choices = new FormData(setupForm);
    const preset = VOICES[choices.get("voice")];
    const pitch = Number(pitchInput.value);

    const gain = new Tone.Gain(0).toDestination();
    const filter = new Tone.Filter({ type: "lowpass", frequency: 900, Q: 1 }).connect(gain);
    const osc1 = new Tone.Oscillator({ frequency: pitch, type: preset.wave }).connect(filter);
    const osc2 = new Tone.Oscillator({ frequency: pitch * 1.004, type: preset.wave }).connect(filter);
    osc1.start();
    osc2.start();
    gain.gain.rampTo(0.2 * Number(choices.get("volume")), 0.15);

    preview = { preset, gain, filter, osc1, osc2 };
    updatePreview();
}

function updatePreview() {
    if (!preview) return;
    const pitch = Number(pitchInput.value);
    preview.osc1.frequency.rampTo(pitch, 0.05);
    preview.osc2.frequency.rampTo(pitch * 1.004, 0.05);
    preview.filter.frequency.rampTo(900 * preview.preset.brightness * Number(brightnessInput.value), 0.05);
}

function stopPreview() {
    pressing = false;
    if (!preview) return;
    const old = preview;
    preview = null;
    old.gain.gain.rampTo(0, 0.4);
    setTimeout(() => {
        old.osc1.stop();
        old.osc2.stop();
        [old.osc1, old.osc2, old.filter, old.gain].forEach(node => node.dispose());
    }, 500);
}

// Two drones and a pad run through a lowpass filter and reverb, fading in from silence. Idk Claude mostly did this stuff. I'm a designer, idk anything about music.
function buildAudio(voice, root, fadeIn, volume, brightness) {
    const preset = VOICES[voice];

    const master = new Tone.Gain(0).toDestination();
    const reverb = new Tone.Reverb({ decay: 8, wet: 0.4 }).connect(master);
    const filter = new Tone.Filter({ type: "lowpass", frequency: 250, Q: 1 }).connect(reverb);

    const droneGain = new Tone.Gain(0.5).connect(filter);
    const drone1 = new Tone.Oscillator({ frequency: root, type: preset.wave }).connect(droneGain);
    const drone2 = new Tone.Oscillator({ frequency: root * 1.004, type: preset.wave }).connect(droneGain);

    const padGain = new Tone.Gain(0).connect(filter);
    const pad1 = new Tone.Oscillator({ frequency: root * 1.5, type: preset.wave }).connect(padGain);
    const pad2 = new Tone.Oscillator({ frequency: root * 2, type: preset.wave }).connect(padGain);

    const oscillators = [drone1, drone2, pad1, pad2];
    oscillators.forEach(osc => osc.start());

    // Master level, set by the volume slider.
    master.gain.rampTo(0.4 * volume, fadeIn);

    // End bell, outside the master so the fade doesn't cut it off. Follows the volume slider.
    const bellGain = new Tone.Gain(0.5 * volume).toDestination();
    const bellReverb = new Tone.Reverb({ decay: 6, wet: 0.4 }).connect(bellGain);
    const bell = new Tone.FMSynth({
        harmonicity: 2.76,
        modulationIndex: 2.5,
        envelope: { attack: 0.005, decay: 60, sustain: 0, release: 60 },
        modulationEnvelope: { attack: 0.005, decay: 30, sustain: 0, release: 30 }
    }).connect(bellReverb);

    return {
        preset,
        root,
        brightness,
        master,
        filter,
        padGain,
        drone1,
        drone2,
        oscillators,
        nodes: [...oscillators, droneGain, padGain, filter, reverb, master],
        bell,
        bellNodes: [bell, bellReverb, bellGain]
    };
}

// Temporal gives the fraction of the session passed, read fresh from the clock every time so it never drifts.
function getProgress() {
    const elapsed = Temporal.Now.instant().since(startInstant);
    return Math.min(1, elapsed.total("milliseconds") / totalDuration.total("milliseconds"));
}

// Turns progress into sound across three phases: settling, steady and closing.
function applyProgress(p) {
    // The voice's brightness times the pad's.
    const b = audio.preset.brightness * audio.brightness;
    let cutoff;
    let pad;
    let lift;

    if (p < 0.2) {
        const t = p / 0.2;
        cutoff = (250 + t * 650) * b;
        pad = 0;
        lift = 0;
    } else if (p < 0.75) {
        const t = (p - 0.2) / 0.55;
        cutoff = (900 + t * 900) * b;
        pad = t * 0.3;
        lift = 0;
    } else {
        const t = (p - 0.75) / 0.25;
        cutoff = (1800 - t * 1500) * b;
        pad = 0.3 * (1 - t);
        lift = t * 0.055;
    }

    audio.filter.frequency.rampTo(Math.max(120, cutoff), 0.5);
    audio.padGain.gain.rampTo(pad, 0.8);
    // Same lift for every tuning, just under a semitone.
    audio.drone1.frequency.rampTo(audio.root * (1 + lift), 1);
    audio.drone2.frequency.rampTo(audio.root * 1.004 * (1 + lift), 1);
}

// A soft bell two octaves above the drone, so it's in tune with any tuning.
function ringBell() {
    audio.bell.triggerAttackRelease(audio.root * 4, 4);
}

// The sound's clock runs four times a second and keeps going in a background tab.
function tick() {
    const p = getProgress();
    applyProgress(p);
    // The bell only rings when time runs out, not when you end it yourself.
    if (p >= 1) {
        ringBell();
        endSession();
    }
}

// Reads the choices, unlocks audio, then starts the Temporal clock and the sound.
async function beginSession(event) {
    event.preventDefault();
    if (document.body.dataset.state !== "idle") return;

    const choices = new FormData(setupForm);
    const length = choices.get("duration");
    const voice = choices.get("voice");
    const root = Number(choices.get("pitch"));
    const brightness = Number(choices.get("brightness"));
    const fadeIn = clamp(Number(choices.get("fadeIn")), 1, 30);
    const volume = Number(choices.get("volume"));
    fadeOut = clamp(Number(choices.get("fadeOut")), 1, 30);

    // CSS reads this so the screen fades out over the same time as the sound.
    document.body.style.setProperty("--fade-out", fadeOut + "s");

    setState("running");

    // If the sound can't start, go back to setup with a message instead of leaving an empty session.
    if (!(await startSound())) {
        setState("idle");
        warningEl.textContent = "The sound couldn't start. Check that your device's sound is working, then press Begin again.";
        return;
    }
    warningEl.textContent = "";

    startInstant = Temporal.Now.instant();

    // Presets are in seconds, and a custom length is minutes plus seconds.
    if (length === "custom") {
        const minutes = clamp(Number(choices.get("minutes")), 0, 120);
        const seconds = clamp(Number(choices.get("seconds")), 0, 59);
        totalDuration = Temporal.Duration.from({ minutes, seconds });

        // Anything shorter would end almost as soon as it starts, so 10 seconds is the minimum.
        const shortest = Temporal.Duration.from({ seconds: 10 });
        if (Temporal.Duration.compare(totalDuration, shortest) < 0) {
            totalDuration = shortest;
        }
    } else {
        totalDuration = Temporal.Duration.from({ seconds: Number(length) });
    }

    audio = buildAudio(voice, root, fadeIn, volume, brightness);

    tick();
    tickTimer = setInterval(tick, 250);
}

// Fades the sound out, then cleans up the audio and returns to setup.
function endSession() {
    if (document.body.dataset.state !== "running" || !audio) return;

    setState("ending");
    clearInterval(tickTimer);

    const fading = audio;
    audio = null;
    fading.master.gain.rampTo(0, fadeOut);

    // The bell rings on after the fade, so it gets cleaned up later.
    setTimeout(() => fading.bellNodes.forEach(node => node.dispose()), 12000);

    setTimeout(() => {
        setState("idle");
        fading.oscillators.forEach(osc => osc.stop());
        fading.nodes.forEach(node => node.dispose());
    }, (fadeOut + 0.5) * 1000);
}

setupForm.addEventListener("submit", beginSession);
endBtn.addEventListener("click", endSession);

// Dragging on the pad, which keeps working if the pointer leaves the box mid drag.
pad.addEventListener("pointerdown", (event) => {
    pad.setPointerCapture(event.pointerId);
    pressing = true;
    startPreview();
    padPoint(event);
});
pad.addEventListener("pointermove", (event) => {
    if (pad.hasPointerCapture(event.pointerId)) padPoint(event);
});
pad.addEventListener("lostpointercapture", stopPreview);

// Arrow keys move the pad too, and play the preview while held.
pad.addEventListener("keydown", (event) => {
    const moves = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    pressing = true;
    startPreview();
    const x = Number(pad.style.getPropertyValue("--x")) + move[0];
    const y = Number(pad.style.getPropertyValue("--y")) + move[1];
    setPad(x, y);
});
pad.addEventListener("keyup", stopPreview);

// Escape ends the session.
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") endSession();
});
