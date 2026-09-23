const { scrapeGroup } = require("./facebook-scraper");

console.log("[orchestrator] loaded, typeof scrapeGroup =", typeof scrapeGroup);

async function main() {
    console.log("[orchestrator] main() started");

    try {
        console.log("[orchestrator] calling scrapeGroup #1");
        await scrapeGroup("https://www.facebook.com/groups/596598397896838");
        console.log("[orchestrator] scrapeGroup #1 returned");

        console.log("[orchestrator] calling scrapeGroup #2");
        await scrapeGroup("https://www.facebook.com/groups/LuxuryRealEstateGroup");
        console.log("[orchestrator] scrapeGroup #2 returned");

        console.log("[orchestrator] all done");
    } catch (err) {
        console.error("[orchestrator] ERROR:", err);
        process.exitCode = 1;
    }
}

main();