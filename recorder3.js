const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// =========================================================
// CONFIGURATION
// =========================================================

// Existing Chrome:
//
// /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//   --remote-debugging-port=9222 \
//   --user-data-dir="/users/zafar/facebook-scraper-chrome"

const CDP_URL =
    process.env.CDP_URL ||
    "http://127.0.0.1:9222";

const CAPTURE_ROOT =
    path.join(__dirname, "captures");

const START_URL =
    "https://www.facebook.com/";


// =========================================================
// IMPORTANT SETTINGS
// =========================================================

// Notification payloads observed so far are >20 KB.
// Threshold applies to the ACTUAL decoded payload,
// not the Base64 representation.
const LARGE_FRAME_THRESHOLD =
    20 * 1024;


// =========================================================
// INDICATORS
// =========================================================

const INDICATORS = [

    "group_activity",

    "all_posts",

    "group_highlights",

    "cometnotifications",

    "cometnotificationsreceivelivequery",

    "notifications_page",

    "live_query",

    "notif_type",

    "context_id",

    "content_id",

    "overlay_has_group",

    "multi_permalinks"
];


// =========================================================
// HELPERS
// =========================================================

function timestamp() {

    return new Date().toISOString();
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
//
// CDP:
// opcode 1 = text
// opcode 2 = binary
//
// Binary WebSocket payloads are provided by CDP as Base64.
// Decode before calculating size or searching indicators.
// =========================================================

function decodePayload(response) {

    const payload =
        response.payloadData || "";

    const opcode =
        response.opcode;


    // ---------------------------------------------
    // Text
    // ---------------------------------------------

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


    // ---------------------------------------------
    // Binary
    // ---------------------------------------------

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

        } catch (error) {

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


    // ---------------------------------------------
    // Unknown opcode
    // ---------------------------------------------

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

const sessionId =
    timestamp().replace(
        /[:.]/g,
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
// STARTUP
// =========================================================

console.log("");

console.log(
    "================================================"
);

console.log(
    " Facebook Streamcontroller Recorder"
);

console.log(
    "================================================"
);

console.log("");

console.log(
    `Session: ${sessionId}`
);

console.log(
    `Output:  ${sessionDir}`
);

console.log(
    `CDP:     ${CDP_URL}`
);

console.log(
    `Threshold: ${LARGE_FRAME_THRESHOLD} bytes actual`
);

console.log("");


// =========================================================
// MAIN
// =========================================================

(async () => {

    let browser;


    // =====================================================
    // CONNECT TO EXISTING CHROME
    // =====================================================

    try {

        console.log(
            `Connecting to existing Chrome at ${CDP_URL}...`
        );


        browser =
            await chromium.connectOverCDP(
                CDP_URL
            );


    } catch (error) {

        console.error("");

        console.error(
            "================================================"
        );

        console.error(
            "Could not connect to Chrome via CDP."
        );

        console.error(
            "================================================"
        );

        console.error("");

        console.error(
            "Start Chrome with:"
        );

        console.error("");

        console.error(
            "/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\"
        );

        console.error(
            "  --remote-debugging-port=9222 \\"
        );

        console.error(
            '  --user-data-dir="/users/zafar/facebook-scraper-chrome"'
        );

        console.error("");

        console.error(
            `Error: ${error.message}`
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
            "No browser context found."
        );

        process.exit(1);
    }


    const context =
        contexts[0];


    console.log("");

    console.log(
        "✓ Connected to existing Chrome"
    );

    console.log(
        `✓ Existing pages: ${context.pages().length}`
    );

    console.log("");

    console.log(
        "Recorder behavior:"
    );

    console.log(
        "  ✓ Track ALL observed WebSocket identities"
    );

    console.log(
        "  ✓ Save ONLY streamcontroller"
    );

    console.log(
        "  ✓ Save full payloads only when >=20 KB"
    );

    console.log(
        "  ✓ Decode binary WebSocket frames"
    );

    console.log(
        "  ✓ Inspect decoded payload"
    );

    console.log(
        "  ✓ Preserve raw Base64 payload"
    );

    console.log(
        "  ✓ Do not launch another Chrome"
    );

    console.log(
        "  ✓ Do not close existing Chrome"
    );

    console.log("");



    // =====================================================
    // SESSION STORAGE
    // =====================================================

    const sessions =
        new Map();



    // =====================================================
    // ATTACH TO PAGE
    // =====================================================

    async function attachToPage(page) {

        if (
            sessions.has(page)
        ) {

            return;
        }


        console.log("");

        console.log(
            "------------------------------------------------"
        );

        console.log(
            "[CDP] Attaching to page"
        );

        console.log(
            `URL: ${page.url()}`
        );

        console.log(
            "------------------------------------------------"
        );


        const cdp =
            await context.newCDPSession(
                page
            );


        await cdp.send(
            "Network.enable"
        );


        // =================================================
        // ALL SOCKETS
        // =================================================
        //
        // This map tracks EVERY WebSocket we observe.
        //
        // It is intentionally separate from `sockets`,
        // which contains ONLY streamcontroller sockets.
        //
        // This lets us distinguish:
        //
        // 1. Known streamcontroller
        // 2. Known other WebSocket
        // 3. Socket whose creation happened before
        //    the recorder attached
        //
        // =================================================

        const allSockets =
            new Map();


        // =================================================
        // STREAMCONTROLLER SOCKETS ONLY
        // =================================================

        const sockets =
            new Map();


        sessions.set(
            page,
            {
                cdp,
                allSockets,
                sockets
            }
        );


        console.log(
            "[CDP] ✓ Network monitoring enabled"
        );



        // =================================================
        // WEBSOCKET CREATED
        // =================================================

        cdp.on(
            "Network.webSocketCreated",
            event => {

                const {
                    requestId,
                    url
                } = event;


                const isStreamController =
                    url.includes(
                        "gateway.facebook.com/ws/streamcontroller"
                    );


                const socketType =
                    isStreamController
                        ? "streamcontroller"
                        : "other";


                // -----------------------------------------
                // Track EVERY WebSocket.
                // -----------------------------------------

                allSockets.set(
                    requestId,
                    {
                        requestId,

                        url,

                        type:
                            socketType,

                        createdAt:
                            timestamp(),

                        pageUrl:
                            page.url()
                    }
                );


                console.log("");

                console.log(
                    "================================================"
                );

                console.log(
                    `[WS CREATED] ${requestId}`
                );

                console.log(
                    `URL: ${url}`
                );


                if (
                    isStreamController
                ) {

                    console.log(
                        "ACTION: ✅ LISTENING + SAVING"
                    );

                    console.log(
                        "TYPE:   STREAMCONTROLLER"
                    );

                } else {

                    console.log(
                        "ACTION: 👂 LISTENING / NOT SAVING"
                    );

                    console.log(
                        "TYPE:   OTHER WEBSOCKET"
                    );
                }


                console.log(
                    "================================================"
                );


                // -----------------------------------------
                // Only streamcontroller sockets get actual
                // payload capture directories.
                // -----------------------------------------

                if (
                    !isStreamController
                ) {

                    return;
                }


                console.log("");

                console.log(
                    ">>> STREAMCONTROLLER DETECTED <<<"
                );


                const wsDir =
                    path.join(
                        sessionDir,
                        `streamcontroller-${safeName(requestId)}`
                    );


                ensureDir(
                    wsDir
                );


                const metadata = {

                    request_id:
                        requestId,

                    url,

                    created_at:
                        timestamp(),

                    type:
                        "streamcontroller",

                    page_url:
                        page.url(),

                    save_threshold_bytes:
                        LARGE_FRAME_THRESHOLD
                };


                fs.writeFileSync(

                    path.join(
                        wsDir,
                        "metadata.json"
                    ),

                    JSON.stringify(
                        metadata,
                        null,
                        2
                    )
                );


                sockets.set(

                    requestId,

                    {

                        url,

                        wsDir,

                        frameCount:
                            0,

                        savedFrameCount:
                            0,

                        skippedSmallFrameCount:
                            0,

                        largeFrameCount:
                            0,

                        interestingFrameCount:
                            0
                    }
                );


                console.log(
                    `Capture directory: ${wsDir}`
                );

                console.log("");
            }
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


                // -----------------------------------------
                // Streamcontroller capture lookup.
                // -----------------------------------------

                const socket =
                    sockets.get(
                        requestId
                    );


                // -----------------------------------------
                // Independent WebSocket identity lookup.
                //
                // This is the important new part.
                //
                // If this is missing, it does NOT mean
                // "this isn't streamcontroller".
                //
                // It can mean the socket existed before
                // our recorder attached.
                // -----------------------------------------

                const socketIdentity =
                    allSockets.get(
                        requestId
                    );


                // -----------------------------------------
                // Decode regardless of socket type.
                // -----------------------------------------

                const decoded =
                    decodePayload(
                        response
                    );


                const buffer =
                    decoded.buffer;


                const actualSize =
                    buffer.length;


                // =================================================
                // NOT IN STREAMCONTROLLER CAPTURE MAP
                // =================================================

                if (
                    !socket
                ) {

                    const isLargeUntracked =
                        actualSize >=
                        LARGE_FRAME_THRESHOLD;


                    // -----------------------------------------
                    // Small non-streamcontroller/unresolved
                    // frames are only reported.
                    // -----------------------------------------

                    if (
                        !isLargeUntracked
                    ) {

                        const identity =
                            socketIdentity
                                ? socketIdentity.type.toUpperCase()
                                : "PRE-EXISTING / UNSEEN";


                        console.log(
                            `[FRAME] ${requestId} | ${actualSize} bytes | ${identity} | 👂 LISTENING / NOT SAVING`
                        );


                        return;
                    }


                    // =================================================
                    // LARGE UNRESOLVED FRAME
                    // =================================================

                    const unresolvedDir =
                        path.join(
                            sessionDir,
                            "unresolved-large",
                            `socket-${safeName(requestId)}`
                        );


                    ensureDir(
                        unresolvedDir
                    );


                    const metadataFile =
                        path.join(
                            unresolvedDir,
                            "metadata.json"
                        );


                    if (
                        !fs.existsSync(
                            metadataFile
                        )
                    ) {

                        const metadata = {

                            request_id:
                                requestId,

                            created_at:
                                timestamp(),

                            type:
                                socketIdentity
                                    ? socketIdentity.type
                                    : "pre-existing-or-unseen",

                            socket_url:
                                socketIdentity
                                    ? socketIdentity.url
                                    : null,

                            socket_created_at:
                                socketIdentity
                                    ? socketIdentity.createdAt
                                    : null,

                            page_url:
                                page.url(),

                            save_threshold_bytes:
                                LARGE_FRAME_THRESHOLD
                        };


                        fs.writeFileSync(

                            metadataFile,

                            JSON.stringify(
                                metadata,
                                null,
                                2
                            )
                        );
                    }


                    // -----------------------------------------
                    // Inspect payload for the same indicators
                    // used by streamcontroller frames.
                    // -----------------------------------------

                    const unresolvedDecodedText =
                        decoded.buffer.toString(
                            "utf8"
                        );


                    const unresolvedLower =
                        unresolvedDecodedText.toLowerCase();


                    const unresolvedMatchedIndicators =
                        INDICATORS.filter(
                            indicator =>
                                unresolvedLower.includes(
                                    indicator
                                )
                        );


                    const unresolvedFrame = {

                        received_at:
                            timestamp(),

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
                            Buffer.byteLength(
                                response.payloadData || ""
                            ),

                        socket_type:
                            socketIdentity
                                ? socketIdentity.type
                                : "pre-existing-or-unseen",

                        socket_url:
                            socketIdentity
                                ? socketIdentity.url
                                : null,

                        matched_indicators:
                            unresolvedMatchedIndicators,

                        payload:
                            decoded.rawPayload
                    };


                    const unresolvedFramesFile =
                        path.join(
                            unresolvedDir,
                            "frames.jsonl"
                        );


                    fs.appendFileSync(

                        unresolvedFramesFile,

                        JSON.stringify(
                            unresolvedFrame
                        ) + "\n"
                    );


                    // -----------------------------------------
                    // Diagnostic output
                    // -----------------------------------------

                    console.log("");

                    console.log(
                        "================================================"
                    );

                    console.log(
                        "🔥 LARGE UNRESOLVED WEBSOCKET FRAME"
                    );

                    console.log(
                        `Request:     ${requestId}`
                    );

                    console.log(
                        `Actual size: ${actualSize} bytes`
                    );

                    console.log(
                        `Actual size: ${(actualSize / 1024).toFixed(2)} KB`
                    );

                    console.log(
                        `Socket type: ${
                            socketIdentity
                                ? socketIdentity.type.toUpperCase()
                                : "PRE-EXISTING / UNSEEN"
                        }`
                    );

                    console.log(
                        `URL: ${
                            socketIdentity
                                ? socketIdentity.url
                                : "NOT OBSERVED"
                        }`
                    );

                    console.log(
                        "Status:      💾 SAVED"
                    );


                    if (
                        unresolvedMatchedIndicators.length > 0
                    ) {

                        console.log(
                            `🔎 Indicators: ${unresolvedMatchedIndicators.join(", ")}`
                        );

                    } else {

                        console.log(
                            "🔎 Indicators: none"
                        );
                    }


                    console.log(
                        `File:        ${unresolvedFramesFile}`
                    );

                    console.log(
                        "================================================"
                    );


                    return;
                }



                // =================================================
                // STREAMCONTROLLER
                // =================================================

                socket.frameCount++;


                // -----------------------------------------
                // Decode payload into searchable text.
                // -----------------------------------------

                const decodedText =
                    buffer.toString(
                        "utf8"
                    );


                const lower =
                    decodedText.toLowerCase();


                // -----------------------------------------
                // Find indicators.
                // -----------------------------------------

                const matchedIndicators =
                    INDICATORS.filter(
                        indicator =>
                            lower.includes(
                                indicator
                            )
                    );


                const isLarge =
                    actualSize >=
                    LARGE_FRAME_THRESHOLD;


                const isInteresting =
                    matchedIndicators.length >
                    0;


                if (
                    isLarge
                ) {

                    socket.largeFrameCount++;
                }


                if (
                    isInteresting
                ) {

                    socket.interestingFrameCount++;
                }



                // =================================================
                // CLASSIFICATION
                // =================================================

                let classification =
                    "small_or_heartbeat";


                if (
                    isInteresting
                ) {

                    classification =
                        "notification_candidate";

                } else if (
                    isLarge
                ) {

                    classification =
                        "large_data";
                }



                // =================================================
                // LIGHTWEIGHT EVENT LOGGING
                // =================================================

                const eventRecord = {

                    received_at:
                        timestamp(),

                    chrome_timestamp:
                        chromeTimestamp,

                    request_id:
                        requestId,

                    frame_number:
                        socket.frameCount,

                    opcode:
                        response.opcode,

                    encoding:
                        decoded.encoding,

                    actual_size:
                        actualSize,

                    classification,

                    matched_indicators:
                        matchedIndicators,

                    saved:
                        isLarge
                };


                const eventsFile =
                    path.join(
                        socket.wsDir,
                        "events.jsonl"
                    );


                fs.appendFileSync(

                    eventsFile,

                    JSON.stringify(
                        eventRecord
                    ) + "\n"
                );



                // =================================================
                // SMALL STREAMCONTROLLER FRAME
                // =================================================

                if (
                    !isLarge
                ) {

                    socket.skippedSmallFrameCount++;


                    console.log("");

                    console.log(
                        `[FRAME ${socket.frameCount}]`
                    );

                    console.log(
                        `  Request: ${requestId}`
                    );

                    console.log(
                        `  Actual size: ${actualSize} bytes`
                    );

                    console.log(
                        `  Status: 👂 LISTENING / NOT SAVING`
                    );

                    console.log(
                        `  Reason: below ${LARGE_FRAME_THRESHOLD} byte threshold`
                    );


                    if (
                        matchedIndicators.length > 0
                    ) {

                        console.log(
                            `  🔎 Indicators: ${matchedIndicators.join(", ")}`
                        );
                    }


                    return;
                }



                // =================================================
                // LARGE STREAMCONTROLLER FRAME
                // =================================================

                socket.savedFrameCount++;


                // -----------------------------------------
                // Preserve raw CDP payload.
                //
                // For binary frames this remains Base64.
                // -----------------------------------------

                const frame = {

                    received_at:
                        timestamp(),

                    chrome_timestamp:
                        chromeTimestamp,

                    request_id:
                        requestId,

                    frame_number:
                        socket.frameCount,

                    opcode:
                        response.opcode,

                    payload_encoding:
                        decoded.encoding,

                    actual_size:
                        actualSize,

                    raw_cdp_payload_size:
                        Buffer.byteLength(
                            response.payloadData || ""
                        ),

                    classification,

                    matched_indicators:
                        matchedIndicators,

                    payload:
                        decoded.rawPayload
                };


                const frameFile =
                    path.join(
                        socket.wsDir,
                        "frames.jsonl"
                    );


                fs.appendFileSync(

                    frameFile,

                    JSON.stringify(
                        frame
                    ) + "\n"
                );



                // =================================================
                // LARGE FRAME TERMINAL OUTPUT
                // =================================================

                console.log("");

                console.log(
                    "================================================"
                );

                console.log(
                    "🔥 LARGE STREAMCONTROLLER FRAME"
                );

                console.log(
                    `Frame:       ${socket.frameCount}`
                );

                console.log(
                    `Actual size: ${actualSize} bytes`
                );

                console.log(
                    `Actual size: ${(actualSize / 1024).toFixed(2)} KB`
                );

                console.log(
                    `Raw Base64:  ${Buffer.byteLength(decoded.rawPayload)} bytes`
                );

                console.log(
                    "Status:      💾 SAVED"
                );

                console.log(
                    `Type:        ${classification}`
                );


                if (
                    matchedIndicators.length > 0
                ) {

                    console.log(
                        `🔎 Indicators: ${matchedIndicators.join(", ")}`
                    );

                } else {

                    console.log(
                        "🔎 Indicators: none"
                    );
                }


                console.log(
                    `File: ${frameFile}`
                );

                console.log(
                    "================================================"
                );
            }
        );



        // =================================================
        // WEBSOCKET CLOSED
        // =================================================

        cdp.on(
            "Network.webSocketClosed",
            event => {

                const socket =
                    sockets.get(
                        event.requestId
                    );


                const socketIdentity =
                    allSockets.get(
                        event.requestId
                    );


                if (
                    !socket
                ) {

                    console.log(
                        `[WS CLOSED] ${event.requestId} | TYPE: ${
                            socketIdentity
                                ? socketIdentity.type.toUpperCase()
                                : "PRE-EXISTING / UNSEEN"
                        }`
                    );


                    if (
                        socketIdentity
                    ) {

                        console.log(
                            `URL: ${socketIdentity.url}`
                        );
                    }


                    return;
                }


                console.log("");

                console.log(
                    "================================================"
                );

                console.log(
                    `[WS CLOSED] ${event.requestId}`
                );

                console.log(
                    "TYPE: STREAMCONTROLLER"
                );

                console.log(
                    `Total frames: ${socket.frameCount}`
                );

                console.log(
                    `Large frames: ${socket.largeFrameCount}`
                );

                console.log(
                    `Saved frames: ${socket.savedFrameCount}`
                );

                console.log(
                    `Small frames skipped: ${socket.skippedSmallFrameCount}`
                );

                console.log(
                    `Notification candidates: ${socket.interestingFrameCount}`
                );

                console.log(
                    "================================================"
                );

                console.log("");
            }
        );
    }



    // =====================================================
    // FIND FACEBOOK PAGE
    // =====================================================

    const pages =
        context.pages();


    let page =
        pages.find(
            existingPage =>
                existingPage.url().includes(
                    "facebook.com"
                )
        );



    // =====================================================
    // FACEBOOK NOT OPEN
    // =====================================================

    if (
        !page
    ) {

        console.log("");

        console.log(
            "================================================"
        );

        console.log(
            "No Facebook page found."
        );

        console.log(
            "Opening Facebook in existing Chrome..."
        );

        console.log(
            "================================================"
        );

        console.log("");


        page =
            await context.newPage();


        // Attach BEFORE navigation so all WebSockets
        // created during Facebook startup are observed.
        await attachToPage(
            page
        );


        console.log(
            "Navigating to Facebook..."
        );


        await page.goto(
            START_URL,
            {
                waitUntil:
                    "domcontentloaded"
            }
        );


        console.log(
            "Facebook loaded."
        );

        console.log("");
    }



    // =====================================================
    // FACEBOOK ALREADY OPEN
    // =====================================================

    else {

        console.log("");

        console.log(
            "================================================"
        );

        console.log(
            "Existing Facebook page found."
        );

        console.log(
            `URL: ${page.url()}`
        );

        console.log(
            "Attaching without reload..."
        );

        console.log(
            "================================================"
        );

        console.log("");


        // IMPORTANT:
        // Existing Facebook page is NOT reloaded.
        await attachToPage(
            page
        );
    }



    // =====================================================
    // ATTACH TO OTHER EXISTING PAGES
    // =====================================================

    for (
        const existingPage of context.pages()
    ) {

        if (
            existingPage === page
        ) {

            continue;
        }


        try {

            await attachToPage(
                existingPage
            );

        } catch (error) {

            console.error(
                `[PAGE ATTACH ERROR] ${error.message}`
            );
        }
    }



    // =====================================================
    // FUTURE PAGES
    // =====================================================

    context.on(
        "page",
        async newPage => {

            console.log("");

            console.log(
                `[NEW PAGE] ${newPage.url()}`
            );


            try {

                await attachToPage(
                    newPage
                );

            } catch (error) {

                console.error(
                    `[PAGE ATTACH ERROR] ${error.message}`
            );
            }
        }
    );



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

    console.log("");

    console.log(
        "Tracking ALL observed WebSocket identities."
    );

    console.log(
        "Saving full payload ONLY for streamcontroller"
    );

    console.log(
        `frames >= ${LARGE_FRAME_THRESHOLD} actual bytes.`
    );

    console.log("");

    console.log(
        "Small streamcontroller frames:"
    );

    console.log(
        "  👂 LISTENING / NOT SAVING"
    );

    console.log("");

    console.log(
        "Large streamcontroller frames:"
    );

    console.log(
        "  💾 SAVING"
    );

    console.log("");

    console.log(
        "Large unresolved frames:"
    );

    console.log(
        "  💾 SAVING to unresolved-large/"
    );

    console.log("");

    console.log(
        "Notification indicators:"
    );

    console.log(
        "  group_activity"
    );

    console.log(
        "  all_posts"
    );

    console.log(
        "  notifications_page"
    );

    console.log(
        "  CometNotificationsReceiveLiveQuery"
    );

    console.log(
        "  context_id"
    );

    console.log(
        "  content_id"
    );

    console.log("");

    console.log(
        `Capture directory: ${sessionDir}`
    );

    console.log("");

    console.log(
        "Press Ctrl+C to stop."
    );

    console.log("");



    // =====================================================
    // SHUTDOWN
    // =====================================================

    process.on(
        "SIGINT",
        async () => {

            console.log("");

            console.log(
                "Stopping recorder..."
            );

            console.log("");

            console.log(
                `Capture saved at: ${sessionDir}`
            );

            console.log("");

            console.log(
                "Chrome will remain running."
            );

            console.log("");

            process.exit(0);
        }
    );

})();