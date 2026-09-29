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

let startInstant = null;
let totalDuration = null;
let audio = null;
let tickTimer = null;
let fadeOut = 5;
let chimes = [];
let chimesRung = 0;
let chimesPlanned = 0;

// Steps up a pentatonic scale, one per chime.
const RISE = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2, 3];

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

// Two drones and a pad run through a lowpass filter and reverb, fading in from silence. Idk Claude mostly did this stuff. I'm a designer, idk anything about music.
function buildAudio(voice, root, fadeIn, volume) {
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

    // Chime synth, in tune with the drone and following the volume slider.
    const chimeGain = new Tone.Gain(0.4 * volume).toDestination();
    const chimeReverb = new Tone.Reverb({ decay: 4, wet: 0.35 }).connect(chimeGain);
    const chime = new Tone.FMSynth({
        harmonicity: 5,
        modulationIndex: 1.5,
        envelope: { attack: 0.002, decay: 20, sustain: 0, release: 20 },
        modulationEnvelope: { attack: 0.002, decay: 10, sustain: 0, release: 10 }
    }).connect(chimeReverb);

    // The final chime: lower and longer than the rest, so the end is clear without counting.
    const endChime = new Tone.FMSynth({
        harmonicity: 5,
        modulationIndex: 1.5,
        envelope: { attack: 0.002, decay: 60, sustain: 0, release: 60 },
        modulationEnvelope: { attack: 0.002, decay: 30, sustain: 0, release: 30 }
    }).connect(chimeReverb);

    return {
        preset,
        root,
        master,
        filter,
        padGain,
        drone1,
        drone2,
        oscillators,
        nodes: [...oscillators, droneGain, padGain, filter, reverb, master],
        chime,
        endChime,
        chimeNodes: [chime, endChime, chimeReverb, chimeGain]
    };
}

// Temporal gives the fraction of the session passed, read fresh from the clock every time so it never drifts.
function getProgress() {
    const elapsed = Temporal.Now.instant().since(startInstant);
    return Math.min(1, elapsed.total("milliseconds") / totalDuration.total("milliseconds"));
}

// Turns progress into sound across three phases: settling, steady and closing.
function applyProgress(p) {
    const b = audio.preset.brightness;
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

// Closing-in chimes: halfway, then halfway through whatever's left, again and again,
// stopping before they'd be under 1.2 s apart. Worked out with Temporal.
function planChimes() {
    const total = totalDuration.total("milliseconds");
    const plan = [];
    let gap = total / 2;
    let at = gap;
    while (gap >= 1200) {
        plan.push(startInstant.add({ milliseconds: Math.round(at) }));
        gap /= 2;
        at += gap;
    }
    return plan;
}

// Plays a chime once its moment has come. If the tab was asleep and several are due, it plays just one.
function playDueChimes() {
    const now = Temporal.Now.instant();
    let due = false;
    while (chimes.length && Temporal.Instant.compare(now, chimes[0]) >= 0) {
        chimes.shift();
        due = true;
    }
    if (!due) return;

    // Each chime is a step higher, so they rise as the end gets closer.
    const step = RISE[Math.min(chimesRung, RISE.length - 1)];
    // They also start soft and get louder, so the first one doesn't startle anyone.
    const loudness = chimesPlanned > 1 ? 0.35 + 0.65 * chimesRung / (chimesPlanned - 1) : 1;
    audio.chime.triggerAttackRelease(audio.root * 4 * step, 1, undefined, loudness);
    chimesRung++;
}

// The rising chimes build up, and this one drops back to the home note an octave above the drone.
function ringEndChime() {
    audio.endChime.triggerAttackRelease(audio.root * 2, 4);
}

// The sound's clock runs four times a second and keeps going in a background tab.
function tick() {
    const p = getProgress();
    applyProgress(p);
    playDueChimes();
    // The end chime only rings when time runs out, not when you end it yourself.
    if (p >= 1) {
        ringEndChime();
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
    const root = Number(choices.get("tuning"));
    const fadeIn = clamp(Number(choices.get("fadeIn")), 1, 30);
    const volume = Number(choices.get("volume"));
    fadeOut = clamp(Number(choices.get("fadeOut")), 1, 30);

    // CSS reads this so the screen fades out over the same time as the sound.
    document.body.style.setProperty("--fade-out", fadeOut + "s");

    setState("running");
    await Tone.start();

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

    audio = buildAudio(voice, root, fadeIn, volume);
    chimes = planChimes();
    chimesRung = 0;
    chimesPlanned = chimes.length;

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

    // Chimes can still be ringing, so they're cleaned up later.
    setTimeout(() => fading.chimeNodes.forEach(node => node.dispose()), 12000);

    setTimeout(() => {
        setState("idle");
        fading.oscillators.forEach(osc => osc.stop());
        fading.nodes.forEach(node => node.dispose());
    }, (fadeOut + 0.5) * 1000);
}

setupForm.addEventListener("submit", beginSession);
endBtn.addEventListener("click", endSession);

// Escape ends the session.
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") endSession();
});
