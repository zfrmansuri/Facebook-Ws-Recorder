const fs = require("fs");

const NOTIFICATION_INDICATORS = [
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
// FILE
// =========================================================

function appendJsonl(file, value) {
    if (!file) {
        return;
    }

    fs.appendFileSync(
        file,
        JSON.stringify(value) + "\n"
    );
}


// =========================================================
// OBJECT WALKER
// =========================================================

function walk(root, visitor) {
    const stack = [root];
    const visited = new Set();

    while (stack.length > 0) {
        const current = stack.pop();

        if (
            current === null ||
            current === undefined ||
            typeof current !== "object"
        ) {
            continue;
        }

        if (visited.has(current)) {
            continue;
        }

        visited.add(current);

        visitor(current);

        for (const value of Object.values(current)) {
            if (
                value !== null &&
                typeof value === "object"
            ) {
                stack.push(value);
            }
        }
    }
}


// =========================================================
// SAFE JSON PARSING
// =========================================================

function parseJsonString(value) {
    if (
        value !== null &&
        typeof value === "object"
    ) {
        return value;
    }

    if (typeof value !== "string") {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}


// =========================================================
// BALANCED JSON EXTRACTION
//
// Facebook prepends binary/protocol bytes before the JSON.
// We therefore cannot JSON.parse(decodedText) directly.
//
// This parser understands strings and escaped characters,
// so braces inside URLs/text/tracking strings do not break it.
// =========================================================

function extractBalancedJson(text, start) {
    if (
        start < 0 ||
        start >= text.length
    ) {
        return null;
    }

    const opening = text[start];

    if (
        opening !== "{" &&
        opening !== "["
    ) {
        return null;
    }

    const stack = [
        opening === "{"
            ? "}"
            : "]"
    ];

    let inString = false;
    let escaped = false;

    for (
        let i = start + 1;
        i < text.length;
        i++
    ) {
        const char = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === "\"") {
                inString = false;
            }

            continue;
        }

        if (char === "\"") {
            inString = true;
            continue;
        }

        if (
            char === "{" ||
            char === "["
        ) {
            stack.push(
                char === "{"
                    ? "}"
                    : "]"
            );

            continue;
        }

        if (
            char === "}" ||
            char === "]"
        ) {
            if (
                stack[
                    stack.length - 1
                ] !== char
            ) {
                return null;
            }

            stack.pop();

            if (stack.length === 0) {
                return text.slice(
                    start,
                    i + 1
                );
            }
        }
    }

    return null;
}


// =========================================================
// FIND MAIN FACEBOOK JSON ROOT
//
// Current payload shape:
//
// [binary protocol prefix]
// {"last_response_digest":"..."}
// [binary bytes]
// {"data":{...notifications_page...}}
//
// We specifically search for JSON roots beginning with
// {"data": and choose the one containing notifications_page.
//
// We do NOT assume byte offset 79/80.
// =========================================================

function parsePayloadJson(text) {
    const rootMarkers = [
        "{\"data\":",
        "{\"data\" :"
    ];

    let searchFrom = 0;

    while (
        searchFrom < text.length
    ) {
        let bestIndex = -1;

        for (
            const marker of rootMarkers
        ) {
            const index =
                text.indexOf(
                    marker,
                    searchFrom
                );

            if (
                index !== -1 &&
                (
                    bestIndex === -1 ||
                    index < bestIndex
                )
            ) {
                bestIndex = index;
            }
        }

        if (bestIndex === -1) {
            break;
        }

        const candidate =
            extractBalancedJson(
                text,
                bestIndex
            );

        if (candidate) {
            try {
                const parsed =
                    JSON.parse(
                        candidate
                    );

                if (
                    parsed &&
                    typeof parsed === "object"
                ) {
                    return parsed;
                }
            } catch {
                // Continue searching for another root.
            }
        }

        searchFrom =
            bestIndex + 1;
    }

    // -----------------------------------------------------
    // Fallback:
    //
    // If Facebook changes whitespace or the root shape,
    // scan JSON-looking objects but cap the attempts so
    // this cannot become an expensive O(n²) operation.
    // -----------------------------------------------------

    let attempts = 0;

    for (
        let i = 0;
        i < text.length &&
        attempts < 200;
        i++
    ) {
        if (
            text[i] !== "{" &&
            text[i] !== "["
        ) {
            continue;
        }

        attempts++;

        const candidate =
            extractBalancedJson(
                text,
                i
            );

        if (!candidate) {
            continue;
        }

        try {
            const parsed =
                JSON.parse(
                    candidate
                );

            if (
                parsed &&
                typeof parsed === "object" &&
                containsNotificationsPage(
                    parsed
                )
            ) {
                return parsed;
            }
        } catch {
            // Try next candidate.
        }
    }

    return null;
}


// =========================================================
// CHECK WHETHER AN OBJECT CONTAINS notifications_page
// =========================================================

function containsNotificationsPage(root) {
    let found = false;

    walk(
        root,
        object => {
            if (
                Object.prototype.hasOwnProperty.call(
                    object,
                    "notifications_page"
                )
            ) {
                found = true;
            }
        }
    );

    return found;
}


// =========================================================
// FIND ACTUAL NOTIFICATION OBJECTS
//
// Important:
//
// tracking itself contains:
//
// {
//     "notif_type": "group_activity",
//     "subtype": "all_posts",
//     ...
// }
//
// Therefore we MUST require the outer object to also have
// a "tracking" property.
//
// This prevents the tracking JSON object itself from being
// mistaken for the notification.
// =========================================================

function findNotificationObjects(root) {
    const notifications = [];

    walk(
        root,
        object => {
            if (
                typeof object.notif_type !==
                    "string"
            ) {
                return;
            }

            const hasTracking =
                typeof object.tracking ===
                    "string" ||
                (
                    object.tracking !== null &&
                    typeof object.tracking ===
                        "object"
                );

            if (!hasTracking) {
                return;
            }

            notifications.push(
                object
            );
        }
    );

    return notifications;
}


// =========================================================
// FIND GROUP ENTITY
// =========================================================

function findGroupEntity(body) {
    let result = null;

    walk(
        body,
        object => {
            if (result) {
                return;
            }

            if (
                !object.entity ||
                typeof object.entity !==
                    "object"
            ) {
                return;
            }

            const entity =
                object.entity;

            if (!entity.id) {
                return;
            }

            const type =
                String(
                    entity.__typename ||
                    entity.type ||
                    ""
                ).toLowerCase();

            const url =
                String(
                    entity.url ||
                    entity.profile_url ||
                    ""
                ).toLowerCase();

            if (
                type.includes("group") ||
                url.includes("/groups/")
            ) {
                result = entity;
            }
        }
    );

    return result;
}


// =========================================================
// GROUP NAME
//
// Group entities in the captured payload often contain no
// "name" field.
//
// Examples of body.text:
//
// "Now in Luxury Real Estate Group: \"...\""
// "Now in Real Estate & Construction Business: \"...\""
// "USA Real Estate Investors has a new post."
// =========================================================

function deriveGroupName(
    groupEntity,
    bodyText
) {
    if (
        groupEntity &&
        (
            groupEntity.name ||
            groupEntity.title
        )
    ) {
        return (
            groupEntity.name ||
            groupEntity.title
        );
    }

    if (
        typeof bodyText !== "string"
    ) {
        return null;
    }

    const nowInMatch =
        bodyText.match(
            /^Now in\s+(.+?):\s*/i
        );

    if (nowInMatch) {
        return nowInMatch[1].trim();
    }

    const newPostMatch =
        bodyText.match(
            /^(.+?)\s+has a new post\.?$/i
        );

    if (newPostMatch) {
        return newPostMatch[1].trim();
    }

    return null;
}


// =========================================================
// NORMALIZE ID
// =========================================================

function normalizeId(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }

    return String(value);
}


// =========================================================
// URL QUERY PARAMETER
// =========================================================

function getQueryParameter(
    url,
    parameter
) {
    if (
        typeof url !== "string"
    ) {
        return null;
    }

    try {
        const parsed =
            new URL(url);

        return (
            parsed.searchParams.get(
                parameter
            ) || null
        );
    } catch {
        // Facebook URLs can occasionally be
        // partially malformed. Use a fallback.
        const escaped =
            parameter.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
            );

        const match =
            url.match(
                new RegExp(
                    `[?&]${escaped}=([^&#]+)`
                )
            );

        return match
            ? decodeURIComponent(
                match[1]
            )
            : null;
    }
}


// =========================================================
// CREATE FILTER
// =========================================================

function createNotificationFilter({
    recordFile,
    onNewGroupSignal
}) {
    const seenEvents = new Set();

    let baselineEstablished = false;

    return {
        process(
            decodedText,
            frameContext = {}
        ) {
            if (
                typeof decodedText !==
                "string" ||
                decodedText.length === 0
            ) {
                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators: [],
                    events: []
                };
            }

            // -------------------------------------------------
            // CHEAP FIRST PASS
            // -------------------------------------------------

            const lower =
                decodedText.toLowerCase();

            const matchedIndicators =
                NOTIFICATION_INDICATORS.filter(
                    indicator =>
                        lower.includes(
                            indicator
                        )
                );

            // Most WebSocket frames die here.
            if (
                !lower.includes(
                    "notifications_page"
                )
            ) {
                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators,
                    events: []
                };
            }

            // -------------------------------------------------
            // PARSE FACEBOOK JSON ROOT
            // -------------------------------------------------

            const root =
                parsePayloadJson(
                    decodedText
                );

            if (!root) {
                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators,
                    events: [],
                    parseFailed: true
                };
            }

            // -------------------------------------------------
            // FIND OUTER NOTIFICATION OBJECTS
            // -------------------------------------------------

            const notifications =
                findNotificationObjects(
                    root
                );

            if (
                notifications.length === 0
            ) {
                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators,
                    events: []
                };
            }

            // -------------------------------------------------
            // IMPORTANT:
            //
            // Parse tracking BEFORE checking subtype.
            //
            // subtype is inside tracking in the real payload.
            // -------------------------------------------------

            const candidates = [];

            for (
                const notification of
                    notifications
            ) {
                if (
                    notification.notif_type !==
                    "group_activity"
                ) {
                    continue;
                }

                const tracking =
                    parseJsonString(
                        notification.tracking
                    );

                if (!tracking) {
                    continue;
                }

                const subtype =
                    String(
                        tracking.subtype ||
                        ""
                    );

                if (
                    subtype !==
                    "all_posts"
                ) {
                    continue;
                }

                candidates.push({
                    notification,
                    tracking
                });
            }

            if (
                candidates.length === 0
            ) {
                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators,
                    events: []
                };
            }

            // -------------------------------------------------
            // DEDUPLICATE WITHIN THIS SINGLE RESPONSE
            //
            // Facebook sends the same notification twice:
            //
            // notif
            // navigation_endpoint...notif
            //
            // Both represent the same event.
            // -------------------------------------------------

            const frameEventKeys =
                new Set();

            const extracted = [];

            let newSignals = 0;

            for (
                const {
                    notification,
                    tracking
                } of candidates
            ) {
                const contextId =
                    normalizeId(
                        tracking.context_id
                    );

                const contentId =
                    normalizeId(
                        tracking.content_id
                    );

                const notifId =
                    normalizeId(
                        tracking.notif_id ||
                        tracking.alert_id ||
                        notification.notif_id
                    );

                const groupEntity =
                    findGroupEntity(
                        notification.body
                    );

                const groupId =
                    normalizeId(
                        groupEntity &&
                        groupEntity.id
                    );

                const groupUrl =
                    groupEntity &&
                    (
                        groupEntity.url ||
                        groupEntity.profile_url ||
                        null
                    );

                const bodyText =
                    notification.body &&
                    typeof notification.body.text ===
                        "string"
                        ? notification.body.text
                        : null;

                const groupName =
                    deriveGroupName(
                        groupEntity,
                        bodyText
                    );

                const contextMatchesGroup =
                    Boolean(
                        contextId &&
                        groupId &&
                        contextId === groupId
                    );

                const notificationUrl =
                    notification.url ||
                    null;

                const multiPermalinks =
                    getQueryParameter(
                        notificationUrl,
                        "multi_permalinks"
                    );

                // -------------------------------------------------
                // We currently use context_id + content_id as
                // the stable event identity.
                //
                // Do NOT call multi_permalinks the canonical
                // post ID yet. Your captures show that it can
                // differ from content_id.
                // -------------------------------------------------

                const eventKey =
                    contextId &&
                    contentId
                        ? `${contextId}:${contentId}`
                        : null;

                // Invalid/incomplete notification.
                if (
                    !contextMatchesGroup ||
                    !eventKey
                ) {
                    continue;
                }

                // Duplicate copy inside the same WebSocket frame.
                if (
                    frameEventKeys.has(
                        eventKey
                    )
                ) {
                    continue;
                }

                frameEventKeys.add(
                    eventKey
                );

                let state;

                if (
                    !baselineEstablished
                ) {
                    state = "baseline";
                } else if (
                    seenEvents.has(
                        eventKey
                    )
                ) {
                    state = "duplicate";
                } else {
                    state = "new";
                    newSignals++;
                }

                seenEvents.add(
                    eventKey
                );

                const event = {
                    recorded_at:
                        new Date().toISOString(),

                    received_at:
                        frameContext.receivedAt ||
                        null,

                    request_id:
                        frameContext.requestId ||
                        null,

                    chrome_timestamp:
                        frameContext.chromeTimestamp ||
                        null,

                    notif_type:
                        notification.notif_type,

                    subtype:
                        tracking.subtype ||
                        null,

                    state,

                    event_key:
                        eventKey,

                    group_id:
                        groupId,

                    group_name:
                        groupName,

                    group_url:
                        groupUrl,

                    context_id:
                        contextId,

                    content_id:
                        contentId,

                    notif_id:
                        notifId,

                    microtime_sent:
                        tracking.microtime_sent ??
                        null,

                    creation_time:
                        notification.creation_time ??
                        null,

                    context_matches_group:
                        contextMatchesGroup,

                    notification_url:
                        notificationUrl,

                    multi_permalinks:
                        multiPermalinks,

                    notification_text:
                        bodyText
                };

                appendJsonl(
                    recordFile,
                    event
                );

                extracted.push(
                    event
                );
            }

            // -------------------------------------------------
            // BASELINE
            //
            // The first valid batch establishes the existing
            // notification state.
            //
            // If a response contains no valid group events,
            // baseline remains untouched.
            // -------------------------------------------------

            if (
                extracted.length > 0 &&
                !baselineEstablished
            ) {
                baselineEstablished = true;
            }

            // -------------------------------------------------
            // NEW SIGNAL CALLBACKS
            // -------------------------------------------------

            for (
                const signal of extracted
            ) {
                if (
                    signal.state === "new" &&
                    typeof onNewGroupSignal ===
                        "function"
                ) {
                    onNewGroupSignal(
                        signal
                    );
                }
            }

            return {
                notificationsFound:
                    extracted.length,

                newSignals,

                matchedIndicators,

                events:
                    extracted
            };
        }
    };
}


module.exports = {
    createNotificationFilter
};