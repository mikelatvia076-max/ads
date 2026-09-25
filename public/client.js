// ============================================================
// CLIENT.JS
// ============================================================

// Default Socket.IO behaviour starts on slow HTTP long-polling and
// only upgrades to a WebSocket afterwards - that handshake is what
// makes joining feel slow even though the click itself is instant.
// Asking for websocket first (falling back to polling only if a
// network/proxy blocks it) skips that wait on almost every setup.
const socket = io({
    transports: ["websocket", "polling"]
});

// ============================================================
// SERVICE WORKER + PUSH NOTIFICATIONS
// Lets the phone show a notification (new message, incoming
// call) even when this tab isn't open/focused. Registering the
// worker just makes push possible; actually subscribing (which
// triggers the permission prompt) only happens once the user
// has joined the chat - see setupPushNotifications() below.
// ============================================================

if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker
            .register("/sw.js")
            .catch(error => console.error("Service worker registration failed:", error));
    });
}

function urlBase64ToUint8Array(base64String) {

    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const output = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; i++) {
        output[i] = rawData.charCodeAt(i);
    }

    return output;
}

async function setupPushNotifications() {

    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission === "denied") return;

    try {

        const keyRes = await fetch("/api/push/vapid-public-key");
        const { enabled, publicKey } = await keyRes.json();
        if (!enabled) return;

        const permission =
            Notification.permission === "granted"
                ? "granted"
                : await Notification.requestPermission();

        if (permission !== "granted") return;

        const registration = await navigator.serviceWorker.ready;

        let subscription = await registration.pushManager.getSubscription();

        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            });
        }

        socket.emit("push-subscribe", subscription.toJSON());

    } catch (error) {
        console.error("Push subscription failed:", error);
    }
}

// routes a tap on a background notification (or the ?openChat=/
// ?answerCall= link it opened the app with) to the right screen
function handleNotificationRoute(data) {

    if (!data) return;

    if (data.type === "call" && data.fromId) {
        waitForIncomingOfferAndAnswer(data.fromId);
    } else if (data.type === "message" && data.chatId) {
        openChatFromNotification(data.chatId);
    }
}

function openChatFromNotification(chatId) {

    if (isGroupChatId(chatId)) {
        const group = myGroups.get(chatId);
        if (group) openChat(group.id, group.name, group);
        return;
    }

    const name = (usersOnline[chatId] && usersOnline[chatId].name) || chatId;
    openChat(chatId, name);
}

// the actual WebRTC offer only arrives over the socket (see
// socket.on("incoming-call") below) - it may take a moment to land
// after we've just (re)joined, so this waits briefly rather than
// assuming it's already there the instant the app opens
function waitForIncomingOfferAndAnswer(fromId, triesLeft = 25) {

    if (pendingOffer && pendingOffer.fromId === fromId) {
        if (acceptCallBtn) acceptCallBtn.click();
        return;
    }

    if (triesLeft <= 0) return;

    setTimeout(() => waitForIncomingOfferAndAnswer(fromId, triesLeft - 1), 200);
}

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data && event.data.type === "notification-click") {
            handleNotificationRoute(event.data.data);
        }
    });
}

let me = null;
let activeChat = null;
let myAvatar =
    localStorage.getItem("siteChatAvatar") || null;

// groups the current user belongs to, id -> group object
// { id, name, memberIds, adminIds, createdBy }
const myGroups = new Map();

// group ids always start with "g_" (assigned by the server) so
// this never needs a lookup - see convoKey/renderMessages/etc.
function isGroupChatId(id) {
    return typeof id === "string" && id.startsWith("g_");
}

const conversations = {};
const usersOnline = {};
const unreadCounts = {};

// conversation ids whose history has already been fetched from the
// server this session, so re-opening a chat doesn't re-fetch it
const historyLoaded = new Set();

// per-conversation disappearing-messages setting, keyed by the other
// user's id: { enabled, seconds }
const disappearingSettings = {};

// per-conversation "where you reached": the id of the last message
// each side has read, keyed by the other user's id
const lastReadPointers = {};

const DISAPPEARING_OPTIONS = [
    { seconds: 0, label: "Off" },
    { seconds: 86400, label: "24 hours" },
    { seconds: 604800, label: "7 days" },
    { seconds: 7776000, label: "90 days" }
];

// message being replied to right now (or null)
let replyingTo = null;
let editingMessage = null;

// one pinned message id per conversation: { [convoKey]: messageId }
const pinnedMessages = {};

const friendIds = new Set(
    JSON.parse(
        localStorage.getItem("siteChatFriends") || "[]"
    )
);

// Cache of { id: { name, avatar } } for every friend we've ever seen
// online, so the friends panel can still show their name/avatar
// (just without the green dot) after they go offline, instead of
// dropping them from the list entirely.
const friendProfiles =
    JSON.parse(
        localStorage.getItem("siteChatFriendProfiles") || "{}"
    );

function saveFriendProfiles() {

    localStorage.setItem(
        "siteChatFriendProfiles",
        JSON.stringify(friendProfiles)
    );

}

function cacheFriendProfile(u) {

    if (!u || !u.id) return;

    friendProfiles[u.id] = {
        name: u.name,
        avatar: u.avatar || null
    };

    saveFriendProfiles();

}

const pendingSent = new Set(
    JSON.parse(
        localStorage.getItem("siteChatPendingSent") || "[]"
    )
);

const pendingReceived = new Map();

const savedName =
    localStorage.getItem("siteChatName");

const savedEmail =
    localStorage.getItem("siteChatEmail");


// ============================================================
// DOM
// ============================================================

const joinScreen =
    document.getElementById("joinScreen");

const nameInput =
    document.getElementById("nameInput");

const emailInput =
    document.getElementById("emailInput");

const joinBtn =
    document.getElementById("joinBtn");

const joinFormFields =
    document.getElementById("joinFormFields");

const autoSigninState =
    document.getElementById("autoSigninState");

const autoSigninText =
    document.getElementById("autoSigninText");

const forgotNameBtn =
    document.getElementById("forgotNameBtn");

const forgotNameModal =
    document.getElementById("forgotNameModal");

const forgotNameBackdrop =
    document.getElementById("forgotNameBackdrop");

const closeForgotModal =
    document.getElementById("closeForgotModal");

const forgotEmailInput =
    document.getElementById("forgotEmailInput");

const forgotNameMsg =
    document.getElementById("forgotNameMsg");

const forgotNameSubmit =
    document.getElementById("forgotNameSubmit");

const createAccountBtn =
    document.getElementById("createAccountBtn");

const createAccountModal =
    document.getElementById("createAccountModal");

const createAccountBackdrop =
    document.getElementById("createAccountBackdrop");

const closeCreateAccountModalBtn =
    document.getElementById("closeCreateAccountModal");

const createAccountNameInput =
    document.getElementById("createAccountNameInput");

const createAccountEmailInput =
    document.getElementById("createAccountEmailInput");

const createAccountMsg =
    document.getElementById("createAccountMsg");

const createAccountSubmit =
    document.getElementById("createAccountSubmit");

const niceAlertModal =
    document.getElementById("niceAlertModal");

const niceAlertBackdrop =
    document.getElementById("niceAlertBackdrop");

const niceAlertIcon =
    document.getElementById("niceAlertIcon");

const niceAlertTitle =
    document.getElementById("niceAlertTitle");

const niceAlertMsg =
    document.getElementById("niceAlertMsg");

const niceAlertOk =
    document.getElementById("niceAlertOk");

const niceConfirmModal =
    document.getElementById("niceConfirmModal");

const niceConfirmBackdrop =
    document.getElementById("niceConfirmBackdrop");

const niceConfirmIcon =
    document.getElementById("niceConfirmIcon");

const niceConfirmTitle =
    document.getElementById("niceConfirmTitle");

const niceConfirmMsg =
    document.getElementById("niceConfirmMsg");

const niceConfirmCancel =
    document.getElementById("niceConfirmCancel");

const niceConfirmOkBtn =
    document.getElementById("niceConfirmOk");

const app =
    document.getElementById("app");

const meName =
    document.getElementById("meName");

const userListEl =
    document.getElementById("friendsList");

const chatBackBtn =
    document.getElementById("chatBackBtn");

const chatWith =
    document.getElementById("chatWith");

const chatStatus =
    document.getElementById("chatStatus");

const headerActions =
    document.getElementById("headerActions");

const disappearingBtn =
    document.getElementById("disappearingBtn");

const disappearingMenu =
    document.getElementById("disappearingMenu");

const disappearingOptions =
    document.getElementById("disappearingOptions");

const messagesEl =
    document.getElementById("messages");

const composer =
    document.getElementById("composer");

const textInput =
    document.getElementById("textInput");

const sendBtn =
    document.getElementById("sendBtn");

const attachBtn =
    document.getElementById("attachBtn");

const fileInput =
    document.getElementById("fileInput");

const micBtn =
    document.getElementById("micBtn");

const recordingBar =
    document.getElementById("recordingBar");

const recTimer =
    document.getElementById("recTimer");

const cancelRecBtn =
    document.getElementById("cancelRecBtn");

const pauseRecBtn =
    document.getElementById("pauseRecBtn");

const stopRecBtn =
    document.getElementById("stopRecBtn");

const audioCallBtn =
    document.getElementById("audioCallBtn");

const videoCallBtn =
    document.getElementById("videoCallBtn");

const addParticipantBtn =
    document.getElementById("addParticipantBtn");

const newGroupBtn =
    document.getElementById("newGroupBtn");

const groupsListEl =
    document.getElementById("groupsList");

const emojiBtn =
    document.getElementById("emojiBtn");

const emojiPanel =
    document.getElementById("emojiPanel");

const emojiGrid =
    document.getElementById("emojiGrid");

const stickerGrid =
    document.getElementById("stickerGrid");

const emojiTabContent =
    document.getElementById("emojiTabContent");

const stickerTabContent =
    document.getElementById("stickerTabContent");

const emojiSearch =
    document.getElementById("emojiSearch");

const emojiCategoryBar =
    document.getElementById("emojiCategoryBar");

const stickerCategoryBar =
    document.getElementById("stickerCategoryBar");

const gifTabContent =
    document.getElementById("gifTabContent");

const gifSearch =
    document.getElementById("gifSearch");

const gifGrid =
    document.getElementById("gifGrid");

const replyPreviewBar =
    document.getElementById("replyPreviewBar");

const replyPreviewName =
    document.getElementById("replyPreviewName");

const replyPreviewText =
    document.getElementById("replyPreviewText");

const replyPreviewClose =
    document.getElementById("replyPreviewClose");

const pinnedBanner =
    document.getElementById("pinnedBanner");

const pinnedBannerText =
    document.getElementById("pinnedBannerText");

const pinnedBannerClose =
    document.getElementById("pinnedBannerClose");


// ============================================================
// ACCOUNT
// ============================================================

const accountBtn =
    document.getElementById("accountBtn");

const accountMenu =
    document.getElementById("accountMenu");

const accountName =
    document.getElementById("accountName");

const accountAvatar =
    document.getElementById("accountAvatar");

const accountAvatarInner =
    document.getElementById("accountAvatarInner");

const avatarInput =
    document.getElementById("avatarInput");

const avatarEditBadge =
    document.getElementById("avatarEditBadge");

const friendsCount =
    document.getElementById("friendsCount");

const requestsCount =
    document.getElementById("requestsCount");

const accountRequestDot =
    document.getElementById("accountRequestDot");

const logoutBtn =
    document.getElementById("logoutBtn");

const deleteAccountBtn =
    document.getElementById("deleteAccountBtn");

const accountPanel =
    document.getElementById("accountPanel");

const accountPanelTitle =
    document.getElementById("accountPanelTitle");

const accountPanelSubtitle =
    document.getElementById("accountPanelSubtitle");

const accountPanelBody =
    document.getElementById("accountPanelBody");

const closeAccountPanel =
    document.getElementById("closeAccountPanel");


// ============================================================
// FIND FRIEND
// ============================================================

const findFriendBtn =
    document.getElementById("findFriendBtn");

const findFriendPanel =
    document.getElementById("findFriendPanel");

const closeFindFriend =
    document.getElementById("closeFindFriend");

const friendSearchInput =
    document.getElementById("friendSearchInput");

const allUsersList =
    document.getElementById("allUsersList");

const findFriendOverlay =
    document.querySelector(".find-friend-overlay");

const findFriendCard =
    document.querySelector(".find-friend-card");


// ============================================================
// COUNTS
// ============================================================

const onlineFriendsCount =
    document.getElementById(
        "onlineFriendsCount"
    );


// ============================================================
// CALL DOM
// ============================================================

const callOverlay =
    document.getElementById("callOverlay");

const callStatusText =
    document.getElementById(
        "callStatusText"
    );

const remoteVideo =
    document.getElementById("remoteVideo");

const localVideo =
    document.getElementById("localVideo");

const muteBtn =
    document.getElementById("muteBtn");

const speakerBtn =
    document.getElementById("speakerBtn");

const screenShareBtn =
    document.getElementById("screenShareBtn");

const recordCallBtn =
    document.getElementById("recordCallBtn");

const callRecordingBadge =
    document.getElementById("callRecordingBadge");

const hangupBtn =
    document.getElementById("hangupBtn");

const minimizeCallBtn =
    document.getElementById("minimizeCallBtn");

const callTimerText =
    document.getElementById("callTimerText");

const floatingCallBubble =
    document.getElementById("floatingCallBubble");

const floatingCallBubbleLabel =
    document.getElementById("floatingCallBubbleLabel");

const floatingCallBubbleIcon =
    document.getElementById("floatingCallBubbleIcon");

const floatingCallBubbleTimer =
    document.getElementById("floatingCallBubbleTimer");

const floatingCallBubbleHangup =
    document.getElementById("floatingCallBubbleHangup");

const activeCallBanner =
    document.getElementById("activeCallBanner");

const activeCallBannerText =
    document.getElementById("activeCallBannerText");

const activeCallBannerJoin =
    document.getElementById("activeCallBannerJoin");

const incomingCall =
    document.getElementById("incomingCall");

const incomingText =
    document.getElementById("incomingText");

const acceptCallBtn =
    document.getElementById(
        "acceptCallBtn"
    );

const declineCallBtn =
    document.getElementById(
        "declineCallBtn"
    );


// ============================================================
// SOUND KIT — notification & ringtone playback
// (tones are synthesized with the Web Audio API, so there are no
// external sound files to load/license — plus a "from device" option
// per section that plays back a user-uploaded clip instead)
// ============================================================

let audioCtx = null;

function getAudioCtx() {

    if (!audioCtx) {

        const AC =
            window.AudioContext ||
            window.webkitAudioContext;

        if (!AC) return null;

        audioCtx = new AC();

    }


    if (audioCtx.state === "suspended") {

        audioCtx.resume();

    }


    return audioCtx;

}


function playTone(
    ctx,
    { freq, start, duration, type = "sine", gain = 0.22 }
) {

    if (!ctx) return;

    const osc =
        ctx.createOscillator();

    const g =
        ctx.createGain();

    osc.type = type;

    osc.frequency.setValueAtTime(
        freq,
        ctx.currentTime + start
    );

    g.gain.setValueAtTime(
        0,
        ctx.currentTime + start
    );

    g.gain.linearRampToValueAtTime(
        gain,
        ctx.currentTime + start + 0.02
    );

    g.gain.exponentialRampToValueAtTime(
        0.001,
        ctx.currentTime + start + duration
    );

    osc.connect(g);
    g.connect(ctx.destination);

    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + duration + 0.05);

}


const NOTIFICATION_PRESETS = {

    chime: {
        label: "Chime",
        play: (ctx) => {
            playTone(ctx, { freq: 660, start: 0, duration: 0.18 });
            playTone(ctx, { freq: 880, start: 0.15, duration: 0.25 });
        }
    },

    ping: {
        label: "Ping",
        play: (ctx) => {
            playTone(ctx, { freq: 1000, start: 0, duration: 0.12, type: "triangle", gain: 0.28 });
        }
    },

    bell: {
        label: "Bell",
        play: (ctx) => {
            playTone(ctx, { freq: 523, start: 0, duration: 0.6, gain: 0.2 });
            playTone(ctx, { freq: 1046, start: 0, duration: 0.4, gain: 0.08 });
        }
    },

    marimba: {
        label: "Marimba",
        play: (ctx) => {
            [523, 659, 784].forEach(
                (f, i) =>
                    playTone(ctx, { freq: f, start: i * 0.12, duration: 0.2, type: "triangle" })
            );
        }
    },

    digital: {
        label: "Digital",
        play: (ctx) => {
            playTone(ctx, { freq: 440, start: 0, duration: 0.08, type: "square", gain: 0.16 });
            playTone(ctx, { freq: 440, start: 0.12, duration: 0.08, type: "square", gain: 0.16 });
        }
    }

};


// plays a repeating back-and-forth tone for `totalLen` seconds — this
// is what makes a ringtone sound like a sustained "brrring" instead
// of a single short blip
function playTrill(
    ctx,
    { freqs, toneLen = 0.14, totalLen = 2, type = "sine", gain = 0.22 }
) {

    let t = 0;
    let i = 0;

    while (t < totalLen) {

        playTone(
            ctx,
            {
                freq: freqs[i % freqs.length],
                start: t,
                duration: toneLen,
                type,
                gain
            }
        );

        t += toneLen;
        i++;

    }

}


const RINGTONE_PRESETS = {

    whatsapp: {
        label: "WhatsApp-style Ring",
        cycleMs: 3200,
        // a bright two-note "brring-brring" double pulse, repeated -
        // close in cadence/feel to the familiar WhatsApp ringtone
        // without reproducing any actual copyrighted audio
        play: (ctx) => {
            [0, 0.32].forEach(offset => {
                playTone(ctx, { freq: 1000, start: offset, duration: 0.22, type: "sine", gain: 0.26 });
                playTone(ctx, { freq: 1300, start: offset + 0.06, duration: 0.2, type: "sine", gain: 0.2 });
            });
        }
    },

    classic: {
        label: "Classic Ring",
        cycleMs: 3600,
        play: (ctx) =>
            playTrill(ctx, {
                freqs: [480, 620],
                toneLen: 0.16,
                totalLen: 2.2,
                gain: 0.22
            })
    },

    marimbaRing: {
        label: "Marimba Ring",
        cycleMs: 3800,
        play: (ctx) =>
            playTrill(ctx, {
                freqs: [523, 659, 784, 659],
                toneLen: 0.18,
                totalLen: 2.4,
                type: "triangle",
                gain: 0.22
            })
    },

    pulse: {
        label: "Pulse",
        cycleMs: 3400,
        play: (ctx) =>
            playTrill(ctx, {
                freqs: [700, 700, 900],
                toneLen: 0.16,
                totalLen: 2,
                type: "square",
                gain: 0.16
            })
    },

    soft: {
        label: "Soft Bell",
        cycleMs: 3800,
        play: (ctx) => {

            playTone(ctx, { freq: 587, start: 0, duration: 0.9, gain: 0.18 });
            playTone(ctx, { freq: 784, start: 0.05, duration: 0.8, gain: 0.1 });
            playTone(ctx, { freq: 587, start: 1.1, duration: 0.9, gain: 0.18 });
            playTone(ctx, { freq: 784, start: 1.15, duration: 0.8, gain: 0.1 });

        }
    }

};


function getSoundChoice(kind) {

    return (
        localStorage.getItem(`siteChat${kind}Choice`) ||
        (kind === "Ringtone" ? "whatsapp" : "chime")
    );

}


function getSoundPresets(kind) {

    return kind === "Ringtone" ?
        RINGTONE_PRESETS :
        NOTIFICATION_PRESETS;

}


function playNotificationSound() {

    const choice =
        getSoundChoice("Notification");

    if (choice === "custom") {

        const dataUrl =
            localStorage.getItem(
                "siteChatNotificationCustom"
            );

        if (dataUrl) {

            const audio =
                new Audio(dataUrl);

            audio.play().catch(
                () => {}
            );

        }

        return;

    }


    const preset =
        NOTIFICATION_PRESETS[choice];

    if (preset) {

        preset.play(
            getAudioCtx()
        );

    }

}


let ringtoneInterval =
    null;

let ringtoneAudioEl =
    null;

function startRingtoneLoop() {

    stopRingtoneLoop();

    const choice =
        getSoundChoice("Ringtone");

    if (choice === "custom") {

        const dataUrl =
            localStorage.getItem(
                "siteChatRingtoneCustom"
            );

        if (dataUrl) {

            ringtoneAudioEl =
                new Audio(dataUrl);

            ringtoneAudioEl.loop =
                true;

            ringtoneAudioEl.play().catch(
                () => {}
            );

        }

        return;

    }


    const preset =
        RINGTONE_PRESETS[choice] ||
        RINGTONE_PRESETS.whatsapp;

    const ctx =
        getAudioCtx();

    preset.play(ctx);

    ringtoneInterval =
        setInterval(
            () => preset.play(ctx),
            preset.cycleMs
        );

}

function stopRingtoneLoop() {

    if (ringtoneInterval) {

        clearInterval(
            ringtoneInterval
        );

        ringtoneInterval =
            null;

    }


    if (ringtoneAudioEl) {

        ringtoneAudioEl.pause();

        ringtoneAudioEl =
            null;

    }

}


// max size for a custom uploaded sound, kept small since it's
// stored as a base64 string in localStorage (which typically caps
// out around 5-10MB total per site)
const MAX_CUSTOM_SOUND_BYTES =
    1.5 * 1024 * 1024;

function handleCustomSoundUpload(
    kind,
    file
) {

    return new Promise(
        (resolve, reject) => {

            if (!file.type.startsWith("audio/")) {

                reject(
                    new Error(
                        "Please choose an audio file."
                    )
                );

                return;

            }


            if (file.size > MAX_CUSTOM_SOUND_BYTES) {

                reject(
                    new Error(
                        "That file is too large — please choose something under 1.5MB (a short clip is plenty)."
                    )
                );

                return;

            }


            const reader =
                new FileReader();

            reader.onload =
                () => {

                    localStorage.setItem(
                        `siteChat${kind}Custom`,
                        reader.result
                    );

                    localStorage.setItem(
                        `siteChat${kind}Choice`,
                        "custom"
                    );

                    resolve();

                };

            reader.onerror =
                () =>
                    reject(
                        new Error(
                            "Couldn't read that file."
                        )
                    );

            reader.readAsDataURL(
                file
            );

        }
    );

}

if (joinBtn) {

    joinBtn.addEventListener(
        "click",
        join
    );

}


if (nameInput) {

    nameInput.addEventListener(
        "keydown",
        (e) => {

            if (e.key === "Enter") {
                join();
            }

        }
    );

}


if (emailInput) {

    emailInput.addEventListener(
        "keydown",
        (e) => {

            if (e.key === "Enter") {
                join();
            }

        }
    );

}


// ---- returning user: auto sign back in until they log out ----

if (
    savedName &&
    savedEmail &&
    nameInput
) {

    nameInput.value =
        savedName;

    if (emailInput) {
        emailInput.value = savedEmail;
    }

    // show a lightweight "signing you in…" state instead of the
    // full form, so a returning user lands straight in the app
    // rather than seeing empty inputs flash by
    if (joinFormFields) joinFormFields.classList.add("hidden");

    if (autoSigninState) {
        autoSigninState.classList.remove("hidden");
        if (autoSigninText) {
            autoSigninText.textContent = `Welcome back, ${savedName} — signing you in…`;
        }
    }

    join();

} else if (savedName && nameInput) {

    // we know their name but not their email (e.g. saved before
    // accounts existed) - pre-fill it but let them fill in email
    // and tap Join themselves rather than auto-submitting
    nameInput.value = savedName;

}


// a real email check - type="email" on the inputs only validates
// through the browser's native form machinery, which we bypass by
// reading .value directly on button clicks, so we check it ourselves
function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function join() {

    if (!nameInput) return;

    const name =
        nameInput.value.trim();

    if (!name) return;

    const email =
        emailInput ? emailInput.value.trim() : "";

    if (!email) {

        resetJoinButton();

        showNiceAlert(
            "Enter the email you used to create your account, then join. Don't have one yet? Tap \"Create new account\" first.",
            { title: "Email needed", icon: "fa-user-lock", onClose: () => {
                if (emailInput) emailInput.focus();
            } }
        );

        return;
    }

    if (name.includes("@")) {

        resetJoinButton();

        showNiceAlert(
            "That doesn't look like a name. Check you haven't put your email in the name field.",
            { title: "Check your name", icon: "fa-triangle-exclamation", onClose: () => {
                if (nameInput) nameInput.focus();
            } }
        );

        return;
    }

    if (!isValidEmail(email)) {

        resetJoinButton();

        showNiceAlert(
            "Enter a valid email address (e.g. name@example.com).",
            { title: "Check your email", icon: "fa-triangle-exclamation", onClose: () => {
                if (emailInput) emailInput.focus();
            } }
        );

        return;
    }

    // audio playback needs a user gesture to unlock in most browsers —
    // the join click is that gesture, so future notification/ringtone
    // sounds triggered by socket events don't need one of their own
    getAudioCtx();

    localStorage.setItem(
        "siteChatName",
        name
    );

    localStorage.setItem("siteChatEmail", email);

    if (joinBtn) {

        joinBtn.disabled =
            true;

        joinBtn.dataset.originalText =
            joinBtn.dataset.originalText ||
            joinBtn.textContent;

        joinBtn.textContent =
            "Joining...";

    }

    socket.emit(
        "join",
        { name, email }
    );

}


function resetJoinButton() {

    // back out of the "signing you in…" auto-login state, if we
    // were in it, and show the real form again
    if (joinFormFields) joinFormFields.classList.remove("hidden");
    if (autoSigninState) autoSigninState.classList.add("hidden");

    if (!joinBtn) return;

    joinBtn.disabled =
        false;

    joinBtn.textContent =
        joinBtn.dataset.originalText ||
        "Join";

}


socket.on(
    "connect_error",
    () => {

        resetJoinButton();

    }
);


// ============================================================
// DECORATED ALERT (replaces native alert() for user-facing messages)
// ============================================================

function showNiceAlert(message, { title = "Heads up", icon = "fa-triangle-exclamation", onClose } = {}) {

    if (!niceAlertModal) {
        alert(message);
        if (onClose) onClose();
        return;
    }

    if (niceAlertTitle) niceAlertTitle.textContent = title;
    if (niceAlertMsg) niceAlertMsg.textContent = message;
    if (niceAlertIcon) niceAlertIcon.innerHTML = `<i class="fa-solid ${icon}"></i>`;

    niceAlertModal.classList.remove("hidden");

    const close = () => {
        niceAlertModal.classList.add("hidden");
        niceAlertOk.removeEventListener("click", close);
        niceAlertBackdrop.removeEventListener("click", close);
        if (onClose) onClose();
    };

    niceAlertOk.addEventListener("click", close);
    niceAlertBackdrop.addEventListener("click", close);
}


// ============================================================
// DECORATED CONFIRM (replaces native confirm() for user prompts)
// Returns a Promise<boolean> — use with async/await or .then()
// ============================================================

function showNiceConfirm(message, { title = "Are you sure?", icon = "fa-triangle-exclamation", danger = true, confirmText = "Confirm", cancelText = "Cancel" } = {}) {

    return new Promise((resolve) => {

        if (!niceConfirmModal) {
            resolve(window.confirm(message));
            return;
        }

        if (niceConfirmTitle) niceConfirmTitle.textContent = title;
        if (niceConfirmMsg) niceConfirmMsg.textContent = message;
        if (niceConfirmIcon) {
            niceConfirmIcon.innerHTML = `<i class="fa-solid ${icon}"></i>`;
            niceConfirmIcon.classList.toggle("info", !danger);
        }
        if (niceConfirmOkBtn) {
            niceConfirmOkBtn.textContent = confirmText;
            niceConfirmOkBtn.classList.toggle("danger", danger);
        }
        if (niceConfirmCancel) niceConfirmCancel.textContent = cancelText;

        niceConfirmModal.classList.remove("hidden");

        const finish = (result) => {
            niceConfirmModal.classList.add("hidden");
            niceConfirmOkBtn.removeEventListener("click", onOk);
            niceConfirmCancel.removeEventListener("click", onCancel);
            niceConfirmBackdrop.removeEventListener("click", onCancel);
            resolve(result);
        };

        const onOk = () => finish(true);
        const onCancel = () => finish(false);

        niceConfirmOkBtn.addEventListener("click", onOk);
        niceConfirmCancel.addEventListener("click", onCancel);
        niceConfirmBackdrop.addEventListener("click", onCancel);
    });
}


// ============================================================
// NAME ALREADY TAKEN
// ============================================================

socket.on(
    "name-taken",
    ({ name }) => {

        resetJoinButton();

        localStorage.removeItem(
            "siteChatName"
        );

        if (joinScreen) {

            joinScreen.classList.remove(
                "hidden"
            );

        }

        if (app) {

            app.classList.add(
                "hidden"
            );

        }

        showNiceAlert(
            `"${name}" is already online right now. Please choose a different name.`,
            { title: "Name already taken", icon: "fa-user-group", onClose: () => {

                if (nameInput) {

                    nameInput.value =
                        "";

                    nameInput.focus();

                }

            } }
        );

    }
);


// ============================================================
// ACCOUNT REQUIRED (join was rejected - no matching account)
// ============================================================

socket.on(
    "account-required",
    ({ reason, email, name } = {}) => {

        resetJoinButton();

        localStorage.removeItem("siteChatName");
        localStorage.removeItem("siteChatEmail");

        if (joinScreen) joinScreen.classList.remove("hidden");
        if (app) app.classList.add("hidden");

        let message;

        if (reason === "not-found") {
            message = `We don't have an account for ${email || "that email"} yet. Tap "Create new account" first.`;
        } else if (reason === "mismatch") {
            message = `That name doesn't match the account for ${email || "that email"}${name ? ` (it's registered as "${name}")` : ""}. Try "Forgot your name?" or check your email.`;
        } else if (reason === "invalid-email") {
            message = "That doesn't look like a valid email address. Please check it and try again.";
        } else {
            message = "Enter the email you used to create your account, then join.";
        }

        showNiceAlert(
            message,
            { title: "Account needed", icon: "fa-user-lock", onClose: () => {

                if (reason === "mismatch" && name && nameInput) {
                    nameInput.value = name;
                }

                if (emailInput) emailInput.focus();
                else if (nameInput) nameInput.focus();

            } }
        );

    }
);


// ============================================================
// FORGOT NAME (looks up the name saved against an email)
// ============================================================

function openForgotNameModal() {

    if (!forgotNameModal) return;

    if (forgotEmailInput) {
        forgotEmailInput.value = emailInput ? emailInput.value.trim() : "";
    }

    if (forgotNameMsg) {
        forgotNameMsg.classList.add("hidden");
        forgotNameMsg.textContent = "";
    }

    forgotNameModal.classList.remove("hidden");

    if (forgotEmailInput) forgotEmailInput.focus();
}

function closeForgotNameModal() {
    if (forgotNameModal) forgotNameModal.classList.add("hidden");
}

if (forgotNameBtn) {
    forgotNameBtn.addEventListener("click", openForgotNameModal);
}

if (closeForgotModal) {
    closeForgotModal.addEventListener("click", closeForgotNameModal);
}

if (forgotNameBackdrop) {
    forgotNameBackdrop.addEventListener("click", closeForgotNameModal);
}

function submitForgotName() {

    if (!forgotEmailInput) return;

    const email = forgotEmailInput.value.trim();

    if (!email) {
        if (forgotNameMsg) {
            forgotNameMsg.textContent = "Enter the email you used before.";
            forgotNameMsg.classList.remove("hidden");
        }
        return;
    }

    if (!isValidEmail(email)) {
        if (forgotNameMsg) {
            forgotNameMsg.textContent = "Enter a valid email address (e.g. name@example.com).";
            forgotNameMsg.classList.remove("hidden");
        }
        return;
    }

    if (forgotNameMsg) {
        forgotNameMsg.classList.add("hidden");
        forgotNameMsg.textContent = "";
    }

    if (forgotNameSubmit) {
        forgotNameSubmit.disabled = true;
        forgotNameSubmit.textContent = "Looking…";
    }

    socket.emit("forgot-name", { email });
}

if (forgotNameSubmit) {
    forgotNameSubmit.addEventListener("click", submitForgotName);
}

if (forgotEmailInput) {

    forgotEmailInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitForgotName();
    });

}

socket.on("name-lookup-result", ({ found, name, email }) => {

    if (forgotNameSubmit) {
        forgotNameSubmit.disabled = false;
        forgotNameSubmit.textContent = "Find my name";
    }

    if (found && name) {

        if (nameInput) nameInput.value = name;
        if (emailInput) emailInput.value = email || (forgotEmailInput ? forgotEmailInput.value.trim() : "");

        closeForgotNameModal();

        showNiceAlert(
            `Found it — welcome back, ${name}!`,
            { title: "Name found", icon: "fa-circle-check" }
        );

    } else if (forgotNameMsg) {

        forgotNameMsg.textContent = "We couldn't find a name saved for that email.";
        forgotNameMsg.classList.remove("hidden");

    }

});


// ============================================================
// CREATE ACCOUNT (registers a name against an email so "Join"
// and "Forgot your name?" can find it later; refuses to create
// a duplicate if that email is already registered)
// ============================================================

function openCreateAccountModal() {

    if (!createAccountModal) return;

    if (createAccountNameInput) {
        createAccountNameInput.value = nameInput ? nameInput.value.trim() : "";
    }

    if (createAccountEmailInput) {
        createAccountEmailInput.value = emailInput ? emailInput.value.trim() : "";
    }

    if (createAccountMsg) {
        createAccountMsg.classList.add("hidden");
        createAccountMsg.textContent = "";
    }

    createAccountModal.classList.remove("hidden");

    if (createAccountNameInput) createAccountNameInput.focus();
}

function closeCreateAccountModal() {
    if (createAccountModal) createAccountModal.classList.add("hidden");
}

if (createAccountBtn) {
    createAccountBtn.addEventListener("click", openCreateAccountModal);
}

if (closeCreateAccountModalBtn) {
    closeCreateAccountModalBtn.addEventListener("click", closeCreateAccountModal);
}

if (createAccountBackdrop) {
    createAccountBackdrop.addEventListener("click", closeCreateAccountModal);
}

function resetCreateAccountSubmit() {

    if (!createAccountSubmit) return;

    createAccountSubmit.disabled = false;
    createAccountSubmit.textContent = "Create account";
}

function submitCreateAccount() {

    if (!createAccountNameInput || !createAccountEmailInput) return;

    const name = createAccountNameInput.value.trim();
    const email = createAccountEmailInput.value.trim();

    if (!name || !email) {

        if (createAccountMsg) {
            createAccountMsg.textContent = "Enter both your name and email.";
            createAccountMsg.classList.remove("hidden");
        }

        return;
    }

    if (name.includes("@")) {

        if (createAccountMsg) {
            createAccountMsg.textContent = "That doesn't look like a name — check the name and email fields aren't swapped.";
            createAccountMsg.classList.remove("hidden");
        }

        createAccountNameInput.focus();
        return;
    }

    if (!isValidEmail(email)) {

        if (createAccountMsg) {
            createAccountMsg.textContent = "Enter a valid email address (e.g. name@example.com).";
            createAccountMsg.classList.remove("hidden");
        }

        createAccountEmailInput.focus();
        return;
    }

    if (createAccountMsg) {
        createAccountMsg.classList.add("hidden");
        createAccountMsg.textContent = "";
    }

    if (createAccountSubmit) {
        createAccountSubmit.disabled = true;
        createAccountSubmit.textContent = "Creating…";
    }

    socket.emit("create-account", { name, email });
}

if (createAccountSubmit) {
    createAccountSubmit.addEventListener("click", submitCreateAccount);
}

if (createAccountNameInput) {

    createAccountNameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitCreateAccount();
    });

}

if (createAccountEmailInput) {

    createAccountEmailInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitCreateAccount();
    });

}

socket.on("account-created", ({ name, email } = {}) => {

    resetCreateAccountSubmit();
    closeCreateAccountModal();

    // carry the new account straight into the join fields so the
    // person can just hit "Join Site Chat" next
    if (nameInput && name) nameInput.value = name;
    if (emailInput && email) emailInput.value = email;

    // and remember it locally too, so the NEXT time they open the
    // site (new tab, closed browser, etc.) the join screen already
    // has it filled in / auto-signs them straight in
    if (name) localStorage.setItem("siteChatName", name);
    if (email) localStorage.setItem("siteChatEmail", email);

    showNiceAlert(
        `Account created — welcome, ${name}! Tap "Join Site Chat" to get started.`,
        { title: "Account created", icon: "fa-circle-check" }
    );

});

socket.on("account-exists", ({ name, email } = {}) => {

    resetCreateAccountSubmit();
    closeCreateAccountModal();

    // don't overwrite an existing account - just point them at Join,
    // pre-filling what we already know so it's a single tap
    if (emailInput && email) emailInput.value = email;
    if (nameInput && name) nameInput.value = name;

    showNiceAlert(
        `An account with that email already exists${name ? ` (${name})` : ""}. Please join the chat instead.`,
        { title: "Account already exists", icon: "fa-user-check" }
    );

});

socket.on("account-create-error", ({ message } = {}) => {

    resetCreateAccountSubmit();

    if (createAccountMsg) {
        createAccountMsg.textContent = message || "Something went wrong. Please try again.";
        createAccountMsg.classList.remove("hidden");
    }

});



// ============================================================
// JOINED
// ============================================================

socket.on(
    "joined",
    (payload) => {

        me = payload;

        if (meName) {

            meName.textContent =
                `You: ${me.name}`;

        }

        if (accountName) {

            accountName.textContent =
                me.name;

        }

        if (accountAvatarInner) {

            accountAvatarInner.innerHTML =
                avatarMarkup(
                    me.name,
                    myAvatar
                );

        }

        if (
            myAvatar &&
            socket.connected
        ) {

            // re-tell the server about our saved picture on every
            // (re)join, since presence is in-memory only and resets
            // per connection
            socket.emit(
                "set-avatar",
                myAvatar
            );

        }

        if (joinScreen) {

            joinScreen.classList.add(
                "hidden"
            );

        }

        if (app) {

            app.classList.remove(
                "hidden"
            );

        }

        refreshPeopleList();

        maybeShowJoinGroupInviteModal();

    }
);


// ============================================================
// RECONNECT / FAST PRESENCE REFRESH
// ============================================================
//
// Two separate problems used to make "online" status go stale after
// leaving and coming back to the chat:
//
// 1. Mobile browsers (and plain network blips) drop the underlying
//    socket when the tab is backgrounded/the phone is locked.
//    Socket.IO reconnects the transport automatically, but this app
//    never re-sent "join" on that reconnect - so the server never
//    put the user back into onlineChatUsers, and nobody's list
//    would show them online again until a full page reload.
//
// 2. Even for the other person's client (already online, connection
//    never dropped), there was nothing that asked the server for a
//    fresh list the moment you came back to the tab, so a stale
//    snapshot could sit around for a while.
//
// This fixes both: re-join automatically on every reconnect after
// the first, and ask for a fresh user list as soon as the tab
// becomes visible again.

let hasJoinedOnce = false;

socket.on(
    "joined",
    () => {
        hasJoinedOnce = true;
    }
);

socket.on(
    "connect",
    () => {

        if (hasJoinedOnce) {

            // This is a reconnect (not the very first connection) -
            // the server has no memory of us on this new socket, so
            // rejoin with the same name to restore our presence.
            join();

        }

    }
);

document.addEventListener(
    "visibilitychange",
    () => {

        if (
            document.visibilityState === "visible" &&
            me &&
            socket.connected
        ) {

            refreshPeopleList();

        }

    }
);


// ============================================================
// USER LIST / PRESENCE
// ============================================================

socket.on(
    "user-list",
    (list) => {

        Object.keys(usersOnline)
            .forEach(
                key =>
                    delete usersOnline[key]
            );


        list.forEach(
            (u) => {

                if (
                    !me ||
                    u.id === me.id
                ) {
                    return;
                }

                usersOnline[u.id] = u;

                if (friendIds.has(u.id)) {

                    cacheFriendProfile(u);

                }

            }
        );


        renderFriendsList();

        updateCounts();


        // Refresh Find Friend only if it is really open
        if (
            findFriendPanel &&
            !findFriendPanel.classList.contains(
                "hidden"
            ) &&
            findFriendPanel.style.display !== "none"
        ) {

            renderAllUsers(
                friendSearchInput
                    ? friendSearchInput.value
                    : ""
            );

        }

    }
);


// ============================================================
// RENDER LEFT FRIEND LIST
// ============================================================

function renderFriendsList() {

    if (!userListEl) return;

    userListEl.innerHTML = "";

    // Show every friend we know about - online friends use the live
    // usersOnline data (name/avatar can change, gets the green dot),
    // offline friends fall back to the last cached profile we have
    // for them so they don't just vanish from the list. Online
    // friends are listed first.
    const onlineList = [];
    const offlineList = [];

    friendIds.forEach(
        (friendId) => {

            const live =
                usersOnline[friendId];

            if (live) {

                onlineList.push(
                    { ...live, online: true }
                );

                return;

            }

            const cached =
                friendProfiles[friendId];

            offlineList.push({
                id: friendId,
                name:
                    cached ?
                        cached.name :
                        "Unknown",
                avatar:
                    cached ?
                        cached.avatar :
                        null,
                online: false
            });

        }
    );

    const allFriends =
        [...onlineList, ...offlineList];


    allFriends.forEach(
        (u) => {

            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "friend-item" +
                (u.online ? "" : " offline");

            item.dataset.id =
                u.id;


            item.innerHTML = `

                <div class="friend-avatar">

                    ${avatarMarkup(
                        u.name,
                        u.avatar
                    )}

                    ${
                        u.online
                            ? '<span class="friend-online-dot"></span>'
                            : ""
                    }

                </div>


                <div class="friend-details">

                    <strong class="friend-name">
                        ${escapeHtml(
                            u.name
                        )}
                    </strong>

                    <span class="friend-status${u.online ? " online" : ""}">
                        ${u.online ? "Online" : "Offline"}
                    </span>

                </div>

                ${
                    unreadCounts[u.id]
                        ? `<span class="unread-badge">${unreadCounts[u.id]}</span>`
                        : ""
                }

            `;


            if (
                activeChat &&
                activeChat.id === u.id
            ) {

                item.classList.add(
                    "active"
                );

            }


            item.addEventListener(
                "click",
                () => {

                    openChat(
                        u.id,
                        u.name
                    );

                }
            );


            userListEl.appendChild(
                item
            );

        }
    );


    if (
        friendIds.size === 0
    ) {

        userListEl.innerHTML = `

            <div class="no-friends">

                <div class="no-friends-icon">
                    👥
                </div>

                <strong>
                    No friends yet
                </strong>

                <span>
                    Find someone to start chatting.
                </span>

            </div>

        `;

    }

}


// ============================================================
// GROUPS
// ============================================================

function renderGroupsList() {

    if (!groupsListEl) return;

    groupsListEl.innerHTML = "";

    Array.from(myGroups.values()).forEach(group => {

        const item = document.createElement("div");
        item.className = "friend-item group-item";
        item.dataset.id = group.id;

        const onlineCount =
            group.memberIds.filter(id => id === (me && me.id) || usersOnline[id]).length;

        item.innerHTML = `

            <div class="friend-avatar">
                ${avatarMarkup(group.name, group.icon || null)}
            </div>

            <div class="friend-details">

                <strong class="friend-name">
                    ${escapeHtml(group.name)}
                </strong>

                <span class="friend-status">
                    ${group.memberIds.length} members${onlineCount > 1 ? ` · ${onlineCount} online` : ""}
                </span>

            </div>

            ${
                unreadCounts[group.id]
                    ? `<span class="unread-badge">${unreadCounts[group.id]}</span>`
                    : ""
            }

        `;

        if (activeChat && activeChat.id === group.id) {
            item.classList.add("active");
        }

        item.addEventListener("click", () => openChat(group.id, group.name, group));

        groupsListEl.appendChild(item);
    });

}

function upsertGroup(group) {

    if (!group || !group.id) return;

    myGroups.set(group.id, group);
    renderGroupsList();

    // keep the open chat's own copy of member/admin ids fresh too,
    // so the header ("N members") and Group Info modal stay accurate
    if (activeChat && activeChat.id === group.id) {
        activeChat.memberIds = group.memberIds;
        activeChat.adminIds = group.adminIds;
        activeChat.icon = group.icon || null;
        activeChat.description = group.description || "";
        activeChat.adminsOnlyMessages = !!group.adminsOnlyMessages;

        if (chatStatus) chatStatus.textContent = `${group.memberIds.length} members`;
        if (chatWith) chatWith.textContent = group.name;

        updateAdminsOnlyComposerLock();
        renderGroupInfoModal();
    }
}

socket.on("my-groups", (groups) => {

    myGroups.clear();
    (groups || []).forEach(g => myGroups.set(g.id, g));
    renderGroupsList();

});

socket.on("group-created", (group) => upsertGroup(group));
socket.on("group-updated", (group) => upsertGroup(group));

socket.on("group-error", ({ message } = {}) => {
    showNiceAlert(message || "That group action wasn't allowed.", { title: "Group", icon: "fa-user-group" });
});

socket.on("left-group", ({ groupId } = {}) => {

    myGroups.delete(groupId);
    renderGroupsList();

    if (activeChat && activeChat.id === groupId) {
        closeGroupInfoModal();
        activeChat = null;
        if (chatWith) chatWith.textContent = "Select a friend";
        if (chatStatus) chatStatus.textContent = "Choose someone from your friends";
        if (composer) composer.hidden = true;
        if (headerActions) headerActions.hidden = true;
        if (messagesEl) messagesEl.innerHTML = "";
    }

});

socket.on("removed-from-group", ({ groupId } = {}) => {

    const group = myGroups.get(groupId);

    myGroups.delete(groupId);
    renderGroupsList();

    if (activeChat && activeChat.id === groupId) {
        closeGroupInfoModal();
        activeChat = null;
        if (chatWith) chatWith.textContent = "Select a friend";
        if (chatStatus) chatStatus.textContent = "Choose someone from your friends";
        if (composer) composer.hidden = true;
        if (headerActions) headerActions.hidden = true;
        if (messagesEl) messagesEl.innerHTML = "";
    }

    if (group) showNiceAlert(`You were removed from "${group.name}".`, { title: "Group", icon: "fa-user-group" });

});


// ------------------------------------------------------
// NEW GROUP MODAL
// ------------------------------------------------------

const newGroupModal = document.getElementById("newGroupModal");
const newGroupNameInput = document.getElementById("newGroupNameInput");
const newGroupMembersList = document.getElementById("newGroupMembersList");
const createGroupBtn = document.getElementById("createGroupBtn");
const closeNewGroupModal = document.getElementById("closeNewGroupModal");

// people this user could plausibly add - known friends plus anyone
// currently online, de-duplicated
function candidateMembers() {

    const byId = new Map();

    friendIds.forEach(id => {
        const live = usersOnline[id];
        const cached = friendProfiles[id];
        byId.set(id, { id, name: (live && live.name) || (cached && cached.name) || "Unknown" });
    });

    Object.values(usersOnline).forEach(u => byId.set(u.id, { id: u.id, name: u.name }));

    return Array.from(byId.values());
}

function openNewGroupModal() {

    if (!newGroupModal) return;

    if (newGroupNameInput) newGroupNameInput.value = "";

    const selected = new Set();

    function renderList() {

        if (!newGroupMembersList) return;

        const people = candidateMembers();

        newGroupMembersList.innerHTML =
            people.length
                ? people.map(p => `
                    <label class="modal-picker-item">
                        <input type="checkbox" data-id="${p.id}" ${selected.has(p.id) ? "checked" : ""}>
                        ${escapeHtml(p.name)}
                    </label>
                `).join("")
                : '<div class="add-participant-empty">No friends or online users to add yet.</div>';

        newGroupMembersList.querySelectorAll("input[type=checkbox]").forEach(box => {
            box.addEventListener("change", () => {
                if (box.checked) selected.add(box.dataset.id);
                else selected.delete(box.dataset.id);
            });
        });
    }

    renderList();

    if (createGroupBtn) {

        createGroupBtn.onclick = () => {

            const name = (newGroupNameInput && newGroupNameInput.value.trim()) || "New Group";

            if (!selected.size) {
                showNiceAlert("Pick at least one member for the group.", { title: "New group", icon: "fa-user-group" });
                return;
            }

            socket.emit("create-group", { name, memberIds: Array.from(selected) });
            newGroupModal.classList.add("hidden");
        };
    }

    newGroupModal.classList.remove("hidden");
}

if (newGroupBtn) newGroupBtn.addEventListener("click", openNewGroupModal);
if (closeNewGroupModal) closeNewGroupModal.addEventListener("click", () => newGroupModal.classList.add("hidden"));


// ------------------------------------------------------
// GROUP INFO MODAL (members, add members, leave)
// ------------------------------------------------------

const groupInfoModal = document.getElementById("groupInfoModal");
const groupInfoName = document.getElementById("groupInfoName");
const groupInfoMembersList = document.getElementById("groupInfoMembersList");
const groupInfoAddMembersBtn = document.getElementById("groupInfoAddMembersBtn");
const groupInfoLeaveBtn = document.getElementById("groupInfoLeaveBtn");
const closeGroupInfoModal_ = document.getElementById("closeGroupInfoModal");

// group icon / description / admin-only toggle / invite link / media gallery
const groupInfoIconInner = document.getElementById("groupInfoIconInner");
const groupInfoIconEditBadge = document.getElementById("groupInfoIconEditBadge");
const groupIconInput = document.getElementById("groupIconInput");
const groupInfoDescriptionText = document.getElementById("groupInfoDescriptionText");
const groupInfoEditDescriptionBtn = document.getElementById("groupInfoEditDescriptionBtn");
const groupInfoDescriptionEdit = document.getElementById("groupInfoDescriptionEdit");
const groupDescriptionInput = document.getElementById("groupDescriptionInput");
const groupDescriptionCancelBtn = document.getElementById("groupDescriptionCancelBtn");
const groupDescriptionSaveBtn = document.getElementById("groupDescriptionSaveBtn");
const groupAdminsOnlyRow = document.getElementById("groupAdminsOnlyRow");
const groupAdminsOnlyToggle = document.getElementById("groupAdminsOnlyToggle");
const groupInviteCopyBtn = document.getElementById("groupInviteCopyBtn");
const groupInviteResetBtn = document.getElementById("groupInviteResetBtn");
const groupInfoMediaGallery = document.getElementById("groupInfoMediaGallery");
const adminsOnlyBanner = document.getElementById("adminsOnlyBanner");
const mentionDropdown = document.getElementById("mentionDropdown");
const joinGroupInviteModal = document.getElementById("joinGroupInviteModal");
const joinGroupInviteText = document.getElementById("joinGroupInviteText");
const joinGroupInviteBtn = document.getElementById("joinGroupInviteBtn");
const closeJoinGroupInviteModal = document.getElementById("closeJoinGroupInviteModal");

// display initial (matches how other avatars in this app fall back
// to a letter when there's no uploaded image)
function renderGroupIcon(group) {

    if (!groupInfoIconInner) return;

    if (group && group.icon) {
        groupInfoIconInner.style.backgroundImage = `url("${group.icon}")`;
        groupInfoIconInner.textContent = "";
        groupInfoIconInner.classList.add("has-image");
    } else {
        groupInfoIconInner.style.backgroundImage = "";
        groupInfoIconInner.classList.remove("has-image");
        groupInfoIconInner.textContent = (group && group.name ? group.name.trim()[0] : "G").toUpperCase();
    }
}

if (groupInfoIconEditBadge && groupIconInput) {

    groupInfoIconEditBadge.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        groupIconInput.click();
    });
}

if (groupIconInput) {

    groupIconInput.addEventListener("change", async () => {

        const file = groupIconInput.files && groupIconInput.files[0];
        if (!file || !activeChat || !activeChat.isGroup) return;

        if (!file.type.startsWith("image/")) {
            showNiceAlert("Please choose an image file for the group icon.", { title: "Group icon", icon: "fa-image" });
            groupIconInput.value = "";
            return;
        }

        const formData = new FormData();
        formData.append("file", file);

        try {

            const res = await fetch("/upload", { method: "POST", body: formData });
            const data = await res.json();

            if (!data || !data.url) {
                showNiceAlert("Couldn't upload that image. Please try a different file.", { title: "Upload failed", icon: "fa-image" });
                return;
            }

            socket.emit("set-group-icon", { groupId: activeChat.id, iconUrl: data.url });

        } catch (error) {
            showNiceAlert("Couldn't upload that image right now.", { title: "Upload failed", icon: "fa-image" });
        } finally {
            groupIconInput.value = "";
        }
    });
}

// ---- description ----

function showGroupDescriptionEditor(show) {

    if (groupInfoDescriptionEdit) groupInfoDescriptionEdit.classList.toggle("hidden", !show);
    if (groupInfoDescriptionText) groupInfoDescriptionText.classList.toggle("hidden", show);

    if (show && groupDescriptionInput && activeChat) {
        groupDescriptionInput.value = activeChat.description || "";
        groupDescriptionInput.focus();
    }
}

if (groupInfoEditDescriptionBtn) {
    groupInfoEditDescriptionBtn.addEventListener("click", () => showGroupDescriptionEditor(true));
}

if (groupDescriptionCancelBtn) {
    groupDescriptionCancelBtn.addEventListener("click", () => showGroupDescriptionEditor(false));
}

if (groupDescriptionSaveBtn) {

    groupDescriptionSaveBtn.addEventListener("click", () => {

        if (!activeChat || !activeChat.isGroup) return;

        socket.emit("set-group-description", {
            groupId: activeChat.id,
            description: (groupDescriptionInput && groupDescriptionInput.value.trim()) || ""
        });

        showGroupDescriptionEditor(false);
    });
}

// ---- admin-only sending toggle ----

if (groupAdminsOnlyToggle) {

    groupAdminsOnlyToggle.addEventListener("change", () => {

        if (!activeChat || !activeChat.isGroup) return;

        socket.emit("set-group-send-permission", {
            groupId: activeChat.id,
            adminsOnly: groupAdminsOnlyToggle.checked
        });
    });
}

function updateAdminsOnlyComposerLock() {

    const locked =
        !!(activeChat && activeChat.isGroup && activeChat.adminsOnlyMessages &&
            me && !activeChat.adminIds.includes(me.id));

    if (adminsOnlyBanner) adminsOnlyBanner.classList.toggle("hidden", !locked);

    [textInput, sendBtn, attachBtn, micBtn, emojiBtn].forEach((el) => {
        if (el) el.disabled = locked;
    });
}

// ---- invite link ----

let pendingInviteAction = null; // "copy" | "reset"

if (groupInviteCopyBtn) {

    groupInviteCopyBtn.addEventListener("click", () => {

        if (!activeChat || !activeChat.isGroup) return;

        pendingInviteAction = "copy";
        socket.emit("get-group-invite", { groupId: activeChat.id });
    });
}

if (groupInviteResetBtn) {

    groupInviteResetBtn.addEventListener("click", async () => {

        if (!activeChat || !activeChat.isGroup) return;

        const ok = await showNiceConfirm("Reset the invite link? The old link will stop working.", {
            title: "Reset invite link",
            icon: "fa-link-slash",
            confirmText: "Reset link"
        });
        if (!ok) return;

        pendingInviteAction = "copy";
        socket.emit("revoke-group-invite", { groupId: activeChat.id });
    });
}

socket.on("group-invite", ({ groupId, code } = {}) => {

    if (!code) return;

    const link = `${location.origin}/?invite=${encodeURIComponent(code)}`;

    if (pendingInviteAction === "copy") {

        if (navigator.clipboard) {
            navigator.clipboard.writeText(link)
                .then(() => showNiceAlert("Invite link copied to clipboard.", { title: "Invite link", icon: "fa-link" }))
                .catch(() => showNiceAlert(link, { title: "Invite link", icon: "fa-link" }));
        } else {
            showNiceAlert(link, { title: "Invite link", icon: "fa-link" });
        }
    }

    pendingInviteAction = null;
});

// joining via a shared invite link (?invite=CODE in the URL)
let pendingInviteCode = null;

(function checkForInviteLinkInUrl() {

    const params = new URLSearchParams(location.search);
    const code = params.get("invite");
    if (code) pendingInviteCode = code;
})();

function maybeShowJoinGroupInviteModal() {

    if (!pendingInviteCode || !joinGroupInviteModal) return;

    if (joinGroupInviteText) {
        joinGroupInviteText.textContent = "You've been invited to join a group on Site Chat.";
    }

    joinGroupInviteModal.classList.remove("hidden");
}

if (joinGroupInviteBtn) {

    joinGroupInviteBtn.addEventListener("click", () => {

        if (pendingInviteCode) socket.emit("join-group-via-invite", { code: pendingInviteCode });

        if (joinGroupInviteModal) joinGroupInviteModal.classList.add("hidden");

        // clean the invite param out of the url so refreshing doesn't
        // re-prompt to join the same group again
        pendingInviteCode = null;
        history.replaceState(null, "", location.pathname);
    });
}

if (closeJoinGroupInviteModal) {

    closeJoinGroupInviteModal.addEventListener("click", () => {
        if (joinGroupInviteModal) joinGroupInviteModal.classList.add("hidden");
        pendingInviteCode = null;
        history.replaceState(null, "", location.pathname);
    });
}

// ---- shared media gallery ----

function renderGroupMediaGallery() {

    if (!groupInfoMediaGallery || !activeChat || !activeChat.isGroup) return;

    const list = conversations[activeChat.id] || [];

    const mediaMsgs =
        list.filter(m =>
            m.attachment &&
            !m.deletedForEveryone &&
            ["image", "video", "gif", "document"].includes(m.attachment.kind || "document")
        );

    if (!mediaMsgs.length) {
        groupInfoMediaGallery.innerHTML = '<div class="group-media-empty">Nothing shared yet.</div>';
        return;
    }

    groupInfoMediaGallery.innerHTML =
        mediaMsgs.slice(-24).reverse().map((m) => {

            const a = m.attachment;

            if (a.kind === "image" || a.kind === "gif") {
                return `<div class="group-media-item" data-jump-id="${m.id}"><img src="${a.url}" loading="lazy" alt=""></div>`;
            }

            if (a.kind === "video") {
                return `<div class="group-media-item group-media-file" data-jump-id="${m.id}"><i class="fa-solid fa-video"></i></div>`;
            }

            return `<div class="group-media-item group-media-file" data-jump-id="${m.id}"><i class="fa-solid fa-file"></i><span>${escapeHtml((a.name || "Document").slice(0, 16))}</span></div>`;
        }).join("");

    groupInfoMediaGallery.querySelectorAll("[data-jump-id]").forEach((el) => {
        el.addEventListener("click", () => {
            closeGroupInfoModal();
            jumpToMessage(el.dataset.jumpId);
        });
    });
}

function closeGroupInfoModal() {
    if (groupInfoModal) groupInfoModal.classList.add("hidden");
}

function renderGroupInfoModal() {

    if (!groupInfoModal || groupInfoModal.classList.contains("hidden")) return;
    if (!activeChat || !activeChat.isGroup) return;

    const isAdmin = activeChat.adminIds.includes(me.id);

    if (groupInfoName) groupInfoName.textContent = activeChat.name;

    renderGroupIcon(activeChat);
    if (groupInfoIconEditBadge) groupInfoIconEditBadge.classList.toggle("hidden", !isAdmin);

    // description
    showGroupDescriptionEditor(false);
    if (groupInfoDescriptionText) {
        groupInfoDescriptionText.textContent =
            activeChat.description ||
            (isAdmin ? "Add a group description" : "No description yet");
        groupInfoDescriptionText.classList.toggle("group-info-description-empty", !activeChat.description);
    }
    if (groupInfoEditDescriptionBtn) groupInfoEditDescriptionBtn.classList.toggle("hidden", !isAdmin);

    // admin-only ("announcement group") toggle
    if (groupAdminsOnlyRow) groupAdminsOnlyRow.classList.toggle("hidden", !isAdmin);
    if (groupAdminsOnlyToggle) groupAdminsOnlyToggle.checked = !!activeChat.adminsOnlyMessages;

    // invite link reset is admin-only; anyone in the group can copy it
    if (groupInviteResetBtn) groupInviteResetBtn.classList.toggle("hidden", !isAdmin);

    if (groupInfoMembersList) {

        groupInfoMembersList.innerHTML =
            activeChat.memberIds.map(id => {

                const isMe = id === me.id;
                const profile = usersOnline[id] || friendProfiles[id] || null;
                const label = isMe ? "You" : ((profile && profile.name) || id);
                const avatarUrl = isMe ? (myAvatar || (profile && profile.avatar) || null) : (profile && profile.avatar) || null;
                const memberIsAdmin = activeChat.adminIds.includes(id);
                const role = memberIsAdmin ? "Admin" : "";

                return `
                    <div class="modal-picker-item">
                        <span class="modal-picker-avatar">${avatarMarkup(label, avatarUrl)}</span>
                        <span class="modal-picker-label">${escapeHtml(label)}</span>
                        ${role ? `<span class="modal-picker-role">${role}</span>` : ""}
                        ${
                            isAdmin && !isMe
                                ? `<button type="button" class="modal-picker-admin" data-toggle-admin-id="${id}" data-is-admin="${memberIsAdmin}" title="${memberIsAdmin ? "Remove as admin" : "Make group admin"}"><i class="fa-solid ${memberIsAdmin ? "fa-user-shield" : "fa-shield-halved"}"></i></button>`
                                : ""
                        }
                        ${
                            isAdmin && !isMe
                                ? `<button type="button" class="modal-picker-remove" data-remove-id="${id}" title="Remove from group"><i class="fa-solid fa-user-minus"></i></button>`
                                : ""
                        }
                    </div>
                `;
            }).join("");

        groupInfoMembersList.querySelectorAll("[data-remove-id]").forEach(btn => {
            btn.addEventListener("click", async () => {
                const ok = await showNiceConfirm("Remove this member from the group?", {
                    title: "Remove member",
                    icon: "fa-user-minus",
                    confirmText: "Remove"
                });
                if (ok) {
                    socket.emit("remove-group-member", { groupId: activeChat.id, memberId: btn.dataset.removeId });
                }
            });
        });

        groupInfoMembersList.querySelectorAll("[data-toggle-admin-id]").forEach(btn => {
            btn.addEventListener("click", () => {

                const memberId = btn.dataset.toggleAdminId;
                const memberIsAdmin = btn.dataset.isAdmin === "true";

                socket.emit(
                    memberIsAdmin ? "demote-group-admin" : "promote-group-admin",
                    { groupId: activeChat.id, memberId }
                );
            });
        });
    }

    if (groupInfoAddMembersBtn) groupInfoAddMembersBtn.hidden = !isAdmin;

    renderGroupMediaGallery();
}

function openGroupInfoModal() {

    if (!groupInfoModal || !activeChat || !activeChat.isGroup) return;

    renderGroupInfoModal();
    groupInfoModal.classList.remove("hidden");
}

if (closeGroupInfoModal_) closeGroupInfoModal_.addEventListener("click", closeGroupInfoModal);

// clicking the group's name/avatar in the chat header opens its
// members panel (add/remove members, leave) - mirrors how WhatsApp
// opens group info from the chat header
const chatUserHeaderEl = document.querySelector(".chat-user");
if (chatUserHeaderEl) {
    chatUserHeaderEl.addEventListener("click", (e) => {
        if (e.target.closest("#chatBackBtn")) return;
        if (activeChat && activeChat.isGroup) openGroupInfoModal();
    });
}

if (groupInfoLeaveBtn) {

    groupInfoLeaveBtn.addEventListener("click", async () => {

        if (!activeChat || !activeChat.isGroup) return;

        const ok = await showNiceConfirm(`Leave "${activeChat.name}"?`, {
            title: "Leave group",
            icon: "fa-right-from-bracket",
            confirmText: "Leave"
        });
        if (ok) {
            socket.emit("leave-group", { groupId: activeChat.id });
            closeGroupInfoModal();
        }
    });
}

if (groupInfoAddMembersBtn) {

    groupInfoAddMembersBtn.addEventListener("click", () => {

        if (!activeChat || !activeChat.isGroup) return;

        const alreadyIn = new Set(activeChat.memberIds);
        const people = candidateMembers().filter(p => !alreadyIn.has(p.id));

        if (!people.length) {
            showNiceAlert("No one else to add right now.", { title: "Add members", icon: "fa-user-plus" });
            return;
        }

        const selected = new Set();

        if (newGroupMembersList && newGroupModal && newGroupNameInput) {

            // reuse the New Group modal's picker UI for adding members
            // to an existing group too
            newGroupNameInput.value = activeChat.name;
            newGroupNameInput.disabled = true;

            newGroupMembersList.innerHTML =
                people.map(p => `
                    <label class="modal-picker-item">
                        <input type="checkbox" data-id="${p.id}">
                        ${escapeHtml(p.name)}
                    </label>
                `).join("");

            newGroupMembersList.querySelectorAll("input[type=checkbox]").forEach(box => {
                box.addEventListener("change", () => {
                    if (box.checked) selected.add(box.dataset.id);
                    else selected.delete(box.dataset.id);
                });
            });

            if (createGroupBtn) {

                createGroupBtn.textContent = "Add Members";

                createGroupBtn.onclick = () => {

                    if (!selected.size) {
                        showNiceAlert("Pick at least one person to add.", { title: "Add members", icon: "fa-user-plus" });
                        return;
                    }

                    socket.emit("add-group-members", { groupId: activeChat.id, memberIds: Array.from(selected) });

                    newGroupModal.classList.add("hidden");
                    newGroupNameInput.disabled = false;
                    createGroupBtn.textContent = "Create Group";
                };
            }

            newGroupModal.classList.remove("hidden");
        }
    });
}


// ============================================================
// FIND FRIEND - CLOSE
// ============================================================

function closeFindFriendPanel() {

    if (!findFriendPanel) return;


    findFriendPanel.classList.add(
        "hidden"
    );


    findFriendPanel.style.display =
        "none";

    findFriendPanel.style.visibility =
        "hidden";

    findFriendPanel.style.opacity =
        "0";

    findFriendPanel.style.pointerEvents =
        "none";


    if (friendSearchInput) {

        friendSearchInput.value =
            "";

    }


    if (allUsersList) {

        allUsersList.innerHTML =
            "";

    }

}


// ============================================================
// FIND FRIEND - OPEN
// ============================================================

function openFindFriendPanel() {

    if (!findFriendPanel) return;


    findFriendPanel.classList.remove(
        "hidden"
    );


    findFriendPanel.style.display =
        "block";

    findFriendPanel.style.visibility =
        "visible";

    findFriendPanel.style.opacity =
        "1";

    findFriendPanel.style.pointerEvents =
        "auto";


    if (friendSearchInput) {

        friendSearchInput.value =
            "";

    }


    renderAllUsers();

}


// ============================================================
// FIND FRIEND BUTTON
// ============================================================

if (findFriendBtn) {

    findFriendBtn.addEventListener(
        "click",
        (e) => {

            e.preventDefault();
            e.stopPropagation();

            openFindFriendPanel();

        }
    );

}


// ============================================================
// BACK TO FRIENDS LIST (phone full-screen chat)
// ============================================================

if (chatBackBtn) {

    chatBackBtn.addEventListener(
        "click",
        () => {

            if (app) {

                app.classList.remove(
                    "chat-open"
                );

            }

            if (
                disappearingMenu &&
                !disappearingMenu.classList.contains(
                    "hidden"
                )
            ) {

                disappearingMenu.classList.add(
                    "hidden"
                );

                if (disappearingBtn) {

                    disappearingBtn.setAttribute(
                        "aria-expanded",
                        "false"
                    );

                }

            }

        }
    );

}


// ============================================================
// CLOSE FIND FRIEND X
// ============================================================

if (closeFindFriend) {

    closeFindFriend.addEventListener(
        "click",
        (e) => {

            e.preventDefault();
            e.stopPropagation();

            closeFindFriendPanel();

        }
    );

}


// ============================================================
// CLOSE FIND FRIEND OVERLAY
// ============================================================

if (findFriendOverlay) {

    findFriendOverlay.addEventListener(
        "click",
        (e) => {

            e.preventDefault();
            e.stopPropagation();

            closeFindFriendPanel();

        }
    );

}


// ============================================================
// DO NOT CLOSE WHEN CLICKING CARD
// ============================================================

if (findFriendCard) {

    findFriendCard.addEventListener(
        "click",
        (e) => {

            e.stopPropagation();

        }
    );

}


// ============================================================
// FIND FRIEND - ESC
// ============================================================

document.addEventListener(
    "keydown",
    (e) => {

        if (e.key !== "Escape") {
            return;
        }


        closeFindFriendPanel();


        if (
            accountPanel &&
            !accountPanel.classList.contains(
                "hidden"
            )
        ) {

            accountPanel.classList.add(
                "hidden"
            );

            accountPanel.setAttribute(
                "aria-hidden",
                "true"
            );

        }

    }
);


// ============================================================
// FIND FRIEND - ALL PEOPLE
// ============================================================

function renderAllUsers(
    searchText = ""
) {

    if (!allUsersList) return;


    allUsersList.innerHTML =
        "";


    const search =
        searchText
            .trim()
            .toLowerCase();


    const people =
        Object.values(
            usersOnline
        )
        .filter(
            (user) => {

                if (!search) {
                    return true;
                }

                return user.name
                    .toLowerCase()
                    .includes(search);

            }
        );


    if (people.length === 0) {

        allUsersList.innerHTML = `

            <div class="empty-panel">

                No people found.

            </div>

        `;

        return;

    }


    people.forEach(
        (user) => {

            const relation =
                getFriendRelation(
                    user.id
                );


            const item =
                document.createElement(
                    "div"
                );

            item.className =
                "discover-user";


            item.innerHTML = `

                <div class="friend-avatar">

                    ${avatarMarkup(
                        user.name,
                        user.avatar
                    )}

                    <span class="friend-online-dot"></span>

                </div>


                <div class="friend-details">

                    <strong class="friend-name">

                        ${escapeHtml(
                            user.name
                        )}

                    </strong>

                    <span class="friend-status online">
                        Online
                    </span>

                </div>


                <div class="discover-actions"></div>

            `;


            const actions =
                item.querySelector(
                    ".discover-actions"
                );


            // ------------------------------------------------
            // FRIEND
            // ------------------------------------------------

            if (
                relation === "friend"
            ) {

                const chatBtn =
                    document.createElement(
                        "button"
                    );

                chatBtn.className =
                    "add-friend-btn";

                chatBtn.textContent =
                    "Chat";


                chatBtn.addEventListener(
                    "click",
                    (e) => {

                        e.preventDefault();
                        e.stopPropagation();

                        openChat(
                            user.id,
                            user.name
                        );

                        closeFindFriendPanel();

                    }
                );


                actions.appendChild(
                    chatBtn
                );

            }


            // ------------------------------------------------
            // REQUEST SENT
            // ------------------------------------------------

            else if (
                relation === "pending"
            ) {

                const btn =
                    document.createElement(
                        "button"
                    );

                btn.className =
                    "add-friend-btn requested";

                btn.textContent =
                    "Requested";

                btn.disabled =
                    true;


                actions.appendChild(
                    btn
                );

            }


            // ------------------------------------------------
            // INCOMING REQUEST
            // ------------------------------------------------

            else if (
                relation === "incoming"
            ) {

                const btn =
                    document.createElement(
                        "button"
                    );

                btn.className =
                    "add-friend-btn";

                btn.textContent =
                    "Confirm";


                btn.addEventListener(
                    "click",
                    (e) => {

                        e.preventDefault();
                        e.stopPropagation();

                        respondToRequest(
                            user,
                            true
                        );


                        renderAllUsers(
                            friendSearchInput
                                ? friendSearchInput.value
                                : ""
                        );

                    }
                );


                actions.appendChild(
                    btn
                );

            }


            // ------------------------------------------------
            // NOT FRIEND
            // ------------------------------------------------

            else {

                const btn =
                    document.createElement(
                        "button"
                    );

                btn.className =
                    "add-friend-btn";

                btn.textContent =
                    "Add Friend";


                btn.addEventListener(
                    "click",
                    (e) => {

                        e.preventDefault();
                        e.stopPropagation();

                        handleFriendAction(
                            user
                        );


                        renderAllUsers(
                            friendSearchInput
                                ? friendSearchInput.value
                                : ""
                        );

                    }
                );


                actions.appendChild(
                    btn
                );

            }


            // ------------------------------------------------
            // CLICK FRIEND TO CHAT
            // ------------------------------------------------

            item.addEventListener(
                "click",
                () => {

                    if (
                        getFriendRelation(
                            user.id
                        ) === "friend"
                    ) {

                        openChat(
                            user.id,
                            user.name
                        );

                        closeFindFriendPanel();

                    }

                }
            );


            allUsersList.appendChild(
                item
            );

        }
    );

}


// ============================================================
// FIND FRIEND SEARCH
// ============================================================

if (friendSearchInput) {

    friendSearchInput.addEventListener(
        "input",
        () => {

            renderAllUsers(
                friendSearchInput.value
            );

        }
    );

}


// ============================================================
// FRIEND REQUEST RECEIVED
// ============================================================

socket.on(
    "friend-request",
    (request) => {

        if (
            !request ||
            !request.fromId
        ) {
            return;
        }


        pendingReceived.set(
            request.fromId,
            {
                id: request.fromId,
                name:
                    request.fromName ||
                    "Unknown"
            }
        );


        updateCounts();


        if (
            accountPanel &&
            !accountPanel.classList.contains(
                "hidden"
            )
        ) {

            renderAccountPanel(
                "requests"
            );

        }


        showNiceAlert(
            `${request.fromName || "Someone"} sent you a friend request.`,
            { title: "Friend request", icon: "fa-user-plus" }
        );


        refreshPeopleList();

    }
);


// ============================================================
// FRIEND REQUEST ACCEPTED
// ============================================================

socket.on(
    "friend-request-accepted",
    ({ userId, name, avatar }) => {

        if (!userId) return;


        friendIds.add(
            userId
        );

        pendingSent.delete(
            userId
        );

        if (name) {

            cacheFriendProfile(
                { id: userId, name, avatar }
            );

        }


        saveFriendState();

        updateCounts();

        renderFriendsList();

        refreshPeopleList();

    }
);


// ============================================================
// FRIEND REQUEST DECLINED
// ============================================================

socket.on(
    "friend-request-declined",
    ({ userId }) => {

        if (!userId) return;


        pendingSent.delete(
            userId
        );


        saveFriendState();

        updateCounts();

        refreshPeopleList();

    }
);


// ============================================================
// FRIEND REMOVED
// ============================================================

socket.on(
    "friend-removed",
    ({ userId }) => {

        if (!userId) return;


        friendIds.delete(
            userId
        );

        delete friendProfiles[userId];
        saveFriendProfiles();


        saveFriendState();

        updateCounts();

        renderFriendsList();

        refreshPeopleList();

    }
);


// ============================================================
// SERVER FRIEND STATE
// ============================================================

socket.on(
    "friend-state",
    ({
        friends = [],
        sent = [],
        received = []
    }) => {

        friendIds.clear();


        friends.forEach(
            id =>
                friendIds.add(id)
        );


        pendingSent.clear();


        sent.forEach(
            id =>
                pendingSent.add(id)
        );


        pendingReceived.clear();


        received.forEach(
            r =>
                pendingReceived.set(
                    r.id,
                    r
                )
        );


        saveFriendState();

        updateCounts();

        renderFriendsList();

        refreshPeopleList();

    }
);


// ============================================================
// FRIEND RELATION
// ============================================================

function getFriendRelation(
    id
) {

    if (
        friendIds.has(id)
    ) {

        return "friend";

    }


    if (
        pendingSent.has(id)
    ) {

        return "pending";

    }


    if (
        pendingReceived.has(id)
    ) {

        return "incoming";

    }


    return "none";

}


// ============================================================
// FRIEND ACTION
// ============================================================

function handleFriendAction(
    user
) {

    const relation =
        getFriendRelation(
            user.id
        );


    if (
        relation === "none"
    ) {

        pendingSent.add(
            user.id
        );


        saveFriendState();


        socket.emit(
            "friend-request",
            {
                toId: user.id,
                toName: user.name
            }
        );

    }


    else if (
        relation === "incoming"
    ) {

        socket.emit(
            "friend-request-response",
            {
                requestId: user.id,
                fromId: user.id,
                accept: true
            }
        );


        friendIds.add(
            user.id
        );

        pendingReceived.delete(
            user.id
        );


        saveFriendState();

    }


    refreshPeopleList();

    updateCounts();

}


// ============================================================
// SAVE FRIEND STATE
// ============================================================

function saveFriendState() {

    localStorage.setItem(
        "siteChatFriends",
        JSON.stringify(
            [...friendIds]
        )
    );


    localStorage.setItem(
        "siteChatPendingSent",
        JSON.stringify(
            [...pendingSent]
        )
    );

}


// ============================================================
// COUNTS
// ============================================================

function updateCounts() {

    if (friendsCount) {

        friendsCount.textContent =
            friendIds.size;

    }


    if (requestsCount) {

        requestsCount.textContent =
            pendingReceived.size;

        requestsCount.classList.toggle(
            "hidden",
            pendingReceived.size === 0
        );

    }


    if (accountRequestDot) {

        accountRequestDot.classList.toggle(
            "hidden",
            pendingReceived.size === 0
        );

    }


    if (onlineFriendsCount) {

        let count = 0;


        friendIds.forEach(
            id => {

                if (
                    usersOnline[id]
                ) {

                    count++;

                }

            }
        );


        onlineFriendsCount.textContent =
            count;

    }

}


// ============================================================
// REQUEST USER LIST
// ============================================================

function refreshPeopleList() {

    socket.emit(
        "request-user-list"
    );

}


// ============================================================
// PROFILE PICTURE
// ============================================================

if (avatarEditBadge && avatarInput) {

    avatarEditBadge.addEventListener(
        "click",
        (e) => {

            e.preventDefault();
            e.stopPropagation();

            avatarInput.click();

        }
    );

}


if (avatarInput) {

    avatarInput.addEventListener(
        "change",
        async () => {

            const file =
                avatarInput.files &&
                avatarInput.files[0];

            if (!file) return;

            if (!file.type.startsWith("image/")) {

                showNiceAlert(
                    "Please choose an image file for your profile picture.",
                    { title: "Profile picture", icon: "fa-image" }
                );

                avatarInput.value = "";
                return;

            }


            const formData =
                new FormData();

            formData.append(
                "file",
                file
            );


            try {

                const res =
                    await fetch(
                        "/upload",
                        {
                            method: "POST",
                            body: formData
                        }
                    );

                const data =
                    await res.json();

                if (!data || !data.url) {

                    showNiceAlert(
                        "Couldn't upload that image. Please try a different file.",
                        { title: "Upload failed", icon: "fa-image" }
                    );

                    return;

                }


                myAvatar =
                    data.url;

                localStorage.setItem(
                    "siteChatAvatar",
                    myAvatar
                );


                if (accountAvatarInner) {

                    accountAvatarInner.innerHTML =
                        avatarMarkup(
                            me ? me.name : "",
                            myAvatar
                        );

                }


                // let everyone currently online see the new picture
                // right away
                socket.emit(
                    "set-avatar",
                    myAvatar
                );

            } catch (err) {

                showNiceAlert(
                    "Couldn't upload that image. Please check your connection and try again.",
                    { title: "Upload failed", icon: "fa-image" }
                );

            }


            avatarInput.value =
                "";

        }
    );

}


// ============================================================
// ACCOUNT MENU
// ============================================================

if (accountBtn) {

    accountBtn.addEventListener(
        "click",
        (e) => {

            e.stopPropagation();


            if (!accountMenu) {
                return;
            }


            accountMenu.classList.toggle(
                "hidden"
            );


            accountBtn.setAttribute(
                "aria-expanded",
                String(
                    !accountMenu.classList.contains(
                        "hidden"
                    )
                )
            );

        }
    );

}


// ============================================================
// ACCOUNT MENU BUTTONS
// ============================================================

document
    .querySelectorAll(
        "[data-account-view]"
    )
    .forEach(
        btn => {

            btn.addEventListener(
                "click",
                () => {

                    if (accountMenu) {

                        accountMenu.classList.add(
                            "hidden"
                        );

                    }


                    renderAccountPanel(
                        btn.dataset.accountView
                    );

                }
            );

        }
    );


// ============================================================
// ACCOUNT PANEL CLOSE
// ============================================================

if (closeAccountPanel) {

    closeAccountPanel.addEventListener(
        "click",
        () => {

            if (!accountPanel) {
                return;
            }


            accountPanel.classList.add(
                "hidden"
            );


            accountPanel.setAttribute(
                "aria-hidden",
                "true"
            );

        }
    );

}


// ============================================================
// ACCOUNT PANEL
// ============================================================

function renderAccountPanel(
    view
) {

    if (!accountPanel) return;


    accountPanel.classList.remove(
        "hidden"
    );


    accountPanel.setAttribute(
        "aria-hidden",
        "false"
    );


    const titles = {

        friends: [
            "Friends",
            "People who have confirmed your friendship request"
        ],

        requests: [
            "Friend requests",
            "Requests waiting for your confirmation"
        ],

        online: [
            "People online",
            "Everyone currently connected"
        ],

        settings: [
            "Notifications & calls",
            "Choose your message notification sound and call ringtone"
        ],

        starred: [
            "Starred messages",
            "Messages you've starred, across all your chats"
        ],

        privacy: [
            "Privacy & security",
            "Control who can see your info and how your chats are protected"
        ],

        "linked-devices": [
            "Linked devices",
            "Use this account on other devices at the same time"
        ]

    };


    const title =
        titles[view] ||
        titles.friends;


    if (accountPanelTitle) {

        accountPanelTitle.textContent =
            title[0];

    }


    if (accountPanelSubtitle) {

        accountPanelSubtitle.textContent =
            title[1];

    }


    if (accountPanelBody) {

        accountPanelBody.innerHTML =
            "";

    }


    // --------------------------------------------------------
    // FRIENDS
    // --------------------------------------------------------

    if (
        view === "friends"
    ) {

        const friends =
            [...friendIds].map(
                id =>
                    usersOnline[id] ||
                    {
                        id,
                        name: "Friend"
                    }
            );


        if (
            !friends.length
        ) {

            return emptyPanel(
                "You have no friends yet. Add someone from People online."
            );

        }


        friends.forEach(
            u => {

                accountPanelBody.appendChild(
                    makePanelPerson(
                        u,
                        true
                    )
                );

            }
        );

    }


    // --------------------------------------------------------
    // REQUESTS
    // --------------------------------------------------------

    if (
        view === "requests"
    ) {

        const requests =
            [
                ...pendingReceived.values()
            ];


        if (
            !requests.length
        ) {

            return emptyPanel(
                "No pending friend requests."
            );

        }


        requests.forEach(
            u => {

                const row =
                    makePanelPerson(
                        u,
                        false
                    );


                row.querySelector(
                    ".panel-actions"
                ).innerHTML = `

                    <button
                        class="panel-action primary"
                        data-accept="${u.id}">
                        Confirm
                    </button>

                    <button
                        class="panel-action danger"
                        data-decline="${u.id}">
                        Decline
                    </button>

                `;


                row.querySelector(
                    "[data-accept]"
                ).addEventListener(
                    "click",
                    () =>
                        respondToRequest(
                            u,
                            true
                        )
                );


                row.querySelector(
                    "[data-decline]"
                ).addEventListener(
                    "click",
                    () =>
                        respondToRequest(
                            u,
                            false
                        )
                );


                accountPanelBody.appendChild(
                    row
                );

            }
        );

    }


    // --------------------------------------------------------
    // ONLINE
    // --------------------------------------------------------

    if (
        view === "online"
    ) {

        const online =
            Object.values(
                usersOnline
            );


        if (
            !online.length
        ) {

            return emptyPanel(
                "No other people are online right now."
            );

        }


        online.forEach(
            u => {

                accountPanelBody.appendChild(
                    makePanelPerson(
                        u,
                        false
                    )
                );

            }
        );

    }


    // --------------------------------------------------------
    // SETTINGS
    // --------------------------------------------------------

    if (
        view === "settings"
    ) {

        renderSettingsPanel();

    }


    // --------------------------------------------------------
    // STARRED MESSAGES
    // --------------------------------------------------------

    if (view === "starred") {

        renderStarredPanel();

    }


    // --------------------------------------------------------
    // PRIVACY & SECURITY
    // --------------------------------------------------------

    if (view === "privacy") {

        renderPrivacyPanel();

    }


    // --------------------------------------------------------
    // LINKED DEVICES
    // --------------------------------------------------------

    if (view === "linked-devices") {

        renderLinkedDevicesPanel();

    }

}


// ============================================================
// STARRED MESSAGES PANEL
// ------------------------------------------------------------
// Pulls every message with msg.starred === true out of whatever
// conversations are currently cached client-side (conversations{}
// only holds chats that have been opened this session - there's no
// "give me every starred message across every chat" server call
// yet, so this is scoped to what's already loaded. Wiring a real
// server-side query is the natural next step).
// ============================================================

function renderStarredPanel() {

    if (!accountPanelBody) return;

    const rows = [];

    Object.keys(conversations).forEach((chatId) => {

        (conversations[chatId] || []).forEach((msg) => {

            if (msg.starred && !msg.deletedForEveryone) {
                rows.push({ chatId, msg });
            }

        });

    });

    if (!rows.length) {

        emptyPanel(
            "No starred messages yet. Long-press (or right-click) any message and choose \u2605 Star."
        );

        return;

    }

    rows.sort((a, b) => (b.msg.at || 0) - (a.msg.at || 0));

    rows.forEach(({ chatId, msg }) => {

        const chatName =
            (activeChat && activeChat.id === chatId && activeChat.name) ||
            (usersOnline[chatId] && usersOnline[chatId].name) ||
            (friendProfiles[chatId] && friendProfiles[chatId].name) ||
            (myGroups.get(chatId) && myGroups.get(chatId).name) ||
            "Chat";

        const row = document.createElement("div");
        row.className = "panel-person starred-message-row";

        row.innerHTML = `
            <div class="panel-avatar">
                ${avatarMarkup(chatName, null)}
            </div>
            <div class="panel-person-info">
                <div class="panel-person-name">${escapeHtml(chatName)}</div>
                <div class="panel-person-status">${escapeHtml(messagePreviewText(msg))}</div>
            </div>
            <div class="panel-actions">
                <span class="starred-message-time">${formatTime(msg.at)}</span>
                <button type="button" class="panel-action starred-unstar-btn" title="Unstar">
                    <i class="fa-solid fa-star"></i>
                </button>
            </div>
        `;

        row.querySelector(".starred-unstar-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            socket.emit("message-context-action", { action: "star", msgId: msg.id, chatId });
            msg.starred = false;
            renderStarredPanel();
            if (activeChat && activeChat.id === chatId) renderMessages();
        });

        row.addEventListener("click", () => {

            const person = usersOnline[chatId] || friendProfiles[chatId];
            const groupInfo = myGroups.get(chatId);

            if (groupInfo) {
                openChat(chatId, chatName, groupInfo);
            } else {
                openChat(chatId, person ? person.name : chatName);
            }

            closeAccountPanelIfOpen();

            setTimeout(() => jumpToMessage(msg.id), 150);

        });

        accountPanelBody.appendChild(row);

    });

}

function closeAccountPanelIfOpen() {

    if (!accountPanel) return;

    accountPanel.classList.add("hidden");
    accountPanel.setAttribute("aria-hidden", "true");

}


// ============================================================
// PRIVACY & SECURITY PANEL
// ------------------------------------------------------------
// Last seen / profile photo / about / read receipts / who-can-add-me
// are persisted server-side (see "set-privacy-settings" in server.js)
// and echoed back here. NOTE: the server does not yet *enforce* these
// (e.g. hiding last-seen from a blocked viewer) - see the comment
// next to that handler for what's left to wire up.
//
// Blocked contacts and Two-step verification are functionally live:
// blocking/unblocking and PIN set/clear both round-trip to the
// server and persist. Two-step verification is not yet *checked*
// anywhere at login.
// ============================================================

let privacySettingsCache = null;
let twoStepEnabledCache = false;

function renderPrivacyPanel() {

    if (!accountPanelBody) return;

    accountPanelBody.innerHTML = `
        <div class="settings-block" id="privacyVisibilityBlock">
            <h4 class="settings-heading">Who can see my info</h4>
            <p class="settings-hint">Loading your current privacy settings\u2026</p>
        </div>

        <div class="settings-block">
            <h4 class="settings-heading">Blocked contacts</h4>
            <p class="settings-hint">People you've blocked can't call you or send you messages.</p>
            <div id="blockedContactsList" class="blocked-contacts-list">
                <p class="settings-hint">Loading\u2026</p>
            </div>
        </div>

        <div class="settings-block" id="twoStepBlock">
            <h4 class="settings-heading">Two-step verification</h4>
            <p class="settings-hint">Add a PIN that's asked for from time to time, for extra account security.</p>
            <div id="twoStepStatus"></div>
        </div>
    `;

    socket.emit("get-privacy-settings");
    socket.emit("get-blocked-list");
    socket.emit("get-two-step-status");

}

function privacyOptionRow(label, key, value, options) {

    const row = document.createElement("div");
    row.className = "privacy-option-row";

    const optionsHtml = options.map(
        ([val, text]) =>
            `<option value="${val}" ${val === value ? "selected" : ""}>${escapeHtml(text)}</option>`
    ).join("");

    row.innerHTML = `
        <span class="privacy-option-label">${escapeHtml(label)}</span>
        <select class="privacy-option-select" data-privacy-key="${key}">
            ${optionsHtml}
        </select>
    `;

    row.querySelector("select").addEventListener("change", (e) => {

        privacySettingsCache = privacySettingsCache || {};
        privacySettingsCache[key] = e.target.value;

        socket.emit("set-privacy-settings", { [key]: e.target.value });

    });

    return row;

}

socket.on("privacy-settings", (settings) => {

    privacySettingsCache = settings;

    const block = document.getElementById("privacyVisibilityBlock");
    if (!block) return; // panel isn't open right now

    block.innerHTML = "";

    const heading = document.createElement("h4");
    heading.className = "settings-heading";
    heading.textContent = "Who can see my info";
    block.appendChild(heading);

    const visOptions = [
        ["everyone", "Everyone"],
        ["contacts", "My contacts"],
        ["nobody", "Nobody"]
    ];

    block.appendChild(privacyOptionRow("Last seen & online", "lastSeen", settings.lastSeen, visOptions));
    block.appendChild(privacyOptionRow("Profile photo", "profilePhoto", settings.profilePhoto, visOptions));
    block.appendChild(privacyOptionRow("About", "about", settings.about, visOptions));

    block.appendChild(privacyOptionRow(
        "Groups - who can add me",
        "groupsAddMe",
        settings.groupsAddMe,
        [["everyone", "Everyone"], ["contacts", "My contacts"]]
    ));

    const receiptsRow = document.createElement("label");
    receiptsRow.className = "privacy-option-row privacy-toggle-row";
    receiptsRow.innerHTML = `
        <span class="privacy-option-label">Read receipts</span>
        <input type="checkbox" id="readReceiptsToggle" ${settings.readReceipts ? "checked" : ""}>
    `;

    receiptsRow.querySelector("input").addEventListener("change", (e) => {
        socket.emit("set-privacy-settings", { readReceipts: e.target.checked });
    });

    block.appendChild(receiptsRow);

});

socket.on("blocked-list", ({ blocked } = {}) => {

    const list = document.getElementById("blockedContactsList");
    if (!list) return;

    list.innerHTML = "";

    if (!blocked || !blocked.length) {
        list.innerHTML = `<p class="settings-hint">You haven't blocked anyone.</p>`;
        return;
    }

    blocked.forEach((userId) => {

        const person = usersOnline[userId] || friendProfiles[userId];
        const name = person ? person.name : "Unknown user";

        const row = document.createElement("div");
        row.className = "panel-person";

        row.innerHTML = `
            <div class="panel-avatar">${avatarMarkup(name, person && person.avatar)}</div>
            <div class="panel-person-info">
                <div class="panel-person-name">${escapeHtml(name)}</div>
            </div>
            <div class="panel-actions">
                <button type="button" class="panel-action blocked-unblock-btn">Unblock</button>
            </div>
        `;

        row.querySelector(".blocked-unblock-btn").addEventListener("click", () => {
            socket.emit("unblock-user", { userId });
        });

        list.appendChild(row);

    });

});

socket.on("two-step-status", ({ enabled } = {}) => {

    twoStepEnabledCache = Boolean(enabled);

    const wrap = document.getElementById("twoStepStatus");
    if (!wrap) return;

    if (enabled) {

        wrap.innerHTML = `
            <p class="settings-hint"><i class="fa-solid fa-check" style="color:#22c55e"></i> Two-step verification is on.</p>
            <button type="button" class="modal-secondary-btn" id="twoStepDisableBtn">Turn off</button>
        `;

        wrap.querySelector("#twoStepDisableBtn").addEventListener("click", () => {
            socket.emit("disable-two-step-pin");
        });

    } else {

        wrap.innerHTML = `
            <div class="privacy-option-row">
                <input type="password" id="twoStepPinInput" class="modal-text-input" placeholder="Choose a PIN (4+ digits)" inputmode="numeric" maxlength="8">
            </div>
            <button type="button" class="modal-primary-btn" id="twoStepEnableBtn">Turn on</button>
        `;

        wrap.querySelector("#twoStepEnableBtn").addEventListener("click", () => {

            const pin = wrap.querySelector("#twoStepPinInput").value.trim();
            socket.emit("set-two-step-pin", { pin });

        });

    }

});

socket.on("two-step-error", ({ message } = {}) => {

    showNiceAlert(message || "Couldn't update two-step verification.", { title: "Two-step verification", icon: "fa-lock" });

});


// ============================================================
// LINKED DEVICES PANEL
// ------------------------------------------------------------
// Generating and displaying a pairing code is fully working.
// Actually mirroring this session onto a second browser/device is
// not implemented yet - that needs the second device to open a
// "redeem this code" flow which isn't built. This gives the UI and
// the server-side code exchange to build that on top of.
// ============================================================

function renderLinkedDevicesPanel() {

    if (!accountPanelBody) return;

    accountPanelBody.innerHTML = `
        <div class="settings-block">
            <h4 class="settings-heading">This device</h4>
            <div class="panel-person">
                <div class="panel-avatar">${avatarMarkup(me ? me.name : "Me", me && me.avatar)}</div>
                <div class="panel-person-info">
                    <div class="panel-person-name">This browser</div>
                    <div class="panel-person-status online">Active now</div>
                </div>
            </div>
        </div>

        <div class="settings-block">
            <h4 class="settings-heading">Other linked devices</h4>
            <div id="linkedDevicesList"><p class="settings-hint">Loading\u2026</p></div>
        </div>

        <div class="settings-block">
            <button type="button" class="modal-primary-btn" id="linkDeviceBtn">
                <i class="fa-solid fa-qrcode"></i> Link a device
            </button>
            <div id="linkDeviceCodeWrap" class="link-device-code-wrap hidden"></div>
        </div>
    `;

    document.getElementById("linkDeviceBtn").addEventListener("click", () => {
        socket.emit("request-link-code");
    });

    socket.emit("get-linked-devices");

}

socket.on("linked-devices", ({ devices } = {}) => {

    const list = document.getElementById("linkedDevicesList");
    if (!list) return;

    if (!devices || !devices.length) {
        list.innerHTML = `<p class="settings-hint">No other devices linked yet.</p>`;
        return;
    }

    list.innerHTML = "";

    devices.forEach((device) => {

        const row = document.createElement("div");
        row.className = "panel-person";

        row.innerHTML = `
            <div class="panel-avatar"><i class="fa-solid fa-display"></i></div>
            <div class="panel-person-info">
                <div class="panel-person-name">${escapeHtml(device.name || "Linked device")}</div>
                <div class="panel-person-status">Linked ${formatTime(device.linkedAt)}</div>
            </div>
            <div class="panel-actions">
                <button type="button" class="panel-action linked-device-remove-btn">Remove</button>
            </div>
        `;

        row.querySelector(".linked-device-remove-btn").addEventListener("click", () => {
            socket.emit("remove-linked-device", { deviceId: device.id });
        });

        list.appendChild(row);

    });

});

socket.on("link-code", ({ code, expiresInMs } = {}) => {

    const wrap = document.getElementById("linkDeviceCodeWrap");
    if (!wrap) return;

    wrap.classList.remove("hidden");

    const minutes = Math.round((expiresInMs || 0) / 60000);

    wrap.innerHTML = `
        <p class="settings-hint">Enter this code on the new device:</p>
        <div class="link-device-code">${escapeHtml(code)}</div>
        <p class="settings-hint">Expires in ${minutes} minute${minutes === 1 ? "" : "s"}.</p>
    `;

});


// ============================================================
// CHAT BACKUP & EXPORT (Settings > Chats > Chat backup)
// Fully working: bundles the server's copy of this user's
// conversations and downloads it as a JSON file.
// ============================================================

function requestChatBackup() {
    socket.emit("request-chat-backup");
}

socket.on("chat-backup-ready", ({ exportedAt, conversations: backupData } = {}) => {

    try {

        const blob = new Blob(
            [JSON.stringify({ exportedAt, conversations: backupData }, null, 2)],
            { type: "application/json" }
        );

        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");

        a.href = url;
        a.download = `chat-backup-${new Date(exportedAt || Date.now()).toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(url);

    } catch (err) {

        showNiceAlert("Couldn't prepare the backup file.", { title: "Chat backup", icon: "fa-box-archive" });

    }

});


// ============================================================
// SETTINGS PANEL (notification sound + call ringtone)
// ============================================================

function renderSettingsPanel() {

    if (!accountPanelBody) return;


    const section = (kind, heading, hint) => {

        const wrap =
            document.createElement("div");

        wrap.className =
            "settings-block";


        const h =
            document.createElement("h4");

        h.className =
            "settings-heading";

        h.textContent =
            heading;

        wrap.appendChild(h);


        if (hint) {

            const p =
                document.createElement("p");

            p.className =
                "settings-hint";

            p.textContent =
                hint;

            wrap.appendChild(p);

        }


        const list =
            document.createElement("div");

        list.className =
            "sound-options";


        const presets =
            getSoundPresets(kind);

        const currentChoice =
            getSoundChoice(kind);

        const groupName =
            `sound-${kind}`;


        Object.entries(presets).forEach(
            ([key, preset]) => {

                const row =
                    document.createElement("label");

                row.className =
                    "sound-option" +
                    (currentChoice === key ? " selected" : "");

                row.innerHTML = `

                    <input
                        type="radio"
                        name="${groupName}"
                        value="${key}"
                        ${currentChoice === key ? "checked" : ""}>

                    <span>${escapeHtml(preset.label)}</span>

                    <button
                        type="button"
                        class="sound-preview-btn"
                        title="Preview">
                        <i class="fa-solid fa-play"></i>
                    </button>

                `;


                row.querySelector("input").addEventListener(
                    "change",
                    () => {

                        localStorage.setItem(
                            `siteChat${kind}Choice`,
                            key
                        );

                    }
                );


                row.querySelector(".sound-preview-btn").addEventListener(
                    "click",
                    (e) => {

                        e.preventDefault();

                        preset.play(
                            getAudioCtx()
                        );

                    }
                );


                list.appendChild(row);

            }
        );


        // --- custom (uploaded from device) ---

        const customName =
            localStorage.getItem(
                `siteChat${kind}CustomName`
            );

        const customRow =
            document.createElement("label");

        customRow.className =
            "sound-option custom-option" +
            (currentChoice === "custom" ? " selected" : "");

        customRow.innerHTML = `

            <input
                type="radio"
                name="${groupName}"
                value="custom"
                ${currentChoice === "custom" ? "checked" : ""}
                ${!localStorage.getItem(`siteChat${kind}Custom`) ? "disabled" : ""}>

            <span>
                ${
                    customName ?
                        `From device: ${escapeHtml(customName)}` :
                        "From device (none uploaded)"
                }
            </span>

            <button
                type="button"
                class="sound-preview-btn"
                title="Preview"
                ${!localStorage.getItem(`siteChat${kind}Custom`) ? "disabled" : ""}>
                <i class="fa-solid fa-play"></i>
            </button>

        `;


        customRow.querySelector("input").addEventListener(
            "change",
            () => {

                localStorage.setItem(
                    `siteChat${kind}Choice`,
                    "custom"
                );

            }
        );


        customRow.querySelector(".sound-preview-btn").addEventListener(
            "click",
            (e) => {

                e.preventDefault();

                const dataUrl =
                    localStorage.getItem(
                        `siteChat${kind}Custom`
                    );

                if (dataUrl) {

                    new Audio(dataUrl).play().catch(
                        () => {}
                    );

                }

            }
        );


        list.appendChild(customRow);


        // keep the highlighted row in sync with whichever radio is
        // actually checked (works everywhere, not just browsers that
        // support the CSS :has() selector)
        list.addEventListener(
            "change",
            () => {

                list.querySelectorAll(".sound-option").forEach(
                    row => {

                        const input =
                            row.querySelector('input[type="radio"]');

                        row.classList.toggle(
                            "selected",
                            Boolean(input && input.checked)
                        );

                    }
                );

            }
        );


        // --- upload button ---

        const uploadBtn =
            document.createElement("button");

        uploadBtn.type =
            "button";

        uploadBtn.className =
            "sound-upload-btn";

        uploadBtn.innerHTML = `
            <i class="fa-solid fa-upload"></i>
            Upload a sound from your device
        `;


        const fileInput =
            document.createElement("input");

        fileInput.type =
            "file";

        fileInput.accept =
            "audio/*";

        fileInput.hidden =
            true;


        uploadBtn.addEventListener(
            "click",
            () =>
                fileInput.click()
        );


        fileInput.addEventListener(
            "change",
            async () => {

                const file =
                    fileInput.files &&
                    fileInput.files[0];

                if (!file) return;

                try {

                    await handleCustomSoundUpload(
                        kind,
                        file
                    );

                    localStorage.setItem(
                        `siteChat${kind}CustomName`,
                        file.name
                    );

                    renderSettingsPanel();

                }

                catch (err) {

                    showNiceAlert(
                        err.message ||
                        "Couldn't upload that sound.",
                        { title: "Sound upload", icon: "fa-volume-high" }
                    );

                }

                fileInput.value =
                    "";

            }
        );


        wrap.appendChild(list);
        wrap.appendChild(uploadBtn);
        wrap.appendChild(fileInput);


        return wrap;

    };


    accountPanelBody.appendChild(
        section(
            "Notification",
            "Message notification sound",
            "Plays when you receive a new message"
        )
    );

    accountPanelBody.appendChild(
        section(
            "Ringtone",
            "Call ringtone",
            "Plays while an incoming call is ringing"
        )
    );

    accountPanelBody.appendChild(
        renderDisappearingDefaultSection()
    );


    // ---- chat backup & export ----

    const backupBlock = document.createElement("div");
    backupBlock.className = "settings-block";
    backupBlock.innerHTML = `
        <h4 class="settings-heading">Chat backup</h4>
        <p class="settings-hint">Download a copy of your chats as a file.</p>
    `;

    const backupBtn = document.createElement("button");
    backupBtn.type = "button";
    backupBtn.className = "modal-secondary-btn";
    backupBtn.innerHTML = '<i class="fa-solid fa-box-archive"></i> Export chats';
    backupBtn.addEventListener("click", requestChatBackup);

    backupBlock.appendChild(backupBtn);
    accountPanelBody.appendChild(backupBlock);

}


// ============================================================
// SETTINGS: DEFAULT DISAPPEARING MESSAGES
// (applied automatically to brand-new conversations; an existing
// conversation's own setting, changed from its chat header, always
// wins over this default)
// ============================================================

function getDefaultDisappearingSeconds() {

    return Number(
        localStorage.getItem("siteChatDisappearingDefault") || 0
    );

}

function renderDisappearingDefaultSection() {

    const wrap = document.createElement("div");
    wrap.className = "settings-block";

    const h = document.createElement("h4");
    h.className = "settings-heading";
    h.textContent = "Disappearing messages";
    wrap.appendChild(h);

    const hint = document.createElement("p");
    hint.className = "settings-hint";
    hint.textContent =
        "Default for new conversations you start. You can still change it per-chat from the clock icon in that chat's header.";
    wrap.appendChild(hint);

    const list = document.createElement("div");
    list.className = "sound-options";

    const current = getDefaultDisappearingSeconds();
    const groupName = "disappearingDefault";

    DISAPPEARING_OPTIONS.forEach(opt => {

        const row = document.createElement("label");
        row.className =
            "sound-option" +
            (current === opt.seconds ? " selected" : "");

        row.innerHTML = `
            <input
                type="radio"
                name="${groupName}"
                value="${opt.seconds}"
                ${current === opt.seconds ? "checked" : ""}>
            <span>${opt.label}</span>
        `;

        row.querySelector("input").addEventListener("change", () => {

            localStorage.setItem(
                "siteChatDisappearingDefault",
                String(opt.seconds)
            );

            list.querySelectorAll(".sound-option").forEach(r =>
                r.classList.remove("selected")
            );

            row.classList.add("selected");

        });

        list.appendChild(row);

    });

    wrap.appendChild(list);

    return wrap;

}


// ============================================================
// ACCOUNT PERSON
// ============================================================

function makePanelPerson(
    u,
    isFriend
) {

    const row =
        document.createElement(
            "div"
        );


    row.className =
        "panel-person";


    const relation =
        getFriendRelation(
            u.id
        );


    const online =
        Boolean(
            usersOnline[u.id]
        );


    row.innerHTML = `

        <div class="panel-avatar">
            ${avatarMarkup(
                u.name,
                u.avatar
            )}
        </div>

        <span class="dot"></span>

        <div class="panel-person-info">

            <div class="panel-person-name">
                ${escapeHtml(
                    u.name
                )}
            </div>

            <div class="panel-person-status ${
                online
                    ? "online"
                    : ""
            }">

                ${
                    online
                        ? "Online"
                        : "Offline"
                }

            </div>

        </div>

        <div class="panel-actions"></div>

    `;


    const actions =
        row.querySelector(
            ".panel-actions"
        );


    if (
        isFriend
    ) {

        const chat =
            document.createElement(
                "button"
            );


        chat.className =
            "panel-action";


        chat.textContent =
            "Chat";


        chat.addEventListener(
            "click",
            () => {

                openChat(
                    u.id,
                    u.name
                );


                if (closeAccountPanel) {

                    closeAccountPanel.click();

                }

            }
        );


        actions.appendChild(
            chat
        );


        const remove =
            document.createElement(
                "button"
            );


        remove.className =
            "panel-action danger";


        remove.textContent =
            "Remove";


        remove.addEventListener(
            "click",
            () =>
                removeFriend(u)
        );


        actions.appendChild(
            remove
        );

    }


    else if (
        relation === "friend"
    ) {

        const chat =
            document.createElement(
                "button"
            );


        chat.className =
            "panel-action";


        chat.textContent =
            "Chat";


        chat.addEventListener(
            "click",
            () => {

                openChat(
                    u.id,
                    u.name
                );


                if (closeAccountPanel) {

                    closeAccountPanel.click();

                }

            }
        );


        actions.appendChild(
            chat
        );

    }


    else if (
        relation === "pending"
    ) {

        const pending =
            document.createElement(
                "button"
            );


        pending.className =
            "panel-action";


        pending.textContent =
            "Requested";


        pending.disabled =
            true;


        actions.appendChild(
            pending
        );

    }


    else if (
        relation === "incoming"
    ) {

        const accept =
            document.createElement(
                "button"
            );


        accept.className =
            "panel-action primary";


        accept.textContent =
            "Confirm";


        accept.addEventListener(
            "click",
            () =>
                respondToRequest(
                    u,
                    true
                )
        );


        actions.appendChild(
            accept
        );

    }


    else {

        const add =
            document.createElement(
                "button"
            );


        add.className =
            "panel-action primary";


        add.textContent =
            "Add friend";


        add.addEventListener(
            "click",
            () => {

                handleFriendAction(
                    u
                );


                renderAccountPanel(
                    "online"
                );

            }
        );


        actions.appendChild(
            add
        );

    }


    return row;

}


// ============================================================
// RESPOND TO FRIEND REQUEST
// ============================================================

function respondToRequest(
    user,
    accept
) {

    socket.emit(
        "friend-request-response",
        {
            requestId: user.id,
            fromId: user.id,
            accept
        }
    );


    if (accept) {

        friendIds.add(
            user.id
        );

    }


    pendingReceived.delete(
        user.id
    );


    saveFriendState();

    updateCounts();

    renderFriendsList();

    renderAccountPanel(
        "requests"
    );

    refreshPeopleList();

}


// ============================================================
// REMOVE FRIEND
// ============================================================

async function removeFriend(
    user
) {

    const ok = await showNiceConfirm(
        `Remove ${user.name} from your friends?`,
        { title: "Remove friend", icon: "fa-user-minus", confirmText: "Remove" }
    );

    if (!ok) {

        return;

    }


    friendIds.delete(
        user.id
    );


    saveFriendState();

    updateCounts();

    renderFriendsList();

    renderAccountPanel(
        "friends"
    );

    refreshPeopleList();


    socket.emit(
        "friend-remove",
        {
            toId: user.id
        }
    );

}


// ============================================================
// EMPTY PANEL
// ============================================================

function emptyPanel(
    text
) {

    if (!accountPanelBody) {
        return;
    }


    const div =
        document.createElement(
            "div"
        );


    div.className =
        "empty-panel";


    div.textContent =
        text;


    accountPanelBody.appendChild(
        div
    );

}


// ============================================================
// LOGOUT
// ============================================================

if (logoutBtn) {

    logoutBtn.addEventListener(
        "click",
        () => {

            localStorage.removeItem(
                "siteChatName"
            );

            localStorage.removeItem(
                "siteChatEmail"
            );


            if (
                socket.connected
            ) {

                socket.emit(
                    "logout"
                );

            }


            location.reload();

        }
    );

}


// ============================================================
// DELETE ACCOUNT
// ============================================================

if (deleteAccountBtn) {

    deleteAccountBtn.addEventListener(
        "click",
        async () => {

            const confirmed = await showNiceConfirm(
                "This permanently deletes your account. You'll need to create a new account to join the chat again. This can't be undone.",
                {
                    title: "Delete account?",
                    icon: "fa-trash-can",
                    danger: true,
                    confirmText: "Delete account",
                    cancelText: "Cancel"
                }
            );

            if (!confirmed) return;

            if (deleteAccountBtn) {
                deleteAccountBtn.disabled = true;
            }

            socket.emit("delete-account");

        }
    );

}

socket.on("account-deleted", () => {

    localStorage.removeItem("siteChatName");
    localStorage.removeItem("siteChatEmail");

    // a fresh reload is the simplest way to drop every bit of
    // in-memory session state and land back on a clean join screen
    location.reload();

});

socket.on("account-delete-error", ({ message } = {}) => {

    if (deleteAccountBtn) {
        deleteAccountBtn.disabled = false;
    }

    showNiceAlert(
        message || "Couldn't delete your account. Please try again.",
        { title: "Couldn't delete account", icon: "fa-triangle-exclamation" }
    );

});


// ============================================================
// OPEN CHAT
// ============================================================

function openChat(
    id,
    name,
    groupInfo
) {

    activeChat =
        groupInfo
            ? {
                id,
                name,
                isGroup: true,
                memberIds: groupInfo.memberIds || [],
                adminIds: groupInfo.adminIds || [],
                icon: groupInfo.icon || null,
                description: groupInfo.description || "",
                adminsOnlyMessages: !!groupInfo.adminsOnlyMessages
            }
            : { id, name };


    if (unreadCounts[id]) {

        delete unreadCounts[id];

        renderFriendsList();
        renderGroupsList();

    }


    if (chatWith) {

        chatWith.textContent =
            name;

    }


    if (chatStatus) {

        chatStatus.textContent =
            activeChat.isGroup
                ? `${activeChat.memberIds.length} members`
                : (usersOnline[id] ? "Online" : "Offline");

    }


    if (headerActions) {

        headerActions.hidden =
            false;

    }


    // on phone, opening a chat takes over the full screen; the
    // back button (chatBackBtn) reverses this. Harmless on wider
    // screens, since only the phone media query reacts to it.
    if (app) {

        app.classList.add(
            "chat-open"
        );

    }


    if (composer) {

        composer.hidden =
            false;

    }


    document
        .querySelectorAll(
            ".friend-item, .group-item"
        )
        .forEach(
            item => {

                item.classList.toggle(
                    "active",
                    item.dataset.id === id
                );

            }
        );


    clearReplyPreview();
    cancelEditMessage();
    hideTypingBubble();
    closeMentionDropdown();
    currentMentionIds.clear();

    renderPinnedBanner();
    updateAdminsOnlyComposerLock();

    // ask the server for what's already been saved for this
    // conversation (and where we/they last reached) the first time
    // we open it this session; after that we already have it live
    if (!historyLoaded.has(id)) {

        if (activeChat.isGroup) {
            socket.emit("get-group-history", { groupId: id });
        } else {
            socket.emit("get-history", { toId: id });
        }

    } else {

        renderMessages();
        scrollToLastReadPosition(id);
        updateDisappearingToggleUI(id);

    }

}

// ============================================================
// DISAPPEARING MESSAGES
// ============================================================

function updateDisappearingToggleUI(id) {

    if (!disappearingBtn) return;

    const setting =
        disappearingSettings[id] || { enabled: false, seconds: 0 };

    disappearingBtn.classList.toggle(
        "disappearing-btn-active",
        !!setting.enabled
    );

    disappearingBtn.title =
        setting.enabled
            ? `Disappearing messages: ${
                DISAPPEARING_OPTIONS.find(o => o.seconds === setting.seconds)?.label || "on"
            }`
            : "Disappearing messages";

    renderDisappearingMenu(id);

}

function renderDisappearingMenu(id) {

    if (!disappearingOptions) return;

    const setting =
        disappearingSettings[id] || { enabled: false, seconds: 0 };

    disappearingOptions.innerHTML = "";

    DISAPPEARING_OPTIONS.forEach(opt => {

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "disappearing-option";

        const selected =
            (setting.seconds || 0) === opt.seconds;

        if (selected) btn.classList.add("selected");

        btn.innerHTML = `
            <span>${opt.label}</span>
            ${selected ? '<i class="fa-solid fa-check"></i>' : ""}
        `;

        btn.addEventListener("click", () => {

            socket.emit("set-disappearing", { toId: id, seconds: opt.seconds });
            disappearingMenu.classList.add("hidden");

            if (disappearingBtn) {
                disappearingBtn.setAttribute("aria-expanded", "false");
            }

        });

        disappearingOptions.appendChild(btn);

    });

}

if (disappearingBtn) {

    disappearingBtn.addEventListener("click", (e) => {

        e.stopPropagation();

        if (!activeChat || !disappearingMenu) return;

        const opening = disappearingMenu.classList.contains("hidden");

        disappearingMenu.classList.toggle("hidden", !opening);
        disappearingBtn.setAttribute("aria-expanded", String(opening));

        if (opening) renderDisappearingMenu(activeChat.id);

    });

}

document.addEventListener("click", () => {

    if (disappearingMenu && !disappearingMenu.classList.contains("hidden")) {
        disappearingMenu.classList.add("hidden");
        if (disappearingBtn) disappearingBtn.setAttribute("aria-expanded", "false");
    }

});

if (disappearingMenu) {
    disappearingMenu.addEventListener("click", (e) => e.stopPropagation());
}

socket.on("disappearing-updated", ({ toId, enabled, seconds, fromName } = {}) => {

    if (!toId) return;

    disappearingSettings[toId] = { enabled: !!enabled, seconds: seconds || 0 };

    if (activeChat && activeChat.id === toId) {
        updateDisappearingToggleUI(toId);
    }

    // let both people see a small system note about the change, same
    // as "X joined the chat" style notices elsewhere in this app
    if (activeChat && activeChat.id === toId) {

        const label =
            enabled
                ? `disappearing messages turned on (${
                    DISAPPEARING_OPTIONS.find(o => o.seconds === seconds)?.label || ""
                })`
                : "disappearing messages turned off";

        const who =
            fromName && me && fromName !== me.name
                ? fromName
                : "You";

        appendSystemMessage(`${who} ${label}`);

    }

});


if (sendBtn) {

    sendBtn.addEventListener(
        "click",
        sendText
    );

}


if (textInput) {

    textInput.addEventListener(
        "keydown",
        (e) => {

            if (
                e.key === "Enter"
            ) {

                sendText();

            }

        }
    );

}


// ---- @mentions (group chats only) ----

const currentMentionIds = new Set();

// members other than yourself, for the @mention picker
function mentionCandidates() {

    if (!activeChat || !activeChat.isGroup || !me) return [];

    return activeChat.memberIds
        .filter(id => id !== me.id)
        .map(id => ({
            id,
            name: (usersOnline[id] && usersOnline[id].name) || (friendProfiles[id] && friendProfiles[id].name) || id
        }));
}

// finds an in-progress "@fragment" ending at the cursor, if any
function currentMentionQuery() {

    if (!textInput) return null;

    const caret = textInput.selectionStart || 0;
    const upToCaret = textInput.value.slice(0, caret);
    const match = upToCaret.match(/(?:^|\s)@([a-zA-Z0-9._-]*)$/);

    if (!match) return null;

    return { fragment: match[1], start: caret - match[1].length - 1 };
}

function closeMentionDropdown() {
    if (mentionDropdown) mentionDropdown.classList.add("hidden");
}

function renderMentionDropdown() {

    if (!mentionDropdown || !textInput) return;

    const query = currentMentionQuery();

    if (!query || !activeChat || !activeChat.isGroup) {
        closeMentionDropdown();
        return;
    }

    const fragment = query.fragment.toLowerCase();

    const options = mentionCandidates()
        .filter(p => p.name.toLowerCase().startsWith(fragment))
        .slice(0, 6);

    // "everyone" always shows up as an option, same as WhatsApp's @all
    if ("everyone".startsWith(fragment)) {
        options.unshift({ id: null, name: "everyone" });
    }

    if (!options.length) {
        closeMentionDropdown();
        return;
    }

    mentionDropdown.innerHTML =
        options.map(p => `
            <button type="button" class="mention-option" data-id="${p.id || ""}" data-name="${escapeHtml(p.name)}">
                ${p.id ? '<i class="fa-solid fa-user"></i>' : '<i class="fa-solid fa-user-group"></i>'}
                ${escapeHtml(p.name)}
            </button>
        `).join("");

    mentionDropdown.querySelectorAll("[data-name]").forEach((btn) => {
        btn.addEventListener("click", () => {

            const name = btn.dataset.name;
            const id = btn.dataset.id;

            const before = textInput.value.slice(0, query.start);
            const after = textInput.value.slice(textInput.selectionStart || 0);

            textInput.value = `${before}@${name} ${after}`;

            if (id) currentMentionIds.add(id);

            const newCaret = (before + "@" + name + " ").length;
            textInput.focus();
            textInput.setSelectionRange(newCaret, newCaret);

            closeMentionDropdown();
        });
    });

    mentionDropdown.classList.remove("hidden");
}

if (textInput) {
    textInput.addEventListener("input", renderMentionDropdown);
    textInput.addEventListener("keyup", (e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") renderMentionDropdown();
    });
    textInput.addEventListener("blur", () => setTimeout(closeMentionDropdown, 150));
}


// ---- typing indicator: let the other side know we're typing ----

let lastTypingEmitAt = 0;

if (textInput) {

    textInput.addEventListener("input", () => {

        if (!activeChat) return;

        const now = Date.now();

        // throttle to at most once every 1.5s so we don't spam the socket
        if (now - lastTypingEmitAt < 1500) return;

        lastTypingEmitAt = now;
        socket.emit("typing", activeChat.id);
    });

}

const typingTimers = {};

socket.on("typing", ({ fromId, toId }) => {

    // for a 1:1 chat the relevant id is the sender (fromId); for a
    // group chat it's the group itself (toId) - either way, only
    // react if that's the conversation currently open
    if (!activeChat || (fromId !== activeChat.id && toId !== activeChat.id)) return;

    const isGroup = activeChat.isGroup;
    const label = isGroup ? ((usersOnline[fromId] && usersOnline[fromId].name) || "Someone") : null;

    if (chatStatus) {
        chatStatus.textContent = isGroup ? `${label} is typing…` : "typing…";
        chatStatus.classList.add("typing-indicator");
    }

    showTypingBubble();

    clearTimeout(typingTimers[fromId]);

    typingTimers[fromId] = setTimeout(() => {

        if (!activeChat || (activeChat.id !== fromId && activeChat.id !== toId)) return;

        if (chatStatus) {
            chatStatus.classList.remove("typing-indicator");
            chatStatus.textContent =
                isGroup
                    ? `${activeChat.memberIds.length} members`
                    : (usersOnline[fromId] ? "Online" : "Offline");
        }

        hideTypingBubble();

    }, 2200);
});


// ---- animated three-dot "typing…" bubble in the message list ----

let typingBubbleRow = null;

function showTypingBubble() {

    if (!messagesEl || typingBubbleRow) return;

    typingBubbleRow = document.createElement("div");
    typingBubbleRow.className = "msg-row theirs typing-row";

    typingBubbleRow.innerHTML = `
        <div class="bubble typing-bubble">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
        </div>
    `;

    messagesEl.appendChild(typingBubbleRow);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideTypingBubble() {

    if (typingBubbleRow && typingBubbleRow.parentNode) {
        typingBubbleRow.parentNode.removeChild(typingBubbleRow);
    }

    typingBubbleRow = null;
}


function sendText() {

    if (!textInput) return;


    const text =
        textInput.value.trim();


    if (!activeChat) {
        return;
    }

    // editing an already-sent message takes priority over everything
    // else the composer could be doing - it never has an attachment
    // to worry about, just new text for an existing message id
    if (editingMessage) {

        if (!text) return;

        socket.emit("edit-message", {
            toId: activeChat.id,
            messageId: editingMessage.id,
            text
        });

        applyMessageEdited({
            messageId: editingMessage.id,
            fromId: editingMessage.from.id,
            toId: activeChat.id,
            text,
            editedAt: Date.now()
        });

        textInput.value = "";
        cancelEditMessage();

        return;
    }

    // a pending attachment (picked via the attach menu) takes priority -
    // whatever is currently typed becomes its caption
    if (pendingFile) {

        const file = pendingFile;
        const forcedKind = pendingForcedKind;
        const viewOnce = pendingViewOnce;
        const replyTo = replyingTo
            ? {
                id: replyingTo.id,
                name: replyingTo.from.id === (me && me.id) ? "You" : replyingTo.from.name,
                preview: messagePreviewText(replyingTo)
            }
            : null;

        clearMediaPreview();

        uploadAndSend(file, forcedKind, { caption: text, viewOnce, replyTo });

        textInput.value = "";
        clearReplyPreview();

        return;

    }

    if (!text) {
        return;
    }

    // only keep mention ids whose "@Name" text is still actually
    // present in the message (covers the user deleting it after
    // picking it from the dropdown)
    const mentions =
        activeChat.isGroup
            ? Array.from(currentMentionIds).filter((id) => {
                const name = (usersOnline[id] && usersOnline[id].name) || (friendProfiles[id] && friendProfiles[id].name);
                return name && text.includes(`@${name}`);
            })
            : [];

    socket.emit(
        "chat-message",
        {
            toId:
                activeChat.id,
            text,
            mentions,
            replyTo: replyingTo
                ? {
                    id: replyingTo.id,
                    name: replyingTo.from.id === (me && me.id) ? "You" : replyingTo.from.name,
                    preview: messagePreviewText(replyingTo)
                }
                : null
        }
    );


    textInput.value =
        "";

    currentMentionIds.clear();
    closeMentionDropdown();
    clearReplyPreview();

}


// ============================================================
// REPLY PREVIEW (composer)
// ============================================================

function messagePreviewText(msg) {

    if (!msg) return "";

    if (msg.deletedForEveryone) return "This message was deleted";
    if (msg.text) return msg.text;

    if (msg.attachment) {

        const kind = msg.attachment.kind;

        if (kind === "image") return "📷 Photo";
        if (kind === "video") return "🎥 Video";
        if (kind === "audio") return "🎤 Voice message";
        if (kind === "gif") return "GIF";
        if (kind === "sticker") return `${msg.attachment.emoji || "🙂"} Sticker`;

        return `📄 ${msg.attachment.name || "Document"}`;
    }

    return "";
}

function startReply(msg) {

    replyingTo = msg;

    if (!replyPreviewBar) return;

    replyPreviewBar.classList.remove("hidden");

    if (replyPreviewName) {
        replyPreviewName.textContent =
            msg.from.id === (me && me.id) ? "Replying to yourself" : `Replying to ${msg.from.name}`;
    }

    if (replyPreviewText) {
        replyPreviewText.textContent = messagePreviewText(msg);
    }

    if (textInput) textInput.focus();
}

function clearReplyPreview() {

    replyingTo = null;

    if (replyPreviewBar) replyPreviewBar.classList.add("hidden");
}

if (replyPreviewClose) {
    replyPreviewClose.addEventListener("click", () => {
        // the close (x) on the composer bar has to clear whichever
        // of reply/edit put it up, or it'll stay stuck open
        if (editingMessage) cancelEditMessage();
        else clearReplyPreview();
    });
}


// ============================================================
// EDIT MESSAGE (composer) - reuses the reply-preview bar's UI
// since only one of "replying" / "editing" is ever active at once
// ============================================================

function startEditMessage(msg) {

    if (!msg.text) return; // only text messages can be edited

    clearReplyPreview();
    editingMessage = msg;

    if (replyPreviewBar) replyPreviewBar.classList.remove("hidden");
    if (replyPreviewName) replyPreviewName.textContent = "Editing message";
    if (replyPreviewText) replyPreviewText.textContent = msg.text;

    if (textInput) {
        textInput.value = msg.text;
        textInput.focus();
        // put the caret at the end rather than the start
        textInput.setSelectionRange(msg.text.length, msg.text.length);
    }
}

function cancelEditMessage() {

    editingMessage = null;

    if (replyPreviewBar) replyPreviewBar.classList.add("hidden");
    if (textInput) textInput.value = "";
}

function applyMessageEdited({ messageId, fromId, toId, text, editedAt }) {

    if (!me) return;

    const convoKey = fromId === me.id ? toId : fromId;
    const found = findMessageInConversation(convoKey, messageId);

    if (found) {
        found.text = text;
        found.edited = true;
        found.editedAt = editedAt || Date.now();
    }

    if (activeChat && activeChat.id === convoKey) {
        renderMessages();
    }
}

socket.on("message-edited", (payload) => {
    applyMessageEdited(payload);
});


// ============================================================
// RECEIVE MESSAGE
// ============================================================

socket.on(
    "chat-message",
    (msg) => {

        if (!me) return;


        // a real message just arrived — the "typing…" state it was
        // preceded by is stale now
        if (msg.from.id !== me.id) {
            clearTimeout(typingTimers[msg.from.id]);
            if (activeChat && (activeChat.id === msg.from.id || activeChat.id === msg.toId)) {
                hideTypingBubble();
                if (chatStatus) {
                    chatStatus.classList.remove("typing-indicator");
                }
            }
        }


        const convoKey =
            (msg.from.id === me.id || isGroupChatId(msg.toId))
                ? msg.toId
                : msg.from.id;


        if (
            !conversations[convoKey]
        ) {

            conversations[convoKey] =
                [];

        }


        conversations[convoKey]
            .push(msg);


        // any message that isn't ours gets a notification sound,
        // whether or not that chat happens to be open right now
        if (msg.from.id !== me.id && !isChatMuted(convoKey)) {

            playNotificationSound();

        }


        // incoming message, not from me, and that chat isn't the
        // one currently open — bump the unread badge on their name
        if (
            msg.from.id !== me.id &&
            (
                !activeChat ||
                convoKey !== activeChat.id
            )
        ) {

            unreadCounts[convoKey] =
                (unreadCounts[convoKey] || 0) + 1;

            if (isGroupChatId(convoKey)) renderGroupsList();
            else renderFriendsList();

        }


        if (
            activeChat &&
            convoKey === activeChat.id
        ) {

            appendMessage(
                msg
            );

            // this chat is open and a new message just landed in it —
            // count it as read right away
            if (msg.from.id !== me.id) {
                markConversationRead(convoKey);
            }

        }

    }
);


// ============================================================
// CHAT HISTORY (loaded from the server on first open)
// ============================================================

socket.on("chat-history", ({ toId, messages, disappearing, pinnedMessageId, lastRead } = {}) => {

    if (!toId) return;

    historyLoaded.add(toId);

    // a live message may already have arrived and been pushed into
    // conversations[toId] while we were waiting on this response —
    // keep those instead of clobbering them with the (slightly
    // older) saved copy
    if (!conversations[toId] || !conversations[toId].length) {
        conversations[toId] = messages || [];
    }

    disappearingSettings[toId] = disappearing || { enabled: false, seconds: 0 };
    lastReadPointers[toId] = lastRead || { mine: null, theirs: null };

    if (pinnedMessageId) pinnedMessages[toId] = pinnedMessageId;
    else delete pinnedMessages[toId];

    // brand-new conversation (nothing saved for it yet) and no
    // disappearing setting has been chosen either way — apply this
    // device's default. An already-established conversation, or one
    // either side already set explicitly, is left alone.
    const defaultSeconds = getDefaultDisappearingSeconds();

    if (
        defaultSeconds > 0 &&
        !(messages && messages.length) &&
        !disappearingSettings[toId].enabled
    ) {

        socket.emit("set-disappearing", { toId, seconds: defaultSeconds });

    }

    if (activeChat && activeChat.id === toId) {

        renderMessages();
        renderPinnedBanner();
        scrollToLastReadPosition(toId);
        updateDisappearingToggleUI(toId);

    }

});

// same idea as "chat-history" above, but for a group conversation
// (one shared history under the group's own id, no per-person
// lastRead/read-receipt tracking)
socket.on("group-history", ({ groupId, messages, disappearing, pinnedMessageId } = {}) => {

    if (!groupId) return;

    historyLoaded.add(groupId);

    if (!conversations[groupId] || !conversations[groupId].length) {
        conversations[groupId] = messages || [];
    }

    disappearingSettings[groupId] = disappearing || { enabled: false, seconds: 0 };

    if (pinnedMessageId) pinnedMessages[groupId] = pinnedMessageId;
    else delete pinnedMessages[groupId];

    if (activeChat && activeChat.id === groupId) {
        renderMessages();
        renderPinnedBanner();
        updateDisappearingToggleUI(groupId);
    }

});

// the other person read up to a given message — currently just
// tracked silently; surfaced here in case a "seen" UI is added later
socket.on("read-receipt", ({ fromId, messageId } = {}) => {

    if (!fromId || !messageId) return;

    if (!lastReadPointers[fromId]) lastReadPointers[fromId] = { mine: null, theirs: null };
    lastReadPointers[fromId].theirs = messageId;

});

// scrolls to the divider marking where this user last left off in a
// conversation ("where you reached"), instead of always jumping to
// the newest message; falls back to the bottom if there's nothing
// unread or nothing saved yet
function scrollToLastReadPosition(id) {

    if (!messagesEl) return;

    const pointer = lastReadPointers[id];
    const lastReadId = pointer && pointer.mine;

    let target = null;

    if (lastReadId) {

        target =
            messagesEl.querySelector(
                `[data-message-id="${lastReadId}"]`
            );

    }

    if (target && target.nextElementSibling) {

        // there's unread content after where we last reached — show a
        // divider right after the last-read message and land on it
        const divider = document.createElement("div");
        divider.className = "unread-divider";
        divider.textContent = "New messages";
        target.after(divider);

        divider.scrollIntoView({ block: "center" });

    } else {

        messagesEl.scrollTop = messagesEl.scrollHeight;

    }

    // give the person a moment to actually see it, then mark the
    // newest message as read so "where you reached" moves forward
    clearTimeout(scrollToLastReadPosition._markTimer);
    scrollToLastReadPosition._markTimer = setTimeout(
        () => markConversationRead(id),
        1200
    );

}

function markConversationRead(id) {

    const list = conversations[id];

    if (!list || !list.length) return;

    const newest = list[list.length - 1];

    if (!newest || !newest.id) return;

    if (!lastReadPointers[id]) lastReadPointers[id] = { mine: null, theirs: null };

    if (lastReadPointers[id].mine === newest.id) return; // already up to date

    lastReadPointers[id].mine = newest.id;

    socket.emit("mark-read", { toId: id, messageId: newest.id });

}


// ============================================================
// RENDER MESSAGES
// ============================================================

function renderMessages() {

    if (!messagesEl) return;


    messagesEl.innerHTML =
        "";

    typingBubbleRow = null;


    if (
        !activeChat
    ) {
        return;
    }


    const list =
        conversations[
            activeChat.id
        ] || [];


    list.forEach(
        appendMessage
    );

}


// ============================================================
// APPEND MESSAGE
// ============================================================

function resolveNameForId(id) {
    if (me && id === me.id) return me.name;
    if (usersOnline[id]) return usersOnline[id].name;
    if (friendProfiles[id]) return friendProfiles[id].name;
    return null;
}

function messageMentionsMe(msg) {

    if (!me) return false;

    if (Array.isArray(msg.mentions) && msg.mentions.includes(me.id)) return true;

    return !!(msg.text && /@(everyone|all)\b/i.test(msg.text));
}

// highlights "@Name" (for anyone in msg.mentions) and "@everyone"/"@all"
// inside a message, without ever using innerHTML on the raw text
function renderMessageTextWithMentions(textSpan, msg) {

    const text = msg.text;
    const mentionIds = Array.isArray(msg.mentions) ? msg.mentions : [];

    const patterns = [];

    mentionIds.forEach((id) => {
        const name = resolveNameForId(id);
        if (name) patterns.push("@" + name);
    });

    if (activeChat && activeChat.isGroup) {
        patterns.push("@everyone", "@all");
    }

    if (!patterns.length) {
        textSpan.textContent = text;
        return;
    }

    // longest patterns first so "@everyone" isn't shadowed by a
    // shorter overlapping match
    const uniquePatterns =
        Array.from(new Set(patterns)).sort((a, b) => b.length - a.length);

    const escapedPatterns =
        uniquePatterns.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

    const re = new RegExp(`(${escapedPatterns.join("|")})(?![\\w])`, "gi");

    let lastIndex = 0;
    let match;

    while ((match = re.exec(text))) {

        if (match.index > lastIndex) {
            textSpan.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        const tag = document.createElement("span");
        tag.className = "mention-tag";

        const lower = match[0].toLowerCase();
        if (
            (me && lower === ("@" + me.name).toLowerCase()) ||
            lower === "@everyone" ||
            lower === "@all"
        ) {
            tag.classList.add("mention-tag-me");
        }

        tag.textContent = match[0];
        textSpan.appendChild(tag);

        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        textSpan.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
}


function appendMessage(
    msg
) {

    if (
        !messagesEl ||
        !me
    ) {
        return;
    }


    const mine =
        msg.from.id === me.id;


    const row =
        document.createElement(
            "div"
        );


    row.className =
        `msg-row ${
            mine
                ? "mine"
                : "theirs"
        }`;

    row.dataset.messageId = msg.id || "";


    const bubble =
        document.createElement(
            "div"
        );


    bubble.className =
        msg.attachment &&
        msg.attachment.kind === "sticker"
            ? "bubble bubble-sticker"
            : "bubble";


    if (msg.deletedForEveryone) {

        bubble.classList.add("bubble-deleted");

        const del = document.createElement("span");
        del.className = "deleted-msg";
        del.innerHTML = '<i class="fa-solid fa-ban"></i> This message was deleted';
        bubble.appendChild(del);

    } else {

        if (msg.forwarded) {

            const fwd = document.createElement("div");
            fwd.className = "forwarded-label";
            fwd.innerHTML = '<i class="fa-solid fa-share"></i> Forwarded';
            bubble.appendChild(fwd);

        }

        if (msg.replyTo) {

            const quote = document.createElement("div");
            quote.className = "quoted-reply";

            const qName = document.createElement("div");
            qName.className = "quoted-reply-name";
            qName.textContent = msg.replyTo.name || "";

            const qText = document.createElement("div");
            qText.className = "quoted-reply-text";
            qText.textContent = msg.replyTo.preview || "";

            quote.appendChild(qName);
            quote.appendChild(qText);

            quote.addEventListener("click", (e) => {
                e.stopPropagation();
                jumpToMessage(msg.replyTo.id);
            });

            bubble.appendChild(quote);

        }

        if (msg.text) {

            const textSpan = document.createElement("span");
            textSpan.className = "msg-text";

            renderMessageTextWithMentions(textSpan, msg);

            twemojify(textSpan);

            bubble.appendChild(textSpan);

        }

        if (activeChat && activeChat.isGroup && me && messageMentionsMe(msg)) {
            bubble.classList.add("bubble-mentioned");
        }


        if (msg.attachment) {

            bubble.appendChild(
                renderAttachment(
                    msg.attachment
                )
            );

        }
    }


    const meta =
        document.createElement(
            "div"
        );


    meta.className =
        "msg-meta";


    meta.textContent =
        `${
            mine
                ? "You"
                : msg.from.name
        } · ${
            formatTime(msg.at)
        }${
            msg.edited
                ? " · edited"
                : ""
        }`;


    if (msg.starred) {

        const starIcon =
            document.createElement("i");

        starIcon.className =
            "fa-solid fa-star msg-star-badge";

        starIcon.title =
            "Starred";

        meta.insertBefore(
            starIcon,
            meta.firstChild
        );

    }


    if (!msg.deletedForEveryone) {

        bubble.appendChild(makeMessageActionsBtn(msg, row));

        attachLongPress(bubble, (e) => {
            openMessageActionSheet(msg, row);
        });

    }

    row.appendChild(
        bubble
    );

    if (!msg.deletedForEveryone) {
        row.appendChild(renderReactionsRow(msg));
    }

    row.appendChild(
        meta
    );

    if (
        activeChat &&
        pinnedMessages[activeChat.id] === msg.id
    ) {
        row.classList.add("is-pinned");
    }


    messagesEl.appendChild(
        row
    );


    messagesEl.scrollTop =
        messagesEl.scrollHeight;

}


function jumpToMessage(messageId) {

    if (!messagesEl || !messageId) return;

    const target = messagesEl.querySelector(
        `.msg-row[data-message-id="${messageId}"]`
    );

    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "center" });

    target.classList.add("flash-highlight");

    setTimeout(() => target.classList.remove("flash-highlight"), 1000);

}


// ============================================================
// MESSAGE ACTIONS (delete for me / delete for everyone)
// ============================================================

function findMessageInConversation(convoKey, messageId) {

    const list = conversations[convoKey] || [];
    return list.find((m) => m.id === messageId);
}

function makeMessageActionsBtn(msg, row) {

    // small "..." button, shown on hover (desktop) — opens the same
    // WhatsApp-style action sheet as a long-press does, so both
    // mouse and touch users reach the full set of options
    const wrap = document.createElement("div");
    wrap.className = "msg-actions";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "msg-actions-btn";
    btn.title = "Message options";
    btn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openMessageActionSheet(msg, row);
    });

    wrap.appendChild(btn);

    return wrap;
}

function closeAllMessageMenus() {
    closeMessageActionSheet();
}


// ============================================================
// LONG PRESS (touch) / RIGHT-CLICK (desktop) → action sheet
// ============================================================

function attachLongPress(el, onLongPress) {

    let timer = null;
    let startX = 0;
    let startY = 0;
    let firedByLongPress = false;

    const clear = () => {
        clearTimeout(timer);
        timer = null;
    };

    const start = (e) => {

        const point = e.touches ? e.touches[0] : e;
        startX = point.clientX;
        startY = point.clientY;
        firedByLongPress = false;

        clear();
        timer = setTimeout(() => {
            firedByLongPress = true;
            if (navigator.vibrate) navigator.vibrate(15);
            onLongPress(e);
        }, 450);
    };

    const move = (e) => {

        if (!timer) return;

        const point = e.touches ? e.touches[0] : e;

        if (
            Math.abs(point.clientX - startX) > 10 ||
            Math.abs(point.clientY - startY) > 10
        ) {
            clear();
        }
    };

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", clear);
    el.addEventListener("touchcancel", clear);

    el.addEventListener("mousedown", start);
    el.addEventListener("mousemove", move);
    el.addEventListener("mouseup", clear);
    el.addEventListener("mouseleave", clear);

    // right-click (desktop) jumps straight to the sheet too
    el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        clear();
        onLongPress(e);
    });

    // a normal click that followed a fired long-press shouldn't also
    // trigger whatever the click would otherwise do
    el.addEventListener("click", (e) => {
        if (firedByLongPress) {
            e.stopPropagation();
            firedByLongPress = false;
        }
    });
}


// ============================================================
// MESSAGE ACTION SHEET (reactions + reply/forward/pin/copy/
// share/delete) — WhatsApp-style, opened by long-press or by
// tapping the "..." button on a message
// ============================================================

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

let openActionSheetEl = null;

function closeMessageActionSheet() {

    if (openActionSheetEl && openActionSheetEl.parentNode) {
        openActionSheetEl.parentNode.removeChild(openActionSheetEl);
    }

    openActionSheetEl = null;
}

function openMessageActionSheet(msg, row) {

    closeMessageActionSheet();

    const mine = me && msg.from.id === me.id;
    const convoKey = activeChat && activeChat.id;

    const overlay = document.createElement("div");
    overlay.className = "msg-sheet-overlay";

    const backdrop = document.createElement("div");
    backdrop.className = "msg-sheet-backdrop";
    backdrop.addEventListener("click", closeMessageActionSheet);

    const sheet = document.createElement("div");
    sheet.className = "msg-sheet";

    // ---- quick reactions ----
    const reactions = document.createElement("div");
    reactions.className = "msg-sheet-reactions";

    QUICK_REACTIONS.forEach((emoji) => {

        const rBtn = document.createElement("button");
        rBtn.type = "button";
        rBtn.className = "msg-sheet-reaction";

        const already =
            msg.reactions &&
            msg.reactions[emoji] &&
            me &&
            msg.reactions[emoji].includes(me.id);

        if (already) rBtn.classList.add("active");

        rBtn.textContent = emoji;

        rBtn.addEventListener("click", () => {
            toggleReaction(msg, emoji);
            closeMessageActionSheet();
        });

        reactions.appendChild(rBtn);
    });

    // ---- preview of the message being acted on ----
    const preview = document.createElement("div");
    preview.className = "msg-sheet-preview";
    preview.textContent = messagePreviewText(msg);

    // ---- action list ----
    const actions = document.createElement("div");
    actions.className = "msg-sheet-actions";

    const addAction = (icon, label, onClick, danger) => {

        const b = document.createElement("button");
        b.type = "button";
        if (danger) b.className = "danger";
        b.innerHTML = `<i class="fa-solid ${icon}"></i> ${label}`;
        b.addEventListener("click", () => {
            onClick();
            closeMessageActionSheet();
        });

        actions.appendChild(b);
    };

    if (!msg.deletedForEveryone) {

        addAction("fa-reply", "Reply", () => startReply(msg));
        addAction("fa-share", "Forward", () => openForwardPicker(msg));

        // WhatsApp only lets the original sender edit their own text
        // messages (no attachments, no other person's messages)
        if (mine && msg.text && !msg.attachment) {
            addAction("fa-pen", "Edit", () => startEditMessage(msg));
        }

        const isPinned = convoKey && pinnedMessages[convoKey] === msg.id;
        addAction(
            "fa-thumbtack",
            isPinned ? "Unpin" : "Pin",
            () => setPinnedMessage(msg, !isPinned)
        );

        addAction(
            "fa-star",
            msg.starred ? "Unstar" : "Star",
            () => toggleStarMessage(msg, convoKey)
        );

        if (msg.text) {
            addAction("fa-copy", "Copy", () => {
                if (navigator.clipboard) navigator.clipboard.writeText(msg.text).catch(() => {});
            });
        }

        if (
            msg.attachment &&
            !["image", "video", "audio", "gif", "sticker"].includes(msg.attachment.kind)
        ) {
            addAction("fa-share-nodes", "Share", () => shareAttachment(msg.attachment));
        }
    }

    addAction("fa-trash", "Delete for me", () => deleteMessageForMe(msg, row));

    if (mine && !msg.deletedForEveryone) {
        addAction("fa-trash", "Delete for everyone", () => deleteMessageForEveryone(msg), true);
    }

    sheet.appendChild(reactions);
    sheet.appendChild(preview);
    sheet.appendChild(actions);

    overlay.appendChild(backdrop);
    overlay.appendChild(sheet);

    document.body.appendChild(overlay);
    openActionSheetEl = overlay;
}

function deleteMessageForMe(msg, row) {

    if (!activeChat) return;

    const list = conversations[activeChat.id] || [];
    const idx = list.findIndex((m) => m.id === msg.id);
    if (idx !== -1) list.splice(idx, 1);

    if (row && row.parentNode) row.parentNode.removeChild(row);
}

function deleteMessageForEveryone(msg) {

    if (!activeChat) return;

    socket.emit("delete-message", {
        toId: activeChat.id,
        messageId: msg.id
    });

    applyMessageDeleted({
        messageId: msg.id,
        fromId: msg.from.id,
        toId: activeChat.id
    });
}

function applyMessageDeleted({ messageId, fromId, toId }) {

    if (!me) return;

    const convoKey = fromId === me.id ? toId : fromId;
    const found = findMessageInConversation(convoKey, messageId);

    if (found) {
        found.deletedForEveryone = true;
        found.text = null;
        found.attachment = null;
    }

    if (activeChat && activeChat.id === convoKey) {
        renderMessages();
    }
}

socket.on("message-deleted", (payload) => {
    applyMessageDeleted(payload);
});


// ---- starred messages: keep the local cache + any open bubble/
// Starred Messages panel in sync with the server's confirmation ----

function toggleStarMessage(msg, chatId) {

    const targetChatId = chatId || (activeChat && activeChat.id);
    if (!targetChatId) return;

    msg.starred = !msg.starred;

    socket.emit("message-context-action", {
        action: "star",
        msgId: msg.id,
        chatId: targetChatId
    });

    if (activeChat && activeChat.id === targetChatId) {
        renderMessages();
    }

}

socket.on("message-starred", ({ chatId, msgId, starred } = {}) => {

    const found = findMessageInConversation(chatId, msgId);

    if (found) {
        found.starred = starred;
    }

    if (activeChat && activeChat.id === chatId) {
        renderMessages();
    }

    // if the Starred Messages panel happens to be open, refresh it
    if (
        accountPanel &&
        !accountPanel.classList.contains("hidden") &&
        accountPanelTitle &&
        accountPanelTitle.textContent === "Starred messages"
    ) {
        renderStarredPanel();
    }

});


// ============================================================
// REACTIONS
// ============================================================

function renderReactionsRow(msg) {

    const wrap = document.createElement("div");
    wrap.className = "msg-reactions-row";

    if (!msg.reactions) return wrap;

    Object.keys(msg.reactions).forEach((emoji) => {

        const users = msg.reactions[emoji];

        if (!users || !users.length) return;

        const pill = document.createElement("button");
        pill.type = "button";
        pill.className = "msg-reaction-pill";

        const mine = me && users.includes(me.id);
        if (mine) pill.classList.add("mine-reacted");

        pill.textContent = users.length > 1 ? `${emoji} ${users.length}` : emoji;

        pill.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleReaction(msg, emoji);
        });

        wrap.appendChild(pill);
    });

    return wrap;
}

function toggleReaction(msg, emoji) {

    if (!activeChat || !me) return;

    const already =
        msg.reactions &&
        msg.reactions[emoji] &&
        msg.reactions[emoji].includes(me.id);

    socket.emit("react-message", {
        toId: activeChat.id,
        messageId: msg.id,
        emoji,
        remove: !!already
    });

    applyMessageReaction({
        messageId: msg.id,
        emoji,
        remove: !!already,
        fromId: me.id,
        toId: activeChat.id
    });
}

function applyMessageReaction({ messageId, emoji, remove, fromId, toId }) {

    if (!me) return;

    // for a group, every reaction lives under the group's own id no
    // matter who reacted; only a 1:1 chat needs the "which side of
    // the pair am I" resolution
    const convoKey = isGroupChatId(toId) ? toId : (fromId === me.id ? toId : fromId);
    const found = findMessageInConversation(convoKey, messageId);

    if (!found) return;

    if (!found.reactions) found.reactions = {};
    if (!found.reactions[emoji]) found.reactions[emoji] = [];

    const idx = found.reactions[emoji].indexOf(fromId);

    if (remove) {
        if (idx !== -1) found.reactions[emoji].splice(idx, 1);
        if (!found.reactions[emoji].length) delete found.reactions[emoji];
    } else if (idx === -1) {
        found.reactions[emoji].push(fromId);
    }

    if (activeChat && activeChat.id === convoKey) {
        renderMessages();
    }
}

socket.on("message-reaction", (payload) => {
    applyMessageReaction(payload);
});


// ============================================================
// PIN MESSAGE
// ============================================================

function setPinnedMessage(msg, pinned) {

    if (!activeChat) return;

    socket.emit("pin-message", {
        toId: activeChat.id,
        messageId: pinned ? msg.id : null
    });

    applyPinnedMessage({
        messageId: pinned ? msg.id : null,
        fromId: me.id,
        toId: activeChat.id
    });
}

function applyPinnedMessage({ messageId, fromId, toId }) {

    if (!me) return;

    const convoKey = isGroupChatId(toId) ? toId : (fromId === me.id ? toId : fromId);

    if (messageId) {
        pinnedMessages[convoKey] = messageId;
    } else {
        delete pinnedMessages[convoKey];
    }

    if (activeChat && activeChat.id === convoKey) {
        renderPinnedBanner();
        renderMessages();
    }
}

function renderPinnedBanner() {

    if (!pinnedBanner || !pinnedBannerText) return;

    if (!activeChat || !pinnedMessages[activeChat.id]) {
        pinnedBanner.classList.add("hidden");
        return;
    }

    const found = findMessageInConversation(activeChat.id, pinnedMessages[activeChat.id]);

    if (!found) {
        pinnedBanner.classList.add("hidden");
        return;
    }

    pinnedBannerText.textContent = messagePreviewText(found);
    pinnedBanner.classList.remove("hidden");
}

if (pinnedBanner) {

    pinnedBanner.addEventListener("click", (e) => {

        if (e.target.closest(".pinned-banner-close")) return;
        if (!activeChat) return;

        const id = pinnedMessages[activeChat.id];
        if (id) jumpToMessage(id);
    });
}

if (pinnedBannerClose) {

    pinnedBannerClose.addEventListener("click", (e) => {

        e.stopPropagation();

        if (!activeChat) return;

        const id = pinnedMessages[activeChat.id];
        const found = id && findMessageInConversation(activeChat.id, id);

        if (found) setPinnedMessage(found, false);
    });
}

socket.on("message-pinned", (payload) => {
    applyPinnedMessage(payload);
});


// ============================================================
// FORWARD MESSAGE
// ============================================================

function openForwardPicker(msg) {

    const overlay = document.createElement("div");
    overlay.className = "forward-modal-overlay";

    const backdrop = document.createElement("div");
    backdrop.className = "forward-modal-backdrop";
    backdrop.addEventListener("click", () => overlay.remove());

    const modal = document.createElement("div");
    modal.className = "forward-modal";

    const header = document.createElement("div");
    header.className = "forward-modal-header";
    header.innerHTML = `<h2>Forward message</h2>`;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "forward-modal-close";
    closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    closeBtn.addEventListener("click", () => overlay.remove());
    header.appendChild(closeBtn);

    const preview = document.createElement("div");
    preview.className = "forward-modal-preview";
    preview.textContent = messagePreviewText(msg);

    const list = document.createElement("div");
    list.className = "forward-modal-list";

    const friends = [...friendIds].map(
        (id) => usersOnline[id] || { id, name: "Friend" }
    );

    if (!friends.length) {

        const empty = document.createElement("div");
        empty.className = "forward-modal-empty";
        empty.textContent = "You don't have any friends to forward to yet.";
        list.appendChild(empty);

    } else {

        friends.forEach((friend) => {

            const item = document.createElement("button");
            item.type = "button";
            item.className = "forward-friend-item";

            item.innerHTML = `
                <span class="forward-friend-avatar">${
                    (friend.name || "?").charAt(0).toUpperCase()
                }</span>
                <span class="forward-friend-name">${escapeHtml(friend.name || "Friend")}</span>
            `;

            item.addEventListener("click", () => {
                forwardMessageTo(msg, friend.id);
                overlay.remove();
            });

            list.appendChild(item);
        });
    }

    modal.appendChild(header);
    modal.appendChild(preview);
    modal.appendChild(list);

    overlay.appendChild(backdrop);
    overlay.appendChild(modal);

    document.body.appendChild(overlay);
}

function forwardMessageTo(msg, toId) {

    if (!toId) return;

    socket.emit("chat-message", {
        toId,
        text: msg.text || null,
        attachment: msg.attachment || null,
        forwarded: true
    });

    // if we're forwarding into the chat we already have open, the
    // server's echo back to us will render it there naturally; if
    // it's a different chat, bump the unread count so it's noticed
    if (!activeChat || activeChat.id !== toId) {
        unreadCounts[toId] = (unreadCounts[toId] || 0) + 1;
        renderFriendsList();
    }
}


// ============================================================
// SHARE (document/file attachments)
// ============================================================

function shareAttachment(att) {

    const absoluteUrl = new URL(att.url, window.location.href).href;

    if (navigator.share) {

        navigator.share({
            title: att.name || "Shared file",
            url: absoluteUrl
        }).catch(() => {});

    } else if (navigator.clipboard) {

        navigator.clipboard.writeText(absoluteUrl).catch(() => {});
    }
}


// ============================================================
// EMOJI RENDERING
// (intentionally left as plain Unicode text so every emoji renders
// through the device's own native emoji font/keyboard, instead of
// being swapped for icons from a third-party set that may not cover
// every codepoint used here)
// ============================================================

function twemojify(el) {
    // no-op: emoji are left as-is, rendered by the device's native font
}


// ============================================================
// SYSTEM MESSAGE
// ============================================================

function appendSystemMessage(
    text
) {

    if (!messagesEl) return;


    const row =
        document.createElement(
            "div"
        );


    row.className =
        "msg-row system";


    row.innerHTML = `
        <div class="bubble">
            ${escapeHtml(text)}
        </div>
    `;


    messagesEl.appendChild(
        row
    );


    messagesEl.scrollTop =
        messagesEl.scrollHeight;

}


// ============================================================
// ATTACHMENTS
// ============================================================

function renderAttachment(
    att
) {

    if (
        att.kind === "sticker"
    ) {

        const emoji = att.emoji || "🙂";

        const wrap =
            document.createElement("div");

        wrap.className = "sticker-msg-wrap";

        const span =
            document.createElement(
                "span"
            );

        span.className =
            "sticker-emoji";

        span.textContent = emoji;
        twemojify(span);

        wrap.appendChild(span);
        wrap.appendChild(makeStickerFavButton(emoji));

        return wrap;

    }


    if (
        att.kind === "gif"
    ) {

        const img =
            document.createElement("img");

        img.src = att.url;
        img.alt = "GIF";
        img.className = "gif-msg";
        img.loading = "lazy";

        return img;

    }


    if (
        att.kind === "image"
    ) {

        const img =
            document.createElement(
                "img"
            );


        img.src =
            att.url;

        img.alt =
            att.name;


        return img;

    }


    if (
        att.kind === "video"
    ) {

        const video =
            document.createElement(
                "video"
            );


        video.src =
            att.url;

        video.controls =
            true;


        return video;

    }


    if (
        att.kind === "audio"
    ) {

        const audio =
            document.createElement(
                "audio"
            );


        audio.src =
            att.url;

        audio.controls =
            true;


        return audio;

    }


    const link =
        document.createElement(
            "a"
        );


    link.className =
        "file-chip";


    link.href =
        att.url;

    link.target =
        "_blank";

    link.download =
        att.name;


    link.innerHTML = `
        <span class="file-icon">
            📄
        </span>

        <span>
            ${escapeHtml(
                att.name
            )}
        </span>
    `;


    const wrap = document.createElement("div");
    wrap.className = "file-chip-wrap";
    wrap.appendChild(link);

    const shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.className = "file-share-btn";
    shareBtn.title = "Share";
    shareBtn.innerHTML = '<i class="fa-solid fa-share-nodes"></i>';

    shareBtn.addEventListener("click", (e) => {

        e.stopPropagation();
        e.preventDefault();

        shareAttachment(att);

        shareBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
        setTimeout(() => {
            shareBtn.innerHTML = '<i class="fa-solid fa-share-nodes"></i>';
        }, 1500);
    });

    wrap.appendChild(shareBtn);

    return wrap;

}


// ============================================================
// FILE SHARING
// ============================================================

// attachBtn now opens the attach-menu dropdown (Document / Photos & Videos /
// Camera / Contact / Poll / Location) instead of jumping straight to the
// file picker - see the ATTACH MENU section (bottom of file) for the
// dropdown wiring and for what each option does with fileInput.

let pendingFile = null;
let pendingForcedKind = null;
let pendingViewOnce = false;

if (fileInput) {

    fileInput.addEventListener(
        "change",
        () => {

            const file =
                fileInput.files[0];

            if (
                !file ||
                !activeChat
            ) {
                fileInput.value = "";
                return;
            }

            pendingFile = file;
            showMediaPreview(file);

        }
    );

}


function showMediaPreview(file) {

    const bar = document.getElementById("mediaPreviewBar");
    const thumb = document.getElementById("mediaPreviewThumb");
    const nameEl = document.getElementById("mediaPreviewName");
    const sizeEl = document.getElementById("mediaPreviewSize");

    if (!bar) return;

    if (nameEl) nameEl.textContent = file.name || "attachment";

    if (sizeEl) {

        const kb = file.size / 1024;
        sizeEl.textContent =
            kb > 1024
                ? `${(kb / 1024).toFixed(1)} MB`
                : `${Math.max(1, Math.round(kb))} KB`;

    }

    if (thumb) {

        if (file.type && file.type.startsWith("image/")) {

            thumb.innerHTML = "";
            thumb.style.backgroundImage = `url("${URL.createObjectURL(file)}")`;
            thumb.classList.add("has-image");

        } else {

            thumb.style.backgroundImage = "";
            thumb.classList.remove("has-image");

            const icon =
                file.type && file.type.startsWith("video/") ? "fa-file-video" :
                file.type && file.type.startsWith("audio/") ? "fa-file-audio" :
                "fa-file";

            thumb.innerHTML = `<i class="fa-regular ${icon}"></i>`;

        }

    }

    bar.classList.remove("hidden");

}


function clearMediaPreview() {

    pendingFile = null;
    pendingForcedKind = null;
    pendingViewOnce = false;

    const bar = document.getElementById("mediaPreviewBar");
    if (bar) bar.classList.add("hidden");

    const viewOnceBtn = document.getElementById("viewOnceToggleBtn");
    if (viewOnceBtn) {
        viewOnceBtn.classList.remove("active");
        viewOnceBtn.setAttribute("aria-pressed", "false");
    }

    if (fileInput) fileInput.value = "";

}


(function wireMediaPreviewBar() {

    const closeBtn = document.getElementById("mediaPreviewClose");
    const viewOnceBtn = document.getElementById("viewOnceToggleBtn");

    if (closeBtn) {
        closeBtn.addEventListener("click", clearMediaPreview);
    }

    if (viewOnceBtn) {
        viewOnceBtn.addEventListener("click", () => {
            pendingViewOnce = !pendingViewOnce;
            viewOnceBtn.classList.toggle("active", pendingViewOnce);
            viewOnceBtn.setAttribute("aria-pressed", String(pendingViewOnce));
        });
    }

})();


async function uploadAndSend(
    file,
    forcedKind,
    extra
) {

    const formData =
        new FormData();


    formData.append(
        "file",
        file
    );


    try {

        const res =
            await fetch(
                "/upload",
                {
                    method: "POST",
                    body: formData
                }
            );


        if (!res.ok) {

            showNiceAlert(
                "Upload failed",
                { title: "Upload failed", icon: "fa-cloud-arrow-up" }
            );

            return;

        }


        const data =
            await res.json();


        if (forcedKind) {

            data.kind =
                forcedKind;

        }


        socket.emit(
            "chat-message",
            {
                toId:
                    activeChat.id,
                attachment:
                    data,
                caption: (extra && extra.caption) || undefined,
                viewOnce: !!(extra && extra.viewOnce),
                replyTo: (extra && extra.replyTo) || undefined
            }
        );

    }

    catch (err) {

        console.error(
            err
        );

        showNiceAlert(
            "Upload failed",
            { title: "Upload failed", icon: "fa-cloud-arrow-up" }
        );

    }

}


// ============================================================
// EMOJI & STICKERS
// ============================================================
//
// Two independent pickers share this panel:
//  - Emoji: a categorized, searchable emoji keyboard with a
//    "Recent" tray. Browsers don't expose an API to read a phone's
//    or computer's own emoji keyboard, but the OS picker still works
//    for free the moment textInput is focused - Windows: Win + . ,
//    macOS: Ctrl + Cmd + Space, and any mobile keyboard's emoji key.
//    This in-app picker is there so it also works on devices/browsers
//    that don't offer a native one, and so search works everywhere.
//  - Stickers: bigger tappable "stamps" organised into packs, plus a
//    "Favorites" pack the user builds by starring stickers - starring
//    works both from the picker and from a sticker already sent in
//    the chat. Favorites persist in localStorage.

const EMOJI_CATEGORIES = [
    { key: "recent", label: "Recent", icon: "🕒", items: [] },
    { key: "smileys", label: "Smileys & People", icon: "😀", items: [
        ["😀","grinning"], ["😁","beaming"], ["😂","joy"], ["🤣","rofl"],
        ["😊","smiling"], ["😇","halo"], ["🙂","slight smile"], ["🙃","upside down"],
        ["😉","wink"], ["😌","relieved"], ["😍","heart eyes"], ["🥰","hearts"],
        ["😘","kiss"], ["😗","kissing"], ["😙","kissing smiling"], ["😚","kissing closed eyes"],
        ["😋","yum"], ["😛","tongue"], ["😜","wink tongue"], ["🤪","zany"],
        ["😝","squint tongue"], ["🤑","money mouth"], ["🤗","hug"], ["🤭","hand over mouth"],
        ["🤫","shush"], ["🤔","thinking"], ["🤐","zipper mouth"], ["🤨","raised eyebrow"],
        ["😐","neutral"], ["😑","expressionless"], ["😶","no mouth"], ["😏","smirk"],
        ["😒","unamused"], ["🙄","eye roll"], ["😬","grimace"], ["🤥","lying"],
        ["😴","sleeping"], ["😪","sleepy"], ["😷","mask"], ["🤒","thermometer"],
        ["🤕","bandage head"], ["🤢","nauseated"], ["🤮","vomit"], ["🥵","hot"],
        ["🥶","cold"], ["😵","dizzy"], ["🤯","mind blown"], ["🥳","party"],
        ["😎","sunglasses cool"], ["🤓","nerd"], ["🧐","monocle"], ["😕","confused"],
        ["😟","worried"], ["🙁","frown"], ["😮","open mouth"], ["😯","hushed"],
        ["😲","astonished"], ["😳","flushed"], ["🥺","pleading"], ["😦","frowning"],
        ["😧","anguished"], ["😨","fearful"], ["😰","anxious sweat"], ["😥","sad relieved"],
        ["😢","crying"], ["😭","sobbing"], ["😱","screaming"], ["😖","confounded"],
        ["😣","persevering"], ["😞","disappointed"], ["😓","downcast sweat"], ["😩","weary"],
        ["😫","tired"], ["🥱","yawn"], ["😤","triumph huff"], ["😡","pouting angry"],
        ["😠","angry"], ["🤬","cursing"], ["😈","smiling devil"], ["👿","angry devil"],
        ["💀","skull"], ["👻","ghost"], ["👽","alien"], ["🤖","robot"],
        ["😺","cat smile"], ["😹","cat joy"], ["👍","thumbs up"], ["👎","thumbs down"],
        ["👊","fist bump"], ["✊","raised fist"], ["🤝","handshake"], ["🙏","pray thanks"],
        ["👏","clap"], ["🙌","raise hands"], ["👐","open hands"], ["🤲","palms up"],
        ["💪","muscle"], ["🫶","heart hands"], ["👋","wave"], ["✌️","peace"],
        ["🤞","fingers crossed"], ["👌","ok hand"], ["👆","point up"], ["👇","point down"],
        ["👈","point left"], ["👉","point right"], ["✋","raised hand"], ["🤟","love you"]
    ]},
    { key: "hearts", label: "Love", icon: "❤️", items: [
        ["❤️","red heart"], ["🧡","orange heart"], ["💛","yellow heart"], ["💚","green heart"],
        ["💙","blue heart"], ["💜","purple heart"], ["🖤","black heart"], ["🤍","white heart"],
        ["🤎","brown heart"], ["💔","broken heart"], ["❣️","heart exclamation"], ["💕","two hearts"],
        ["💞","revolving hearts"], ["💓","beating heart"], ["💗","growing heart"], ["💖","sparkling heart"],
        ["💘","heart arrow"], ["💝","heart ribbon"], ["💟","heart decoration"]
    ]},
    { key: "animals", label: "Animals & Nature", icon: "🐶", items: [
        ["🐶","dog"], ["🐱","cat"], ["🐭","mouse"], ["🐹","hamster"],
        ["🐰","rabbit"], ["🦊","fox"], ["🐻","bear"], ["🐼","panda"],
        ["🐨","koala"], ["🐯","tiger"], ["🦁","lion"], ["🐮","cow"],
        ["🐷","pig"], ["🐸","frog"], ["🐵","monkey"], ["🐔","chicken"],
        ["🐧","penguin"], ["🐦","bird"], ["🦆","duck"], ["🦅","eagle"],
        ["🦉","owl"], ["🦇","bat"], ["🐺","wolf"], ["🐗","boar"],
        ["🐴","horse"], ["🦄","unicorn"], ["🐝","bee"], ["🐛","caterpillar"],
        ["🦋","butterfly"], ["🐌","snail"], ["🐞","ladybug"], ["🐜","ant"],
        ["🐢","turtle"], ["🐍","snake"], ["🦎","lizard"], ["🐙","octopus"],
        ["🦑","squid"], ["🦀","crab"], ["🐠","fish"], ["🐬","dolphin"],
        ["🐳","whale"], ["🦈","shark"], ["🐊","crocodile"], ["🐘","elephant"],
        ["🦒","giraffe"], ["🦓","zebra"], ["🦍","gorilla"], ["🌵","cactus"],
        ["🌲","tree"], ["🌳","deciduous tree"], ["🌴","palm tree"], ["🌸","cherry blossom"],
        ["🌼","blossom"], ["🌻","sunflower"], ["🌹","rose"], ["🍀","clover"],
        ["🍁","maple leaf"], ["🌙","crescent moon"], ["☀️","sun"], ["⭐","star"],
        ["🌈","rainbow"], ["☁️","cloud"], ["⚡","lightning"]
    ]},
    { key: "food", label: "Food & Drink", icon: "🍕", items: [
        ["🍏","green apple"], ["🍎","red apple"], ["🍐","pear"], ["🍊","orange"],
        ["🍋","lemon"], ["🍌","banana"], ["🍉","watermelon"], ["🍇","grapes"],
        ["🍓","strawberry"], ["🫐","blueberries"], ["🍈","melon"], ["🍒","cherries"],
        ["🍑","peach"], ["🥭","mango"], ["🍍","pineapple"], ["🥥","coconut"],
        ["🥝","kiwi"], ["🍅","tomato"], ["🍆","eggplant"], ["🥑","avocado"],
        ["🥦","broccoli"], ["🥕","carrot"], ["🌽","corn"], ["🌶️","pepper"],
        ["🥔","potato"], ["🍞","bread"], ["🥐","croissant"], ["🥖","baguette"],
        ["🧀","cheese"], ["🥚","egg"], ["🍳","fried egg"], ["🥞","pancakes"],
        ["🥓","bacon"], ["🍔","burger"], ["🍟","fries"], ["🍕","pizza"],
        ["🌭","hotdog"], ["🌮","taco"], ["🌯","burrito"], ["🥗","salad"],
        ["🍝","pasta"], ["🍜","noodles"], ["🍲","stew"], ["🍣","sushi"],
        ["🍱","bento"], ["🍤","shrimp"], ["🍦","icecream"], ["🍩","donut"],
        ["🍪","cookie"], ["🎂","cake"], ["🍰","shortcake"], ["🧁","cupcake"],
        ["🍫","chocolate"], ["🍬","candy"], ["🍭","lollipop"], ["☕","coffee"],
        ["🍵","tea"], ["🧃","juice box"], ["🥤","soda"], ["🍺","beer"],
        ["🍷","wine"], ["🥂","cheers"], ["🍾","champagne"], ["🍹","cocktail"]
    ]},
    { key: "activities", label: "Activities", icon: "⚽", items: [
        ["⚽","soccer"], ["🏀","basketball"], ["🏈","football"], ["⚾","baseball"],
        ["🎾","tennis"], ["🏐","volleyball"], ["🏉","rugby"], ["🎱","8 ball"],
        ["🏓","ping pong"], ["🏸","badminton"], ["🥊","boxing"], ["🥋","martial arts"],
        ["⛳","golf"], ["🏹","archery"], ["🎣","fishing"], ["🥇","gold medal"],
        ["🏆","trophy"], ["🎮","gamepad"], ["🎲","dice"], ["♟️","chess"],
        ["🎯","dart"], ["🎳","bowling"], ["🎨","art"], ["🎭","masks"],
        ["🎤","mic"], ["🎧","headphones"], ["🎸","guitar"], ["🎹","piano"],
        ["🥁","drum"], ["🎺","trumpet"], ["🎬","clapper"], ["📚","books"]
    ]},
    { key: "travel", label: "Travel & Places", icon: "✈️", items: [
        ["🚗","car"], ["🚕","taxi"], ["🚙","suv"], ["🚌","bus"],
        ["🏍️","motorcycle"], ["🚲","bike"], ["✈️","plane"], ["🚀","rocket"],
        ["🚁","helicopter"], ["🚆","train"], ["🚢","ship"], ["⛵","sailboat"],
        ["🚦","traffic light"], ["🗺️","map"], ["🗽","liberty"], ["🗼","tower"],
        ["🏰","castle"], ["🏝️","island"], ["🏔️","mountain"], ["🌋","volcano"],
        ["🏕️","camping"], ["🏟️","stadium"], ["🎡","ferris wheel"], ["🎢","rollercoaster"]
    ]},
    { key: "objects", label: "Objects", icon: "💡", items: [
        ["📱","phone"], ["💻","laptop"], ["⌨️","keyboard"], ["🖥️","desktop"],
        ["🖨️","printer"], ["📷","camera"], ["🎥","video camera"], ["📺","tv"],
        ["📞","telephone"], ["⏰","alarm"], ["⏳","hourglass"], ["🔋","battery"],
        ["💡","bulb"], ["🔦","flashlight"], ["🕯️","candle"], ["📖","open book"],
        ["📝","memo"], ["✏️","pencil"], ["📌","pin"], ["📎","clip"],
        ["🔒","lock"], ["🔑","key"], ["🔨","hammer"], ["🛠️","tools"],
        ["💰","money bag"], ["💵","dollar"], ["💳","card"], ["🎁","gift"],
        ["🛒","cart"], ["📦","package"], ["✉️","envelope"], ["📬","mailbox"]
    ]},
    { key: "symbols", label: "Symbols", icon: "✅", items: [
        ["✅","check"], ["❌","cross"], ["❗","exclaim"], ["❓","question"],
        ["‼️","double exclaim"], ["⚠️","warning"], ["♻️","recycle"], ["🔞","18+"],
        ["🔥","fire"], ["✨","sparkles"], ["💯","100"], ["💢","anger"],
        ["💤","zzz"], ["💦","sweat drops"], ["💨","dash"], ["🕳️","hole"],
        ["🔴","red circle"], ["🟠","orange circle"], ["🟡","yellow circle"], ["🟢","green circle"],
        ["🔵","blue circle"], ["🟣","purple circle"], ["⚪","white circle"], ["⚫","black circle"],
        ["🔺","red triangle"], ["🔻","down triangle"], ["🔶","orange diamond"], ["🔷","blue diamond"]
    ]},
    { key: "flags", label: "Flags", icon: "🏁", items: [
        ["🏁","checkered"], ["🚩","triangular"], ["🎌","crossed flags"], ["🏳️","white flag"],
        ["🏴","black flag"], ["🏳️‍🌈","rainbow flag"], ["🇰🇪","Kenya"], ["🇺🇸","USA"],
        ["🇬🇧","UK"], ["🇨🇦","Canada"], ["🇳🇬","Nigeria"], ["🇿🇦","South Africa"],
        ["🇹🇿","Tanzania"], ["🇺🇬","Uganda"], ["🇮🇳","India"], ["🇨🇳","China"]
    ]}
];

const STICKER_PACKS = [
    { key: "favorites", label: "⭐ Favorites", items: [] }, // populated live from localStorage
    { key: "classic", label: "Classic", items: [
        "😂","😍","🥳","😎","🤩","😭","😱","🥺",
        "😡","🤔","👍","👏","🙌","🔥","💯","❤️",
        "🎉","😴","🤯","🙈","💃","🕺","🤝","👋"
    ]},
    { key: "reactions", label: "Reactions", items: [
        "😆","😊","🥰","😘","😜","🙄","😬","😤",
        "🤗","🫡","🤞","👌","✌️","🤙","👀","💪"
    ]},
    { key: "animals", label: "Animals", items: [
        "🐶","🐱","🐼","🦊","🐨","🦁","🐸","🐵",
        "🐧","🦄","🐝","🦋","🐢","🐙","🦈","🐘"
    ]},
    { key: "party", label: "Party", items: [
        "🎉","🎊","🎈","🎂","🍾","🥂","🎆","🎇",
        "🪅","🎁","🌟","✨","💫","🥳","🎵","🎶"
    ]}
];


// ---- persistence: recent emoji + favorite stickers ----

const RECENT_EMOJI_KEY = "siteChatRecentEmoji";
const FAVORITE_STICKERS_KEY = "siteChatFavoriteStickers";

function loadRecentEmoji() {

    try {
        return JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) || "[]");
    } catch {
        return [];
    }
}

function saveRecentEmoji(list) {
    localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(list.slice(0, 32)));
}

function pushRecentEmoji(emoji) {

    const list = loadRecentEmoji().filter((e) => e !== emoji);
    list.unshift(emoji);
    saveRecentEmoji(list);
    EMOJI_CATEGORIES[0].items = list.map((e) => [e, "recent"]);
}

function loadFavoriteStickers() {

    try {
        return new Set(JSON.parse(localStorage.getItem(FAVORITE_STICKERS_KEY) || "[]"));
    } catch {
        return new Set();
    }
}

let favoriteStickers = loadFavoriteStickers();

function saveFavoriteStickers() {

    localStorage.setItem(
        FAVORITE_STICKERS_KEY,
        JSON.stringify(Array.from(favoriteStickers))
    );
}

function isFavoriteSticker(emoji) {
    return favoriteStickers.has(emoji);
}

function cssEscapeEmoji(str) {

    return window.CSS && CSS.escape
        ? CSS.escape(str)
        : str.replace(/["\\]/g, "\\$&");
}

function toggleFavoriteSticker(emoji) {

    if (favoriteStickers.has(emoji)) {
        favoriteStickers.delete(emoji);
    } else {
        favoriteStickers.add(emoji);
    }

    saveFavoriteStickers();

    // keep every star showing this emoji (picker + any chat bubbles) in sync
    document
        .querySelectorAll(`[data-fav-emoji="${cssEscapeEmoji(emoji)}"]`)
        .forEach((btn) => {
            const active = isFavoriteSticker(emoji);
            btn.classList.toggle("active", active);
            btn.title = active ? "Remove from favorites" : "Add to favorites";
        });

    if (activeStickerPack === "favorites") {
        renderActiveStickerPack();
    }
}


// ---- emoji tab: single flat grid, search still filters it ----

function renderEmojiGrid(filterText) {

    if (!emojiGrid) return;

    emojiGrid.innerHTML = "";

    const q = (filterText || "").trim().toLowerCase();

    const items = EMOJI_CATEGORIES
        .filter((cat) => cat.key !== "recent")
        .flatMap((cat) => cat.items)
        .filter(([, name]) => !q || name.toLowerCase().includes(q));

    if (items.length === 0) {

        const empty = document.createElement("div");
        empty.className = "emoji-empty-hint";
        empty.textContent = "No emoji found.";
        emojiGrid.appendChild(empty);
        return;
    }

    items.forEach(([emoji, name]) => {

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "emoji-item";
        btn.textContent = emoji;
        btn.title = name;

        btn.addEventListener("click", () => insertEmoji(emoji));

        twemojify(btn);

        emojiGrid.appendChild(btn);
    });
}

if (emojiSearch) {

    emojiSearch.addEventListener("input", () => {
        renderEmojiGrid(emojiSearch.value);
    });
}

function insertEmoji(emoji) {

    if (!textInput) return;

    const start = textInput.selectionStart ?? textInput.value.length;
    const end = textInput.selectionEnd ?? textInput.value.length;

    textInput.value =
        textInput.value.slice(0, start) +
        emoji +
        textInput.value.slice(end);

    const cursor = start + emoji.length;

    textInput.focus();
    textInput.setSelectionRange(cursor, cursor);

    pushRecentEmoji(emoji);
}


// ---- sticker tab: packs + favorites ----

let activeStickerPack = "classic";

function renderStickerCategoryBar() {

    if (!stickerCategoryBar) return;

    stickerCategoryBar.innerHTML = "";

    STICKER_PACKS.forEach((pack) => {

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "emoji-cat-btn sticker-pack-btn" +
            (pack.key === activeStickerPack ? " active" : "");
        btn.textContent = pack.label;

        twemojify(btn);

        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            activeStickerPack = pack.key;
            renderStickerCategoryBar();
            renderActiveStickerPack();
        });

        stickerCategoryBar.appendChild(btn);
    });
}

function makeStickerFavButton(emoji) {

    const starBtn = document.createElement("button");
    starBtn.type = "button";
    starBtn.className = "sticker-fav-btn" + (isFavoriteSticker(emoji) ? " active" : "");
    starBtn.dataset.favEmoji = emoji;
    starBtn.innerHTML = '<i class="fa-solid fa-star"></i>';
    starBtn.title = isFavoriteSticker(emoji) ? "Remove from favorites" : "Add to favorites";

    starBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavoriteSticker(emoji);
    });

    return starBtn;
}

function renderActiveStickerPack() {

    if (!stickerGrid) return;

    stickerGrid.innerHTML = "";

    const pack = STICKER_PACKS.find((p) => p.key === activeStickerPack);

    const items = pack && pack.key === "favorites"
        ? Array.from(favoriteStickers)
        : (pack ? pack.items : []);

    if (items.length === 0) {

        const empty = document.createElement("div");
        empty.className = "emoji-empty-hint";
        empty.textContent =
            pack && pack.key === "favorites"
                ? "Tap the star on any sticker to save it here."
                : "No stickers in this pack.";

        stickerGrid.appendChild(empty);
        return;
    }

    items.forEach((emoji) => {

        const wrap = document.createElement("div");
        wrap.className = "sticker-item-wrap";

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sticker-item";
        btn.textContent = emoji;
        btn.title = "Send sticker";

        btn.addEventListener("click", () => sendSticker(emoji));
        twemojify(btn);

        wrap.appendChild(btn);
        wrap.appendChild(makeStickerFavButton(emoji));

        stickerGrid.appendChild(wrap);
    });
}

function sendSticker(emoji) {

    if (!activeChat) return;

    socket.emit(
        "chat-message",
        {
            toId: activeChat.id,
            attachment: {
                kind: "sticker",
                emoji
            }
        }
    );

    closeEmojiPanel();
}


// ---- GIF tab: search GIPHY via our own server proxy ----

let gifsLoadedOnce = false;
let gifSearchDebounce = null;
let gifRequestToken = 0;

async function loadGifs(query) {

    if (!gifGrid) return;

    const myToken = ++gifRequestToken;

    gifGrid.innerHTML = '<div class="emoji-empty-hint">Loading GIFs…</div>';

    try {

        const res = await fetch(`/api/gifs?q=${encodeURIComponent(query || "")}&limit=24`);
        const data = await res.json();

        if (myToken !== gifRequestToken) return; // a newer search superseded this one

        gifGrid.innerHTML = "";

        const gifs = data.gifs || [];

        if (gifs.length === 0) {
            const empty = document.createElement("div");
            empty.className = "emoji-empty-hint";
            empty.textContent = "No GIFs found.";
            gifGrid.appendChild(empty);
            return;
        }

        gifs.forEach((gif) => {

            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "gif-item";
            btn.title = "Send GIF";

            const img = document.createElement("img");
            img.src = gif.preview || gif.url;
            img.alt = "GIF";
            img.loading = "lazy";

            btn.appendChild(img);
            btn.addEventListener("click", () => sendGif(gif.url));

            gifGrid.appendChild(btn);
        });

    } catch (err) {

        if (myToken !== gifRequestToken) return;

        console.error("GIF load failed:", err);

        gifGrid.innerHTML =
            '<div class="emoji-empty-hint">Couldn\'t load GIFs. Check your connection.</div>';
    }
}

if (gifSearch) {

    gifSearch.addEventListener("input", () => {

        clearTimeout(gifSearchDebounce);

        gifSearchDebounce = setTimeout(() => {
            loadGifs(gifSearch.value);
        }, 400);
    });
}

function sendGif(url) {

    if (!activeChat || !url) return;

    socket.emit(
        "chat-message",
        {
            toId: activeChat.id,
            attachment: {
                kind: "gif",
                url
            }
        }
    );

    closeEmojiPanel();
}


// ---- panel open/close + tab switching ----

function openEmojiPanel() {
    if (!emojiPanel) return;
    emojiPanel.classList.remove("hidden");
}

function closeEmojiPanel() {
    if (!emojiPanel) return;
    emojiPanel.classList.add("hidden");
}

if (emojiBtn) {

    emojiBtn.addEventListener("click", (e) => {

        e.stopPropagation();

        if (!emojiPanel) return;

        emojiPanel.classList.contains("hidden")
            ? openEmojiPanel()
            : closeEmojiPanel();
    });
}

document
    .querySelectorAll(".emoji-tab")
    .forEach((tab) => {

        tab.addEventListener("click", () => {

            document
                .querySelectorAll(".emoji-tab")
                .forEach((t) => t.classList.remove("active"));

            tab.classList.add("active");

            const target = tab.dataset.tab; // "emoji" | "stickers" | "gifs"

            if (emojiTabContent) emojiTabContent.classList.toggle("hidden", target !== "emoji");
            if (stickerTabContent) stickerTabContent.classList.toggle("hidden", target !== "stickers");
            if (gifTabContent) gifTabContent.classList.toggle("hidden", target !== "gifs");

            if (target === "gifs" && !gifsLoadedOnce) {
                gifsLoadedOnce = true;
                loadGifs("");
            }
        });
    });

if (emojiPanel) {
    // Stop any click that originates inside the panel from ever reaching
    // the document-level "click outside" listener below. This matters
    // because several inner click handlers (category/pack buttons, the
    // "Recent" grid refresh in insertEmoji) rebuild their own DOM on
    // click, which detaches the clicked element from the tree. A removed
    // node still finishes bubbling, but emojiPanel.contains(e.target)
    // would then wrongly report "false" and slam the panel shut.
    // Stopping propagation here, on the panel itself, sidesteps that
    // regardless of what any inner handler does to the DOM.
    emojiPanel.addEventListener("click", (e) => e.stopPropagation());
}

document.addEventListener("click", (e) => {

    if (
        emojiPanel &&
        !emojiPanel.classList.contains("hidden") &&
        !emojiPanel.contains(e.target) &&
        e.target !== emojiBtn &&
        !emojiBtn?.contains(e.target)
    ) {
        closeEmojiPanel();
    }
});


// ---- init ----

EMOJI_CATEGORIES[0].items = loadRecentEmoji().map((e) => [e, "recent"]);

renderEmojiGrid();
renderStickerCategoryBar();
renderActiveStickerPack();


let mediaRecorder =
    null;

let recordedChunks =
    [];

let recTimerHandle =
    null;

let recSeconds =
    0;


// ============================================================
// MEDIA ACCESS HELPERS (mic/camera — shared by voice notes and calls)
// ============================================================

function mediaDevicesAvailable() {

    return Boolean(
        navigator.mediaDevices &&
        navigator.mediaDevices.getUserMedia
    );

}


function mediaErrorMessage(err) {

    if (!mediaDevicesAvailable()) {

        return "Camera/microphone access needs a secure connection. This works on localhost while testing, but needs https:// (not http://) once the site is live on a real domain.";

    }


    if (err && err.name === "NotAllowedError") {

        return "Microphone/camera access was blocked. Check the camera/mic permission for this site in your browser's address-bar settings, then try again.";

    }


    if (err && err.name === "NotFoundError") {

        return "No microphone/camera was found on this device.";

    }


    if (err && err.name === "NotReadableError") {

        return "Your microphone/camera is already in use by another app.";

    }


    return "Could not access camera/microphone.";

}


if (micBtn) {

    micBtn.addEventListener(
        "click",
        async () => {

            if (!activeChat) {
                return;
            }


            if (!mediaDevicesAvailable()) {

                showNiceAlert(mediaErrorMessage(null), { title: "Camera & mic", icon: "fa-video" });

                return;

            }


            try {

                const stream =
                    await navigator
                        .mediaDevices
                        .getUserMedia({
                            audio: HIGH_QUALITY_AUDIO_CONSTRAINTS
                        });


                startRecording(
                    stream
                );

            }

            catch (err) {

                showNiceAlert(mediaErrorMessage(err), { title: "Camera & mic", icon: "fa-video" });

            }

        }
    );

}


function startRecording(
    stream
) {

    recordedChunks =
        [];


    mediaRecorder =
        new MediaRecorder(
            stream
        );


    mediaRecorder.ondataavailable =
        (e) => {

            if (
                e.data.size > 0
            ) {

                recordedChunks.push(
                    e.data
                );

            }

        };


    mediaRecorder.start();


    recSeconds =
        0;


    if (recTimer) {

        recTimer.textContent =
            "0:00";

    }


    if (recordingBar) {

        recordingBar.classList.remove(
            "hidden"
        );

        recordingBar.classList.remove(
            "is-paused"
        );

    }


    if (pauseRecBtn) {

        pauseRecBtn.classList.remove(
            "is-paused"
        );

        pauseRecBtn.innerHTML =
            '<i class="fa-solid fa-pause"></i>';

        pauseRecBtn.title =
            "Pause recording";

    }


    if (composer) {

        composer.hidden =
            true;

    }


    startRecTimer();

}


// The timer only ticks while actively recording - pausing the
// recorder freezes it instead of letting it keep counting up, so
// the displayed duration always matches what actually gets sent.
function startRecTimer() {

    clearInterval(
        recTimerHandle
    );

    recTimerHandle =
        setInterval(
            () => {

                recSeconds++;


                const m =
                    Math.floor(
                        recSeconds / 60
                    );


                const s =
                    recSeconds % 60;


                if (recTimer) {

                    recTimer.textContent =
                        `${m}:${String(
                            s
                        ).padStart(
                            2,
                            "0"
                        )}`;

                }

            },
            1000
        );

}


function stopStream() {

    if (
        mediaRecorder &&
        mediaRecorder.stream
    ) {

        mediaRecorder.stream
            .getTracks()
            .forEach(
                track =>
                    track.stop()
            );

    }


    clearInterval(
        recTimerHandle
    );


    if (recordingBar) {

        recordingBar.classList.add(
            "hidden"
        );

        recordingBar.classList.remove(
            "is-paused"
        );

    }


    if (composer) {

        composer.hidden =
            false;

    }

}


if (cancelRecBtn) {

    cancelRecBtn.addEventListener(
        "click",
        () => {

            if (!mediaRecorder) {
                return;
            }


            mediaRecorder.onstop =
                () => {

                    stopStream();

                };


            // pause() must resolve before stop() on some browsers,
            // but calling stop() directly on a paused recorder is
            // fine too - this just guarantees we don't try to stop
            // an already-inactive recorder and throw.
            if (mediaRecorder.state !== "inactive") {

                mediaRecorder.stop();

            }


            recordedChunks =
                [];

        }
    );

}


// ============================================================
// PAUSE / RESUME RECORDING
// ============================================================

if (pauseRecBtn) {

    pauseRecBtn.addEventListener(
        "click",
        () => {

            if (
                !mediaRecorder ||
                mediaRecorder.state === "inactive"
            ) {
                return;
            }


            if (mediaRecorder.state === "recording") {

                mediaRecorder.pause();

                clearInterval(
                    recTimerHandle
                );


                if (recordingBar) {

                    recordingBar.classList.add(
                        "is-paused"
                    );

                }


                pauseRecBtn.classList.add(
                    "is-paused"
                );

                pauseRecBtn.innerHTML =
                    '<i class="fa-solid fa-microphone"></i>';

                pauseRecBtn.title =
                    "Resume recording";

            } else if (mediaRecorder.state === "paused") {

                mediaRecorder.resume();

                startRecTimer();


                if (recordingBar) {

                    recordingBar.classList.remove(
                        "is-paused"
                    );

                }


                pauseRecBtn.classList.remove(
                    "is-paused"
                );

                pauseRecBtn.innerHTML =
                    '<i class="fa-solid fa-pause"></i>';

                pauseRecBtn.title =
                    "Pause recording";

            }

        }
    );

}


if (stopRecBtn) {

    stopRecBtn.addEventListener(
        "click",
        () => {

            if (!mediaRecorder) {
                return;
            }


            mediaRecorder.onstop =
                async () => {

                    stopStream();


                    const blob =
                        new Blob(
                            recordedChunks,
                            {
                                type:
                                    "audio/webm"
                            }
                        );


                    const file =
                        new File(
                            [blob],
                            `voice-note-${Date.now()}.webm`,
                            {
                                type:
                                    "audio/webm"
                            }
                        );


                    await uploadAndSend(
                        file,
                        "audio"
                    );

                };


            // A paused MediaRecorder can still be stopped directly -
            // this lets "Send" work whether the user is actively
            // recording or currently paused.
            if (mediaRecorder.state !== "inactive") {

                mediaRecorder.stop();

            }

        }
    );

}


// ============================================================
// WEBRTC
// ============================================================

const rtcConfig = {

    iceServers: [
        {
            urls:
                "stun:stun.l.google.com:19302"
        },
        {
            urls:
                "stun:stun1.l.google.com:19302"
        },
        {
            urls:
                "stun:stun2.l.google.com:19302"
        },
        {
            urls:
                "stun:stun.cloudflare.com:3478"
        },
        // STUN alone can't get through every network — some
        // routers/firewalls (common on mobile data or locked-down
        // corporate networks) block direct peer-to-peer connections
        // entirely, even with STUN. When that happens the call used
        // to "connect" (offer/answer/signaling all succeed) but no
        // audio or video would ever arrive — that was the main cause
        // of calls ringing through with no sound. A TURN server (a
        // relay) fixes it by routing media through a server instead
        // of trying to go directly between the two browsers.
        //
        // The entries below are a free public TURN relay (Open
        // Relay Project) so calls work out of the box. It's fine for
        // testing, but it's shared/rate-limited — for production,
        // swap these credentials for your own TURN provider (Twilio,
        // Metered, Xirsys) or a self-hosted coturn server.
        {
            urls: "turn:openrelay.metered.ca:80",
            username: "openrelayproject",
            credential: "openrelayproject"
        },
        {
            urls: "turn:openrelay.metered.ca:443",
            username: "openrelayproject",
            credential: "openrelayproject"
        },
        {
            urls: "turn:openrelay.metered.ca:443?transport=tcp",
            username: "openrelayproject",
            credential: "openrelayproject"
        }
    ],

    // Ask the browser to also try relay candidates proactively
    // rather than only as a last resort — makes the TURN fallback
    // above actually kick in reliably on restrictive networks.
    iceCandidatePoolSize: 4

};


// Plain `audio: true` leaves echo cancellation/noise suppression/gain
// control up to browser defaults, and lets the mic pick whatever
// sample rate it wants - both are common reasons a call is "audible
// but not clear". Asking for these explicitly gets a cleaner, more
// consistent signal on both ends.
//
// Echo (especially the kind that gets worse as call/speaker volume
// goes up) happens when the mic re-picks-up sound coming out of the
// phone's own speaker - loudspeaker/hands-free mode makes this much
// more likely the louder it plays. `echoCancellation: true` is the
// main defense; using the `{ ideal: true }` form (rather than a bare
// boolean) asks the browser to satisfy it more strongly if at all
// possible instead of silently falling back to defaults. The
// "goog*" keys are non-standard but still read by Chromium-based
// mobile browsers/WebViews (a large share of Android phones) and
// enable a more aggressive echo canceller there; unsupported keys
// are simply ignored elsewhere, so this is safe everywhere.
const HIGH_QUALITY_AUDIO_CONSTRAINTS = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: true },
    autoGainControl: { ideal: true },
    channelCount: 1,
    sampleRate: 48000,
    googEchoCancellation: true,
    googEchoCancellation2: true,
    googExperimentalEchoCancellation: true,
    googAutoGainControl: true,
    googNoiseSuppression: true,
    googHighpassFilter: true
};

// `{ ideal: true }` above still lets the browser silently connect the
// call with echo cancellation OFF if it decides not to honor it -
// which is exactly when people hear a lot of echo (typically
// speakerphone/hands-free, where the mic re-picks-up the call's own
// audio from the speaker). This stricter version asks for it as a
// hard requirement instead, so the browser is forced to actually
// turn it on. It only gets used for calls (see getCallAudioStream
// below), with an automatic fallback to the softer version above if
// a device genuinely can't satisfy it - so a rare device that lacks
// hardware AEC still gets a call instead of a hard failure.
const STRICT_AUDIO_CONSTRAINTS = {
    ...HIGH_QUALITY_AUDIO_CONSTRAINTS,
    echoCancellation: { exact: true },
    noiseSuppression: { exact: true },
    autoGainControl: { exact: true }
};

// Requests mic (and, for video calls, camera) access for a call,
// trying to force real echo cancellation on first and only relaxing
// that requirement if the device can't actually provide it.
async function getCallAudioStream(callType) {

    const video =
        callType === "video";

    try {

        return await navigator
            .mediaDevices
            .getUserMedia({
                audio: STRICT_AUDIO_CONSTRAINTS,
                video
            });

    } catch (err) {

        // exact echoCancellation/noiseSuppression/autoGainControl
        // isn't something this particular mic/browser can guarantee -
        // fall back to asking for it as a soft preference instead of
        // failing the call entirely
        if (
            err &&
            (
                err.name === "OverconstrainedError" ||
                err.name === "ConstraintNotSatisfiedError"
            )
        ) {

            return await navigator
                .mediaDevices
                .getUserMedia({
                    audio: HIGH_QUALITY_AUDIO_CONSTRAINTS,
                    video
                });

        }

        throw err;

    }

}

// The Opus codec defaults to a fairly low bitrate (often ~24-32kbps)
// unless the SDP explicitly asks for more - that's the other big
// contributor to calls that connect fine but sound muffled/thin.
// This rewrites the audio line's fmtp params to raise the ceiling
// and turn on a couple of quality-friendly Opus options, right
// before each offer/answer is set as the local description.
function boostAudioQuality(description) {

    if (!description || !description.sdp) return description;

    let sdp = description.sdp;

    // find the opus payload type from the rtpmap line, then extend
    // (or add) its fmtp line with higher-bitrate params
    const opusMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/);

    if (opusMatch) {

        const payloadType = opusMatch[1];
        const fmtpRegex = new RegExp(`a=fmtp:${payloadType} (.*)`);

        if (fmtpRegex.test(sdp)) {

            sdp = sdp.replace(
                fmtpRegex,
                (match, params) => {

                    const extra =
                        "maxaveragebitrate=128000;stereo=0;useinbandfec=1;maxplaybackrate=48000";

                    return `a=fmtp:${payloadType} ${params};${extra}`;

                }
            );

        } else {

            sdp = sdp.replace(
                opusMatch[0],
                `${opusMatch[0]}\r\na=fmtp:${payloadType} maxaveragebitrate=128000;stereo=0;useinbandfec=1;maxplaybackrate=48000`
            );

        }

    }

    return new RTCSessionDescription({
        type: description.type,
        sdp
    });

}


let pc =
    null;

let localStream =
    null;

let callPartnerId =
    null;

let pendingOffer =
    null;

// same idea as pendingOffer, but for a group-call ring (either a
// fresh group call rung from a group chat, or someone adding us to
// an already-running call) - kept separate so the accept/decline
// buttons on the shared incoming-call screen know which flow to run
let pendingGroupInvite =
    null;

// which chat (1:1 partner id, or group id) the current call belongs
// to - lets the in-chat "call in progress" banner know whether to
// show itself for the chat that's currently open
let activeCallChatId =
    null;

// tracked globally (not just as a local var inside startCall/accept)
// so the record/share-screen buttons know what kind of call is live
let currentCallType =
    null;

// whether incoming call audio is currently audible - toggled by the
// speaker button, and applied to any group-call tile created while
// it's switched off so a late joiner doesn't get an unmuted surprise
let speakerOn = true;

// the original camera video track, kept aside while screen sharing
// so we can switch back to it when the share ends
let cameraTrack =
    null;

let screenShareStream =
    null;

// ICE candidates can arrive over the socket before this side even
// has a RTCPeerConnection yet - most commonly on the callee's end,
// since candidates start trickling from the caller the instant the
// call starts ringing, but the callee doesn't create its `pc` until
// they actually click Accept. Any candidate that shows up in that
// window used to just be silently dropped (no pc to add it to),
// which starves the connection of routing info and is why calls
// would often connect one side but fail/hang on the other. Queue
// them here instead, and flush the queue once pc exists AND the
// remote description has been applied (addIceCandidate requires
// that on some browsers).
let pendingIceCandidates =
    [];

// ============================================================
// MINIMIZE / FLOATING CALL BUBBLE
//
// Lets someone step away from the full-screen call UI (to read a
// chat, check another group, etc.) without hanging up. The call
// itself (pc / localStream / everything above) is left completely
// alone - this only toggles which element is visible.
// ============================================================

let isCallMinimized = false;
let callTimerInterval = null;
let callTimerStartedAt = null;

// ------------------------------------------------------------
// RECONNECT HANDLING
//
// oniceconnectionstatechange used to flip straight to showing
// "Reconnecting..." the instant the ICE state said "disconnected",
// and then just sit there forever with nothing actually trying to
// fix it - "disconnected" on its own doesn't retry anything, it's
// only a status label. Two problems that caused in practice:
//
//  1. A call that's actually fine can dip into "disconnected" for a
//     fraction of a second right as it's being set up (normal churn
//     while ICE finishes picking a candidate pair) - that briefly
//     showed "Reconnecting..." on a call that was never broken.
//  2. A call that's genuinely stuck stayed stuck, because nothing
//     ever attempted an ICE restart - "Reconnecting..." was really
//     just "disconnected, permanently, forever".
//
// reconnectGraceTimer delays the "Reconnecting..." label so a quick
// blip never shows it, and iceRestartInFlight guards against firing
// more than one restart attempt at the same time.
// ------------------------------------------------------------
let reconnectGraceTimer = null;
let iceRestartInFlight = false;

function clearReconnectGraceTimer() {
    if (reconnectGraceTimer) {
        clearTimeout(reconnectGraceTimer);
        reconnectGraceTimer = null;
    }
}

// Actually tries to fix a stuck call instead of just labeling it
// broken - re-does the offer/answer exchange with iceRestart:true,
// over its own signaling events (call-renegotiate-offer/answer) so
// it can never be mistaken for a brand new incoming call.
async function attemptIceRestart(conn) {

    if (
        iceRestartInFlight ||
        !conn ||
        !callPartnerId ||
        conn.signalingState === "closed"
    ) {
        return;
    }

    iceRestartInFlight = true;

    try {

        const offer =
            await conn.createOffer({ iceRestart: true });

        await conn.setLocalDescription(
            boostAudioQuality(offer)
        );

        socket.emit(
            "call-renegotiate-offer",
            {
                toId: callPartnerId,
                offer: conn.localDescription
            }
        );

    } catch (err) {

        console.error("ICE restart error:", err);
        iceRestartInFlight = false;

    }

}

// ============================================================
// MULTI-PARTY (GROUP) CALLING
//
// The original 1:1 call above (pc / callPartnerId / remoteVideo /
// localVideo) is left completely untouched - it keeps working
// exactly as it always did. Everything below is additive: extra
// peer connections to any additional participants, rendered as
// extra tiles alongside the original call UI. This is what powers
// both "Add participant" during an ordinary call, and a real
// group call started from a group chat.
// ============================================================

// call id shared by every participant currently on the call,
// whether it started as a 1:1 call or a group call
let activeCallId = null;

// everyone we know is on the current call (including ourselves),
// id -> { name }. Used to tell a newly-added person who to
// connect to, and to know who's already in the call so we don't
// invite the same person twice.
let myParticipants = new Map();

// extra peer connections beyond the original 1:1 `pc`, id -> { pc, name }
let groupPeers = new Map();

// same idea as pendingIceCandidates above, but per extra peer
let pendingGroupIce = new Map();

function genCallId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function flushPendingGroupIce(peerId) {

    const entry = groupPeers.get(peerId);
    if (!entry) return;

    const queued = pendingGroupIce.get(peerId) || [];
    pendingGroupIce.set(peerId, []);

    for (const candidate of queued) {

        try {
            await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error("Queued group-call ICE candidate error:", err);
        }
    }
}

// Creates the peer connection WE initiate toward an existing
// participant (used when we're the one joining/being added).
async function connectToGroupPeer(peerId, peerName, callId) {

    if (groupPeers.has(peerId) || !localStream) return;

    const conn = new RTCPeerConnection(rtcConfig);
    groupPeers.set(peerId, { pc: conn, name: peerName || "Participant" });

    localStream.getTracks().forEach(track => conn.addTrack(track, localStream));

    conn.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit("group-peer-ice", { toId: peerId, callId, candidate: e.candidate });
        }
    };

    conn.ontrack = (e) => {
        showGroupPeerTile(peerId, peerName || "Participant", e.streams[0]);
    };

    conn.oniceconnectionstatechange = () => {
        if (["disconnected", "failed", "closed"].includes(conn.iceConnectionState)) {
            removeGroupPeerTile(peerId);
        }
    };

    const offer = await conn.createOffer();
    await conn.setLocalDescription(boostAudioQuality(offer));

    socket.emit("group-peer-offer", { toId: peerId, callId, offer: conn.localDescription });
}

function ensureCallTilesGrid() {

    let grid = document.getElementById("callParticipantsGrid");

    if (!grid) {

        const win = document.querySelector(".call-window");
        if (!win) return null;

        grid = document.createElement("div");
        grid.id = "callParticipantsGrid";
        grid.className = "call-participants-grid hidden";

        const controls = win.querySelector(".call-controls");
        if (controls) win.insertBefore(grid, controls);
        else win.appendChild(grid);
    }

    return grid;
}

function showGroupPeerTile(peerId, name, stream) {

    const grid = ensureCallTilesGrid();
    if (!grid) return;

    grid.classList.remove("hidden");

    let tile = document.getElementById("callTile-" + peerId);

    if (!tile) {

        tile = document.createElement("div");
        tile.className = "call-tile";
        tile.id = "callTile-" + peerId;
        tile.innerHTML =
            '<div class="call-tile-avatar"><div class="call-tile-avatar-circle"></div></div>' +
            '<video autoplay playsinline></video><span class="call-tile-name"></span>';

        grid.appendChild(tile);
    }

    const nameEl = tile.querySelector(".call-tile-name");
    if (nameEl) nameEl.textContent = name;

    // fill in the picture once - it doesn't change for the life of
    // this tile, no need to redo it on every track update
    const avatarCircle = tile.querySelector(".call-tile-avatar-circle");
    if (avatarCircle && !avatarCircle.dataset.filled) {
        avatarCircle.innerHTML = avatarMarkup(name, getUserAvatar(peerId));
        avatarCircle.dataset.filled = "1";
    }

    const videoEl = tile.querySelector("video");

    // deliberately never muted - this is someone else's audio, not
    // our own. Only our own local preview is ever muted (see the
    // `muted` attribute on #localVideo), which is also what keeps a
    // group call from feeding back into itself.
    if (videoEl && videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
        videoEl.muted = !speakerOn;
        videoEl.play().catch(() => {});
    }

    // show the picture instead of a blank/black box whenever this
    // participant has no live video track (voice call, or their
    // camera's off) - re-checked on every track update so a tile
    // flips to their real video the moment they turn their camera on
    const hasLiveVideo =
        !!stream &&
        stream.getVideoTracks().some(t => t.enabled && t.readyState === "live");

    tile.classList.toggle("audio-only", !hasLiveVideo);
}

function removeGroupPeerTile(peerId) {

    const tile = document.getElementById("callTile-" + peerId);
    if (tile && tile.parentNode) tile.parentNode.removeChild(tile);

    const entry = groupPeers.get(peerId);
    if (entry) {
        try { entry.pc.close(); } catch (err) {}
        groupPeers.delete(peerId);
    }

    pendingGroupIce.delete(peerId);
    myParticipants.delete(peerId);
}

function resetGroupCallState() {

    // notify everyone who's part of this call - not just the peers
    // we've actually finished connecting to. Someone who was invited
    // but hasn't answered yet (still on their own ringing screen)
    // never got a peer connection in `groupPeers`, so if we only
    // told already-connected peers "bye", anyone still ringing would
    // be left ringing forever after we hang up.
    if (activeCallId) {

        Array.from(myParticipants.keys())
            .filter(id => me && id !== me.id)
            .forEach(id => {
                try {
                    socket.emit("group-peer-bye", { toId: id, callId: activeCallId });
                } catch (err) {}
            });
    }

    groupPeers.forEach((entry) => {
        try { entry.pc.close(); } catch (err) {}
    });

    groupPeers.clear();
    pendingGroupIce.clear();
    myParticipants.clear();
    activeCallId = null;

    const grid = document.getElementById("callParticipantsGrid");
    if (grid) grid.innerHTML = "";

    const picker = document.getElementById("addParticipantPicker");
    if (picker) picker.classList.add("hidden");

    if (addParticipantBtn) addParticipantBtn.hidden = true;
}

function openAddParticipantPicker() {

    const win = document.querySelector(".call-window");
    if (!win) return;

    let picker = document.getElementById("addParticipantPicker");

    if (!picker) {
        picker = document.createElement("div");
        picker.id = "addParticipantPicker";
        picker.className = "add-participant-picker hidden";
        win.appendChild(picker);
    }

    const candidates =
        Object.values(usersOnline)
            .filter(u => !myParticipants.has(u.id));

    picker.innerHTML = `
        <div class="add-participant-picker-head">
            <strong>Add to call</strong>
            <button type="button" id="closeAddParticipantPicker" aria-label="Close">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        <div class="add-participant-picker-list">
            ${
                candidates.length
                    ? candidates.map(u => `
                        <button type="button" class="add-participant-item" data-id="${u.id}">
                            ${u.name}
                        </button>
                    `).join("")
                    : '<div class="add-participant-empty">No one else is online right now.</div>'
            }
        </div>
    `;

    picker.classList.remove("hidden");

    const closeBtn = document.getElementById("closeAddParticipantPicker");
    if (closeBtn) closeBtn.addEventListener("click", () => picker.classList.add("hidden"));

    picker.querySelectorAll(".add-participant-item").forEach(btn => {

        btn.addEventListener("click", () => {

            const id = btn.dataset.id;
            const user = usersOnline[id];

            inviteToCall(id, user ? user.name : "Participant");
            picker.classList.add("hidden");
        });
    });
}

function inviteToCall(targetId, targetName, meta = {}) {

    if (!activeCallId || !targetId || myParticipants.has(targetId)) return;

    const participantIds = Array.from(myParticipants.keys());

    const participantNames =
        participantIds.map(id => (myParticipants.get(id) || {}).name || "");

    socket.emit("call-add-participant", {
        toId: targetId,
        callId: activeCallId,
        callType: currentCallType || "audio",
        participantIds,
        participantNames,
        // when this invite is really "a group call just started ringing"
        // (as opposed to someone being added mid-call), the ring screen
        // shows the group instead of naming whoever happened to tap
        // "call" first - see call-add-invite below
        isGroupCall: !!meta.isGroupCall,
        groupName: meta.groupName || null,
        groupId: meta.groupId || null
    });

    // optimistic - if they decline, "call-add-declined" removes them again
    myParticipants.set(targetId, { name: targetName });
}

if (addParticipantBtn) {
    addParticipantBtn.addEventListener("click", openAddParticipantPicker);
}

socket.on("call-add-invite", ({ fromId, fromName, callId, callType, participantIds, participantNames, isGroupCall, groupName, groupId } = {}) => {

    if (!fromId || !callId) return;

    const namesById = {};
    (participantIds || []).forEach((id, i) => { namesById[id] = (participantNames || [])[i] || "Someone"; });

    const roster = (participantIds || []).filter(id => me && id !== me.id);

    pendingGroupInvite = {
        fromId,
        fromName,
        callId,
        callType,
        roster,
        namesById,
        groupId: isGroupCall ? (groupId || null) : null,
        groupName: isGroupCall ? (groupName || null) : null
    };

    if (isGroupCall) {

        // a real group call ringing everyone at once - shown like
        // WhatsApp's group call screen: the group, not an individual
        // caller's name
        showIncomingCallScreen(
            groupName || "Group Call",
            `Incoming ${callType === "video" ? "video" : "voice"} call`,
            avatarMarkup(groupName || "Group Call", getGroupAvatar(groupId))
        );

    } else {

        const rosterNames =
            roster.map(id => namesById[id] || "Someone").filter(Boolean);

        showIncomingCallScreen(
            "Incoming Call",
            `${fromName || "Someone"} wants to add you to a ${callType === "video" ? "video" : "voice"} call` +
            (rosterNames.length ? ` with ${rosterNames.join(", ")}` : ""),
            avatarMarkup(fromName || "Someone", getUserAvatar(fromId))
        );
    }
});

async function acceptGroupInvite() {

    if (!pendingGroupInvite) return;

    const { fromId, callId, callType, roster, namesById, groupId, groupName } = pendingGroupInvite;

    pendingGroupInvite = null;
    hideIncomingCallScreen();

    if (!mediaDevicesAvailable()) {
        showNiceAlert(mediaErrorMessage(null), { title: "Camera & mic", icon: "fa-video" });
        socket.emit("call-add-decline", { toId: fromId, callId });
        return;
    }

    try {
        localStream = await getCallAudioStream(callType);
    } catch (err) {
        showNiceAlert(mediaErrorMessage(err), { title: "Camera & mic", icon: "fa-video" });
        socket.emit("call-add-decline", { toId: fromId, callId });
        return;
    }

    currentCallType = callType;
    cameraTrack = callType === "video" ? (localStream.getVideoTracks()[0] || null) : null;
    activeCallId = callId;
    activeCallChatId = groupId || null;

    myParticipants = new Map();
    if (me) myParticipants.set(me.id, { name: me.name });
    roster.forEach(id => myParticipants.set(id, { name: namesById[id] || "Participant" }));

    showCallUI(
        callType,
        "Connecting...",
        groupId ? avatarMarkup(groupName || "Group", getGroupAvatar(groupId)) : null
    );

    roster.forEach(id => connectToGroupPeer(id, namesById[id] || "Participant", callId));
}

socket.on("call-add-declined", ({ fromId, callId } = {}) => {

    if (callId !== activeCallId) return;
    myParticipants.delete(fromId);

    // if we're the one who started this call and everyone we invited
    // has now declined (nobody ever connected either), don't leave
    // ourselves stuck in a call screen with no one else on it
    if (groupPeers.size === 0 && myParticipants.size <= 1 && callStatusText) {
        callStatusText.textContent = "No one answered";
        setTimeout(() => {
            if (activeCallId === callId) endCallCleanup();
        }, 1500);
    }
});

// Someone we're already on a call with is sending us their offer -
// either because they're the newcomer connecting to us, or because
// they're an existing peer we haven't directly connected to yet.
socket.on("group-peer-offer", async ({ fromId, fromName, callId, offer } = {}) => {

    if (!fromId || !offer || callId !== activeCallId || !localStream) return;

    let entry = groupPeers.get(fromId);

    if (!entry) {

        const conn = new RTCPeerConnection(rtcConfig);
        entry = { pc: conn, name: fromName || "Participant" };
        groupPeers.set(fromId, entry);

        localStream.getTracks().forEach(track => conn.addTrack(track, localStream));

        conn.onicecandidate = (e) => {
            if (e.candidate) {
                socket.emit("group-peer-ice", { toId: fromId, callId, candidate: e.candidate });
            }
        };

        conn.ontrack = (e) => showGroupPeerTile(fromId, entry.name, e.streams[0]);

        conn.oniceconnectionstatechange = () => {
            if (["disconnected", "failed", "closed"].includes(conn.iceConnectionState)) {
                removeGroupPeerTile(fromId);
            }
        };
    }

    myParticipants.set(fromId, { name: entry.name });

    await entry.pc.setRemoteDescription(new RTCSessionDescription(offer));
    await flushPendingGroupIce(fromId);

    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(boostAudioQuality(answer));

    socket.emit("group-peer-answer", { toId: fromId, callId, answer: entry.pc.localDescription });
});

socket.on("group-peer-answer", async ({ fromId, callId, answer } = {}) => {

    if (callId !== activeCallId) return;

    const entry = groupPeers.get(fromId);
    if (!entry || !answer) return;

    await entry.pc.setRemoteDescription(new RTCSessionDescription(answer));
    await flushPendingGroupIce(fromId);
});

socket.on("group-peer-ice", async ({ fromId, callId, candidate } = {}) => {

    if (callId !== activeCallId || !candidate) return;

    const entry = groupPeers.get(fromId);

    if (!entry || !entry.pc.remoteDescription || !entry.pc.remoteDescription.type) {

        if (!pendingGroupIce.has(fromId)) pendingGroupIce.set(fromId, []);
        pendingGroupIce.get(fromId).push(candidate);
        return;
    }

    try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("group-peer-ice error:", err);
    }
});

socket.on("group-peer-bye", ({ fromId, callId } = {}) => {

    // we might still be on the ringing screen for this exact call
    // (invited, never accepted/connected yet) - if the caller hangs
    // up before we answer, dismiss the ring instead of leaving it
    // stuck forever.
    if (pendingGroupInvite && pendingGroupInvite.callId === callId && pendingGroupInvite.fromId === fromId) {
        pendingGroupInvite = null;
        hideIncomingCallScreen();
        return;
    }

    if (callId !== activeCallId) return;

    removeGroupPeerTile(fromId);

    // if that was the last other person on the call (no more group
    // peers, and this isn't a 1:1 call still going with its own
    // `pc`), the call is effectively over for us too - close our own
    // screen instead of sitting alone in an empty call.
    const onlySelfLeft =
        groupPeers.size === 0 &&
        !pc &&
        myParticipants.size <= 1;

    if (onlySelfLeft) {
        endCallCleanup();
    }
});

async function flushPendingIceCandidates() {

    if (
        !pc ||
        !pc.remoteDescription ||
        !pc.remoteDescription.type
    ) {
        return;
    }


    const queued =
        pendingIceCandidates;

    pendingIceCandidates =
        [];


    for (const candidate of queued) {

        try {

            await pc.addIceCandidate(
                new RTCIceCandidate(
                    candidate
                )
            );

        }

        catch (err) {

            console.error(
                "Queued ICE candidate error:",
                err
            );

        }

    }

}


if (audioCallBtn) {

    audioCallBtn.addEventListener(
        "click",
        () =>
            activeChat && activeChat.isGroup
                ? startGroupCallFromGroup("audio")
                : startCall("audio")
    );

}


if (videoCallBtn) {

    videoCallBtn.addEventListener(
        "click",
        () =>
            activeChat && activeChat.isGroup
                ? startGroupCallFromGroup("video")
                : startCall("video")
    );

}

// Rings every online member of the currently-open group at once,
// using the exact same "add participant" mesh mechanism as adding
// someone mid-call - a group call is really just several people
// added to the same call in quick succession.
async function startGroupCallFromGroup(callType) {

    if (!activeChat || !activeChat.isGroup) return;

    if (!mediaDevicesAvailable()) {
        showNiceAlert(mediaErrorMessage(null), { title: "Camera & mic", icon: "fa-video" });
        return;
    }

    try {
        localStream = await getCallAudioStream(callType);
    } catch (err) {
        showNiceAlert(mediaErrorMessage(err), { title: "Camera & mic", icon: "fa-video" });
        return;
    }

    currentCallType = callType;
    cameraTrack = callType === "video" ? (localStream.getVideoTracks()[0] || null) : null;
    activeCallId = genCallId("c");
    activeCallChatId = activeChat.id;
    myParticipants = new Map([[me.id, { name: me.name }]]);

    showCallUI(
        callType,
        `Calling ${activeChat.name}...`,
        avatarMarkup(activeChat.name, getGroupAvatar(activeChat.id))
    );

    const members =
        (activeChat.memberIds || [])
            .filter(id => id !== me.id && usersOnline[id]);

    members.forEach(id => inviteToCall(id, usersOnline[id].name, {
        isGroupCall: true,
        groupName: activeChat.name,
        groupId: activeChat.id
    }));
}


async function startCall(
    callType
) {

    if (!activeChat) {
        return;
    }


    callPartnerId =
        activeChat.id;


    if (!mediaDevicesAvailable()) {

        showNiceAlert(mediaErrorMessage(null), { title: "Camera & mic", icon: "fa-video" });

        callPartnerId = null;
        return;

    }


    try {

        localStream =
            await getCallAudioStream(
                callType
            );

    }

    catch (err) {

        showNiceAlert(mediaErrorMessage(err), { title: "Camera & mic", icon: "fa-video" });

        return;

    }


    currentCallType =
        callType;

    cameraTrack =
        callType === "video"
            ? localStream.getVideoTracks()[0] || null
            : null;


    showCallUI(
        callType,
        `Calling ${activeChat.name}...`,
        avatarMarkup(activeChat.name, getUserAvatar(activeChat.id))
    );


    pc =
        createPeerConnection();


    localStream
        .getTracks()
        .forEach(
            track =>
                pc.addTrack(
                    track,
                    localStream
                )
        );


    const offer =
        await pc.createOffer();


    await pc.setLocalDescription(
        boostAudioQuality(offer)
    );


    socket.emit(
        "call-user",
        {
            toId:
                callPartnerId,
            offer:
                pc.localDescription,
            callType
        }
    );

    // ringback ("brrring") plays on our end for as long as the other
    // side hasn't answered - stopped by call-answer (they picked up),
    // call-rejected (they declined), or endCallCleanup's safety net
    // (we hang up first / call-ended)
    startRingtoneLoop();

    // seed the multi-party call state so "Add participant" works on
    // an otherwise ordinary 1:1 call too - see the MULTI-PARTY
    // (GROUP) CALLING section further down
    activeCallId = genCallId("c");
    activeCallChatId = callPartnerId;
    myParticipants = new Map([
        [me.id, { name: me.name }],
        [callPartnerId, { name: activeChat.name }]
    ]);

}


// ============================================================
// PEER CONNECTION
// ============================================================

function createPeerConnection() {

    const conn =
        new RTCPeerConnection(
            rtcConfig
        );


    conn.onicecandidate =
        (e) => {

            if (
                e.candidate &&
                callPartnerId
            ) {

                socket.emit(
                    "ice-candidate",
                    {
                        toId:
                            callPartnerId,
                        candidate:
                            e.candidate
                    }
                );

            }

        };


    conn.ontrack =
        (e) => {

            if (remoteVideo) {

                if (remoteVideo.srcObject !== e.streams[0]) {

                    remoteVideo.srcObject =
                        e.streams[0];

                }


                // Some browsers block autoplay of media that has sound
                // unless it's muted, even right after a call is accepted.
                // If that happens the <video> just sits there silently
                // with no error - which looks exactly like "the call
                // connects but I can't hear them". Force playback, and
                // if the browser still refuses, fall back to a brief
                // muted-then-unmuted play (allowed almost everywhere)
                // instead of staying silent forever.
                const playPromise = remoteVideo.play();

                if (playPromise && typeof playPromise.catch === "function") {

                    playPromise.catch(() => {

                        remoteVideo.muted = true;

                        remoteVideo.play()
                            .then(() => { remoteVideo.muted = false; })
                            .catch(() => {});

                    });

                }

            }

            // NOTE: deliberately not setting "Connected" here. ontrack
            // fires once the SDP negotiation creates a receiver, which
            // can happen before the ICE connection actually finishes
            // checking - showing "Connected" at this point is what made
            // one side look connected while the other was still stuck
            // negotiating/failing. The real "Connected" state is set
            // from oniceconnectionstatechange below instead, since that
            // reflects whether a media path was actually established.

        };


    conn.oniceconnectionstatechange =
        () => {

            const state =
                conn.iceConnectionState;

            if (state === "checking") {

                // don't stomp on a "Connected"/timer state that's
                // already showing - ICE can briefly re-enter
                // "checking" on its own during normal negotiation
                // even while audio keeps flowing fine
                clearReconnectGraceTimer();

                if (callStatusText && !callTimerInterval) {
                    callStatusText.textContent =
                        "Connecting...";
                }

            } else if (
                state === "connected" ||
                state === "completed"
            ) {

                // recovered (or connected for the first time) - drop
                // any pending "Reconnecting..." grace timer and any
                // in-flight restart bookkeeping
                clearReconnectGraceTimer();
                iceRestartInFlight = false;

                if (callStatusText) {
                    callStatusText.textContent =
                        "Connected";
                }

                startCallTimer();

            } else if (state === "disconnected") {

                // "disconnected" is often a brief blip (a dropped
                // packet, a network switch, or even just normal churn
                // right as the call is being set up) that recovers on
                // its own within a second or two. Jumping straight to
                // "Reconnecting..." here was flashing that message on
                // calls that were never actually broken - and calls
                // that were left with nothing that ever tried to fix
                // them. So: wait a couple of seconds, and only show
                // "Reconnecting..." (and try an ICE restart) if it's
                // still disconnected by then.
                clearReconnectGraceTimer();

                reconnectGraceTimer = setTimeout(() => {

                    reconnectGraceTimer = null;

                    if (conn.iceConnectionState !== "disconnected") {
                        return;
                    }

                    if (callStatusText) {
                        callStatusText.textContent =
                            "Reconnecting...";
                    }

                    attemptIceRestart(conn);

                }, 2000);

            } else if (state === "failed") {

                clearReconnectGraceTimer();

                // try to actually recover once before telling the
                // person the call is dead
                if (!iceRestartInFlight) {

                    if (callStatusText) {
                        callStatusText.textContent =
                            "Reconnecting...";
                    }

                    attemptIceRestart(conn);

                } else if (callStatusText) {

                    callStatusText.textContent =
                        "Connection failed — this can happen on some networks/firewalls. Try again, or on a different network.";

                }

            }

        };


    return conn;

}


// ============================================================
// CALL UI
// ============================================================

const callRemoteAvatar =
    document.getElementById("callRemoteAvatar");

const callRemoteAvatarCircle =
    document.getElementById("callRemoteAvatarCircle");

function showCallUI(
    callType,
    statusText,
    avatarHtml
) {

    if (callOverlay) {

        callOverlay.classList.remove(
            "hidden"
        );

        callOverlay.dataset.callActive = "true";

    }


    if (callStatusText) {

        callStatusText.textContent =
            statusText;

    }


    if (localVideo) {

        localVideo.srcObject =
            localStream;

        localVideo.style.display =
            callType === "video"
                ? "block"
                : "none";

    }


    if (remoteVideo) {

        remoteVideo.style.display =
            callType === "video"
                ? "block"
                : "none";

    }

    if (callRemoteAvatarCircle) {
        callRemoteAvatarCircle.innerHTML =
            avatarHtml || avatarMarkup(null, null);
    }

    if (callRemoteAvatar) {
        callRemoteAvatar.classList.toggle(
            "hidden",
            callType === "video"
        );
    }

    if (addParticipantBtn) {
        addParticipantBtn.hidden = false;
    }

    // a fresh call always starts full-screen, not minimized
    restoreCall();

    if (floatingCallBubbleLabel) {
        floatingCallBubbleLabel.textContent =
            callType === "video" ? "Video call" : "Voice call";
    }

    if (floatingCallBubbleIcon) {
        floatingCallBubbleIcon.innerHTML =
            avatarHtml || DEFAULT_INCOMING_CALL_ICON;
    }

}


// ============================================================
// CALL TIMER (drives both the in-call clock and the bubble clock)
// ============================================================

function formatCallDuration(totalSeconds) {

    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    const pad = (n) => String(n).padStart(2, "0");

    return mins >= 60
        ? `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}:${pad(secs)}`
        : `${pad(mins)}:${pad(secs)}`;

}

function startCallTimer() {

    // already running (e.g. ICE re-connected) - don't reset the clock
    if (callTimerInterval) return;

    callTimerStartedAt = Date.now();

    const tick = () => {

        const elapsed =
            Math.floor((Date.now() - callTimerStartedAt) / 1000);

        const label =
            formatCallDuration(elapsed);

        if (callTimerText) {
            callTimerText.textContent = label;
            callTimerText.classList.remove("hidden");
        }

        if (floatingCallBubbleTimer) {
            floatingCallBubbleTimer.textContent = label;
            floatingCallBubbleTimer.classList.remove("hidden");
        }

    };

    tick();
    callTimerInterval = setInterval(tick, 1000);

}

function stopCallTimer() {

    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }

    callTimerStartedAt = null;

    if (callTimerText) {
        callTimerText.classList.add("hidden");
        callTimerText.textContent = "00:00";
    }

    if (floatingCallBubbleTimer) {
        floatingCallBubbleTimer.classList.add("hidden");
        floatingCallBubbleTimer.textContent = "00:00";
    }

}


// ============================================================
// MINIMIZE CALL (go back to the app, call keeps running as a
// small floating, draggable bubble) / RESTORE CALL
// ============================================================

function minimizeCall() {

    if (!callOverlay || isCallMinimized) return;

    isCallMinimized = true;

    // hide the full-screen call UI only - pc/localStream/remote
    // stream are untouched, so audio (and video, off-screen) keep
    // flowing exactly as before
    callOverlay.classList.add("hidden");

    if (floatingCallBubble) {
        floatingCallBubble.classList.remove("hidden");
    }

    updateActiveCallBannerVisibility();

}

function restoreCall() {

    isCallMinimized = false;

    if (floatingCallBubble) {
        floatingCallBubble.classList.add("hidden");
    }

    if (callOverlay && callOverlay.dataset.callActive === "true") {
        callOverlay.classList.remove("hidden");
    }

    updateActiveCallBannerVisibility();

}

// Shows a small "call in progress, tap to return" banner inside the
// currently-open chat once the person has scrolled up a good way
// from the bottom while their call is minimized - mirrors WhatsApp's
// ongoing-call bar, but only surfaces when they've scrolled away
// instead of sitting on screen the whole time.
function updateActiveCallBannerVisibility() {

    if (!activeCallBanner || !messagesEl) return;

    const belongsToOpenChat =
        isCallMinimized &&
        activeCallChatId &&
        activeChat &&
        activeCallChatId === activeChat.id;

    if (!belongsToOpenChat) {
        activeCallBanner.classList.add("hidden");
        return;
    }

    const distanceFromBottom =
        messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;

    // only surface once they've scrolled up a good way from the
    // latest messages - near the bottom, the floating call bubble
    // is already visible and this would just be redundant
    const scrolledUpFar = distanceFromBottom > 220;

    if (!scrolledUpFar) {
        activeCallBanner.classList.add("hidden");
        return;
    }

    if (activeCallBannerText) {
        activeCallBannerText.textContent =
            (currentCallType === "video" ? "Video call" : "Voice call") + " in progress";
    }

    activeCallBanner.classList.remove("hidden");

}

if (messagesEl) {
    messagesEl.addEventListener("scroll", updateActiveCallBannerVisibility);
}

if (activeCallBannerJoin) {
    activeCallBannerJoin.addEventListener("click", restoreCall);
}

if (minimizeCallBtn) {
    minimizeCallBtn.addEventListener("click", minimizeCall);
}

// tapping the bubble (as opposed to dragging it) returns to the
// full call screen
if (floatingCallBubble) {

    let dragging = false;
    let moved = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    floatingCallBubble.addEventListener("pointerdown", (e) => {

        dragging = true;
        moved = false;

        const rect = floatingCallBubble.getBoundingClientRect();

        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;

        floatingCallBubble.setPointerCapture(e.pointerId);

    });

    floatingCallBubble.addEventListener("pointermove", (e) => {

        if (!dragging) return;

        moved = true;

        const maxX = window.innerWidth - floatingCallBubble.offsetWidth - 8;
        const maxY = window.innerHeight - floatingCallBubble.offsetHeight - 8;

        const nextX = Math.min(Math.max(8, e.clientX - dragOffsetX), maxX);
        const nextY = Math.min(Math.max(8, e.clientY - dragOffsetY), maxY);

        floatingCallBubble.style.left = `${nextX}px`;
        floatingCallBubble.style.top = `${nextY}px`;
        floatingCallBubble.style.right = "auto";

    });

    const endDrag = (e) => {

        if (!dragging) return;

        dragging = false;

        // a genuine drag shouldn't also count as a "tap to restore"
        if (!moved) {
            restoreCall();
        }

    };

    floatingCallBubble.addEventListener("pointerup", endDrag);
    floatingCallBubble.addEventListener("pointercancel", endDrag);

}

if (floatingCallBubbleHangup) {

    floatingCallBubbleHangup.addEventListener("click", (e) => {

        // don't let this also trigger the bubble's own tap-to-restore
        e.stopPropagation();

        // "call-end" forces the call fully closed on the other end -
        // only fire it for a genuine 1:1 (nobody else on the call).
        // With extra participants, resetGroupCallState (inside
        // endCallCleanup below) tells each of them individually that
        // we've left, and their own side decides whether the call is
        // now over for them too - so it doesn't yank a still-ongoing
        // group call out from under everyone else just because one
        // person hung up.
        if (callPartnerId && myParticipants.size <= 2) {
            socket.emit("call-end", { toId: callPartnerId });
        }

        endCallCleanup();

    });

}


// ============================================================
// END CALL CLEANUP
// ============================================================

function endCallCleanup() {

    // safety net — guarantees the ringtone stops however the call
    // screen closes (accept/decline/hangup/rejected/ended)
    stopRingtoneLoop();

    // if the other side ends/cancels the call while we're still on
    // the ringing screen (either the classic 1:1 "Incoming Call" or
    // a group-call ring we haven't answered yet), that screen has to
    // close too - otherwise it's stuck showing a call that no longer
    // exists on the other end
    if (incomingCall && !incomingCall.classList.contains("hidden")) {
        incomingCall.classList.add("hidden");
    }
    if (incomingTitle) incomingTitle.textContent = "Incoming Call";
    pendingOffer = null;
    pendingGroupInvite = null;
    activeCallChatId = null;

    // tear down any extra (beyond the original 1:1 partner) call
    // participants - see MULTI-PARTY (GROUP) CALLING
    resetGroupCallState();

    stopCallTimer();

    clearReconnectGraceTimer();
    iceRestartInFlight = false;

    isCallMinimized = false;

    if (floatingCallBubble) {
        floatingCallBubble.classList.add("hidden");
    }

    if (activeCallBanner) {
        activeCallBanner.classList.add("hidden");
    }

    if (callOverlay) {

        callOverlay.classList.add(
            "hidden"
        );

        callOverlay.dataset.callActive = "false";

    }


    if (pc) {

        pc.close();

        pc =
            null;

    }


    if (localStream) {

        localStream
            .getTracks()
            .forEach(
                track =>
                    track.stop()
            );


        localStream =
            null;

    }


    if (remoteVideo) {

        remoteVideo.srcObject =
            null;

    }

    if (callRemoteAvatarCircle) {
        callRemoteAvatarCircle.innerHTML = "";
    }

    if (floatingCallBubbleIcon) {
        floatingCallBubbleIcon.innerHTML = DEFAULT_INCOMING_CALL_ICON;
    }

    speakerOn = true;

    if (speakerBtn) {

        speakerBtn.classList.remove("speaker-off");

        const speakerIcon = speakerBtn.querySelector("i");
        if (speakerIcon) speakerIcon.className = "fa-solid fa-volume-high";

    }


    if (localVideo) {

        localVideo.srcObject =
            null;

    }


    callPartnerId =
        null;

    pendingIceCandidates =
        [];

    currentCallType =
        null;

    cameraTrack =
        null;

    if (screenShareStream) {

        screenShareStream
            .getTracks()
            .forEach(track => track.stop());

        screenShareStream =
            null;

    }

    stopCallRecording(true);

    if (screenShareBtn) {
        screenShareBtn.classList.remove("active-control");
    }

}


// ============================================================
// HANG UP
// ============================================================

if (hangupBtn) {

    hangupBtn.addEventListener(
        "click",
        () => {

            // "call-end" forces the call fully closed on the other
            // end - only fire it for a genuine 1:1 (nobody else on
            // the call). With extra participants, resetGroupCallState
            // (inside endCallCleanup below) tells each of them
            // individually that we've left, and their own side
            // decides whether the call is now over for them too.
            if (
                callPartnerId &&
                myParticipants.size <= 2
            ) {

                socket.emit(
                    "call-end",
                    {
                        toId:
                            callPartnerId
                    }
                );

            }


            endCallCleanup();

        }
    );

}


// ============================================================
// MUTE
// ============================================================

if (muteBtn) {

    muteBtn.addEventListener(
        "click",
        () => {

            if (!localStream) {
                return;
            }


            const track =
                localStream
                    .getAudioTracks()[0];


            if (!track) {
                return;
            }


            track.enabled =
                !track.enabled;


            muteBtn.classList.toggle(
                "recording",
                !track.enabled
            );

        }
    );

}


// ============================================================
// SPEAKER
// ============================================================
// Toggles whether we can hear the other side - applied to the 1:1
// remote stream and every group-call tile's audio at once, so it
// works the same regardless of how many people are on the call.

if (speakerBtn) {

    speakerBtn.addEventListener(
        "click",
        () => {

            speakerOn = !speakerOn;

            speakerBtn.classList.toggle("speaker-off", !speakerOn);

            const icon = speakerBtn.querySelector("i");
            if (icon) {
                icon.className =
                    speakerOn
                        ? "fa-solid fa-volume-high"
                        : "fa-solid fa-volume-xmark";
            }

            if (remoteVideo) remoteVideo.muted = !speakerOn;

            document
                .querySelectorAll(".call-tile video")
                .forEach(v => { v.muted = !speakerOn; });

        }
    );

}


// ============================================================
// SHARE SCREEN
// ============================================================
// Swaps the outgoing video track for a screen-capture track using
// replaceTrack, so it doesn't need a fresh offer/answer round trip.
// Only available once a video call is live (an audio-only call has
// no video m-line in its SDP to swap a track into).

async function toggleScreenShare() {

    if (!pc || currentCallType !== "video") {

        showNiceAlert("Screen sharing is only available during a video call.", { title: "Screen share", icon: "fa-desktop" });
        return;

    }


    const sender =
        pc.getSenders().find(s => s.track && s.track.kind === "video");

    if (!sender) return;


    // already sharing — switch back to the camera
    if (screenShareStream) {

        screenShareStream
            .getTracks()
            .forEach(track => track.stop());

        screenShareStream =
            null;


        if (cameraTrack) {

            await sender.replaceTrack(cameraTrack);

            if (localVideo) localVideo.srcObject = localStream;

        }


        if (screenShareBtn) screenShareBtn.classList.remove("active-control");

        return;

    }


    try {

        screenShareStream =
            await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: false
            });

    }

    catch (err) {

        // user cancelled the picker, or the browser doesn't support it
        return;

    }


    const screenTrack =
        screenShareStream.getVideoTracks()[0];

    if (!screenTrack) return;


    await sender.replaceTrack(screenTrack);

    if (localVideo) localVideo.srcObject = screenShareStream;

    if (screenShareBtn) screenShareBtn.classList.add("active-control");


    // if the person stops sharing from the browser's own "Stop
    // sharing" control (instead of our button), switch back to the
    // camera automatically instead of leaving a dead video track
    screenTrack.addEventListener("ended", () => {

        if (screenShareStream) toggleScreenShare();

    });

}

if (screenShareBtn) {

    screenShareBtn.addEventListener(
        "click",
        toggleScreenShare
    );

}


// ============================================================
// RECORD CALL
// (mixes local + remote audio via the Web Audio API, and - for
// video calls - composites both video feeds onto a canvas, then
// records the result with MediaRecorder and downloads it as a file
// once the recording is stopped)
// ============================================================

let callRecorder = null;
let callRecordedChunks = [];
let recordingAudioCtx = null;
let recordingCanvas = null;
let recordingCanvasRAF = null;

function buildRecordingStream() {

    recordingAudioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const destination =
        recordingAudioCtx.createMediaStreamDestination();

    // local mic audio
    if (localStream && localStream.getAudioTracks().length) {

        recordingAudioCtx
            .createMediaStreamSource(new MediaStream(localStream.getAudioTracks()))
            .connect(destination);

    }

    // remote party's audio
    if (remoteVideo && remoteVideo.srcObject) {

        const remoteAudioTracks =
            remoteVideo.srcObject.getAudioTracks();

        if (remoteAudioTracks.length) {

            recordingAudioCtx
                .createMediaStreamSource(new MediaStream(remoteAudioTracks))
                .connect(destination);

        }

    }


    // audio-only call: the mixed audio track is the whole recording
    if (currentCallType !== "video") {
        return destination.stream;
    }


    // video call: composite both video feeds onto a canvas so a
    // single file captures what both people saw and heard
    recordingCanvas = document.createElement("canvas");
    recordingCanvas.width = 1280;
    recordingCanvas.height = 720;

    const ctx = recordingCanvas.getContext("2d");

    const drawFrame = () => {

        ctx.fillStyle = "#05070c";
        ctx.fillRect(0, 0, recordingCanvas.width, recordingCanvas.height);

        if (remoteVideo && remoteVideo.videoWidth) {
            ctx.drawImage(remoteVideo, 0, 0, recordingCanvas.width, recordingCanvas.height);
        }

        if (localVideo && localVideo.videoWidth) {

            const pipW = recordingCanvas.width * 0.25;
            const pipH = pipW * (localVideo.videoHeight / localVideo.videoWidth || 0.75);

            ctx.drawImage(
                localVideo,
                recordingCanvas.width - pipW - 20,
                recordingCanvas.height - pipH - 20,
                pipW,
                pipH
            );

        }

        recordingCanvasRAF = requestAnimationFrame(drawFrame);

    };

    drawFrame();


    const canvasStream = recordingCanvas.captureStream(30);
    const mixed = new MediaStream();

    canvasStream.getVideoTracks().forEach(t => mixed.addTrack(t));
    destination.stream.getAudioTracks().forEach(t => mixed.addTrack(t));

    return mixed;

}

function startCallRecording() {

    if (!pc || !localStream || callRecorder) return;


    let stream;

    try {

        stream = buildRecordingStream();

    }

    catch (err) {

        showNiceAlert("Couldn't start recording on this browser.", { title: "Voice message", icon: "fa-microphone" });
        return;

    }


    callRecordedChunks = [];

    try {

        callRecorder = new MediaRecorder(stream, {
            mimeType:
                MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
                    ? "video/webm;codecs=vp9,opus"
                    : "video/webm"
        });

    }

    catch (err) {

        callRecorder = new MediaRecorder(stream);

    }


    callRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) callRecordedChunks.push(e.data);
    };

    callRecorder.onstop = () => {

        if (callRecordedChunks.length) {

            const blob = new Blob(callRecordedChunks, { type: "video/webm" });
            const url = URL.createObjectURL(blob);

            const a = document.createElement("a");
            a.href = url;
            a.download = `call-recording-${Date.now()}.webm`;
            document.body.appendChild(a);
            a.click();
            a.remove();

            setTimeout(() => URL.revokeObjectURL(url), 10000);

        }


        if (recordingCanvasRAF) {
            cancelAnimationFrame(recordingCanvasRAF);
            recordingCanvasRAF = null;
        }

        if (recordingAudioCtx) {
            recordingAudioCtx.close().catch(() => {});
            recordingAudioCtx = null;
        }

        recordingCanvas = null;
        callRecordedChunks = [];

    };

    callRecorder.start(1000);

    if (recordCallBtn) recordCallBtn.classList.add("rec-active");
    if (callRecordingBadge) callRecordingBadge.classList.remove("hidden");

}

function stopCallRecording(silent) {

    if (!callRecorder) return;

    if (callRecorder.state !== "inactive") {
        callRecorder.stop();
    }

    callRecorder = null;

    if (recordCallBtn) recordCallBtn.classList.remove("rec-active");
    if (callRecordingBadge) callRecordingBadge.classList.add("hidden");

}

if (recordCallBtn) {

    recordCallBtn.addEventListener(
        "click",
        () => {

            if (callRecorder) {
                stopCallRecording();
            } else {
                startCallRecording();
            }

        }
    );

}


// ============================================================
// INCOMING CALL
// ============================================================

const incomingTitle =
    document.getElementById("incomingTitle");

// Shared by every kind of incoming ring (1:1 call, a fresh group
// call, or being added to an in-progress call) so they all get the
// same full-screen ring treatment + looping ringtone instead of
// some using a plain confirm popup.
const incomingCallAvatar =
    document.getElementById("incomingCallAvatar");

const DEFAULT_INCOMING_CALL_ICON =
    '<i class="fa-solid fa-phone"></i>';

function showIncomingCallScreen(titleText, bodyText, avatarHtml) {

    if (incomingTitle) incomingTitle.textContent = titleText;
    if (incomingText) incomingText.textContent = bodyText;

    if (incomingCallAvatar) {
        incomingCallAvatar.innerHTML = avatarHtml || DEFAULT_INCOMING_CALL_ICON;
    }

    if (incomingCall) {
        incomingCall.classList.remove("hidden");
    }

    startRingtoneLoop();
}

function hideIncomingCallScreen() {

    stopRingtoneLoop();

    if (incomingCall) {
        incomingCall.classList.add("hidden");
    }

    if (incomingTitle) incomingTitle.textContent = "Incoming Call";

    if (incomingCallAvatar) {
        incomingCallAvatar.innerHTML = DEFAULT_INCOMING_CALL_ICON;
    }
}

socket.on(
    "incoming-call",
    ({
        fromId,
        fromName,
        offer,
        callType
    }) => {

        pendingOffer = {

            fromId,
            fromName,
            offer,
            callType

        };

        showIncomingCallScreen(
            "Incoming Call",
            `${fromName} is ${
                callType === "video"
                    ? "video calling"
                    : "calling"
            } you`,
            avatarMarkup(fromName, getUserAvatar(fromId))
        );

    }
);


// ============================================================
// ACCEPT CALL
// ============================================================

if (acceptCallBtn) {

    acceptCallBtn.addEventListener(
        "click",
        async () => {

            if (pendingGroupInvite) {
                await acceptGroupInvite();
                return;
            }

            if (!pendingOffer) {
                return;
            }


            hideIncomingCallScreen();


            const {
                fromId,
                fromName,
                offer,
                callType
            } =
                pendingOffer;


            callPartnerId =
                fromId;


            if (!mediaDevicesAvailable()) {

                showNiceAlert(mediaErrorMessage(null), { title: "Camera & mic", icon: "fa-video" });

                socket.emit(
                    "call-reject",
                    {
                        toId:
                            fromId
                    }
                );

                pendingOffer =
                    null;

                return;

            }


            try {

                localStream =
                    await getCallAudioStream(
                        callType
                    );

            }

            catch (err) {

                showNiceAlert(mediaErrorMessage(err), { title: "Camera & mic", icon: "fa-video" });


                socket.emit(
                    "call-reject",
                    {
                        toId:
                            fromId
                    }
                );


                pendingOffer =
                    null;


                return;

            }


            currentCallType =
                callType;

            cameraTrack =
                callType === "video"
                    ? localStream.getVideoTracks()[0] || null
                    : null;


            showCallUI(
                callType,
                "Connecting...",
                avatarMarkup(fromName, getUserAvatar(fromId))
            );


            pc =
                createPeerConnection();


            localStream
                .getTracks()
                .forEach(
                    track =>
                        pc.addTrack(
                            track,
                            localStream
                        )
                );


            await pc.setRemoteDescription(
                new RTCSessionDescription(
                    offer
                )
            );

            // Now that pc exists and has the caller's SDP applied,
            // add back in any of the caller's ICE candidates that
            // arrived while we were still ringing (see
            // pendingIceCandidates above) - otherwise they're lost
            // for good and the connection can fail even though both
            // sides are actually reachable.
            await flushPendingIceCandidates();


            const answer =
                await pc.createAnswer();


            await pc.setLocalDescription(
                boostAudioQuality(answer)
            );


            socket.emit(
                "call-answer",
                {
                    toId:
                        fromId,
                    answer:
                        pc.localDescription
                }
            );

            // we just answered - both sides' audio tracks are
            // attached already, so treat the call as live and start
            // the clock right now instead of waiting on ICE (which
            // used to be the only thing that started the timer, and
            // could lag or briefly flicker through "Reconnecting..."
            // right as the call was picked up)
            if (callStatusText) {
                callStatusText.textContent = "Connected";
            }

            startCallTimer();

            // seed the multi-party call state so "Add participant"
            // works on an otherwise ordinary 1:1 call too
            activeCallId = genCallId("c");
            activeCallChatId = fromId;
            myParticipants = new Map([
                [me.id, { name: me.name }],
                [fromId, { name: fromName || "Caller" }]
            ]);


            pendingOffer =
                null;

        }
    );

}


// ============================================================
// DECLINE CALL
// ============================================================

if (declineCallBtn) {

    declineCallBtn.addEventListener(
        "click",
        () => {

            if (pendingGroupInvite) {

                socket.emit("call-add-decline", {
                    toId: pendingGroupInvite.fromId,
                    callId: pendingGroupInvite.callId
                });

                pendingGroupInvite = null;
                hideIncomingCallScreen();
                return;
            }

            if (!pendingOffer) {
                return;
            }


            socket.emit(
                "call-reject",
                {
                    toId:
                        pendingOffer.fromId
                }
            );


            hideIncomingCallScreen();


            pendingOffer =
                null;

        }
    );

}


// ============================================================
// CALL ANSWER
// ============================================================

socket.on(
    "call-answer",
    async ({
        answer
    }) => {

        if (!pc) {
            return;
        }

        // they picked up - the ringback stops the moment an answer
        // comes back, same as a real phone call
        stopRingtoneLoop();

        try {

            await pc.setRemoteDescription(
                new RTCSessionDescription(
                    answer
                )
            );

            await flushPendingIceCandidates();

            // The other side just answered - both ends already have
            // their audio tracks attached and are sending, so treat
            // the call as live right now rather than waiting on ICE
            // (which can lag a beat, or briefly dip through
            // "checking"/"disconnected" while it finishes negotiating
            // and used to show a false "Reconnecting..." right at the
            // moment the call was actually picked up). ICE reaching
            // "connected" below is still the source of truth for a
            // *real* reconnect later in the call - this just makes
            // sure the very first "someone answered" moment always
            // feels instant.
            if (callStatusText) {
                callStatusText.textContent = "Connected";
            }

            startCallTimer();

        }

        catch (err) {

            console.error(
                "Call answer error:",
                err
            );

        }

    }
);


// ============================================================
// ICE RESTART RENEGOTIATION (recovering a stuck call)
// ============================================================

socket.on(
    "call-renegotiate-offer",
    async ({ fromId, offer } = {}) => {

        if (!pc || !offer || fromId !== callPartnerId) return;

        try {

            await pc.setRemoteDescription(
                new RTCSessionDescription(offer)
            );

            await flushPendingIceCandidates();

            const answer =
                await pc.createAnswer();

            await pc.setLocalDescription(
                boostAudioQuality(answer)
            );

            socket.emit(
                "call-renegotiate-answer",
                {
                    toId: fromId,
                    answer: pc.localDescription
                }
            );

        } catch (err) {

            console.error("ICE restart (offer) error:", err);
            iceRestartInFlight = false;

        }

    }
);

socket.on(
    "call-renegotiate-answer",
    async ({ fromId, answer } = {}) => {

        if (!pc || !answer || fromId !== callPartnerId) return;

        try {

            await pc.setRemoteDescription(
                new RTCSessionDescription(answer)
            );

            await flushPendingIceCandidates();

        } catch (err) {

            console.error("ICE restart (answer) error:", err);
            iceRestartInFlight = false;

        }

    }
);


// ============================================================
// ICE CANDIDATE
// ============================================================

socket.on(
    "ice-candidate",
    async ({
        candidate
    }) => {

        if (!candidate) {

            return;

        }


        if (
            !pc ||
            !pc.remoteDescription ||
            !pc.remoteDescription.type
        ) {

            // No peer connection yet (callee hasn't hit Accept), or
            // we haven't applied the remote SDP yet - hold onto this
            // candidate instead of dropping it, and add it once we
            // catch up.
            pendingIceCandidates.push(
                candidate
            );

            return;

        }


        try {

            await pc.addIceCandidate(
                new RTCIceCandidate(
                    candidate
                )
            );

        }

        catch (err) {

            console.error(
                "ICE error:",
                err
            );

        }

    }
);


// ============================================================
// CALL REJECTED
// ============================================================

socket.on(
    "call-rejected",
    () => {

        // they declined - stop the ringback right away rather than
        // waiting for the cleanup safety net a moment later
        stopRingtoneLoop();

        if (callStatusText) {

            callStatusText.textContent =
                "Call declined";

        }


        setTimeout(
            endCallCleanup,
            1200
        );

    }
);


// ============================================================
// CALL ENDED
// ============================================================

socket.on(
    "call-ended",
    () => {

        endCallCleanup();

    }
);


// ============================================================
// CLOSE MENUS WHEN CLICKING OUTSIDE
// ============================================================

document.addEventListener(
    "click",
    (e) => {

        if (
            accountMenu &&
            accountBtn &&
            !accountMenu.contains(e.target) &&
            !accountBtn.contains(e.target)
        ) {

            accountMenu.classList.add(
                "hidden"
            );

        }

    }
);


// ============================================================
// HELPERS
// ============================================================

function escapeHtml(
    str
) {

    const div =
        document.createElement(
            "div"
        );


    div.textContent =
        String(str);


    return div.innerHTML;

}


// escapeHtml above doesn't escape quote characters (fine for text
// nodes, not safe inside an attribute like src="..."), so avatar
// URLs — which can come from other users over the network — get
// their own stricter escaper before going into an <img src="">.
function escapeAttr(
    str
) {

    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

}


// looks up a person's profile picture wherever we might have it cached -
// the live presence list first (freshest), then the saved friend profile
// (so it still works for someone who's currently offline)
function getUserAvatar(id) {

    if (!id) return null;

    return (
        (usersOnline[id] && usersOnline[id].avatar) ||
        (friendProfiles[id] && friendProfiles[id].avatar) ||
        null
    );
}

function getGroupAvatar(groupId) {

    if (!groupId) return null;

    const group = myGroups.get(groupId);

    return (group && group.icon) || null;
}

function avatarMarkup(
    name,
    avatarUrl
) {

    if (avatarUrl) {

        return `<img class="avatar-img" src="${escapeAttr(avatarUrl)}" alt="">`;

    }


    const initial =
        (name || "?")
            .charAt(0)
            .toUpperCase();


    return escapeHtml(
        initial
    );

}


function formatTime(
    ts
) {

    const d =
        new Date(ts);


    return d.toLocaleTimeString(
        [],
        {
            hour:
                "2-digit",

            minute:
                "2-digit"
        }
    );

}


// ============================================================
// SAFETY: FIND FRIEND STARTS COMPLETELY CLOSED
// ============================================================

function forceCloseFindFriend() {

    if (!findFriendPanel) return;


    findFriendPanel.classList.add(
        "hidden"
    );


    findFriendPanel.style.display =
        "none";

    findFriendPanel.style.visibility =
        "hidden";

    findFriendPanel.style.opacity =
        "0";

    findFriendPanel.style.pointerEvents =
        "none";

}


// Close immediately
forceCloseFindFriend();


// Close again after everything loads
window.addEventListener(
    "load",
    () => {

        forceCloseFindFriend();

    }
);

// ============================================================
// ============================================================
//  NEW FEATURE WIRING (Status, Channels, Communities, Calls tab,
//  chat lock / secret code / wallpaper, polls, share contact,
//  archived chats, in-chat search, message context menu,
//  attach menu, export/clear chat)
//
//  These sections wire up markup that was added to nodi.html.
//  Anything that needs the server (statuses, channels,
//  communities, polls, shared contacts) emits a socket event
//  and listens for a matching one - the server-side handlers
//  for those are the next pass. Everything else (locks, mute,
//  wallpaper, archive, search, export) works fully client-side.
// ============================================================
// ============================================================

function $id(id) { return document.getElementById(id); }

function openModal(el) { if (el) el.classList.remove("hidden"); }
function closeModal(el) { if (el) el.classList.add("hidden"); }

// clicking the dimmed backdrop of any .modal-overlay closes it
document.addEventListener("click", (e) => {
    if (e.target && e.target.classList && e.target.classList.contains("modal-overlay")) {
        e.target.classList.add("hidden");
    }
});


// ============================================================
// SIDEBAR NAV TABS (Chats / Status / Calls)
// ============================================================

(function wireSidebarNavTabs() {

    const tabs = document.querySelectorAll("#sidebarNavTabs .sidebar-nav-tab");
    const views = {
        chats: $id("chatsView"),
        status: $id("statusView"),
        calls: $id("callsView")
    };

    if (!tabs.length) return;

    tabs.forEach(tab => {
        tab.addEventListener("click", () => {

            const view = tab.dataset.sidebarView;
            if (!view || !views[view]) return;

            tabs.forEach(t => t.classList.toggle("active", t === tab));

            Object.keys(views).forEach(key => {
                if (views[key]) views[key].classList.toggle("hidden", key !== view);
            });

            if (view === "status") {
                const dot = $id("statusUnreadDot");
                if (dot) dot.classList.add("hidden");
                requestStatuses();
            }

            if (view === "calls") {
                renderCallHistory();
            }

        });
    });

})();


// ============================================================
// ARCHIVED CHATS
// ============================================================

function getArchivedChats() {
    try {
        return JSON.parse(localStorage.getItem("siteChatArchived") || "[]");
    } catch (e) {
        return [];
    }
}

function saveArchivedChats(list) {
    localStorage.setItem("siteChatArchived", JSON.stringify(list));
}

function isChatArchived(id) {
    return getArchivedChats().includes(id);
}

function setChatArchived(id, archived) {
    const list = getArchivedChats();
    const idx = list.indexOf(id);
    if (archived && idx === -1) list.push(id);
    if (!archived && idx !== -1) list.splice(idx, 1);
    saveArchivedChats(list);
    renderArchivedChatsList();
}

function renderArchivedChatsList() {

    const toggle = $id("archivedChatsToggle");
    const listEl = $id("archivedChatsList");
    const countEl = $id("archivedCount");

    const archived = getArchivedChats();

    if (toggle) toggle.classList.toggle("hidden", archived.length === 0);
    if (countEl) countEl.textContent = String(archived.length);

    if (!listEl) return;

    if (!archived.length) {
        listEl.innerHTML = "";
        return;
    }

    listEl.innerHTML = archived.map(id => {

        const group = myGroups.get(id);
        const profile = friendProfiles[id];
        const name = group ? group.name : (profile ? profile.name : (usersOnline[id] ? usersOnline[id].name : "Chat"));

        return `
            <div class="friend-item archived-chat-item" data-id="${id}">
                <span class="find-text"><strong>${escapeHtml(name || "Chat")}</strong></span>
                <button class="unarchive-btn" data-id="${id}" title="Unarchive"><i class="fa-solid fa-box-open"></i></button>
            </div>
        `;

    }).join("");

    listEl.querySelectorAll(".archived-chat-item").forEach(item => {
        item.addEventListener("click", (e) => {
            if (e.target.closest(".unarchive-btn")) return;
            const id = item.dataset.id;
            const group = myGroups.get(id);
            openChat(id, group ? group.name : ((friendProfiles[id] && friendProfiles[id].name) || (usersOnline[id] && usersOnline[id].name) || "Chat"), group);
        });
    });

    listEl.querySelectorAll(".unarchive-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            setChatArchived(btn.dataset.id, false);
        });
    });

}

if ($id("archivedChatsToggle")) {
    $id("archivedChatsToggle").addEventListener("click", () => {
        const listEl = $id("archivedChatsList");
        if (listEl) listEl.classList.toggle("hidden");
    });
}

renderArchivedChatsList();


// ============================================================
// CHAT LOCK (PIN-protected chats) + SECRET CODE
// ============================================================

function getLockedChats() {
    try {
        return JSON.parse(localStorage.getItem("siteChatLockedChats") || "[]");
    } catch (e) {
        return [];
    }
}

function saveLockedChats(list) {
    localStorage.setItem("siteChatLockedChats", JSON.stringify(list));
}

function isChatLocked(id) {
    return getLockedChats().includes(id);
}

function getChatLockPin() {
    return localStorage.getItem("siteChatLockPin") || "";
}

function getSecretCode() {
    return localStorage.getItem("siteChatSecretCode") || "";
}

let chatLockModalMode = "set"; // "set" | "unlock-folder"

function openChatLockModal(mode) {

    chatLockModalMode = mode;

    const modal = $id("chatLockModal");
    const title = $id("chatLockModalTitle");
    const text = $id("chatLockModalText");
    const pinInput = $id("chatLockPinInput");
    const err = $id("chatLockError");

    if (!modal) return;

    if (pinInput) pinInput.value = "";
    if (err) err.classList.add("hidden");

    const hasPin = !!getChatLockPin();

    if (mode === "set") {
        if (title) title.textContent = activeChat && isChatLocked(activeChat.id) ? "Unlock this chat" : "Lock this chat";
        if (text) text.textContent = hasPin
            ? "Enter your PIN to continue."
            : "Create a PIN. Locked chats move to a separate folder that only opens with this PIN.";
    } else {
        if (title) title.textContent = "Locked Chats";
        if (text) text.textContent = "Enter your PIN or secret code to view locked chats.";
    }

    openModal(modal);
    if (pinInput) pinInput.focus();

}

function submitChatLockPin() {

    const pinInput = $id("chatLockPinInput");
    const err = $id("chatLockError");
    const pin = pinInput ? pinInput.value.trim() : "";

    if (!pin) return;

    const storedPin = getChatLockPin();

    if (!storedPin) {
        // first time - this PIN becomes the lock PIN
        localStorage.setItem("siteChatLockPin", pin);
        finishChatLockAction();
        return;
    }

    if (pin === storedPin || (chatLockModalMode === "unlock-folder" && pin === getSecretCode() && getSecretCode())) {
        finishChatLockAction();
        return;
    }

    if (err) err.classList.remove("hidden");

}

function finishChatLockAction() {

    closeModal($id("chatLockModal"));

    if (chatLockModalMode === "set" && activeChat) {

        const locked = getLockedChats();
        const idx = locked.indexOf(activeChat.id);

        if (idx === -1) {
            locked.push(activeChat.id);
        } else {
            locked.splice(idx, 1);
        }

        saveLockedChats(locked);
        renderLockedChatsFolder();

    } else if (chatLockModalMode === "unlock-folder") {

        renderLockedChatsFolder(true);

    }

}

function renderLockedChatsFolder(revealed) {

    const toggle = $id("lockedChatsToggle");
    const locked = getLockedChats();

    if (toggle) toggle.classList.toggle("hidden", locked.length === 0);

    if (!toggle) return;

    toggle.onclick = () => {

        if (!revealed) {
            openChatLockModal("unlock-folder");
            return;
        }

        const names = locked.map(id => {
            const group = myGroups.get(id);
            return (group && group.name) || (friendProfiles[id] && friendProfiles[id].name) || (usersOnline[id] && usersOnline[id].name) || "Chat";
        });

        showNiceAlert(names.length ? `Locked chats: ${names.join(", ")}` : "No locked chats yet.", { title: "Locked Chats", icon: "fa-lock" });

    };

}

if ($id("closeChatLockModal")) $id("closeChatLockModal").addEventListener("click", () => closeModal($id("chatLockModal")));
if ($id("chatLockSubmitBtn")) $id("chatLockSubmitBtn").addEventListener("click", submitChatLockPin);
if ($id("chatLockPinInput")) $id("chatLockPinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitChatLockPin(); });

if ($id("chatLockOption")) {
    $id("chatLockOption").addEventListener("click", () => {
        closeModal($id("disappearingMenu"));
        if (!activeChat) return;
        openChatLockModal("set");
    });
}

// Secret code modal (lets the user set an alternate unlock code for
// the Locked Chats folder, opened from Privacy & security)
if ($id("closeSecretCodeModal")) $id("closeSecretCodeModal").addEventListener("click", () => closeModal($id("secretCodeModal")));

if ($id("saveSecretCodeBtn")) {
    $id("saveSecretCodeBtn").addEventListener("click", () => {

        const code = $id("secretCodeInput") ? $id("secretCodeInput").value.trim() : "";
        const confirm = $id("secretCodeConfirmInput") ? $id("secretCodeConfirmInput").value.trim() : "";

        if (!code || code.length < 4) {
            showNiceAlert("Secret code must be at least 4 characters.", { title: "Try again" });
            return;
        }

        if (code !== confirm) {
            showNiceAlert("Codes don't match.", { title: "Try again" });
            return;
        }

        localStorage.setItem("siteChatSecretCode", code);

        if ($id("secretCodeReplacePinToggle") && $id("secretCodeReplacePinToggle").checked) {
            localStorage.setItem("siteChatLockPin", code);
        }

        closeModal($id("secretCodeModal"));
        showNiceAlert("Secret code saved.", { title: "Done", icon: "fa-circle-check" });

    });
}

function openSecretCodeModal() {
    const modal = $id("secretCodeModal");
    if ($id("secretCodeInput")) $id("secretCodeInput").value = "";
    if ($id("secretCodeConfirmInput")) $id("secretCodeConfirmInput").value = "";
    openModal(modal);
}

renderLockedChatsFolder();


// ============================================================
// CHAT WALLPAPER
// ============================================================

function getChatWallpaper(id) {
    try {
        return JSON.parse(localStorage.getItem("siteChatWallpapers") || "{}")[id] || "default";
    } catch (e) {
        return "default";
    }
}

function setChatWallpaper(id, wallpaper) {
    let map = {};
    try { map = JSON.parse(localStorage.getItem("siteChatWallpapers") || "{}"); } catch (e) {}
    map[id] = wallpaper;
    localStorage.setItem("siteChatWallpapers", JSON.stringify(map));
    applyChatWallpaper();
}

function applyChatWallpaper() {

    const messagesEl = $id("messages");
    if (!messagesEl || !activeChat) return;

    messagesEl.className = messagesEl.className.replace(/\bwallpaper-\S+/g, "").trim();
    if (!messagesEl.classList.contains("messages")) messagesEl.classList.add("messages");

    const wp = getChatWallpaper(activeChat.id);

    if (isCustomWallpaperValue(wp)) {
        messagesEl.classList.add("wallpaper-custom");
        messagesEl.style.backgroundImage = `url("${wp}")`;
    } else {
        messagesEl.style.backgroundImage = "";
        if (wp && wp !== "default") messagesEl.classList.add(`wallpaper-${wp}`);
    }

}

// a custom uploaded wallpaper is stored as its /upload URL rather
// than one of the fixed preset names ("slate", "forest", etc.)
function isCustomWallpaperValue(wp) {
    return !!wp && /^(https?:|\/|data:image)/.test(wp);
}

if ($id("closeChatWallpaperModal")) $id("closeChatWallpaperModal").addEventListener("click", () => closeModal($id("chatWallpaperModal")));

if ($id("chatWallpaperOption")) {
    $id("chatWallpaperOption").addEventListener("click", () => {

        closeModal($id("disappearingMenu"));
        if (!activeChat) return;

        const grid = $id("wallpaperSwatchGrid");
        const current = getChatWallpaper(activeChat.id);

        if (grid) {
            grid.querySelectorAll(".wallpaper-swatch").forEach(sw => {
                sw.classList.toggle("selected", !isCustomWallpaperValue(current) && sw.dataset.wallpaper === current);
            });
        }

        openModal($id("chatWallpaperModal"));

    });
}

(function wireWallpaperGrid() {
    const grid = $id("wallpaperSwatchGrid");
    if (!grid) return;
    grid.addEventListener("click", (e) => {
        const swatch = e.target.closest(".wallpaper-swatch");
        if (!swatch || !activeChat) return;
        grid.querySelectorAll(".wallpaper-swatch").forEach(sw => sw.classList.remove("selected"));
        swatch.classList.add("selected");
        setChatWallpaper(activeChat.id, swatch.dataset.wallpaper);
    });
})();

if ($id("wallpaperUploadBtn") && $id("wallpaperUploadInput")) {
    $id("wallpaperUploadBtn").addEventListener("click", () => $id("wallpaperUploadInput").click());
}

if ($id("wallpaperUploadInput")) {
    $id("wallpaperUploadInput").addEventListener("change", async () => {

        const input = $id("wallpaperUploadInput");
        const file = input.files && input.files[0];
        if (!file || !activeChat) return;

        if (!file.type.startsWith("image/")) {
            showNiceAlert("Please choose an image file for your wallpaper.", { title: "Wallpaper", icon: "fa-image" });
            input.value = "";
            return;
        }

        const formData = new FormData();
        formData.append("file", file);

        try {
            const res = await fetch("/upload", { method: "POST", body: formData });
            const data = await res.json();

            if (!data || !data.url) {
                showNiceAlert("Couldn't upload that image. Please try a different file.", { title: "Upload failed", icon: "fa-image" });
                return;
            }

            setChatWallpaper(activeChat.id, data.url);

            const grid = $id("wallpaperSwatchGrid");
            if (grid) grid.querySelectorAll(".wallpaper-swatch").forEach(sw => sw.classList.remove("selected"));

        } catch (err) {
            showNiceAlert("Couldn't upload that image right now.", { title: "Upload failed", icon: "fa-image" });
        } finally {
            input.value = "";
        }
    });
}

if ($id("resetWallpaperBtn")) {
    $id("resetWallpaperBtn").addEventListener("click", () => {
        if (!activeChat) return;
        setChatWallpaper(activeChat.id, "default");
        const grid = $id("wallpaperSwatchGrid");
        if (grid) {
            grid.querySelectorAll(".wallpaper-swatch").forEach(sw => sw.classList.toggle("selected", sw.dataset.wallpaper === "default"));
        }
    });
}


// ============================================================
// CHAT MUTE
// ============================================================

function getMutedChats() {
    try {
        return JSON.parse(localStorage.getItem("siteChatMuted") || "[]");
    } catch (e) {
        return [];
    }
}

function isChatMuted(id) {
    return getMutedChats().includes(id);
}

function toggleChatMuted(id) {
    const list = getMutedChats();
    const idx = list.indexOf(id);
    if (idx === -1) list.push(id); else list.splice(idx, 1);
    localStorage.setItem("siteChatMuted", JSON.stringify(list));
    return idx === -1;
}

if ($id("muteChatOption")) {
    $id("muteChatOption").addEventListener("click", () => {
        closeModal($id("disappearingMenu"));
        if (!activeChat) return;
        const nowMuted = toggleChatMuted(activeChat.id);
        const label = $id("muteChatOption").querySelector("span");
        if (label) label.innerHTML = nowMuted
            ? '<i class="fa-solid fa-bell"></i> Unmute notifications'
            : '<i class="fa-solid fa-bell-slash"></i> Mute notifications';
    });
}


// ============================================================
// VIEW CONTACT / ADVANCED PRIVACY / BLOCK (chat more-options)
// ============================================================

if ($id("viewContactOption")) {
    $id("viewContactOption").addEventListener("click", () => {
        closeModal($id("disappearingMenu"));
        if (!activeChat) return;
        if (activeChat.isGroup) {
            if (typeof openGroupInfoModal === "function") openGroupInfoModal();
        } else {
            showNiceAlert(activeChat.name, { title: "Contact", icon: "fa-user" });
        }
    });
}

if ($id("advancedPrivacyOption")) {
    $id("advancedPrivacyOption").addEventListener("click", () => {
        closeModal($id("disappearingMenu"));
        showNiceAlert("Advanced chat privacy settings for this chat.", { title: "Advanced privacy", icon: "fa-shield-halved" });
    });
}

if ($id("blockContactOption")) {
    $id("blockContactOption").addEventListener("click", () => {
        closeModal($id("disappearingMenu"));
        if (!activeChat || activeChat.isGroup) return;
        if (typeof handleFriendAction === "function") {
            handleFriendAction(activeChat.id, "block");
        } else {
            socket.emit("block-user", { userId: activeChat.id });
        }
    });
}


// ============================================================
// EXPORT CHAT / CLEAR CHAT / ARCHIVE CHAT
// ============================================================

if ($id("exportChatOption")) {
    $id("exportChatOption").addEventListener("click", () => {
        closeModal($id("disappearingMenu"));
        if (!activeChat) return;
        openModal($id("exportChatModal"));
    });
}
if ($id("closeExportChatModal")) $id("closeExportChatModal").addEventListener("click", () => closeModal($id("exportChatModal")));

if ($id("exportChatConfirmBtn")) {
    $id("exportChatConfirmBtn").addEventListener("click", () => {

        if (!activeChat) return;

        const msgs = conversations[activeChat.id] || [];
        const includeMedia = $id("exportIncludeMediaToggle") ? $id("exportIncludeMediaToggle").checked : true;

        const lines = msgs.map(m => {
            const who = (m.from && m.from.id) === (me && me.id) ? "You" : (m.from && m.from.name) || "Them";
            const when = m.time ? new Date(m.time).toLocaleString() : "";
            const body = m.text || (m.attachment ? (includeMedia ? `[attachment: ${m.attachment.name || m.attachment.kind || "file"}${m.attachment.url ? " - " + m.attachment.url : ""}]` : "[attachment omitted]") : "");
            return `[${when}] ${who}: ${body}`;
        });

        const blob = new Blob([lines.join("\n")], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chat-with-${(activeChat.name || "chat").replace(/\s+/g, "_")}.txt`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        closeModal($id("exportChatModal"));

    });
}

if ($id("archiveChatOption")) {
    $id("archiveChatOption").addEventListener("click", () => {
        closeModal($id("disappearingMenu"));
        if (!activeChat) return;
        setChatArchived(activeChat.id, !isChatArchived(activeChat.id));
    });
}

if ($id("closeClearChatModal")) $id("closeClearChatModal").addEventListener("click", () => closeModal($id("clearChatModal")));

if ($id("clearChatOption")) {
    $id("clearChatOption").addEventListener("click", () => {
        closeModal($id("disappearingMenu"));
        if (!activeChat) return;
        openModal($id("clearChatModal"));
    });
}

if ($id("clearChatConfirmBtn")) {
    $id("clearChatConfirmBtn").addEventListener("click", () => {

        if (!activeChat) return;

        const deleteStarred = $id("clearChatDeleteStarredToggle") ? $id("clearChatDeleteStarredToggle").checked : false;

        conversations[activeChat.id] = deleteStarred
            ? []
            : (conversations[activeChat.id] || []).filter(m => m.starred);

        if (typeof renderMessages === "function") renderMessages();

        socket.emit("clear-chat", { chatId: activeChat.id, deleteStarred });

        closeModal($id("clearChatModal"));

    });
}


// ============================================================
// SEARCH IN CHAT
// ============================================================

let chatSearchMatches = [];
let chatSearchIndex = -1;

function openChatSearchBar() {
    const bar = $id("chatSearchBar");
    if (!bar || !activeChat) return;
    bar.classList.remove("hidden");
    if ($id("chatSearchBarInput")) {
        $id("chatSearchBarInput").value = "";
        $id("chatSearchBarInput").focus();
    }
    chatSearchMatches = [];
    chatSearchIndex = -1;
    updateChatSearchCount();
}

function closeChatSearchBar() {
    closeModal(null);
    const bar = $id("chatSearchBar");
    if (bar) bar.classList.add("hidden");
    document.querySelectorAll(".msg-search-highlight").forEach(el => el.classList.remove("msg-search-highlight"));
}

function updateChatSearchCount() {
    const countEl = $id("chatSearchMatchCount");
    if (!countEl) return;
    countEl.textContent = chatSearchMatches.length
        ? `${chatSearchIndex + 1}/${chatSearchMatches.length}`
        : "0/0";
}

function runChatSearch(query) {

    document.querySelectorAll(".msg-search-highlight").forEach(el => el.classList.remove("msg-search-highlight"));

    chatSearchMatches = [];
    chatSearchIndex = -1;

    if (!query || !query.trim()) {
        updateChatSearchCount();
        return;
    }

    const q = query.trim().toLowerCase();
    const bubbles = document.querySelectorAll("#messages .message, #messages .msg-bubble, #messages [data-msg-id]");

    bubbles.forEach(el => {
        if (el.textContent && el.textContent.toLowerCase().includes(q)) {
            chatSearchMatches.push(el);
        }
    });

    updateChatSearchCount();

    if (chatSearchMatches.length) jumpToChatSearchMatch(0);

}

function jumpToChatSearchMatch(index) {

    if (!chatSearchMatches.length) return;

    chatSearchIndex = (index + chatSearchMatches.length) % chatSearchMatches.length;

    document.querySelectorAll(".msg-search-highlight").forEach(el => el.classList.remove("msg-search-highlight"));

    const el = chatSearchMatches[chatSearchIndex];
    if (el) {
        el.classList.add("msg-search-highlight");
        el.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    updateChatSearchCount();

}

if ($id("searchInChatBtn")) $id("searchInChatBtn").addEventListener("click", openChatSearchBar);
if ($id("chatSearchCloseBtn")) $id("chatSearchCloseBtn").addEventListener("click", closeChatSearchBar);
if ($id("chatSearchBarInput")) $id("chatSearchBarInput").addEventListener("input", (e) => runChatSearch(e.target.value));
if ($id("chatSearchNextBtn")) $id("chatSearchNextBtn").addEventListener("click", () => jumpToChatSearchMatch(chatSearchIndex + 1));
if ($id("chatSearchPrevBtn")) $id("chatSearchPrevBtn").addEventListener("click", () => jumpToChatSearchMatch(chatSearchIndex - 1));


// ============================================================
// MESSAGE CONTEXT MENU (right-click / long-press on a message)
// ============================================================

(function wireMsgContextMenu() {

    const menu = $id("msgContextMenu");
    if (!menu) return;

    function itemsFor(msgEl) {

        const msgId = findMsgId(msgEl);
        const found = activeChat && msgId && findMessageInConversation(activeChat.id, msgId);

        const items = [
            { icon: "fa-reply", label: "Reply", action: "reply" },
            { icon: "fa-share", label: "Forward", action: "forward" },
            { icon: "fa-star", label: (found && found.starred) ? "Unstar" : "Star", action: "star" },
            { icon: "fa-copy", label: "Copy", action: "copy" },
            { icon: "fa-thumbtack", label: "Pin", action: "pin" },
            { icon: "fa-trash", label: "Delete", action: "delete", danger: true }
        ];

        return items.map(it =>
            `<button class="msg-context-menu-item${it.danger ? " danger" : ""}" data-action="${it.action}">
                <i class="fa-solid ${it.icon}"></i> ${it.label}
            </button>`
        ).join("");

    }

    function findMsgId(el) {
        const target = el.closest("[data-msg-id]") || el.closest(".message") || el.closest(".msg-bubble");
        return target ? (target.dataset.msgId || target.id) : null;
    }

    function showMenuAt(x, y, msgEl) {
        menu.innerHTML = itemsFor(msgEl);
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.dataset.forMsg = findMsgId(msgEl) || "";
        menu.classList.remove("hidden");
    }

    const messagesEl = $id("messages");
    if (messagesEl) {

        messagesEl.addEventListener("contextmenu", (e) => {
            const bubble = e.target.closest(".message, .msg-bubble, [data-msg-id]");
            if (!bubble) return;
            e.preventDefault();
            showMenuAt(e.clientX, e.clientY, bubble);
        });

        let pressTimer = null;
        messagesEl.addEventListener("touchstart", (e) => {
            const bubble = e.target.closest(".message, .msg-bubble, [data-msg-id]");
            if (!bubble) return;
            const touch = e.touches[0];
            pressTimer = setTimeout(() => showMenuAt(touch.clientX, touch.clientY, bubble), 500);
        });
        messagesEl.addEventListener("touchend", () => clearTimeout(pressTimer));
        messagesEl.addEventListener("touchmove", () => clearTimeout(pressTimer));

    }

    menu.addEventListener("click", (e) => {

        const btn = e.target.closest(".msg-context-menu-item");
        if (!btn) return;

        const msgId = menu.dataset.forMsg;
        const action = btn.dataset.action;

        if (action === "star") {

            const found = activeChat && findMessageInConversation(activeChat.id, msgId);

            if (found) {
                toggleStarMessage(found, activeChat.id);
            }

            menu.classList.add("hidden");
            return;

        }

        socket.emit("message-context-action", { action, msgId, chatId: activeChat && activeChat.id });

        if (action === "copy") {
            const el = document.querySelector(`[data-msg-id="${msgId}"]`) || document.getElementById(msgId);
            if (el) navigator.clipboard && navigator.clipboard.writeText(el.textContent.trim());
        }

        menu.classList.add("hidden");

    });

    document.addEventListener("click", (e) => {
        if (!menu.contains(e.target)) menu.classList.add("hidden");
    });

})();


// ============================================================
// ATTACH MENU (Document / Photos & Videos / Camera / Contact /
// Poll / Location)
// ============================================================

(function wireAttachMenu() {

    const menu = $id("attachMenu");
    const btn = attachBtn;

    if (!menu || !btn) return;

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!activeChat) return;
        const opening = menu.classList.contains("hidden");
        menu.classList.toggle("hidden", !opening);
        btn.setAttribute("aria-expanded", String(opening));
    });

    document.addEventListener("click", (e) => {
        if (!menu.contains(e.target) && e.target !== btn) {
            menu.classList.add("hidden");
            btn.setAttribute("aria-expanded", "false");
        }
    });

    function pickFile(accept, forcedKind, capture) {
        if (!fileInput) return;
        fileInput.accept = accept;
        pendingForcedKind = forcedKind || null;
        if (capture) fileInput.setAttribute("capture", capture); else fileInput.removeAttribute("capture");
        fileInput.click();
        menu.classList.add("hidden");
    }

    if ($id("attachDocumentOption")) $id("attachDocumentOption").addEventListener("click", () => pickFile("*/*", "document"));
    if ($id("attachGalleryOption")) $id("attachGalleryOption").addEventListener("click", () => pickFile("image/*,video/*", null));
    if ($id("attachCameraOption")) $id("attachCameraOption").addEventListener("click", () => pickFile("image/*", "image", "environment"));

    if ($id("attachContactOption")) {
        $id("attachContactOption").addEventListener("click", () => {
            menu.classList.add("hidden");
            openShareContactModal();
        });
    }

    if ($id("attachPollOption")) {
        $id("attachPollOption").addEventListener("click", () => {
            menu.classList.add("hidden");
            openCreatePollModal();
        });
    }

    if ($id("attachLocationOption")) {
        $id("attachLocationOption").addEventListener("click", () => {

            menu.classList.add("hidden");
            if (!activeChat) return;

            if (!navigator.geolocation) {
                showNiceAlert("Location isn't available on this device.", { title: "Can't share location" });
                return;
            }

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    socket.emit("chat-message", {
                        toId: activeChat.id,
                        attachment: {
                            kind: "location",
                            lat: pos.coords.latitude,
                            lng: pos.coords.longitude
                        }
                    });
                },
                () => showNiceAlert("Couldn't get your location.", { title: "Location unavailable" })
            );

        });
    }

})();


// ============================================================
// SHARE CONTACT
// ============================================================

function openShareContactModal() {

    const modal = $id("shareContactModal");
    if (!modal) return;

    renderShareContactList("");
    if ($id("shareContactSearchInput")) $id("shareContactSearchInput").value = "";

    openModal(modal);

}

let selectedShareContactId = null;

function renderShareContactList(query) {

    const listEl = $id("shareContactList");
    if (!listEl) return;

    const q = (query || "").toLowerCase();

    const friends = Object.keys(friendProfiles)
        .map(id => ({ id, name: friendProfiles[id].name || "Friend" }))
        .filter(f => f.name.toLowerCase().includes(q));

    listEl.innerHTML = friends.length
        ? friends.map(f => `
            <label class="modal-picker-item">
                <input type="radio" name="shareContactPick" data-id="${f.id}">
                ${escapeHtml(f.name)}
            </label>
        `).join("")
        : '<div class="add-participant-empty">No friends to share yet.</div>';

    listEl.querySelectorAll("input[type=radio]").forEach(radio => {
        radio.addEventListener("change", () => { selectedShareContactId = radio.dataset.id; });
    });

}

if ($id("shareContactSearchInput")) {
    $id("shareContactSearchInput").addEventListener("input", (e) => renderShareContactList(e.target.value));
}

if ($id("closeShareContactModal")) $id("closeShareContactModal").addEventListener("click", () => closeModal($id("shareContactModal")));

if ($id("sendContactBtn")) {
    $id("sendContactBtn").addEventListener("click", () => {

        if (!activeChat || !selectedShareContactId) {
            showNiceAlert("Pick a contact to share first.", { title: "No contact selected" });
            return;
        }

        const profile = friendProfiles[selectedShareContactId];

        socket.emit("chat-message", {
            toId: activeChat.id,
            attachment: {
                kind: "contact",
                contactId: selectedShareContactId,
                name: (profile && profile.name) || "Contact"
            }
        });

        closeModal($id("shareContactModal"));

    });
}


// ============================================================
// POLLS
// ============================================================

function openCreatePollModal() {

    const modal = $id("createPollModal");
    if (!modal) return;

    if ($id("pollQuestionInput")) $id("pollQuestionInput").value = "";
    if ($id("pollMultiAnswerToggle")) $id("pollMultiAnswerToggle").checked = false;

    const list = $id("pollOptionsList");
    if (list) {
        list.innerHTML = `
            <div class="poll-option-row"><input class="modal-text-input poll-option-input" type="text" maxlength="80" placeholder="Option 1"></div>
            <div class="poll-option-row"><input class="modal-text-input poll-option-input" type="text" maxlength="80" placeholder="Option 2"></div>
        `;
    }

    openModal(modal);

}

if ($id("closeCreatePollModal")) $id("closeCreatePollModal").addEventListener("click", () => closeModal($id("createPollModal")));

if ($id("addPollOptionBtn")) {
    $id("addPollOptionBtn").addEventListener("click", () => {
        const list = $id("pollOptionsList");
        if (!list) return;
        const count = list.querySelectorAll(".poll-option-row").length + 1;
        if (count > 12) return;
        const row = document.createElement("div");
        row.className = "poll-option-row";
        row.innerHTML = `<input class="modal-text-input poll-option-input" type="text" maxlength="80" placeholder="Option ${count}">`;
        list.appendChild(row);
    });
}

if ($id("createPollBtn")) {
    $id("createPollBtn").addEventListener("click", () => {

        if (!activeChat) return;

        const question = $id("pollQuestionInput") ? $id("pollQuestionInput").value.trim() : "";
        const options = Array.from(document.querySelectorAll("#pollOptionsList .poll-option-input"))
            .map(inp => inp.value.trim())
            .filter(Boolean);

        if (!question || options.length < 2) {
            showNiceAlert("Add a question and at least two options.", { title: "Poll incomplete" });
            return;
        }

        socket.emit("chat-message", {
            toId: activeChat.id,
            attachment: {
                kind: "poll",
                question,
                options,
                allowMultiple: $id("pollMultiAnswerToggle") ? $id("pollMultiAnswerToggle").checked : false
            }
        });

        closeModal($id("createPollModal"));

    });
}


// ============================================================
// STATUS / STORIES
// ============================================================

let myStatusColor = "green";
let statusMediaFile = null;

function requestStatuses() {
    socket.emit("get-statuses");
}

// keeps the status list accurate as updates hit their 24h expiry
// without needing to reopen the app
setInterval(requestStatuses, 60000);

function statusPreviewLine(update) {
    if (!update) return "";
    if (update.kind === "media") {
        const isVideo = update.url && /\.(mp4|webm|mov)$/i.test(update.url);
        const label = isVideo ? "Video" : "Photo";
        return update.caption ? `${label} · ${update.caption}` : label;
    }
    return update.text || "";
}

function renderStatusList(statuses) {

    const listEl = $id("statusList");
    const emptyEl = $id("noStatusUpdates");
    if (!listEl) return;

    if (!statuses || !statuses.length) {
        if (emptyEl) emptyEl.classList.remove("hidden");
        listEl.querySelectorAll(".status-item").forEach(el => el.remove());
        return;
    }

    if (emptyEl) emptyEl.classList.add("hidden");

    listEl.querySelectorAll(".status-item").forEach(el => el.remove());

    statuses.forEach((group, idx) => {
        const item = document.createElement("button");

        const updates = group.updates || [];
        const latest = updates[updates.length - 1];
        const isMine = me && group.id === me.id;
        const allSeen = isMine || updates.every(u => (u.viewers || []).some(v => v.id === (me && me.id)));

        item.className = `find-friend-btn status-item status-ring-${allSeen ? "seen" : "unseen"}`;

        const mediaThumb = latest && latest.kind === "media" && latest.url
            ? `<img class="status-item-thumb" src="${escapeAttr(latest.url)}" alt="">`
            : avatarMarkup(group.name, group.avatar);

        item.innerHTML = `
            <span class="find-icon status-item-ring"><span class="avatar-inner">${mediaThumb}</span></span>
            <span class="find-text">
                <strong>${escapeHtml(group.name || "Someone")}</strong>
                <small>${escapeHtml(statusPreviewLine(latest)) || `${updates.length} update(s)`}</small>
            </span>
        `;
        item.addEventListener("click", () => openStatusViewer(statuses, idx));
        listEl.appendChild(item);
    });

}

socket.on("statuses", (statuses) => {
    renderStatusList(statuses);
    refreshOpenStatusViewer(statuses);
});

socket.on("status-posted", () => requestStatuses());

// If the full-screen viewer is open when a "statuses" refresh comes in
// (e.g. someone else viewed/liked what we're looking at, or our own
// like/view just got acknowledged), swap in the fresh data and update
// the like/view counters live, without restarting the slide/timer.
function refreshOpenStatusViewer(statuses) {

    const overlay = $id("statusViewerOverlay");
    if (!overlay || overlay.classList.contains("hidden")) return;

    const group = currentStatusGroup();
    const update = currentStatusUpdate();
    if (!group || !update) return;

    const freshGroup = (statuses || []).find(g => g.id === group.id);
    const freshUpdate = freshGroup && freshGroup.updates.find(u => u.id === update.id);
    if (!freshGroup || !freshUpdate) return;

    statusViewerGroups = statuses;
    statusViewerGroupIdx = statuses.indexOf(freshGroup);

    const viewCountWrap = $id("statusViewCountWrap");
    const isMine = me && freshGroup.id === me.id;
    if (viewCountWrap) viewCountWrap.classList.toggle("hidden", !isMine);
    if (isMine && $id("statusViewCount")) $id("statusViewCount").textContent = String((freshUpdate.viewers || []).length);

    const likeBtn = $id("statusViewerLikeBtn");
    if (likeBtn) {
        const iLiked = !isMine && me && (freshUpdate.likes || []).some(l => l.id === me.id);
        const icon = likeBtn.querySelector("i");
        likeBtn.classList.toggle("liked", !!iLiked);
        if (icon) {
            icon.classList.toggle("fa-regular", !iLiked);
            icon.classList.toggle("fa-solid", !!iLiked);
        }
    }
}

if ($id("addStatusBtn")) $id("addStatusBtn").addEventListener("click", openCreateStatusModal);

function openCreateStatusModal() {

    const modal = $id("createStatusModal");
    if (!modal) return;

    if ($id("statusTextInput")) $id("statusTextInput").value = "";
    if ($id("statusCaptionInput")) $id("statusCaptionInput").value = "";
    statusMediaFile = null;

    const preview = $id("statusMediaPreview");
    if (preview) { preview.innerHTML = ""; preview.classList.add("hidden"); }

    openModal(modal);

}

if ($id("closeCreateStatusModal")) $id("closeCreateStatusModal").addEventListener("click", () => closeModal($id("createStatusModal")));

(function wireStatusComposeTabs() {

    const tabs = document.querySelectorAll(".status-compose-tab");
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.toggle("active", t === tab));
            const which = tab.dataset.statusTab;
            if ($id("statusTextTabContent")) $id("statusTextTabContent").classList.toggle("hidden", which !== "text");
            if ($id("statusMediaTabContent")) $id("statusMediaTabContent").classList.toggle("hidden", which !== "media");
        });
    });

})();

(function wireStatusColorSwatches() {

    const grid = $id("statusColorSwatchGrid");
    if (!grid) return;

    grid.addEventListener("click", (e) => {
        const sw = e.target.closest(".status-color-swatch");
        if (!sw) return;
        grid.querySelectorAll(".status-color-swatch").forEach(s => s.classList.remove("selected"));
        sw.classList.add("selected");
        myStatusColor = sw.dataset.statusColor;
    });

})();

if ($id("statusMediaPickBtn") && $id("statusMediaInput")) {
    $id("statusMediaPickBtn").addEventListener("click", () => $id("statusMediaInput").click());
}

if ($id("statusMediaInput")) {
    $id("statusMediaInput").addEventListener("change", () => {

        const file = $id("statusMediaInput").files[0];
        if (!file) return;

        statusMediaFile = file;

        const preview = $id("statusMediaPreview");
        if (preview) {
            preview.classList.remove("hidden");
            if (file.type.startsWith("image/")) {
                preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="">`;
            } else {
                preview.innerHTML = `<i class="fa-solid fa-video"></i> ${escapeHtml(file.name)}`;
            }
        }

    });
}

// uploads a file with real progress events (fetch doesn't expose
// upload progress, which is exactly why a big video felt "stuck" -
// the button gave zero feedback while it silently transferred)
function uploadFileWithProgress(file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append("file", file);

        xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        });

        xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    resolve(JSON.parse(xhr.responseText));
                } catch (e) {
                    reject(e);
                }
            } else {
                reject(new Error(`Upload failed (${xhr.status})`));
            }
        });

        xhr.addEventListener("error", () => reject(new Error("Upload failed")));

        xhr.open("POST", "/upload");
        xhr.send(formData);
    });
}

if ($id("postStatusBtn")) {
    $id("postStatusBtn").addEventListener("click", async () => {

        const btn = $id("postStatusBtn");
        if (btn.disabled) return; // already posting - ignore extra clicks

        const activeTab = document.querySelector(".status-compose-tab.active");
        const isMedia = activeTab && activeTab.dataset.statusTab === "media";
        const privacy = $id("statusPrivacySelect") ? $id("statusPrivacySelect").value : "contacts";

        if (isMedia) {

            if (!statusMediaFile) {
                showNiceAlert("Choose a photo or video first.", { title: "Nothing to post" });
                return;
            }

            const originalLabel = btn.textContent;
            btn.disabled = true;

            try {
                const data = await uploadFileWithProgress(statusMediaFile, (pct) => {
                    btn.textContent = `Uploading... ${pct}%`;
                });

                btn.textContent = "Posting...";

                socket.emit("post-status", {
                    kind: "media",
                    url: data.url,
                    caption: $id("statusCaptionInput") ? $id("statusCaptionInput").value.trim() : "",
                    privacy
                });
            } catch (err) {
                showNiceAlert("Couldn't upload that file right now.", { title: "Upload failed" });
                btn.disabled = false;
                btn.textContent = originalLabel;
                return;
            }

            btn.disabled = false;
            btn.textContent = originalLabel;

        } else {

            const text = $id("statusTextInput") ? $id("statusTextInput").value.trim() : "";

            if (!text) {
                showNiceAlert("Write something first.", { title: "Nothing to post" });
                return;
            }

            socket.emit("post-status", { kind: "text", text, color: myStatusColor, privacy });

        }

        closeModal($id("createStatusModal"));

    });
}


// ---- Status viewer (full-screen playback) ----

let statusViewerGroups = [];
let statusViewerGroupIdx = 0;
let statusViewerUpdateIdx = 0;
let statusViewerTimer = null;

function openStatusViewer(groups, groupIdx) {

    statusViewerGroups = groups;
    statusViewerGroupIdx = groupIdx;
    statusViewerUpdateIdx = 0;

    openModal($id("statusViewerOverlay"));
    playCurrentStatus();

}

function currentStatusGroup() { return statusViewerGroups[statusViewerGroupIdx]; }
function currentStatusUpdate() {
    const g = currentStatusGroup();
    return g && g.updates ? g.updates[statusViewerUpdateIdx] : null;
}

// Draws the top progress bars (one per update, like WhatsApp/Instagram
// stories) and animates a moving line across the current slide's bar,
// growing over `durationMs`. Also (re)schedules the auto-advance timer
// to fire when that line finishes, so both stay in sync.
function startStatusProgress(durationMs) {

    const group = currentStatusGroup();
    if (!group) return;

    const bars = $id("statusProgressBars");
    if (bars) {
        bars.innerHTML = group.updates.map((u, i) => {
            const state = i < statusViewerUpdateIdx ? "done" : (i === statusViewerUpdateIdx ? "active" : "");
            const isActive = i === statusViewerUpdateIdx;
            const isDone = i < statusViewerUpdateIdx;
            const style = isActive
                ? `width:0%; animation-duration:${durationMs}ms`
                : `width:${isDone ? "100%" : "0%"}`;
            return `<span class="status-progress-bar${state ? " " + state : ""}"><span class="status-progress-fill" style="${style}"></span></span>`;
        }).join("");
    }

    clearTimeout(statusViewerTimer);
    statusViewerTimer = setTimeout(nextStatus, durationMs);
}

function playCurrentStatus() {

    clearTimeout(statusViewerTimer);

    const group = currentStatusGroup();
    const update = currentStatusUpdate();

    if (!group || !update) {
        closeModal($id("statusViewerOverlay"));
        return;
    }

    if ($id("statusViewerName")) $id("statusViewerName").textContent = group.name || "";
    if ($id("statusViewerAvatar")) $id("statusViewerAvatar").innerHTML = avatarMarkup(group.name, group.avatar);
    if ($id("statusViewerTime")) $id("statusViewerTime").textContent = update.time ? new Date(update.time).toLocaleTimeString() : "Just now";

    const isVideo = update.kind === "media" && update.url && /\.(mp4|webm|mov)$/i.test(update.url);
    let durationMs = isVideo ? 15000 : 5000;

    const content = $id("statusViewerContent");
    if (content) {
        if (update.kind === "media") {
            content.innerHTML = isVideo
                ? `<video src="${update.url}" autoplay playsinline></video>`
                : `<img src="${update.url}" alt="">`;

            if (isVideo) {
                const videoEl = content.querySelector("video");
                if (videoEl) {

                    // videos play WITH sound by default, unless the
                    // viewer has already muted this session (mirrors
                    // the mute button's current icon state)
                    const muteBtn = $id("statusViewerMuteBtn");
                    const muteIcon = muteBtn && muteBtn.querySelector("i");
                    const wantsMuted = !!(muteIcon && muteIcon.classList.contains("fa-volume-xmark"));
                    videoEl.muted = wantsMuted;

                    videoEl.play().catch(() => {
                        // some browsers block autoplay-with-sound - fall
                        // back to muted playback instead of a frozen/silent video
                        videoEl.muted = true;
                        if (muteIcon) {
                            muteIcon.classList.remove("fa-volume-high");
                            muteIcon.classList.add("fa-volume-xmark");
                        }
                        videoEl.play().catch(() => {});
                    });

                    videoEl.addEventListener("loadedmetadata", () => {
                        if (!videoEl.duration || !isFinite(videoEl.duration)) return;
                        // sync the moving line + auto-advance timer to the
                        // clip's real length instead of the generic default
                        startStatusProgress(Math.min(Math.max(videoEl.duration * 1000, 3000), 60000));
                    }, { once: true });
                }
            }
        } else {
            content.innerHTML = `<div class="status-text-slide status-color-${update.color || "green"}">${escapeHtml(update.text || "")}</div>`;
        }
    }

    startStatusProgress(durationMs);

    const viewCountWrap = $id("statusViewCountWrap");
    const isMine = me && group.id === me.id;
    if (viewCountWrap) viewCountWrap.classList.toggle("hidden", !isMine);
    if (isMine && $id("statusViewCount")) $id("statusViewCount").textContent = String((update.viewers || []).length);

    const likeBtn = $id("statusViewerLikeBtn");
    if (likeBtn) {
        const iLiked = !isMine && me && (update.likes || []).some(l => l.id === me.id);
        const icon = likeBtn.querySelector("i");
        likeBtn.classList.toggle("liked", !!iLiked);
        if (icon) {
            icon.classList.toggle("fa-regular", !iLiked);
            icon.classList.toggle("fa-solid", !!iLiked);
        }
        // owners can see who liked their status, but can't like their own
        likeBtn.classList.toggle("hidden", !!isMine);
    }

    if (!isMine) socket.emit("view-status", { statusId: update.id, ownerId: group.id });

}

function nextStatus() {

    const group = currentStatusGroup();
    if (!group) return;

    if (statusViewerUpdateIdx < group.updates.length - 1) {
        statusViewerUpdateIdx++;
        playCurrentStatus();
    } else {
        // finished this person's last update - close back to the list
        // instead of rolling into the next contact's status, so each
        // person's story stays its own separate viewing session
        clearTimeout(statusViewerTimer);
        closeModal($id("statusViewerOverlay"));
    }

}

function prevStatus() {

    if (statusViewerUpdateIdx > 0) {
        statusViewerUpdateIdx--;
        playCurrentStatus();
    }
    // already at this person's first update - stay put rather than
    // jumping back into a different person's story

}

if ($id("statusViewerNextZone")) $id("statusViewerNextZone").addEventListener("click", nextStatus);
if ($id("statusViewerPrevZone")) $id("statusViewerPrevZone").addEventListener("click", prevStatus);

if ($id("statusViewerCloseBtn")) {
    $id("statusViewerCloseBtn").addEventListener("click", () => {
        clearTimeout(statusViewerTimer);
        closeModal($id("statusViewerOverlay"));
    });
}

if ($id("statusViewerMuteBtn")) {
    $id("statusViewerMuteBtn").addEventListener("click", () => {
        const icon = $id("statusViewerMuteBtn").querySelector("i");
        const muted = icon && icon.classList.contains("fa-volume-xmark");
        if (icon) {
            icon.classList.toggle("fa-volume-high", muted);
            icon.classList.toggle("fa-volume-xmark", !muted);
        }
        const media = document.querySelector("#statusViewerContent video");
        if (media) media.muted = !muted;
    });
}

if ($id("statusViewerMoreBtn")) {
    $id("statusViewerMoreBtn").addEventListener("click", async () => {
        const update = currentStatusUpdate();
        const group = currentStatusGroup();
        if (!update || !group) return;
        if (me && group.id === me.id) {
            const ok = await showNiceConfirm("Delete this status update?", {
                title: "Delete status",
                icon: "fa-trash",
                confirmText: "Delete"
            });
            if (ok) {
                socket.emit("delete-status", { statusId: update.id });
                closeModal($id("statusViewerOverlay"));
            }
        }
    });
}

if ($id("statusViewerLikeBtn")) {
    $id("statusViewerLikeBtn").addEventListener("click", () => {
        const update = currentStatusUpdate();
        const group = currentStatusGroup();
        if (!update || !group || !me || group.id === me.id) return;

        socket.emit("like-status", { statusId: update.id, ownerId: group.id });

        // optimistic local flip so it feels instant while we wait for
        // the server's "status-posted" refresh to come back
        const alreadyLiked = (update.likes || []).some(l => l.id === me.id);
        update.likes = update.likes || [];
        if (alreadyLiked) {
            update.likes = update.likes.filter(l => l.id !== me.id);
        } else {
            update.likes.push({ id: me.id, name: me.name, at: Date.now() });
        }

        const likeBtn = $id("statusViewerLikeBtn");
        const icon = likeBtn.querySelector("i");
        likeBtn.classList.toggle("liked", !alreadyLiked);
        if (icon) {
            icon.classList.toggle("fa-regular", alreadyLiked);
            icon.classList.toggle("fa-solid", !alreadyLiked);
        }
    });
}

// ============================================================
// STATUS VIEWERS SHEET — tap the view count on your own status
// to see who watched it and who liked it (opens like WhatsApp's
// "Viewed by" sheet, sliding up from the bottom).
// ============================================================

function openStatusViewersModal() {

    const update = currentStatusUpdate();
    const group = currentStatusGroup();
    if (!update || !group || !me || group.id !== me.id) return;

    clearTimeout(statusViewerTimer);

    const viewers = update.viewers || [];
    const likes = update.likes || [];
    const likedIds = new Set(likes.map(l => l.id));

    if ($id("statusViewersCount")) $id("statusViewersCount").textContent = String(viewers.length);

    const listEl = $id("statusViewersList");
    const emptyEl = $id("statusViewersEmpty");

    if (!viewers.length) {
        if (listEl) listEl.innerHTML = "";
        if (emptyEl) emptyEl.classList.remove("hidden");
    } else {
        if (emptyEl) emptyEl.classList.add("hidden");

        // people who liked show up first, most recent view first within
        // each group — same ordering WhatsApp uses for its viewer sheet
        const sorted = [...viewers].sort((a, b) => {
            const aLiked = likedIds.has(a.id) ? 1 : 0;
            const bLiked = likedIds.has(b.id) ? 1 : 0;
            if (aLiked !== bLiked) return bLiked - aLiked;
            return b.at - a.at;
        });

        if (listEl) {
            listEl.innerHTML = sorted.map(v => {
                const profile = usersOnline[v.id] || friendProfiles[v.id] || null;
                const avatarUrl = profile && profile.avatar;
                const liked = likedIds.has(v.id);

                return `
                    <div class="status-viewer-row">
                        <span class="modal-picker-avatar">${avatarMarkup(v.name, avatarUrl)}</span>
                        <span class="status-viewer-row-name">${escapeHtml(v.name || "Someone")}</span>
                        <span class="status-viewer-row-time">${v.at ? new Date(v.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
                        ${liked ? `<i class="fa-solid fa-heart status-viewer-row-liked"></i>` : ""}
                    </div>
                `;
            }).join("");
        }
    }

    $id("statusViewersModal").classList.remove("hidden");
}

function closeStatusViewersModal() {
    if ($id("statusViewersModal")) $id("statusViewersModal").classList.add("hidden");
    // resume the story where it was, since opening the sheet paused it
    if (!$id("statusViewerOverlay").classList.contains("hidden")) playCurrentStatus();
}

if ($id("statusViewCountWrap")) {
    $id("statusViewCountWrap").addEventListener("click", openStatusViewersModal);
    $id("statusViewCountWrap").addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") openStatusViewersModal();
    });
}

if ($id("closeStatusViewersModal")) $id("closeStatusViewersModal").addEventListener("click", closeStatusViewersModal);
if ($id("statusViewersBackdrop")) $id("statusViewersBackdrop").addEventListener("click", closeStatusViewersModal);

if ($id("statusReplySendBtn")) {
    $id("statusReplySendBtn").addEventListener("click", () => {

        const input = $id("statusReplyInput");
        const text = input ? input.value.trim() : "";
        const update = currentStatusUpdate();
        const group = currentStatusGroup();

        if (!text || !update || !group) return;

        socket.emit("chat-message", {
            toId: group.id,
            text: `Replying to status: ${text}`
        });

        if (input) input.value = "";

    });
}


// ============================================================
// CALLS TAB
// ============================================================

function getCallHistory() {
    try {
        return JSON.parse(localStorage.getItem("siteChatCallHistory") || "[]");
    } catch (e) {
        return [];
    }
}

function logCallHistory(entry) {
    const list = getCallHistory();
    list.unshift(Object.assign({ time: Date.now() }, entry));
    localStorage.setItem("siteChatCallHistory", JSON.stringify(list.slice(0, 100)));
    renderCallHistory();
}

function renderCallHistory() {

    const listEl = $id("callHistoryList");
    const emptyEl = $id("noCallHistory");
    if (!listEl) return;

    const history = getCallHistory();

    listEl.querySelectorAll(".call-history-item").forEach(el => el.remove());

    if (!history.length) {
        if (emptyEl) emptyEl.classList.remove("hidden");
        return;
    }

    if (emptyEl) emptyEl.classList.add("hidden");

    history.forEach(entry => {
        const item = document.createElement("div");
        item.className = "find-friend-btn call-history-item";
        const icon = entry.direction === "outgoing" ? "fa-arrow-up-right-from-square" : entry.direction === "missed" ? "fa-phone-slash" : "fa-arrow-down-left";
        item.innerHTML = `
            <span class="find-icon"><i class="fa-solid ${entry.callType === "video" ? "fa-video" : "fa-phone"}"></i></span>
            <span class="find-text">
                <strong>${escapeHtml(entry.name || "Unknown")}</strong>
                <small><i class="fa-solid ${icon}"></i> ${new Date(entry.time).toLocaleString()}</small>
            </span>
        `;
        item.addEventListener("click", () => {
            if (entry.id) {
                openChat(entry.id, entry.name, myGroups.get(entry.id));
                startCall(entry.callType || "audio");
            }
        });
        listEl.appendChild(item);
    });

}

if ($id("newCallBtn")) {
    $id("newCallBtn").addEventListener("click", () => {
        if (typeof openFindFriendPanel === "function") openFindFriendPanel();
    });
}

// best-effort call history logging, hooking the existing call events
socket.on("incoming-call", ({ fromId, fromName, callType }) => {
    logCallHistory({ id: fromId, name: fromName, callType, direction: "incoming" });
});

(function wireOutgoingCallLog() {
    if (audioCallBtn) {
        audioCallBtn.addEventListener("click", () => {
            if (activeChat && !activeChat.isGroup) logCallHistory({ id: activeChat.id, name: activeChat.name, callType: "audio", direction: "outgoing" });
        });
    }
    if (videoCallBtn) {
        videoCallBtn.addEventListener("click", () => {
            if (activeChat && !activeChat.isGroup) logCallHistory({ id: activeChat.id, name: activeChat.name, callType: "video", direction: "outgoing" });
        });
    }
})();

renderCallHistory();


// ============================================================
// CHANNELS
// ============================================================

let channelIconUrl = null;

function requestChannels() { socket.emit("get-channels"); }

function renderChannelsList(channels) {

    const listEl = $id("channelsList");
    if (!listEl) return;

    listEl.innerHTML = (channels || []).map(ch => `
        <div class="friend-item channel-item" data-id="${ch.id}">
            <span class="find-icon"><i class="fa-solid fa-bullhorn"></i></span>
            <span class="find-text"><strong>${escapeHtml(ch.name)}</strong></span>
        </div>
    `).join("");

    listEl.querySelectorAll(".channel-item").forEach(item => {
        item.addEventListener("click", () => {
            const ch = (channels || []).find(c => c.id === item.dataset.id);
            openChat(item.dataset.id, ch ? ch.name : "Channel", ch ? { memberIds: [], adminIds: [me.id], icon: ch.icon, description: ch.description } : null);
        });
    });

}

socket.on("channels-list", (channels) => renderChannelsList(channels));

if ($id("newChannelBtn")) {
    $id("newChannelBtn").addEventListener("click", () => {
        channelIconUrl = null;
        if ($id("newChannelNameInput")) $id("newChannelNameInput").value = "";
        if ($id("newChannelDescInput")) $id("newChannelDescInput").value = "";
        if ($id("channelIconInner")) { $id("channelIconInner").style.backgroundImage = ""; $id("channelIconInner").innerHTML = '<i class="fa-solid fa-bullhorn"></i>'; }
        openModal($id("newChannelModal"));
    });
}

if ($id("closeNewChannelModal")) $id("closeNewChannelModal").addEventListener("click", () => closeModal($id("newChannelModal")));

if ($id("channelIcon") && $id("channelIconInput")) {
    $id("channelIcon").addEventListener("click", () => $id("channelIconInput").click());
}

if ($id("channelIconInput")) {
    $id("channelIconInput").addEventListener("change", async () => {

        const file = $id("channelIconInput").files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append("file", file);

        try {
            const res = await fetch("/upload", { method: "POST", body: formData });
            const data = await res.json();
            channelIconUrl = data.url;
            if ($id("channelIconInner")) {
                $id("channelIconInner").style.backgroundImage = `url("${data.url}")`;
                $id("channelIconInner").innerHTML = "";
            }
        } catch (err) {
            showNiceAlert("Couldn't upload that image.", { title: "Upload failed" });
        }

    });
}

if ($id("createChannelBtn")) {
    $id("createChannelBtn").addEventListener("click", () => {

        const name = $id("newChannelNameInput") ? $id("newChannelNameInput").value.trim() : "";

        if (!name) {
            showNiceAlert("Give your channel a name first.", { title: "Name required" });
            return;
        }

        socket.emit("create-channel", {
            name,
            description: $id("newChannelDescInput") ? $id("newChannelDescInput").value.trim() : "",
            icon: channelIconUrl
        });

        closeModal($id("newChannelModal"));

    });
}


// ============================================================
// COMMUNITIES
// ============================================================

let communityIconUrl = null;
let selectedCommunityGroups = new Set();

function requestCommunities() { socket.emit("get-communities"); }

function renderCommunitiesList(communities) {

    const listEl = $id("communitiesList");
    if (!listEl) return;

    listEl.innerHTML = (communities || []).map(c => `
        <div class="friend-item community-item" data-id="${c.id}">
            <span class="find-icon"><i class="fa-solid fa-people-roof"></i></span>
            <span class="find-text"><strong>${escapeHtml(c.name)}</strong></span>
        </div>
    `).join("");

    listEl.querySelectorAll(".community-item").forEach(item => {
        item.addEventListener("click", () => {
            const c = (communities || []).find(x => x.id === item.dataset.id);
            showNiceAlert(c ? c.description || "Community" : "Community", { title: c ? c.name : "Community", icon: "fa-people-roof" });
        });
    });

}

socket.on("communities-list", (communities) => renderCommunitiesList(communities));

if ($id("newCommunityBtn")) {
    $id("newCommunityBtn").addEventListener("click", () => {

        communityIconUrl = null;
        selectedCommunityGroups = new Set();

        if ($id("newCommunityNameInput")) $id("newCommunityNameInput").value = "";
        if ($id("newCommunityDescInput")) $id("newCommunityDescInput").value = "";
        if ($id("communityIconInner")) { $id("communityIconInner").style.backgroundImage = ""; $id("communityIconInner").innerHTML = '<i class="fa-solid fa-people-roof"></i>'; }

        const groupsList = $id("newCommunityGroupsList");
        if (groupsList) {
            const groups = Array.from(myGroups.values());
            groupsList.innerHTML = groups.length
                ? groups.map(g => `
                    <label class="modal-picker-item">
                        <input type="checkbox" data-id="${g.id}">
                        ${escapeHtml(g.name)}
                    </label>
                `).join("")
                : '<div class="add-participant-empty">No groups yet - create one first.</div>';

            groupsList.querySelectorAll("input[type=checkbox]").forEach(box => {
                box.addEventListener("change", () => {
                    if (box.checked) selectedCommunityGroups.add(box.dataset.id);
                    else selectedCommunityGroups.delete(box.dataset.id);
                });
            });
        }

        openModal($id("newCommunityModal"));

    });
}

if ($id("closeNewCommunityModal")) $id("closeNewCommunityModal").addEventListener("click", () => closeModal($id("newCommunityModal")));

if ($id("communityIcon") && $id("communityIconInput")) {
    $id("communityIcon").addEventListener("click", () => $id("communityIconInput").click());
}

if ($id("communityIconInput")) {
    $id("communityIconInput").addEventListener("change", async () => {

        const file = $id("communityIconInput").files[0];
        if (!file) return;

        const formData = new FormData();
        formData.append("file", file);

        try {
            const res = await fetch("/upload", { method: "POST", body: formData });
            const data = await res.json();
            communityIconUrl = data.url;
            if ($id("communityIconInner")) {
                $id("communityIconInner").style.backgroundImage = `url("${data.url}")`;
                $id("communityIconInner").innerHTML = "";
            }
        } catch (err) {
            showNiceAlert("Couldn't upload that image.", { title: "Upload failed" });
        }

    });
}

if ($id("createCommunityBtn")) {
    $id("createCommunityBtn").addEventListener("click", () => {

        const name = $id("newCommunityNameInput") ? $id("newCommunityNameInput").value.trim() : "";

        if (!name) {
            showNiceAlert("Give your community a name first.", { title: "Name required" });
            return;
        }

        socket.emit("create-community", {
            name,
            description: $id("newCommunityDescInput") ? $id("newCommunityDescInput").value.trim() : "",
            icon: communityIconUrl,
            groupIds: Array.from(selectedCommunityGroups)
        });

        closeModal($id("newCommunityModal"));

    });
}


// ============================================================
// HOOK INTO openChat() FOR WALLPAPER / SEARCH-BAR RESET
// ============================================================

(function wrapOpenChatForNewFeatures() {

    const originalOpenChat = openChat;

    openChat = function (...args) {

        originalOpenChat.apply(this, args);

        applyChatWallpaper();
        closeChatSearchBar();

        const muteOption = $id("muteChatOption");
        if (muteOption && activeChat) {
            const label = muteOption.querySelector("span");
            if (label) label.innerHTML = isChatMuted(activeChat.id)
                ? '<i class="fa-solid fa-bell"></i> Unmute notifications'
                : '<i class="fa-solid fa-bell-slash"></i> Mute notifications';
        }

    };

})();


// ============================================================
// INITIAL LOAD (once we've joined)
// ============================================================

socket.on("joined", () => {
    requestStatuses();
    requestChannels();
    requestCommunities();

    setupPushNotifications();

    // came here from a background notification tap (either the service
    // worker opened a new window with these params, or we're in an
    // already-open tab that just got postMessage'd instead - handle
    // whichever actually happens)
    const params = new URLSearchParams(window.location.search);
    const openChatId = params.get("openChat");
    const answerCallFromId = params.get("answerCall");

    if (openChatId) {
        openChatFromNotification(openChatId);
    } else if (answerCallFromId) {
        waitForIncomingOfferAndAnswer(answerCallFromId);
    }

    if (openChatId || answerCallFromId) {
        window.history.replaceState({}, "", window.location.pathname);
    }
});