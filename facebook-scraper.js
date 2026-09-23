#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");


/*
|--------------------------------------------------------------------------
| CONFIGURATION
|--------------------------------------------------------------------------
*/

console.log("Groot....")

const CDP_URL =
    process.env.CDP_URL ||
    "http://127.0.0.1:9222";


/*
 * Output directory. Each group gets its own file inside.
 */
const OUTPUT_DIR =
    path.resolve(
        process.env.OUTPUT_DIR ||
        "./facebook-posts"
    );


/*
 * Optional absolute override. If set, ALL groups write here
 * (useful for testing; normally leave unset).
 */
const OUTPUT_FILE_OVERRIDE =
    process.env.OUTPUT_FILE
        ? path.resolve(process.env.OUTPUT_FILE)
        : null;


const MAX_SCROLLS =
    Number(
        process.env.MAX_SCROLLS ||
        5
    );


const SCROLL_DELAY_MS =
    Number(
        process.env.SCROLL_DELAY_MS ||
        5114
    );


const NO_NEW_POST_LIMIT =
    Number(
        process.env.NO_NEW_POST_LIMIT ||
        8
    );


const INITIAL_SETTLE_DELAY_MS =
    Number(
        process.env.INITIAL_SETTLE_DELAY_MS ||
        5000
    );


/*
|--------------------------------------------------------------------------
| BASIC HELPERS
|--------------------------------------------------------------------------
*/

function isObject(value) {

    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
    );
}


function cleanText(value) {

    if (
        typeof value !== "string"
    ) {

        return null;
    }


    const cleaned =
        value
            .replace(/\r\n/g, "\n")
            .trim();


    return cleaned.length > 0
        ? cleaned
        : null;
}


function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}


/*
|--------------------------------------------------------------------------
| GROUP URL / KEY / OUTPUT PATH
|--------------------------------------------------------------------------
*/

function normalizeGroupUrl(rawUrl) {

    if (
        typeof rawUrl !== "string" ||
        rawUrl.trim().length === 0
    ) {

        throw new Error(
            "Group URL is required."
        );
    }


    let url = rawUrl.trim();


    /*
     * Strip query string and fragment.
     */

    url =
        url.split("#")[0].split("?")[0];


    /*
     * Strip trailing slash(es).
     */

    url =
        url.replace(/\/+$/, "");


    return url;
}


function getGroupKey(normalizedUrl) {

    /*
     * https://www.facebook.com/groups/<KEY>
     *   -> <KEY>
     *
     * Works for numeric IDs and slugs alike.
     */

    const match =
        normalizedUrl.match(
            /facebook\.com\/groups\/([^\/?#]+)/i
        );


    if (!match) {

        throw new Error(
            `Could not derive group key from URL: ${normalizedUrl}`
        );
    }


    return match[1];
}


function getOutputPathForGroup(groupKey) {

    if (OUTPUT_FILE_OVERRIDE) {

        return OUTPUT_FILE_OVERRIDE;
    }


    if (
        !fs.existsSync(OUTPUT_DIR)
    ) {

        fs.mkdirSync(
            OUTPUT_DIR,
            { recursive: true }
        );
    }


    return path.join(
        OUTPUT_DIR,
        `facebook-posts-${groupKey}.json`
    );
}


/*
|--------------------------------------------------------------------------
| GENERIC JSON TREE WALKER
|--------------------------------------------------------------------------
*/

function walk(
    value,
    callback
) {

    if (
        Array.isArray(value)
    ) {

        for (
            const item
            of value
        ) {

            walk(
                item,
                callback
            );
        }

        return;
    }


    if (
        !isObject(value)
    ) {

        return;
    }


    callback(value);


    for (
        const child
        of Object.values(value)
    ) {

        walk(
            child,
            callback
        );
    }
}


/*
|--------------------------------------------------------------------------
| FIND STRING FROM KNOWN PATHS
|--------------------------------------------------------------------------
*/

function findFirstString(
    obj,
    paths
) {

    for (
        const parts
        of paths
    ) {

        let value = obj;


        for (
            const part
            of parts
        ) {

            if (
                !isObject(value) ||
                !(part in value)
            ) {

                value = undefined;
                break;
            }


            value =
                value[part];
        }


        value =
            cleanText(value);


        if (value) {

            return value;
        }
    }


    return null;
}


/*
|--------------------------------------------------------------------------
| TEXT EXTRACTION
|--------------------------------------------------------------------------
*/

function getOldPrimaryText(
    story
) {

    return findFirstString(

        story,

        [

            [
                "comet_sections",
                "content",
                "story",
                "message",
                "text"
            ],

            [
                "comet_sections",
                "feedback",
                "story",
                "story_ufi_container",
                "story",
                "message",
                "text"
            ]

        ]
    );
}


function getMessageContainerText(
    story
) {

    const direct =
        cleanText(

            story
                ?.comet_sections
                ?.message_container
                ?.story
                ?.message
                ?.text

        );


    if (direct) {

        return direct;
    }


    let result = null;


    walk(

        story?.comet_sections,

        node => {

            if (result) {

                return;
            }


            const container =
                node?.message_container;


            if (
                container?.__typename !==
                "CometFeedStoryMessageContainerRenderingStrategy"
            ) {

                return;
            }


            const text =
                cleanText(

                    container
                        ?.story
                        ?.message
                        ?.text

                );


            if (text) {

                result = text;
            }
        }
    );


    return result;
}


function getPrimaryText(
    story
) {

    const oldText =
        getOldPrimaryText(
            story
        );


    if (oldText) {

        return {

            text:
                oldText,

            source:
                "message.text"
        };
    }


    const fallback =
        getMessageContainerText(
            story
        );


    if (fallback) {

        return {

            text:
                fallback,

            source:
                "message_container"
        };
    }


    return {

        text:
            null,

        source:
            null
    };
}


/*
|--------------------------------------------------------------------------
| IMAGE ACCESSIBILITY / IMAGE TEXT
|--------------------------------------------------------------------------
*/

function extractImageText(
    story
) {

    const results = [];

    const seen =
        new Set();


    walk(

        story?.attachments,

        node => {

            const caption =
                cleanText(
                    node?.accessibility_caption
                );


            if (!caption) {

                return;
            }


            if (
                seen.has(
                    caption
                )
            ) {

                return;
            }


            seen.add(
                caption
            );


            const hasEmbeddedText =
                /text(?:\s+\w+){0,3}\s+says\s+["“]/i
                    .test(caption);


            let extractedText = null;


            if (
                hasEmbeddedText
            ) {

                const match =
                    caption.match(

                        /text(?:\s+\w+){0,3}\s+says\s+["“]([\s\S]*?)["”]/i

                    );


                extractedText =
                    cleanText(
                        match?.[1]
                    );
            }


            results.push({

                caption,

                extractedText,

                likelyImageText:
                    hasEmbeddedText

            });
        }
    );


    return results;
}


/*
|--------------------------------------------------------------------------
| IMAGE URLS
|--------------------------------------------------------------------------
*/

function extractImages(
    story
) {

    const images = [];

    const seen =
        new Set();


    walk(

        story?.attachments,

        node => {

            const uri =
                cleanText(
                    node?.photo_image?.uri
                ) ||

                cleanText(
                    node?.image?.uri
                );


            if (
                !uri ||
                seen.has(uri)
            ) {

                return;
            }


            seen.add(uri);


            images.push({

                url:
                    uri,

                width:
                    node?.photo_image?.width ??
                    node?.image?.width ??
                    null,

                height:
                    node?.photo_image?.height ??
                    node?.image?.height ??
                    null

            });
        }
    );


    return images;
}


/*
|--------------------------------------------------------------------------
| AUTHOR
|--------------------------------------------------------------------------
*/

function getOwner(
    story
) {

    const profile =
        story
            ?.feedback
            ?.owning_profile;


    if (
        isObject(profile)
    ) {

        return {

            id:
                cleanText(
                    profile.id
                ),

            name:
                cleanText(
                    profile.name
                ),

            shortName:
                cleanText(
                    profile.short_name
                )
        };
    }


    const actors =
        story
            ?.comet_sections
            ?.content
            ?.story
            ?.actors;


    const actor =
        Array.isArray(
            actors
        )
            ? actors[0]
            : null;


    return {

        id:
            cleanText(
                actor?.id
            ),

        name:
            cleanText(
                actor?.name
            ),

        shortName:
            cleanText(
                actor?.short_name
            )
    };
}


/*
|--------------------------------------------------------------------------
| PERMALINK
|--------------------------------------------------------------------------
*/

function getPermalink(
    story
) {

    return findFirstString(

        story,

        [

            [
                "comet_sections",
                "feedback",
                "story",
                "story_ufi_container",
                "story",
                "permalink_url"
            ],

            [
                "comet_sections",
                "feedback",
                "story",
                "story_ufi_container",
                "story",
                "url"
            ],

            [
                "comet_sections",
                "content",
                "story",
                "wwwURL"
            ],

            [
                "permalink_url"
            ],

            [
                "url"
            ]

        ]
    );
}


/*
|--------------------------------------------------------------------------
| TRACKING
|--------------------------------------------------------------------------
*/

function decodeTracking(
    tracking
) {

    if (
        typeof tracking !==
        "string"
    ) {

        return null;
    }


    try {

        return JSON.parse(
            tracking
        );

    }

    catch {

        return null;
    }
}


/*
|--------------------------------------------------------------------------
| NORMALIZE ONE FACEBOOK STORY
|--------------------------------------------------------------------------
*/

function extractPost(
    story
) {

    const postId =
        cleanText(
            story?.post_id
        );


    if (!postId) {

        return null;
    }


    const textResult =
        getPrimaryText(
            story
        );


    const imageTexts =
        extractImageText(
            story
        );


    const likelyImageText =
        imageTexts.find(
            item =>
                item.likelyImageText
        );


    const tracking =
        decodeTracking(

            story
                ?.comet_sections
                ?.feedback
                ?.story
                ?.story_ufi_container
                ?.story
                ?.tracking

        );


    return {

        postId,

        text:
            textResult.text,

        textSource:
            textResult.source,

        imageText:
            likelyImageText
                ?.extractedText ||
            null,

        allImageCaptions:
            imageTexts.map(
                item =>
                    item.caption
            ),

        author:
            getOwner(
                story
            ),

        creationTime:
            Number.isFinite(
                story?.creation_time
            )
                ? story.creation_time
                : null,

        creationTimeISO:
            Number.isFinite(
                story?.creation_time
            )
                ? new Date(
                    story.creation_time *
                    1000
                ).toISOString()
                : null,

        permalink:
            getPermalink(
                story
            ),

        storyId:
            cleanText(
                story?.id
            ),

        feedbackId:
            cleanText(
                story
                    ?.feedback
                    ?.id
            ),

        groupId:
            cleanText(
                story
                    ?.feedback
                    ?.associated_group
                    ?.id
            ),

        tracking:
            tracking
                ? {

                    topLevelPostId:
                        tracking
                            .top_level_post_id
                        ?? null,

                    storyFbid:
                        Array.isArray(
                            tracking.story_fbid
                        )
                            ? tracking.story_fbid
                            : null,

                    contentOwnerId:
                        tracking
                            .content_owner_id_new
                        ?? null,

                    profileId:
                        tracking
                            .profile_id
                        ?? null

                }
                : null,


        images:
            extractImages(
                story
            )
    };
}


/*
|--------------------------------------------------------------------------
| INITIAL HTML PARSER
|--------------------------------------------------------------------------
*/

function extractJsonScriptBlocks(
    html
) {

    const blocks = [];


    const regex =
        /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;


    let match;


    while (
        (match = regex.exec(html)) !== null
    ) {

        const content =
            match[1].trim();


        if (content) {

            blocks.push(
                content
            );
        }
    }


    return blocks;
}


function isRelayFeedCandidate(
    block
) {

    return (

        block.includes(
            "RelayPrefetchedStreamCache"
        ) &&

        block.includes(
            '"group_feed"'
        ) &&

        block.includes(
            '"__bbox"'
        ) &&

        block.includes(
            '"result"'
        )
    );
}


function findRelayPayloads(
    root
) {

    const results = [];


    const stack = [
        root
    ];


    while (
        stack.length > 0
    ) {

        const current =
            stack.pop();


        if (
            Array.isArray(current)
        ) {

            for (
                const item
                of current
            ) {

                if (
                    item &&
                    typeof item === "object"
                ) {

                    stack.push(
                        item
                    );
                }
            }


            continue;
        }


        if (
            !isObject(current)
        ) {

            continue;
        }


        const bbox =
            current.__bbox;


        if (
            isObject(bbox) &&
            Array.isArray(
                bbox.require
            )
        ) {

            for (
                const requirement
                of bbox.require
            ) {

                if (
                    !Array.isArray(
                        requirement
                    )
                ) {

                    continue;
                }


                if (
                    requirement[0] !==
                    "RelayPrefetchedStreamCache"
                ) {

                    continue;
                }


                if (
                    requirement[1] !==
                    "next"
                ) {

                    continue;
                }


                const payload =
                    requirement[3];


                if (
                    !Array.isArray(
                        payload
                    )
                ) {

                    continue;
                }


                results.push(
                    payload
                );
            }
        }


        for (
            const [
                key,
                child
            ]
            of Object.entries(
                current
            )
        ) {

            if (
                key === "__bbox"
            ) {

                continue;
            }


            if (
                child &&
                typeof child === "object"
            ) {

                stack.push(
                    child
                );
            }
        }
    }


    return results;
}


function extractRelayResult(
    payload
) {

    if (
        !Array.isArray(payload)
    ) {

        return null;
    }


    const payloadObject =
        payload[1];


    if (
        !isObject(payloadObject)
    ) {

        return null;
    }


    const result =
        payloadObject
            ?.__bbox
            ?.result;


    return isObject(result)
        ? result
        : null;
}


function getGroupFeedEdgeIndex(
    result
) {

    const relayPath =
        result?.path;


    if (
        !Array.isArray(relayPath)
    ) {

        return null;
    }


    if (
        relayPath.length < 4
    ) {

        return null;
    }


    if (
        relayPath[0] !== "group" ||
        relayPath[1] !== "group_feed" ||
        relayPath[2] !== "edges"
    ) {

        return null;
    }


    if (
        !Number.isInteger(
            relayPath[3]
        )
    ) {

        return null;
    }


    return relayPath[3];
}


function findInitialFeedStories(
    relayPayloads
) {

    const matches = [];


    for (
        const payload
        of relayPayloads
    ) {

        const result =
            extractRelayResult(
                payload
            );


        if (!result) {

            continue;
        }


        const edgeIndex =
            getGroupFeedEdgeIndex(
                result
            );


        if (
            edgeIndex === null
        ) {

            continue;
        }


        const story =
            result
                ?.data
                ?.node;


        if (
            !isObject(story)
        ) {

            continue;
        }


        if (
            story.__typename !==
            "Story"
        ) {

            continue;
        }


        if (
            story.__isFeedUnit !==
            "Story"
        ) {

            continue;
        }


        if (
            !cleanText(
                story.post_id
            )
        ) {

            continue;
        }


        matches.push({

            edgeIndex,

            path:
                result.path,

            story
        });
    }


    return matches;
}


function processInitialDocument(
    html
) {

    const blocks =
        extractJsonScriptBlocks(
            html
        );


    let candidateBlocks = 0;

    let parsedCandidateBlocks = 0;

    let relayPayloadsFound = 0;


    const matches = [];


    for (
        const block
        of blocks
    ) {

        if (
            !isRelayFeedCandidate(
                block
            )
        ) {

            continue;
        }


        candidateBlocks++;


        let root;


        try {

            root =
                JSON.parse(
                    block
                );


            parsedCandidateBlocks++;

        }

        catch {

            continue;
        }


        const payloads =
            findRelayPayloads(
                root
            );


        relayPayloadsFound +=
            payloads.length;


        matches.push(

            ...findInitialFeedStories(
                payloads
            )

        );
    }


    matches.sort(

        (a, b) =>
            a.edgeIndex -
            b.edgeIndex

    );


    const posts =
        new Map();


    for (
        const match
        of matches
    ) {

        const post =
            extractPost(
                match.story
            );


        if (!post) {

            continue;
        }


        if (
            !posts.has(
                post.postId
            )
        ) {

            posts.set(

                post.postId,

                {

                    edgeIndex:
                        match.edgeIndex,

                    path:
                        match.path,

                    post
                }

            );
        }
    }


    return {

        scriptBlocksFound:
            blocks.length,

        candidateBlocks,

        parsedCandidateBlocks,

        relayPayloadsFound,

        firstPost:
            posts.size
                ? [...posts.values()][0]
                : null,

        posts:
            [...posts.values()]
    };
}


/*
|--------------------------------------------------------------------------
| GRAPHQL JSON SPLITTER
|--------------------------------------------------------------------------
*/

function splitJsonDocuments(
    text
) {

    const documents = [];


    let start = null;

    let depth = 0;

    let inString = false;

    let escaped = false;


    for (
        let i = 0;
        i < text.length;
        i++
    ) {

        const ch =
            text[i];


        if (inString) {

            if (escaped) {

                escaped = false;

            }

            else if (
                ch === "\\"
            ) {

                escaped = true;

            }

            else if (
                ch === '"'
            ) {

                inString = false;
            }


            continue;
        }


        if (
            ch === '"'
        ) {

            inString = true;

            continue;
        }


        if (
            ch === "{" ||
            ch === "["
        ) {

            if (
                depth === 0
            ) {

                start = i;
            }


            depth++;

        }

        else if (
            ch === "}" ||
            ch === "]"
        ) {

            depth--;


            if (
                depth === 0 &&
                start !== null
            ) {

                documents.push(

                    text.slice(
                        start,
                        i + 1
                    )

                );


                start = null;
            }
        }
    }


    return documents;
}


function extractPostsFromResponse(
    body
) {

    const documents =
        splitJsonDocuments(
            body
        );


    const posts =
        new Map();


    let storiesSeen = 0;


    for (
        const document
        of documents
    ) {

        let root;


        try {

            root =
                JSON.parse(
                    document
                );

        }

        catch {

            continue;
        }


        walk(

            root,

            node => {

                if (
                    node?.__typename !==
                    "Story" ||

                    node?.__isFeedUnit !==
                    "Story" ||

                    !cleanText(
                        node?.post_id
                    )
                ) {

                    return;
                }


                storiesSeen++;


                const post =
                    extractPost(
                        node
                    );


                if (!post) {

                    return;
                }


                const existing =
                    posts.get(
                        post.postId
                    );


                if (!existing) {

                    posts.set(

                        post.postId,

                        post

                    );


                    return;
                }


                mergeSinglePost(

                    existing,

                    post
                );
            }
        );
    }


    return {

        posts:
            [
                ...posts.values()
            ],

        documentsFound:
            documents.length,

        storiesSeen

    };
}


/*
|--------------------------------------------------------------------------
| MERGE SAME POST
|--------------------------------------------------------------------------
*/

function mergeSinglePost(
    existing,
    incoming
) {

    let changed = false;


    if (
        !existing.text &&
        incoming.text
    ) {

        existing.text =
            incoming.text;


        existing.textSource =
            incoming.textSource;


        changed = true;
    }


    if (
        !existing.imageText &&
        incoming.imageText
    ) {

        existing.imageText =
            incoming.imageText;


        changed = true;
    }


    if (
        !existing.permalink &&
        incoming.permalink
    ) {

        existing.permalink =
            incoming.permalink;


        changed = true;
    }


    if (
        !existing.author?.id &&
        incoming.author?.id
    ) {

        existing.author =
            incoming.author;


        changed = true;
    }


    if (
        !existing.creationTime &&
        incoming.creationTime
    ) {

        existing.creationTime =
            incoming.creationTime;


        existing.creationTimeISO =
            incoming.creationTimeISO;


        changed = true;
    }


    if (
        !existing.tracking &&
        incoming.tracking
    ) {

        existing.tracking =
            incoming.tracking;


        changed = true;
    }


    if (
        incoming.images.length >
        existing.images.length
    ) {

        existing.images =
            incoming.images;


        changed = true;
    }


    if (
        incoming.allImageCaptions.length >
        existing.allImageCaptions.length
    ) {

        existing.allImageCaptions =
            incoming.allImageCaptions;


        changed = true;
    }


    return changed;
}


/*
|--------------------------------------------------------------------------
| LOAD EXISTING POSTS (per group file)
|--------------------------------------------------------------------------
*/

function loadExistingPosts(
    outputFile
) {

    if (
        !fs.existsSync(
            outputFile
        )
    ) {

        return new Map();
    }


    try {

        const data =
            JSON.parse(

                fs.readFileSync(

                    outputFile,

                    "utf8"

                )

            );


        const posts =
            Array.isArray(data)
                ? data
                : data.posts;


        if (
            !Array.isArray(posts)
        ) {

            return new Map();
        }


        return new Map(

            posts

                .filter(
                    post =>
                        post?.postId
                )

                .map(
                    post => [
                        post.postId,
                        post
                    ]
                )

        );

    }

    catch (error) {

        console.warn(

            "Could not read existing output file:",

            error.message

        );


        return new Map();
    }
}


/*
|--------------------------------------------------------------------------
| SAVE POSTS (per group file)
|--------------------------------------------------------------------------
*/

function savePosts(
    postMap,
    outputFile,
    meta
) {

    const output = {

        groupUrl:
            meta.groupUrl,

        groupKey:
            meta.groupKey,

        updatedAt:
            new Date().toISOString(),

        totalPosts:
            postMap.size,

        watermark:
            meta.watermark || null,

        posts:
            [
                ...postMap.values()
            ]
    };


    const tempFile =
        `${outputFile}.tmp`;


    fs.writeFileSync(

        tempFile,

        JSON.stringify(
            output,
            null,
            2
        ),

        "utf8"

    );


    fs.renameSync(

        tempFile,

        outputFile

    );
}


/*
|--------------------------------------------------------------------------
| MERGE INCOMING POSTS INTO GLOBAL MAP
|--------------------------------------------------------------------------
*/

function mergePosts(
    globalPosts,
    incomingPosts
) {

    let newCount = 0;

    let updatedCount = 0;


    for (
        const incoming
        of incomingPosts
    ) {

        const existing =
            globalPosts.get(
                incoming.postId
            );


        if (!existing) {

            globalPosts.set(

                incoming.postId,

                incoming

            );


            newCount++;


            continue;
        }


        if (
            mergeSinglePost(
                existing,
                incoming
            )
        ) {

            updatedCount++;
        }
    }


    return {

        newCount,

        updatedCount

    };
}


/*
|--------------------------------------------------------------------------
| WATERMARK HELPERS
|--------------------------------------------------------------------------
|
| The watermark is the postId of the newest post we already
| know about for this group. It was the very first post of
| the feed at the time of the previous run.
|
| On Mode B, the moment we see that exact postId in any
| incoming batch we:
|
|   1. Flip reachedWatermark to true
|   2. Filter the watermark post OUT of the merge batch
|      (do not re-save / re-enrich it — pure new posts only)
|
|--------------------------------------------------------------------------
*/

function computeWatermarkPostId(
    postMap
) {

    /*
     * Prefer the post with the highest creationTime.
     * Fall back to insertion order (first inserted) if no timestamps.
     */

    let bestId = null;

    let bestTime = -Infinity;


    for (
        const post
        of postMap.values()
    ) {

        if (
            typeof post?.postId !== "string"
        ) {

            continue;
        }


        const t =
            Number.isFinite(
                post?.creationTime
            )
                ? post.creationTime
                : -1;


        if (
            t > bestTime
        ) {

            bestTime = t;

            bestId = post.postId;
        }
    }


    /*
     * If nothing had a timestamp, first inserted wins.
     */

    if (
        bestId === null &&
        postMap.size > 0
    ) {

        bestId =
            [...postMap.values()][0].postId;
    }


    return bestId;
}


/*
|--------------------------------------------------------------------------
| GRAPHQL RESPONSE DETECTION
|--------------------------------------------------------------------------
*/

function isFacebookGraphResponse(
    response
) {

    const request =
        response.request();


    const resourceType =
        request.resourceType();


    if (
        resourceType !== "xhr" &&
        resourceType !== "fetch"
    ) {

        return false;
    }


    const url =
        response.url();


    if (
        !/\/graphql/i.test(
            url
        )
    ) {

        return false;
    }


    if (
        !/facebook\.com/i.test(
            url
        )
    ) {

        return false;
    }


    return true;
}


/*
|--------------------------------------------------------------------------
| FIND TARGET FACEBOOK TAB
|--------------------------------------------------------------------------
*/

function findTargetFacebookPage(
    context,
    targetUrl
) {

    const pages =
        context.pages();


    const target =
        targetUrl.replace(
            /\/$/,
            ""
        );


    for (
        const page
        of pages
    ) {

        const current =
            page
                .url()
                .split("?")[0]
                .split("#")[0]
                .replace(
                    /\/$/,
                    ""
                );


        if (
            current ===
            target
        ) {

            return page;
        }


        if (
            current.startsWith(
                `${target}/`
            )
        ) {

            return page;
        }
    }


    return null;
}


/*
|--------------------------------------------------------------------------
| CORE SCRAPER
|--------------------------------------------------------------------------
|
| This used to be a top-level IIFE. It is now an exported
| async function so a parent script can call:
|
|   const { scrapeGroup } = require("./scraper");
|   await scrapeGroup("https://www.facebook.com/groups/123");
|
|--------------------------------------------------------------------------
*/

async function scrapeGroup(
    rawGroupUrl
) {

    const GROUP_URL =
        normalizeGroupUrl(
            rawGroupUrl
        );


    const GROUP_KEY =
        getGroupKey(
            GROUP_URL
        );


    const OUTPUT_FILE =
        getOutputPathForGroup(
            GROUP_KEY
        );


    console.log(
        "\n========================================"
    );


    console.log(
        "SocialScout Facebook Combined Collector"
    );


    console.log(
        "INITIAL HTML + GRAPHQL"
    );


    console.log(
        "========================================\n"
    );


    console.log(
        `CDP endpoint: ${CDP_URL}`
    );


    console.log(
        `Group URL: ${GROUP_URL}`
    );


    console.log(
        `Group key: ${GROUP_KEY}`
    );


    console.log(
        `Output file: ${OUTPUT_FILE}`
    );


    /*
     * ----------------------------------------------------------
     * LOAD EXISTING POSTS (this group only)
     * ----------------------------------------------------------
     */

    const globalPosts =
        loadExistingPosts(
            OUTPUT_FILE
        );


    const isFirstRun =
        globalPosts.size === 0;


    /*
     * Watermark = newest postId already known.
     *
     * Mode A: no watermark (nothing to stop at).
     * Mode B: stop when we see this postId.
     */

    const watermarkPostId =
        isFirstRun
            ? null
            : computeWatermarkPostId(
                globalPosts
            );


    console.log(
        `Existing posts: ${globalPosts.size}`
    );


    console.log(
        `Mode: ${isFirstRun
            ? "A (first run — only post #1)"
            : "B (incremental — stop at watermark)"
        }`
    );


    if (!isFirstRun) {

        console.log(
            `Watermark postId: ${watermarkPostId}`
        );
    }


    /*
     * ----------------------------------------------------------
     * CONNECT TO CHROME
     * ----------------------------------------------------------
     */

    let browser;


    try {

        browser =
            await chromium.connectOverCDP(
                CDP_URL
            );

    }

    catch (error) {

        console.error(
            "\nCould not connect to Chrome."
        );


        console.error(
            error.message
        );


        console.error(
            "\nMake sure Chrome is running with:"
        );


        console.error(

            '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome ' +

            '--user-data-dir="$HOME/facebook-scraper-chrome" ' +

            '--remote-debugging-port=9222 ' +

            '--remote-allow-origins=http://localhost:9222'

        );


        throw error;
    }


    const contexts =
        browser.contexts();


    if (
        contexts.length === 0
    ) {

        throw new Error(
            "No Chrome browser context found."
        );
    }


    const context =
        contexts[0];


    /*
     * ----------------------------------------------------------
     * FIND TARGET GROUP TAB
     * ----------------------------------------------------------
     */

    let page =
        findTargetFacebookPage(
            context,
            GROUP_URL
        );


    if (!page) {

        page =
            await context.newPage();
    }


    /*
     * ----------------------------------------------------------
     * RUNTIME STATE
     * ----------------------------------------------------------
     */

    let initialPostReady =
        false;


    let collectorActive =
        true;


    let initialDocumentCaptured =
        false;


    /*
     * Set to true when the watermark postId is observed
     * in any incoming GraphQL batch (Mode B only).
     */

    let reachedWatermark =
        false;


    const bufferedGraphBodies =
        [];


    const activeResponseHandlers =
        new Set();


    let processedGraphResponses = 0;

    let graphResponsesWithPosts = 0;

    let newPostsTotal = 0;

    let updatedPostsTotal = 0;


    /*
|--------------------------------------------------------------------------
| INITIAL DOCUMENT RESPONSE HANDLER
|--------------------------------------------------------------------------
*/

    const documentResponseHandler =
        async response => {

            if (
                !collectorActive
            ) {

                return;
            }


            const request =
                response.request();


            if (
                request.resourceType() !==
                "document"
            ) {

                return;
            }


            if (
                !/facebook\.com/i.test(
                    response.url()
                )
            ) {

                return;
            }


            if (
                initialDocumentCaptured
            ) {

                return;
            }


            initialDocumentCaptured =
                true;


            console.log(
                "\n========================================"
            );


            console.log(
                "INITIAL FACEBOOK DOCUMENT RECEIVED"
            );


            console.log(
                `URL: ${response.url()}`
            );


            let documentName =
                "(unknown)";


            try {

                documentName =

                    new URL(
                        response.url()
                    )

                        .pathname

                        .split("/")

                        .filter(Boolean)

                        .pop() ||

                    "(root)";

            }

            catch {
                // Keep "(unknown)".
            }


            console.log(
                `Document name: ${documentName}`
            );


            let html;


            try {

                html =
                    await response.text();

            }

            catch (error) {

                console.error(

                    "Could not read initial document:",

                    error.message

                );


                initialPostReady =
                    true;


                return;
            }


            console.log(

                `Document size: ${(
                    html.length /
                    1024 /
                    1024
                ).toFixed(2)} MB`

            );


            const result =
                processInitialDocument(
                    html
                );


            console.log(
                "\nInitial document parser:"
            );


            console.log(
                `JSON blocks: ${result.scriptBlocksFound}`
            );


            console.log(
                `Candidate blocks: ${result.candidateBlocks}`
            );


            console.log(
                `Parsed candidate blocks: ${result.parsedCandidateBlocks}`
            );


            console.log(
                `Relay payloads: ${result.relayPayloadsFound}`
            );


            /*
             * --------------------------------------------------
             * MODE A — first run: take ONLY post #1, then stop.
             * --------------------------------------------------
             */

            if (
                isFirstRun
            ) {

                if (
                    result.firstPost
                ) {

                    const first =
                        result.firstPost.post;


                    /*
                     * If (somehow) the very first post already
                     * equals the watermark — impossible on first
                     * run because watermarkPostId is null — but
                     * guard anyway.
                     */

                    if (
                        watermarkPostId &&
                        first.postId ===
                        watermarkPostId
                    ) {

                        reachedWatermark =
                            true;
                    }


                    const mergeResult =
                        mergePosts(

                            globalPosts,

                            [first]

                        );


                    newPostsTotal +=
                        mergeResult.newCount;


                    updatedPostsTotal +=
                        mergeResult.updatedCount;


                    console.log(
                        "\n✅ FIRST DISCUSSION POST (Mode A)"
                    );


                    console.log(
                        `Post ID: ${first.postId}`
                    );


                    console.log(
                        `User: ${first.author?.name ||
                        "Unknown"
                        }`
                    );


                    console.log(
                        `Edge index: ${result.firstPost.edgeIndex
                        }`
                    );


                    console.log(
                        `Text: ${first.text ||
                        "[no native text]"
                        }`
                    );


                    console.log(
                        `Image text: ${first.imageText ||
                        "[none]"
                        }`
                    );


                    if (
                        first
                            .allImageCaptions
                            ?.length
                    ) {

                        console.log(
                            "Image captions:"
                        );


                        for (
                            const caption
                            of first.allImageCaptions
                        ) {

                            console.log(
                                `  - ${caption}`
                            );
                        }
                    }


                    /*
                     * Compute and store the new watermark
                     * (= post #1's postId) so future runs know
                     * where to stop.
                     */

                    const newWatermark =
                        computeWatermarkPostId(
                            globalPosts
                        );


                    savePosts(

                        globalPosts,

                        OUTPUT_FILE,

                        {

                            groupUrl:
                                GROUP_URL,

                            groupKey:
                                GROUP_KEY,

                            watermark:
                                newWatermark
                                    ? {
                                        postId:
                                            newWatermark
                                    }
                                    : null
                        }
                    );

                }

                else {

                    console.warn(

                        "\n⚠️ Mode A: initial document did not yield a Discussion Story."
                    );
                }


                /*
                 * Mode A: do NOT flush buffered GraphQL.
                 * Do NOT scroll. We are done.
                 */

                initialPostReady =
                    true;


                page.off(
                    "response",
                    documentResponseHandler
                );


                page.off(
                    "response",
                    graphResponseHandler
                );


                console.log(
                    "\n✅ Mode A complete (no scrolling)."
                );


                return;
            }


            /*
             * --------------------------------------------------
             * MODE B — incremental.
             *
             * Process the top post from the initial document
             * too, but only if it isn't the watermark.
             *
             * In practice, on Mode B the initial HTML top post
             * is usually NEW (the watermark lives somewhere
             * deeper), so we merge it.
             * --------------------------------------------------
             */

            if (
                result.firstPost
            ) {

                const first =
                    result.firstPost.post;


                if (
                    watermarkPostId &&
                    first.postId ===
                    watermarkPostId
                ) {

                    /*
                     * Top of feed is already the newest known.
                     * No new posts to scrape.
                     */

                    reachedWatermark =
                        true;


                    console.log(
                        "\n🛑 Initial HTML top post IS the watermark — nothing new."
                    );
                }

                else {

                    const mergeResult =
                        mergePosts(

                            globalPosts,

                            [first]

                        );


                    newPostsTotal +=
                        mergeResult.newCount;


                    updatedPostsTotal +=
                        mergeResult.updatedCount;


                    console.log(
                        "\n✅ FIRST DISCUSSION POST (Mode B — new)"
                    );


                    console.log(
                        `Post ID: ${first.postId}`
                    );


                    console.log(
                        `User: ${first.author?.name ||
                        "Unknown"
                        }`
                    );


                    console.log(
                        `Text: ${first.text ||
                        "[no native text]"
                        }`
                    );


                    savePosts(

                        globalPosts,

                        OUTPUT_FILE,

                        {

                            groupUrl:
                                GROUP_URL,

                            groupKey:
                                GROUP_KEY,

                            watermark:
                                watermarkPostId
                                    ? {
                                        postId:
                                            watermarkPostId
                                    }
                                    : null
                        }
                    );
                }
            }

            else {

                console.warn(

                    "\n⚠️ Initial document did not yield a Discussion Story."
                );
            }


            initialPostReady =
                true;


            /*
             * If the watermark wasn't already reached via the
             * initial HTML post, flush buffered GraphQL bodies.
             */

            if (
                !reachedWatermark &&
                bufferedGraphBodies.length > 0
            ) {

                console.log(

                    `\nProcessing ${bufferedGraphBodies.length} buffered GraphQL response(s)...`

                );


                while (
                    bufferedGraphBodies.length > 0
                ) {

                    if (
                        reachedWatermark
                    ) {

                        /*
                         * Once watermark is hit, discard the rest
                         * of the buffer — no point processing it.
                         */

                        bufferedGraphBodies.length = 0;

                        break;
                    }


                    const body =
                        bufferedGraphBodies.shift();


                    await processGraphBody(
                        body
                    );
                }
            }


            page.off(
                "response",
                documentResponseHandler
            );


            console.log(
                "\n✅ Initial document processing complete."
            );
        };


    /*
|--------------------------------------------------------------------------
| GRAPHQL BODY PROCESSOR
|--------------------------------------------------------------------------
*/

    async function processGraphBody(
        body
    ) {

        if (
            !body ||
            body.length < 2 ||
            !collectorActive
        ) {

            return;
        }


        /*
         * Mode A: never process GraphQL. The caller already
         * guards this, but belt-and-braces.
         */

        if (isFirstRun) {

            return;
        }


        /*
         * Watermark already hit — nothing more to do.
         */

        if (reachedWatermark) {

            return;
        }


        processedGraphResponses++;


        const result =
            extractPostsFromResponse(
                body
            );


        if (
            result.posts.length === 0
        ) {

            return;
        }


        graphResponsesWithPosts++;


        /*
         * ----------------------------------------------------------
         * WATERMARK GATE
         * ----------------------------------------------------------
         *
         * Split the batch into:
         *   - postsToMerge      (above the watermark — NEW)
         *   - watermarkPresent  (matches watermarkPostId)
         *
         * The watermark post itself is NEVER merged — pure
         * new-posts-only behavior.
         * ----------------------------------------------------------
         */

        let postsToMerge =
            result.posts;


        if (watermarkPostId) {

            const hit =
                result.posts.some(
                    p =>
                        p.postId ===
                        watermarkPostId
                );


            if (hit) {

                postsToMerge =
                    result.posts.filter(
                        p =>
                            p.postId !==
                            watermarkPostId
                    );


                reachedWatermark =
                    true;


                console.log(
                    `\n🛑 Watermark reached (${watermarkPostId}) — stopping.`
                );
            }
        }


        if (
            postsToMerge.length === 0
        ) {

            /*
             * Nothing new in this batch. Save is not needed
             * since nothing changed.
             */

            return;
        }


        const {

            newCount,

            updatedCount

        } =
            mergePosts(

                globalPosts,

                postsToMerge

            );


        newPostsTotal +=
            newCount;


        updatedPostsTotal +=
            updatedCount;


        savePosts(

            globalPosts,

            OUTPUT_FILE,

            {

                groupUrl:
                    GROUP_URL,

                groupKey:
                    GROUP_KEY,

                watermark:
                    watermarkPostId
                        ? {
                            postId:
                                watermarkPostId
                        }
                        : null
            }
        );


        console.log(
            "\n----------------------------------------"
        );


        console.log(
            "GRAPHQL RESPONSE"
        );


        console.log(
            "----------------------------------------"
        );


        console.log(
            `Documents: ${result.documentsFound}`
        );


        console.log(
            `Stories found: ${result.storiesSeen}`
        );


        console.log(
            `Unique posts in response: ${result.posts.length}`
        );


        console.log(
            `New posts: ${newCount}`
        );


        console.log(
            `Updated posts: ${updatedCount}`
        );


        console.log(
            `Global unique posts: ${globalPosts.size}`
        );


        console.log(
            `Watermark reached: ${reachedWatermark}`
        );


        for (
            const post
            of postsToMerge
        ) {

            console.log(
                `Post ID: ${post.postId}`
            );


            console.log(

                `User: ${post.author?.name ||
                "Unknown"
                }`

            );


            console.log(

                `Text: ${post.text ||
                "[no native text]"
                }`

            );


            if (
                post.imageText
            ) {

                console.log(
                    `Image text: ${post.imageText}`
                );
            }


            console.log("");
        }
    }


    /*
|--------------------------------------------------------------------------
| GRAPHQL RESPONSE HANDLER
|--------------------------------------------------------------------------
*/

    const graphResponseHandler =
        async response => {

            if (
                !collectorActive
            ) {

                return;
            }


            if (
                !isFacebookGraphResponse(
                    response
                )
            ) {

                return;
            }


            const processingPromise =
                (async () => {

                    try {

                        let body;


                        try {

                            body =
                                await response.text();

                        }

                        catch {

                            return;
                        }


                        if (!body) {

                            return;
                        }


                        /*
                         * Mode A: never buffer GraphQL.
                         */

                        if (isFirstRun) {

                            return;
                        }


                        /*
                         * Watermark already hit: don't buffer
                         * or process further.
                         */

                        if (reachedWatermark) {

                            return;
                        }


                        if (
                            !initialPostReady
                        ) {

                            bufferedGraphBodies.push(
                                body
                            );


                            console.log(
                                "Buffered GraphQL response until initial post is ready."
                            );


                            return;
                        }


                        await processGraphBody(
                            body
                        );

                    }

                    catch (error) {

                        console.error(

                            "GraphQL response processing error:"

                        );


                        console.error(
                            error
                        );
                    }

                })();


            activeResponseHandlers.add(
                processingPromise
            );


            try {

                await processingPromise;

            }

            finally {

                activeResponseHandlers.delete(
                    processingPromise
                );
            }
        };


    /*
|--------------------------------------------------------------------------
| ATTACH LISTENERS BEFORE NAVIGATION
|--------------------------------------------------------------------------
*/

    page.on(
        "response",
        documentResponseHandler
    );


    page.on(
        "response",
        graphResponseHandler
    );


    /*
|--------------------------------------------------------------------------
| OPEN / REFRESH TARGET GROUP
|--------------------------------------------------------------------------
*/

    const currentUrl =
        page.url()
            .split("?")[0]
            .split("#")[0]
            .replace(
                /\/$/,
                ""
            );


    const targetGroupUrl =
        GROUP_URL.replace(
            /\/$/,
            ""
        );


    const isTargetGroupOpen =
        currentUrl ===
        targetGroupUrl ||

        currentUrl.startsWith(
            `${targetGroupUrl}/`
        );


    if (
        isTargetGroupOpen
    ) {

        console.log(
            "\n🎯 Target group already open."
        );


        console.log(
            "Refreshing target group..."
        );


        await page.reload({

            waitUntil:
                "domcontentloaded",

            timeout:
                60000

        });

    }

    else {

        console.log(
            "\n🎯 Target group is not open."
        );


        console.log(
            `Opening: ${GROUP_URL}`
        );


        await page.goto(

            GROUP_URL,

            {

                waitUntil:
                    "domcontentloaded",

                timeout:
                    60000

            }

        );
    }


    /*
|--------------------------------------------------------------------------
| WAIT FOR INITIAL DOCUMENT
|--------------------------------------------------------------------------
*/

    console.log(

        `\nWaiting ${INITIAL_SETTLE_DELAY_MS}ms for initial feed...`

    );


    await sleep(
        INITIAL_SETTLE_DELAY_MS
    );


    /*
|--------------------------------------------------------------------------
| MODE A — EARLY EXIT (NO SCROLLING)
|--------------------------------------------------------------------------
*/

    if (isFirstRun) {

        /*
         * Give the initial document handler a moment to finish
         * if it hasn't already. The handler is async; we can't
         * await it directly, but the sleep above + a bit more
         * will cover it.
         */

        const waitStart =
            Date.now();


        while (

            !initialPostReady &&

            Date.now() - waitStart <
            15000

        ) {

            await sleep(
                250
            );
        }


        console.log(
            "\n========================================"
        );


        console.log(
            "MODE A COMPLETE — NO SCROLLING"
        );


        console.log(
            "========================================"
        );


        console.log(
            `Total unique posts: ${globalPosts.size}`
        );


        console.log(
            `Saved to: ${OUTPUT_FILE}`
        );


        collectorActive =
            false;


        page.off(
            "response",
            documentResponseHandler
        );


        page.off(
            "response",
            graphResponseHandler
        );


        return;
    }


    /*
|--------------------------------------------------------------------------
| MODE B — AUTOMATED SCROLLING
|--------------------------------------------------------------------------
*/

    let noNewPostScrolls =
        0;


    let previousPostCount =
        globalPosts.size;


    for (

        let scrollNumber = 1;

        scrollNumber <=
        MAX_SCROLLS;

        scrollNumber++

    ) {

        /*
         * Watermark already hit → stop.
         */

        if (reachedWatermark) {

            console.log(
                "\n🛑 Watermark reached — breaking scroll loop."
            );


            break;
        }


        if (
            !initialPostReady
        ) {

            console.log(
                "Initial document not ready yet; waiting..."
            );


            await sleep(
                1000
            );
        }


        console.log(

            `\n========== SCROLL ${scrollNumber} ==========`

        );


        await page.evaluate(

            () => {

                window.scrollBy(

                    0,

                    Math.floor(
                        window.innerHeight *
                        0.85
                    )

                );
            }
        );


        await sleep(
            SCROLL_DELAY_MS
        );


        /*
         * Re-check watermark after the delay — a batch may
         * have landed during the sleep.
         */

        if (reachedWatermark) {

            console.log(
                "\n🛑 Watermark reached after scroll delay — breaking."
            );


            break;
        }


        const currentPostCount =
            globalPosts.size;


        console.log(

            `Current unique posts: ${currentPostCount}`

        );


        if (
            currentPostCount ===
            previousPostCount
        ) {

            noNewPostScrolls++;


            console.log(

                `No new posts: ${noNewPostScrolls}/${NO_NEW_POST_LIMIT}`

            );

        }

        else {

            noNewPostScrolls = 0;
        }


        previousPostCount =
            currentPostCount;


        if (
            noNewPostScrolls >=
            NO_NEW_POST_LIMIT
        ) {

            console.log(
                "\nNo new posts detected repeatedly."
            );


            break;
        }
    }


    /*
|--------------------------------------------------------------------------
| STOP COLLECTION
|--------------------------------------------------------------------------
*/

    console.log(
        "\n========================================"
    );


    console.log(
        "AUTOMATED SCROLLING FINISHED"
    );


    console.log(
        "Stopping collectors..."
    );


    collectorActive =
        false;


    page.off(
        "response",
        documentResponseHandler
    );


    page.off(
        "response",
        graphResponseHandler
    );


    console.log(
        "Response listeners stopped."
    );


    if (
        activeResponseHandlers.size > 0
    ) {

        console.log(

            `Waiting for ${activeResponseHandlers.size} active response(s)...`

        );


        await Promise.allSettled(

            [
                ...activeResponseHandlers
            ]

        );
    }


    /*
     * Final save — watermark stays the SAME as when we
     * started (newest known post hasn't changed since
     * we deliberately don't merge the watermark post).
     */

    savePosts(

        globalPosts,

        OUTPUT_FILE,

        {

            groupUrl:
                GROUP_URL,

            groupKey:
                GROUP_KEY,

            watermark:
                watermarkPostId
                    ? {
                        postId:
                            watermarkPostId
                    }
                    : null
        }
    );


    /*
|--------------------------------------------------------------------------
| FINAL SUMMARY
|--------------------------------------------------------------------------
*/

    console.log(
        "\n========================================"
    );


    console.log(
        "SCRAPING FINISHED"
    );


    console.log(
        "========================================"
    );


    console.log(
        "Initial post source: HTML document"
    );


    console.log(

        `GraphQL responses processed: ${processedGraphResponses
        }`

    );


    console.log(

        `GraphQL responses containing posts: ${graphResponsesWithPosts
        }`

    );


    console.log(

        `New unique posts: ${newPostsTotal
        }`

    );


    console.log(

        `Existing posts enriched: ${updatedPostsTotal
        }`

    );


    console.log(

        `Total unique posts: ${globalPosts.size
        }`

    );


    console.log(

        `Watermark reached: ${reachedWatermark}`

    );


    console.log(
        `Saved to: ${OUTPUT_FILE}`
    );


    console.log(
        "\nCollector is now INACTIVE."
    );


    console.log(
        "You can manually scroll Facebook."
    );


    console.log(
        "Manual scrolling will NOT modify the output."
    );
}


/*
|--------------------------------------------------------------------------
| ENTRY POINTS
|--------------------------------------------------------------------------
|
| 1. If required as a module:
|
|       const { scrapeGroup } = require("./this-file");
|       await scrapeGroup("https://www.facebook.com/groups/123");
|
| 2. If run directly:
|
|       node this-file.js https://www.facebook.com/groups/123
|
|       (or)
|
|       GROUP_URL=https://www.facebook.com/groups/123 node this-file.js
|
|--------------------------------------------------------------------------
*/

module.exports = {
    scrapeGroup
};


if (require.main === module) {

    (async () => {

        try {

            const cliUrl =
                process.argv[2];

            const envUrl =
                process.env.GROUP_URL ||
                process.env.FACEBOOK_URL;

            const url =
                cliUrl || envUrl;


            if (!url) {

                console.error(
                    "No group URL provided."
                );

                console.error(
                    "Usage: node scraper.js <groupUrl>"
                );

                console.error(
                    "   or: GROUP_URL=<groupUrl> node scraper.js"
                );

                process.exit(1);
            }


            await scrapeGroup(
                url
            );


            process.exit(0);

        }

        catch (error) {

            console.error(
                "\nFatal error:"
            );


            console.error(
                error
            );


            process.exit(1);
        }

    })();
}