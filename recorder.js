const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const {
    createNotificationFilter
} = require("./notification-filter");

// =========================================================
// CONFIGURATION
// =========================================================

const CDP_URL =
    process.env.CDP_URL ||
    "http://127.0.0.1:9222";

const CAPTURE_ROOT =
    path.join(__dirname, "captures");

const START_URL =
    "https://www.facebook.com/";

// Notification payloads observed so far are >= 20 KB.
// Size is measured AFTER decoding the CDP payload.
const LARGE_FRAME_THRESHOLD =
    20 * 1024;


// =========================================================
// HELPERS
// =========================================================

function timestamp() {
    const now = new Date();

    const datePart =
        new Intl.DateTimeFormat(
            "en-IN",
            {
                timeZone: "Asia/Kolkata",
                weekday: "long",
                day: "2-digit",
                month: "long",
                year: "numeric"
            }
        ).format(now);

    const timePart =
        new Intl.DateTimeFormat(
            "en-IN",
            {
                timeZone: "Asia/Kolkata",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: true
            }
        ).format(now);

    return `${datePart}, ${timePart}`;
}


function ensureDir(dir) {
    fs.mkdirSync(
        dir,
        {
            recursive: true
        }
    );
}


function safeName(value) {
    return String(value).replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
    );
}


// =========================================================
// DECODE WEBSOCKET PAYLOAD
// =========================================================

function decodePayload(response) {

    const payload =
        response.payloadData || "";

    const opcode =
        response.opcode;


    // -------------------------------------------------------
    // TEXT FRAME
    // -------------------------------------------------------

    if (opcode === 1) {

        const buffer =
            Buffer.from(
                payload,
                "utf8"
            );

        return {

            buffer,

            encoding:
                "utf8",

            rawPayload:
                payload
        };
    }


    // -------------------------------------------------------
    // BINARY FRAME
    // -------------------------------------------------------

    if (opcode === 2) {

        try {

            const buffer =
                Buffer.from(
                    payload,
                    "base64"
                );

            return {

                buffer,

                encoding:
                    "base64",

                rawPayload:
                    payload
            };

        } catch {

            return {

                buffer:
                    Buffer.from(
                        payload,
                        "utf8"
                    ),

                encoding:
                    "unknown",

                rawPayload:
                    payload
            };
        }
    }


    // -------------------------------------------------------
    // UNKNOWN OPCODE
    // -------------------------------------------------------

    return {

        buffer:
            Buffer.from(
                payload,
                "utf8"
            ),

        encoding:
            "unknown",

        rawPayload:
            payload
    };
}


// =========================================================
// CAPTURE SESSION
// =========================================================

const sessionTimestamp =
    timestamp();

const sessionId =
    sessionTimestamp.replace(
        /:/g,
        "-"
    );


const sessionDir =
    path.join(
        CAPTURE_ROOT,
        sessionId
    );


ensureDir(
    sessionDir
);


// =========================================================
// NOTIFICATION FILTER / GROUP SIGNALS
// =========================================================

const notificationRecordFile =
    path.join(
        sessionDir,
        "notification-events.jsonl"
    );


const notificationFilter =
    createNotificationFilter({
        recordFile:
            notificationRecordFile,

        onNewGroupSignal:
            signal => {

                let output =
                    `[GROUP SIGNAL] ${signal.group_id} | ${signal.group_name || "Unknown Group"}`;

                if (
                    signal.content_id
                ) {
                    output +=
                        ` | content=${signal.content_id}`;
                }

                output +=
                    " | 🆕 NEW";

                console.log(
                    output
                );
            }
    });


// =========================================================
// STARTUP
// =========================================================

console.log("");

console.log(
    "================================================"
);

console.log(
    " Facebook Notification Recorder"
);

console.log(
    "================================================"
);

console.log(
    `Session:   ${sessionTimestamp}`
);

console.log(
    `Output:    ${sessionDir}`
);

console.log(
    `CDP:       ${CDP_URL}`
);

console.log(
    `Threshold: ${(LARGE_FRAME_THRESHOLD / 1024).toFixed(0)} KB decoded`
);

console.log("");


// =========================================================
// MAIN
// =========================================================

(async () => {

    let browser;

    let cdp;

    let page;


    // =====================================================
    // CONNECT TO EXISTING CHROME
    // =====================================================

    try {

        console.log(
            `[START] Connecting to Chrome at ${CDP_URL}...`
        );


        browser =
            await chromium.connectOverCDP(
                CDP_URL
            );

    } catch (error) {

        console.error("");

        console.error(
            "[ERROR] Could not connect to Chrome via CDP."
        );

        console.error(
            `        ${error.message}`
        );

        console.error("");

        console.error(
            "Start Chrome with:"
        );

        console.error(
            "/Applications/Google\\ Chrome.app/Contents/MacOS/Google Chrome \\"
        );

        console.error(
            "  --remote-debugging-port=9222 \\"
        );

        console.error(
            '  --user-data-dir="/users/zafar/facebook-scraper-chrome"'
        );

        process.exit(1);
    }


    // =====================================================
    // GET BROWSER CONTEXT
    // =====================================================

    const contexts =
        browser.contexts();


    if (
        contexts.length === 0
    ) {

        console.error(
            "[ERROR] No browser context found."
        );

        process.exit(1);
    }


    const context =
        contexts[0];


    const pages =
        context.pages();


    console.log(
        `[READY] Connected to Chrome (${pages.length} existing page${pages.length === 1 ? "" : "s"})`
    );


    // =====================================================
    // FIND EXACT FACEBOOK ROOT PAGE
    // =====================================================

    page =
        pages.find(
            existingPage => {

                const url =
                    existingPage.url();

                return (
                    url === "https://www.facebook.com/" ||
                    url === "https://www.facebook.com"
                );
            }
        );


    // =====================================================
    // FACEBOOK ROOT PAGE NOT OPEN
    // =====================================================

    if (!page) {

        console.log(
            "[PAGE] No https://www.facebook.com/ page found."
        );

        console.log(
            "[PAGE] Opening Facebook in existing Chrome..."
        );


        page =
            await context.newPage();


        // Attach BEFORE navigation so we capture
        // WebSocket activity created during navigation.
        await attachToPage(
            page
        );


        console.log(
            "[PAGE] Navigating to Facebook..."
        );


        await page.goto(
            START_URL,
            {
                waitUntil:
                    "domcontentloaded"
            }
        );


        console.log(
            `[PAGE] Facebook loaded: ${page.url()}`
        );
    }


    // =====================================================
    // FACEBOOK ROOT PAGE ALREADY OPEN
    // =====================================================

    else {

        console.log(
            `[PAGE] Using existing Facebook page: ${page.url()}`
        );

        console.log(
            "[PAGE] Attaching without reload..."
        );


        await attachToPage(
            page
        );
    }


    // =====================================================
    // READY
    // =====================================================

    console.log("");

    console.log(
        "================================================"
    );

    console.log(
        " 🚀 RECORDER IS RUNNING"
    );

    console.log(
        "================================================"
    );

    console.log(
        "[MODE] One Facebook page"
    );

    console.log(
        "[MODE] One CDP session"
    );

    console.log(
        "[MODE] No WebSocket requestId mapping"
    );

    console.log(
        "[MODE] No streamcontroller filtering"
    );

    console.log(
        "[MODE] Inspecting all decoded WebSocket frames"
    );

    console.log(
        `[MODE] Saving frames >= ${(LARGE_FRAME_THRESHOLD / 1024).toFixed(0)} KB`
    );

    console.log(
        `[MODE] Notification records: ${notificationRecordFile}`
    );

    console.log("");

    console.log(
        "Waiting for WebSocket frames..."
    );

    console.log("");

    console.log(
        "Press Ctrl+C to stop."
    );

    console.log("");


    // =====================================================
    // ATTACH TO ONE FACEBOOK PAGE
    // =====================================================

    async function attachToPage(targetPage) {

        if (cdp) {
            return;
        }


        console.log(
            `[CDP] Attaching to: ${targetPage.url()}`
        );


        cdp =
            await context.newCDPSession(
                targetPage
            );


        await cdp.send(
            "Network.enable"
        );


        console.log(
            "[CDP] Network monitoring enabled"
        );

        console.log(
            "[CDP] Listening for WebSocket frames"
        );


        // =================================================
        // WEBSOCKET FRAME RECEIVED
        // =================================================

        cdp.on(
            "Network.webSocketFrameReceived",
            event => {

                const {
                    requestId,
                    timestamp:
                        chromeTimestamp,
                    response
                } = event;


                // -------------------------------------------------
                // Decode incoming payload.
                // -------------------------------------------------

                const decoded =
                    decodePayload(
                        response
                    );


                const buffer =
                    decoded.buffer;


                const actualSize =
                    buffer.length;


                const rawPayloadSize =
                    Buffer.byteLength(
                        response.payloadData || ""
                    );


                // =================================================
                // SMALL FRAME
                // =================================================

                if (
                    actualSize <
                    LARGE_FRAME_THRESHOLD
                ) {

                    console.log(
                        `[FRAME] ${requestId} | ${actualSize} bytes | 👂 LISTENING / NOT SAVING`
                    );

                    return;
                }


                // =================================================
                // LARGE FRAME
                // =================================================

                const decodedText =
                    buffer.toString(
                        "utf8"
                    );


                const frameReceivedAt =
                    timestamp();


                // -------------------------------------------------
                // Structured notification processing.
                // -------------------------------------------------

                const notificationResult =
                    notificationFilter.process(
                        decodedText,
                        {
                            receivedAt:
                                frameReceivedAt,

                            requestId,

                            chromeTimestamp
                        }
                    );


                const matchedIndicators =
                    notificationResult.matchedIndicators;


                const classification =
                    notificationResult.notificationsFound > 0
                        ? "notification_candidate"
                        : "large_websocket_frame";


                // -------------------------------------------------
                // Capture directory
                // -------------------------------------------------

                const requestDir =
                    path.join(
                        sessionDir,
                        `large-frame-${safeName(requestId)}`
                    );


                ensureDir(
                    requestDir
                );


                const framesFile =
                    path.join(
                        requestDir,
                        "frames.jsonl"
                    );


                // -------------------------------------------------
                // Save decoded payload + metadata
                // -------------------------------------------------

                const frame = {

                    received_at:
                        frameReceivedAt,

                    chrome_timestamp:
                        chromeTimestamp,

                    request_id:
                        requestId,

                    opcode:
                        response.opcode,

                    payload_encoding:
                        decoded.encoding,

                    actual_size:
                        actualSize,

                    raw_cdp_payload_size:
                        rawPayloadSize,

                    classification,

                    matched_indicators:
                        matchedIndicators,

                    decoded_payload:
                        decodedText
                };


                fs.appendFileSync(

                    framesFile,

                    JSON.stringify(
                        frame
                    ) + "\n"
                );


                // =================================================
                // LARGE FRAME OUTPUT
                // =================================================

                let output =
                    `[FRAME] ${requestId} | ${(actualSize / 1024).toFixed(2)} KB | 💾 SAVED | ${classification}`;


                if (
                    matchedIndicators.length > 0
                ) {

                    output +=
                        ` | ${matchedIndicators.join(", ")}`;
                }


                output +=
                    ` | ${framesFile}`;


                console.log(
                    output
                );

            }
        );
    }


    // =====================================================
    // SHUTDOWN
    // =====================================================

    process.on(
        "SIGINT",
        async () => {

            console.log("");

            console.log(
                "[STOP] Stopping recorder..."
            );

            console.log(
                `[STOP] Capture saved at: ${sessionDir}`
            );

            console.log(
                `[STOP] Notification records saved at: ${notificationRecordFile}`
            );

            console.log(
                "[STOP] Chrome will remain running."
            );

            console.log("");


            try {

                if (cdp) {

                    await cdp.detach();

                }

            } catch {

                // Ignore detach errors during shutdown.

            }


            process.exit(0);
        }
    );

})();