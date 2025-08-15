import fetch from "node-fetch";
import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

const { DISCORD_WEBHOOK_URL, TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID } =
  process.env;

const TZ = "Asia/Jakarta";
const API_BASE = "https://api.trello.com/1";

/** Helper to build Trello API URLs with auth */
function trelloUrl(path, params = {}) {
  const qs = new URLSearchParams({
    key: TRELLO_KEY,
    token: TRELLO_TOKEN,
    ...params,
  });
  return `${API_BASE}${path}?${qs.toString()}`;
}

/** ✅ Fetch ALL open lists on the board (name + id) */
async function fetchTrelloLists(boardId) {
  const url = trelloUrl(`/boards/${boardId}/lists`, {
    filter: "open",
    fields: "name",
  });
  const res = await fetch(url);
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error("❌ Trello lists error:", data);
    return [];
  }
  return data; // [{id, name}, ...]
}

/** ✅ Fetch cards for a specific list (only open cards) */
async function fetchTrelloCards(listId) {
  const url = trelloUrl(`/lists/${listId}/cards`, {
    filter: "open",
    fields: "name,shortUrl,due",
  });
  const res = await fetch(url);
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error(`❌ Trello cards error for list ${listId}:`, data);
    return [];
  }
  return data; // [{id, name, shortUrl, due}, ...]
}

/** Post to Discord webhook (one message) */
async function sendToDiscord(payload) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("❌ Discord webhook error:", await res.text());
  }
}

/** Build embeds for one list; chunk if the description would be too long */
function buildEmbedsForList(listName, cards) {
  // Each line: "- [Card Name](URL) (Due: YYYY-MM-DD)"
  const lines = cards.map((c) => {
    const due = c.due
      ? ` (Due: ${new Date(c.due).toISOString().slice(0, 10)})`
      : "";
    // Basic escaping for brackets in names
    const safeName = c.name.replace(/\[/g, "［").replace(/\]/g, "］");
    return `- [${safeName}](${c.shortUrl})${due}`;
  });

  // Discord embed description limit is 4096 chars; chunk lines accordingly
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const line of lines) {
    if (currentLen + line.length + 1 > 3800) {
      // keep a buffer
      chunks.push(current.join("\n"));
      current = [line];
      currentLen = line.length + 1;
    } else {
      current.push(line);
      currentLen += line.length + 1;
    }
  }
  if (current.length) chunks.push(current.join("\n"));

  return chunks.map((desc) => ({
    title: `Backlog — ${listName}`,
    description: desc || "_No cards_",
    color: 3447003,
  }));
}

/** Main job: send all cards from lists whose name contains "backlog" */
async function sendDailyBacklogReport() {
  try {
    const lists = await fetchTrelloLists(TRELLO_BOARD_ID);
    const backlogLists = lists.filter((l) =>
      l.name.toLowerCase().includes("backlog")
    );

    if (backlogLists.length === 0) {
      await sendToDiscord({
        content:
          "📋 **Daily Backlog Report**\n_There's no backlog in Trello, my dear._",
      });
      console.log(
        `[${new Date().toLocaleString("en-US", {
          timeZone: TZ,
        })}] No backlog lists.`
      );
      return;
    }

    let allEmbeds = [];
    for (const list of backlogLists) {
      const cards = await fetchTrelloCards(list.id);
      if (cards.length === 0) continue;
      allEmbeds.push(...buildEmbedsForList(list.name, cards));
    }

    if (allEmbeds.length === 0) {
      await sendToDiscord({
        content: "📋 **Daily Backlog Report**\n_No work today, feel free to found something. More research._",
      });
      console.log(
        `[${new Date().toLocaleString("en-US", {
          timeZone: TZ,
        })}] Backlog lists empty.`
      );
      return;
    }

    // Discord: max 10 embeds per message → send in batches of 10
    for (let i = 0; i < allEmbeds.length; i += 10) {
      const chunk = allEmbeds.slice(i, i + 10);
      await sendToDiscord({
        content: i === 0 ? "📋 **Back to work, my little guinea pig.**" : undefined,
        embeds: chunk,
      });
    }

    console.log(
      `[${new Date().toLocaleString("en-US", { timeZone: TZ })}] Sent ${
        allEmbeds.length
      } embeds.`
    );
  } catch (err) {
    console.error("❌ Error in daily backlog report:", err);
  }
}

/** Schedule at 08:00 Asia/Jakarta daily */
cron.schedule(
  "0 6 * * *",
  () => {
    console.log(
      `⏰ Running daily backlog report at ${new Date().toLocaleString("en-US", {
        timeZone: TZ,
      })}`
    );
    sendDailyBacklogReport();
  },
  { timezone: TZ }
);

/** Manual test: `node index.js --test` */
if (process.argv.includes("--test")) {
  sendDailyBacklogReport().then(() => {
    console.log("✅ Test run complete.");
    process.exit(0);
  });
}
