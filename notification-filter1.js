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

function appendJsonl(file, value) {
    if (!file) return;

    fs.appendFileSync(
        file,
        JSON.stringify(value) + "\n"
    );
}

/*
 * Walk objects in natural JSON order.
 *
 * The order matters because the first relevant notification
 * in Facebook's payload is the event we want to use as the
 * group signal.
 */
function walk(root, visitor) {
    const visited = new Set();

    function visit(value) {
        if (
            value === null ||
            typeof value !== "object" ||
            visited.has(value)
        ) {
            return;
        }

        visited.add(value);
        visitor(value);

        for (const child of Object.values(value)) {
            visit(child);
        }
    }

    visit(root);
}

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

function extractBalancedJson(text, start) {
    if (
        start < 0 ||
        start >= text.length ||
        (text[start] !== "{" && text[start] !== "[")
    ) {
        return null;
    }

    const stack = [
        text[start] === "{" ? "}" : "]"
    ];

    let inString = false;
    let escaped = false;

    for (let i = start + 1; i < text.length; i++) {
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

        if (char === "{" || char === "[") {
            stack.push(
                char === "{" ? "}" : "]"
            );
            continue;
        }

        if (char === "}" || char === "]") {
            if (stack[stack.length - 1] !== char) {
                return null;
            }

            stack.pop();

            if (stack.length === 0) {
                return text.slice(start, i + 1);
            }
        }
    }

    return null;
}

function containsNotificationsPage(root) {
    let found = false;

    walk(root, object => {
        if (
            Object.prototype.hasOwnProperty.call(
                object,
                "notifications_page"
            )
        ) {
            found = true;
        }
    });

    return found;
}

function parsePayloadJson(text) {
    const markers = [
        "{\"data\":",
        "{\"data\" :"
    ];

    let searchFrom = 0;

    while (searchFrom < text.length) {
        let index = -1;

        for (const marker of markers) {
            const found = text.indexOf(
                marker,
                searchFrom
            );

            if (
                found !== -1 &&
                (index === -1 || found < index)
            ) {
                index = found;
            }
        }

        if (index === -1) {
            break;
        }

        const candidate = extractBalancedJson(
            text,
            index
        );

        if (candidate) {
            try {
                const parsed = JSON.parse(candidate);

                if (
                    parsed &&
                    typeof parsed === "object"
                ) {
                    return parsed;
                }
            } catch {
                // Keep looking.
            }
        }

        searchFrom = index + 1;
    }

    /*
     * Fallback for minor Facebook payload format changes.
     */
    let attempts = 0;

    for (
        let i = 0;
        i < text.length && attempts < 200;
        i++
    ) {
        if (
            text[i] !== "{" &&
            text[i] !== "["
        ) {
            continue;
        }

        attempts++;

        const candidate = extractBalancedJson(
            text,
            i
        );

        if (!candidate) continue;

        try {
            const parsed = JSON.parse(candidate);

            if (
                parsed &&
                typeof parsed === "object" &&
                containsNotificationsPage(parsed)
            ) {
                return parsed;
            }
        } catch {
            // Keep looking.
        }
    }

    return null;
}

/*
 * Find notification-like objects without requiring
 * Facebook to expose a particular notification type.
 *
 * The only structural requirement here is tracking data.
 * The actual group identity is determined later from
 * tracking.context_id.
 */
function findNotificationObjects(root) {
    const notifications = [];

    walk(root, object => {
        const hasTracking =
            typeof object.tracking === "string" ||
            (
                object.tracking &&
                typeof object.tracking === "object"
            );

        if (hasTracking) {
            notifications.push(object);
        }
    });

    return notifications;
}

function findGroupEntity(body) {
    let result = null;

    walk(body, object => {
        if (result || !object.entity) {
            return;
        }

        const entity = object.entity;

        if (!entity.id) {
            return;
        }

        const type = String(
            entity.__typename ||
            entity.type ||
            ""
        ).toLowerCase();

        const url = String(
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
    });

    return result;
}

function deriveGroupName(groupEntity, bodyText) {
    if (
        groupEntity &&
        (groupEntity.name || groupEntity.title)
    ) {
        return (
            groupEntity.name ||
            groupEntity.title
        );
    }

    if (typeof bodyText !== "string") {
        return null;
    }

    const nowIn = bodyText.match(
        /^Now in\s+(.+?):\s*/i
    );

    if (nowIn) {
        return nowIn[1].trim();
    }

    const newPost = bodyText.match(
        /^(.+?)\s+has a new post\.?$/i
    );

    if (newPost) {
        return newPost[1].trim();
    }

    return null;
}

function getQueryParameter(url, parameter) {
    if (typeof url !== "string") {
        return null;
    }

    try {
        return (
            new URL(url)
                .searchParams
                .get(parameter) || null
        );
    } catch {
        return null;
    }
}

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

function timestampIST() {
    return new Date().toLocaleString(
        "en-IN",
        {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }
    );
}

function createNotificationFilter({
    recordFile,
    onNewGroupSignal
}) {
    return {
        process(decodedText, frameContext = {}) {
            if (
                typeof decodedText !== "string" ||
                !decodedText
            ) {
                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators: [],
                    events: []
                };
            }

            const lower = decodedText.toLowerCase();

            const matchedIndicators =
                NOTIFICATION_INDICATORS.filter(
                    indicator =>
                        lower.includes(indicator)
                );

            /*
             * Almost every WebSocket frame stops here.
             */
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

            const root = parsePayloadJson(
                decodedText
            );

            if (!root) {
                const result = {
                    recorded_at:
                        timestampIST(),

                    received_at:
                        frameContext.receivedAt || null,

                    request_id:
                        frameContext.requestId || null,

                    chrome_timestamp:
                        frameContext.chromeTimestamp || null,

                    parse_failed: true,

                    matchedIndicators
                };

                appendJsonl(
                    recordFile,
                    result
                );

                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators,
                    events: [],
                    parseFailed: true
                };
            }

            const notifications =
                findNotificationObjects(root);

            /*
             * Find the FIRST notification in natural
             * JSON order that contains the group identity.
             *
             * We only need context_id to wake the scanner.
             *
             * No dependency on:
             * - notif_type
             * - subtype
             * - content_id
             * - notif_id
             * - multi_permalinks
             */
            let selected = null;

            for (const notification of notifications) {
                const tracking =
                    parseJsonString(
                        notification.tracking
                    );

                if (!tracking) {
                    continue;
                }

                const groupId =
                    normalizeId(
                        tracking.context_id
                    );

                if (!groupId) {
                    continue;
                }

                selected = {
                    notification,
                    tracking,
                    groupId
                };

                break;
            }

            /*
             * No notification containing a group ID
             * was found in this response.
             */
            if (!selected) {
                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators,
                    events: []
                };
            }

            const {
                notification,
                tracking,
                groupId
            } = selected;

            const groupEntity =
                findGroupEntity(
                    notification.body
                );

            const embeddedGroupId =
                normalizeId(
                    groupEntity &&
                    groupEntity.id
                );

            const bodyText =
                notification.body &&
                typeof notification.body.text ===
                    "string"
                    ? notification.body.text
                    : null;

            const event = {
                recorded_at:
                    timestampIST(),

                received_at:
                    frameContext.receivedAt || null,

                request_id:
                    frameContext.requestId || null,

                chrome_timestamp:
                    frameContext.chromeTimestamp || null,

                /*
                 * These are metadata only.
                 * They are NOT used to decide whether
                 * this is a valid group signal.
                 */
                notif_type:
                    notification.notif_type ||
                    tracking.notif_type ||
                    null,

                subtype:
                    tracking.subtype ||
                    null,

                group_id:
                    groupId,

                group_name:
                    deriveGroupName(
                        groupEntity,
                        bodyText
                    ),

                group_url:
                    groupEntity &&
                    (
                        groupEntity.url ||
                        groupEntity.profile_url ||
                        null
                    ),

                context_id:
                    groupId,

                embedded_group_id:
                    embeddedGroupId,

                content_id:
                    normalizeId(
                        tracking.content_id
                    ),

                notif_id:
                    normalizeId(
                        tracking.notif_id ||
                        tracking.alert_id ||
                        notification.notif_id
                    ),

                microtime_sent:
                    tracking.microtime_sent ??
                    null,

                creation_time:
                    notification.creation_time ??
                    null,

                notification_url:
                    notification.url ||
                    null,

                multi_permalinks:
                    getQueryParameter(
                        notification.url,
                        "multi_permalinks"
                    ),

                notification_text:
                    bodyText
            };

            /*
             * One JSONL record for one relevant
             * WebSocket response.
             */
            appendJsonl(
                recordFile,
                event
            );

            /*
             * One response = one signal.
             *
             * No baseline.
             * No cross-response deduplication.
             */
            if (
                typeof onNewGroupSignal ===
                "function"
            ) {
                onNewGroupSignal(event);
            }

            return {
                notificationsFound: 1,
                newSignals: 1,
                matchedIndicators,
                events: [event]
            };
        }
    };
}

module.exports = {
    createNotificationFilter
};