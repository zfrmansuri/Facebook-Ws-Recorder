"use strict";

const fs = require("fs");
const path = require("path");

// =========================================================
// CONFIGURATION
// =========================================================

const NOTIFICATION_INDICATORS = [
    "group_activity",
    "all_posts",
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

const REQUIRED_INDICATORS = [
    "notifications_page",
    "group_activity",
    "context_id"
];

const DEBUG_FILTER = false;

// Known group IDs -> slugs (used as a fallback when the
// URL slug and body text can't be parsed).
const KNOWN_GROUPS = {
    "1763837817231349": "LuxuryRealEstateGroup",
    "326738981445019": "usareinvestors",
    "596598397896838": "realestate.and.construction.business"
};

// Scrape throttle: don't scrape the same group more than
// once per COOLDOWN_MS, and never run two scrapes for the
// same group at once.
const SCRAPE_COOLDOWN_MS = 60 * 1000;

// =========================================================
// HELPERS
// =========================================================

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function debugLog(...args) {
    if (DEBUG_FILTER) {
        console.log("[FILTER]", ...args);
    }
}

// ---------------------------------------------------------
// Extract the first parseable JSON object that has `.data`.
// Handles CDP binary prefix and trailing bytes.
// ---------------------------------------------------------

function extractJson(text) {
    if (typeof text !== "string" || text.length === 0) {
        return null;
    }

    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return parsed;
    } catch {
        // ignore
    }

    const firstBrace = text.indexOf("{");
    if (firstBrace === -1) return null;

    const fromFirstBrace = text.slice(firstBrace);

    try {
        const parsed = JSON.parse(fromFirstBrace);
        if (parsed && typeof parsed === "object") return parsed;
    } catch {
        // ignore
    }

    let fallback = null;
    let fallbackLen = 0;

    const bracePositions = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "{") bracePositions.push(i);
    }

    for (let bi = bracePositions.length - 1; bi >= 0; bi--) {
        const start = bracePositions[bi];

        for (let end = text.length - 1; end > start; end--) {
            if (text[end] !== "}") continue;

            const candidate = text.slice(start, end + 1);

            let parsed;
            try {
                parsed = JSON.parse(candidate);
            } catch {
                continue;
            }

            if (!parsed || typeof parsed !== "object") continue;

            if (parsed.data && typeof parsed.data === "object") {
                return parsed;
            }

            if (candidate.length > fallbackLen) {
                fallback = parsed;
                fallbackLen = candidate.length;
            }
        }
    }

    return fallback;
}

// ---------------------------------------------------------
// Parse the tracking string on a notification row.
// ---------------------------------------------------------

function parseTracking(tracking) {
    if (typeof tracking !== "string" || tracking.length === 0) {
        return null;
    }
    try {
        return JSON.parse(tracking);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------
// Derive the group slug from a notification body.
//
// 1) Prefer body.ranges[].entity.url slug.
// 2) Fall back to body.text "Now in <Name>: ...".
// 3) Fall back to the KNOWN_GROUPS map (using the tracking
//    context_id, passed in by the caller).
// ---------------------------------------------------------

function deriveGroupSlug(notif, contextId) {
    // 1) URL slug
    try {
        const ranges = notif?.body?.ranges;
        if (Array.isArray(ranges)) {
            for (const range of ranges) {
                const url = range?.entity?.url;
                if (typeof url === "string") {
                    const m = url.match(/\/groups\/([^/?#]+)/);
                    if (m && m[1]) return m[1];
                }
            }
        }
    } catch {
        // ignore
    }

    // 2) Text fallback
    try {
        const text = notif?.body?.text;
        if (typeof text === "string") {
            const m = text.match(/^Now in\s+(.+?):/);
            if (m && m[1]) {
                return m[1].trim().replace(/\s+/g, "");
            }
        }
    } catch {
        // ignore
    }

    // 3) Known-groups fallback
    if (contextId && KNOWN_GROUPS[contextId]) {
        return KNOWN_GROUPS[contextId];
    }

    return null;
}

// ---------------------------------------------------------
// Extract all notification rows from a parsed response.
// ---------------------------------------------------------

function extractNotifications(parsed) {
    const out = [];

    const edges =
        parsed?.data?.viewer?.notifications_page?.edges;

    if (!Array.isArray(edges)) return out;

    for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        if (node.row_type !== "NOTIFICATION") continue;

        const notif = node.notif;
        if (!notif) continue;

        const tracking = parseTracking(notif.tracking);
        const contextId = tracking?.context_id ?? null;
        const contentId = tracking?.content_id ?? null;
        const notifId =
            notif.notif_id ?? tracking?.alert_id ?? null;

        if (!contextId) continue;

        const groupSlug = deriveGroupSlug(notif, contextId);

        out.push({
            notif_id: notifId,
            context_id: contextId,
            content_id: contentId,
            group_name: groupSlug,
            seen_state: notif.seen_state ?? null,
            notif_type: tracking?.notif_type ?? null,
            subtype: tracking?.subtype ?? null,
            unread: tracking?.unread ?? null,
            notif_tags: Array.isArray(notif.notif_tags)
                ? notif.notif_tags
                : [],
            cache_timestamp: notif.cache_timestamp ?? null,
            creation_time:
                notif.creation_time?.timestamp ?? null
        });
    }

    return out;
}

// ---------------------------------------------------------
// Determine which group triggered this frame.
//
// Rule: among rows with `unread: 1`, pick the one whose
// `creation_time` is closest to (but not after)
// `last_update_timestamp`.
// ---------------------------------------------------------

function computeVerdict(parsed, notifications) {
    const lastUpdate =
        parsed?.data?.viewer?.notifications_page
            ?.last_update_timestamp ?? null;

    const unread = notifications.filter(
        n => n.unread === 1 && typeof n.creation_time === "number"
    );

    if (unread.length === 0) {
        return { verdict: null, lastUpdateTimestamp: lastUpdate };
    }

    let best = null;
    let bestGap = Infinity;

    for (const n of unread) {
        if (lastUpdate && n.creation_time > lastUpdate) {
            continue;
        }
        const gap = lastUpdate
            ? lastUpdate - n.creation_time
            : -n.creation_time;
        if (gap < bestGap) {
            bestGap = gap;
            best = n;
        }
    }

    if (!best) {
        return { verdict: null, lastUpdateTimestamp: lastUpdate };
    }

    return {
        verdict: {
            group_id: best.context_id,
            group_name: best.group_name,
            notif_id: best.notif_id,
            content_id: best.content_id,
            creation_time: best.creation_time,
            last_update_timestamp: lastUpdate,
            gap_seconds: lastUpdate ? lastUpdate - best.creation_time : null
        },
        lastUpdateTimestamp: lastUpdate
    };
}

// ---------------------------------------------------------
// Indicator scan.
// ---------------------------------------------------------

function detectIndicators(text) {
    const found = [];
    for (const indicator of NOTIFICATION_INDICATORS) {
        if (text.includes(indicator)) found.push(indicator);
    }
    return found;
}

function hasRequiredIndicators(list) {
    for (const req of REQUIRED_INDICATORS) {
        if (!list.includes(req)) return false;
    }
    return true;
}

// ---------------------------------------------------------
// Format the verdict line.
// ---------------------------------------------------------

function formatTime(receivedAt) {
    const parts = String(receivedAt).split(",");
    if (parts.length >= 2) {
        return parts[parts.length - 1].trim();
    }
    return String(receivedAt);
}

function formatVerdictLine(verdict, receivedAt) {
    const time = formatTime(receivedAt);
    return `[${time}] 🎯 ${verdict.group_name || "Unknown"} (${verdict.group_id}) | notif=${verdict.notif_id} | content=${verdict.content_id} | gap=${verdict.gap_seconds}s`;
}

function formatHeartbeatLine(receivedAt) {
    const time = formatTime(receivedAt);
    return `[${time}] ⏸ heartbeat — no new event`;
}

// =========================================================
// FILTER FACTORY
// =========================================================

function createNotificationFilter(options) {
    options = options || {};

    const recordFile = options.recordFile || null;
    const verdictFile = options.verdictFile || null;

    const onNewGroupSignal =
        typeof options.onNewGroupSignal === "function"
            ? options.onNewGroupSignal
            : null;

    // Optional scraper. If provided, the filter will invoke
    // it whenever a verdict identifies a source group.
    const scrapeGroup =
        typeof options.scrapeGroup === "function"
            ? options.scrapeGroup
            : null;

    if (recordFile) ensureDir(path.dirname(recordFile));
    if (verdictFile) ensureDir(path.dirname(verdictFile));

    // ---------------------------------------------------------
    // Scrape throttle state.
    //
    // - inFlight: group IDs currently being scraped
    // - lastScrapeAt: group ID -> last scrape start (ms)
    // ---------------------------------------------------------

    const inFlight = new Set();
    const lastScrapeAt = new Map();

    function triggerScrape(groupId) {
        if (!scrapeGroup) {
            debugLog(
                `scrapeGroup not provided, skipping scrape for ${groupId}`
            );
            return;
        }

        if (!groupId) return;

        const now = Date.now();
        const last = lastScrapeAt.get(groupId) || 0;

        if (inFlight.has(groupId)) {
            console.log(
                `[filter] scrape already in flight for ${groupId}, skipping`
            );
            return;
        }

        if (now - last < SCRAPE_COOLDOWN_MS) {
            const remaining = Math.ceil(
                (SCRAPE_COOLDOWN_MS - (now - last)) / 1000
            );
            console.log(
                `[filter] scrape cooldown for ${groupId} (${remaining}s left), skipping`
            );
            return;
        }

        const url =
            `https://www.facebook.com/groups/${groupId}`;

        inFlight.add(groupId);
        lastScrapeAt.set(groupId, now);

        console.log(`[filter] triggering scrape: ${url}`);

        Promise.resolve()
            .then(() => scrapeGroup(url))
            .then(() => {
                console.log(
                    `[filter] scrape complete for ${groupId}`
                );
            })
            .catch(err => {
                console.error(
                    `[filter] scrape failed for ${groupId}:`,
                    err && err.message ? err.message : err
                );
            })
            .finally(() => {
                inFlight.delete(groupId);
            });
    }

    // ---------------------------------------------------------
    // process(decodedText, meta) -> result
    // ---------------------------------------------------------

    function process(decodedText, meta) {
        meta = meta || {};

        const result = {
            notificationsFound: 0,
            matchedIndicators: [],
            verdict: null,
            isHeartbeat: false,
            scrapeTriggered: false
        };

        if (typeof decodedText !== "string" || decodedText.length === 0) {
            return result;
        }

        const indicators = detectIndicators(decodedText);
        result.matchedIndicators = indicators;

        if (!hasRequiredIndicators(indicators)) {
            return result;
        }

        const parsed = extractJson(decodedText);
        if (!parsed) return result;

        const notifications = extractNotifications(parsed);
        result.notificationsFound = notifications.length;

        if (notifications.length === 0) return result;

        // ---------------------------------------------------
        // 1) Append every notification to notification-events.jsonl
        // ---------------------------------------------------

        if (recordFile) {
            try {
                const separator =
                    `--- FRAME ${meta.requestId ?? "?"} | ${meta.receivedAt ?? "?"} | ${notifications.length} notifications ---\n`;
                fs.appendFileSync(recordFile, separator);

                for (const n of notifications) {
                    const record = {
                        received_at: meta.receivedAt ?? null,
                        chrome_timestamp: meta.chromeTimestamp ?? null,
                        request_id: meta.requestId ?? null,
                        notif_id: n.notif_id,
                        context_id: n.context_id,
                        content_id: n.content_id,
                        group_name: n.group_name,
                        notif_type: n.notif_type,
                        subtype: n.subtype,
                        seen_state: n.seen_state,
                        unread: n.unread,
                        notif_tags: n.notif_tags,
                        cache_timestamp: n.cache_timestamp,
                        creation_time: n.creation_time
                    };
                    fs.appendFileSync(
                        recordFile,
                        JSON.stringify(record) + "\n"
                    );
                }
            } catch (err) {
                debugLog("record append error:", err.message);
            }
        }

        // ---------------------------------------------------
        // 2) Compute the verdict for this frame.
        // ---------------------------------------------------

        const { verdict } = computeVerdict(parsed, notifications);
        result.verdict = verdict;
        result.isHeartbeat = verdict === null;

        // ---------------------------------------------------
        // 3) Write the verdict line to group-verdicts.jsonl
        //    and pass it to the recorder callback.
        // ---------------------------------------------------

        let verdictLine;
        if (verdict) {
            verdictLine = formatVerdictLine(
                verdict,
                meta.receivedAt
            );
        } else {
            verdictLine = formatHeartbeatLine(meta.receivedAt);
        }

        if (verdictFile) {
            try {
                fs.appendFileSync(verdictFile, verdictLine + "\n");
            } catch (err) {
                debugLog("verdict append error:", err.message);
            }
        }

        if (onNewGroupSignal) {
            try {
                onNewGroupSignal({
                    line: verdictLine,
                    verdict,
                    isHeartbeat: result.isHeartbeat,
                    received_at: meta.receivedAt ?? null,
                    request_id: meta.requestId ?? null
                });
            } catch (err) {
                debugLog("callback error:", err.message);
            }
        }

        // ---------------------------------------------------
        // 4) If a source group was identified, trigger the
        //    scraper for that group. Fire-and-forget.
        // ---------------------------------------------------

        if (verdict && verdict.group_id) {
            triggerScrape(verdict.group_id);
            result.scrapeTriggered = true;
        }

        return result;
    }

    return {
        process
    };
}

// =========================================================
// EXPORTS
// =========================================================

module.exports = {
    createNotificationFilter,
    _internals: {
        extractJson,
        parseTracking,
        deriveGroupSlug,
        extractNotifications,
        computeVerdict,
        detectIndicators,
        hasRequiredIndicators,
        formatVerdictLine,
        formatHeartbeatLine,
        KNOWN_GROUPS
    }
};