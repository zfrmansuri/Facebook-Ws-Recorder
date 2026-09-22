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
    fs.appendFileSync(
        file,
        JSON.stringify(value) + "\n"
    );
}

function firstValue(object, keys) {
    if (!object || typeof object !== "object") {
        return null;
    }

    const wanted = new Set(keys);

    const stack = [object];
    const visited = new Set();

    while (stack.length > 0) {
        const current = stack.pop();

        if (!current || typeof current !== "object") {
            continue;
        }

        if (visited.has(current)) {
            continue;
        }

        visited.add(current);

        if (!Array.isArray(current)) {
            for (const key of wanted) {
                if (
                    Object.prototype.hasOwnProperty.call(
                        current,
                        key
                    ) &&
                    current[key] !== null &&
                    current[key] !== undefined
                ) {
                    return current[key];
                }
            }
        }

        for (const value of Object.values(current)) {
            if (value && typeof value === "object") {
                stack.push(value);
            }
        }
    }

    return null;
}

function walk(object, visitor) {
    const stack = [object];
    const visited = new Set();

    while (stack.length > 0) {
        const current = stack.pop();

        if (!current || typeof current !== "object") {
            continue;
        }

        if (visited.has(current)) {
            continue;
        }

        visited.add(current);

        visitor(current);

        for (const value of Object.values(current)) {
            if (value && typeof value === "object") {
                stack.push(value);
            }
        }
    }
}

function parseJsonString(value) {
    if (typeof value === "object" && value !== null) {
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
    const opening = text[start];

    if (opening !== "{" && opening !== "[") {
        return null;
    }

    const stack = [
        opening === "{" ? "}" : "]"
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
            } else if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
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
                return text.slice(
                    start,
                    i + 1
                );
            }
        }
    }

    return null;
}

function parsePayloadJson(text) {
    const candidates = [];

    for (let i = 0; i < text.length; i++) {
        if (
            text[i] === "{" ||
            text[i] === "["
        ) {
            candidates.push(i);

            if (candidates.length >= 50) {
                break;
            }
        }
    }

    for (const start of candidates) {
        const candidate =
            extractBalancedJson(
                text,
                start
            );

        if (!candidate) {
            continue;
        }

        try {
            return JSON.parse(candidate);
        } catch {
            // Try the next possible JSON root.
        }
    }

    return null;
}

function findNotificationObjects(root) {
    const notifications = [];

    walk(
        root,
        object => {
            if (
                typeof object.notif_type === "string" &&
                (
                    typeof object.tracking === "string" ||
                    (
                        object.tracking &&
                        typeof object.tracking === "object"
                    )
                )
            ) {
                notifications.push(
                    object
                );
            }
        }
    );

    return notifications;
}

function findGroupEntity(body) {
    let result = null;

    walk(
        body,
        object => {
            if (result || !object.entity) {
                return;
            }

            const entity =
                object.entity;

            if (
                !entity ||
                typeof entity !== "object" ||
                !entity.id
            ) {
                return;
            }

            const url =
                entity.url ||
                entity.profile_url ||
                "";

            const type =
                String(
                    entity.__typename ||
                    entity.type ||
                    ""
                ).toLowerCase();

            if (
                type.includes("group") ||
                String(url).includes("/groups/")
            ) {
                result = entity;
            }
        }
    );

    return result;
}

function normalizeId(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    return String(value);
}

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
            const lower =
                decodedText.toLowerCase();

            const matchedIndicators =
                NOTIFICATION_INDICATORS.filter(
                    indicator =>
                        lower.includes(
                            indicator
                        )
                );

            if (
                !lower.includes(
                    "notifications_page"
                )
            ) {
                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators
                };
            }

            const root =
                parsePayloadJson(
                    decodedText
                );

            if (!root) {
                return {
                    notificationsFound: 0,
                    newSignals: 0,
                    matchedIndicators,
                    parseFailed: true
                };
            }

            const notifications =
                findNotificationObjects(
                    root
                );

            const groupNotifications =
                notifications.filter(
                    notification =>
                        notification.notif_type ===
                            "group_activity" &&
                        String(
                            notification.subtype || ""
                        ) === "all_posts"
                );

            let newSignals = 0;

            const extracted = [];

            for (
                const notification of groupNotifications
            ) {
                const tracking =
                    parseJsonString(
                        notification.tracking
                    ) || {};

                const contextId =
                    normalizeId(
                        firstValue(
                            tracking,
                            ["context_id"]
                        )
                    );

                const contentId =
                    normalizeId(
                        firstValue(
                            tracking,
                            ["content_id"]
                        )
                    );

                const notifId =
                    normalizeId(
                        firstValue(
                            tracking,
                            ["notif_id"]
                        ) ||
                        notification.notif_id
                    );

                const microtimeSent =
                    firstValue(
                        tracking,
                        ["microtime_sent"]
                    );

                const creationTime =
                    firstValue(
                        tracking,
                        ["creation_time"]
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

                const groupName =
                    groupEntity &&
                    (
                        groupEntity.name ||
                        groupEntity.title ||
                        null
                    );

                const contextMatchesGroup =
                    Boolean(
                        contextId &&
                        groupId &&
                        contextId === groupId
                    );

                const eventKey =
                    contextId &&
                    contentId
                        ? `${contextId}:${contentId}`
                        : null;

                let state = "ignored";

                if (
                    contextMatchesGroup &&
                    eventKey
                ) {
                    if (!baselineEstablished) {
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
                }

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
                        notification.subtype ||
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
                        microtimeSent ??
                        null,

                    creation_time:
                        creationTime ??
                        null,

                    context_matches_group:
                        contextMatchesGroup,

                    notification_url:
                        notification.url ||
                        null
                };

                appendJsonl(
                    recordFile,
                    event
                );

                extracted.push(
                    event
                );
            }

            if (
                groupNotifications.length > 0 &&
                !baselineEstablished
            ) {
                baselineEstablished = true;
            }

            for (const signal of extracted) {
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
                    groupNotifications.length,

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