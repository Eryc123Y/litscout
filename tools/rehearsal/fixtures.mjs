import { createServer } from "node:http";
import { once } from "node:events";

// Use a completed week so the simulated reports are inside Health's reporting
// window even though the local Worker keeps its real clock.
const today = new Date();
const lastMonday = today.getUTCDate() - ((today.getUTCDay() + 6) % 7) - 7;
const dateAt = (offset) =>
  new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), lastMonday + offset),
  )
    .toISOString()
    .slice(0, 10);
export const monday = dateAt(0);
export const tuesday = dateAt(1);
export const wednesday = dateAt(2);
export const thursday = dateAt(3);
export const legacyDay = dateAt(-5);

export const mondayPaper = {
  id: "2511.00001",
  title: "Stereo depth from paired images",
};
export const tuesdayPaper = {
  id: "2511.00002",
  title: "Stereo depth with a moving camera",
};
export const venueTitle = "A journal study of stereo depth";

function listingItem(paper) {
  return `<dt><a name="item1"></a><a title="Abstract" href="/abs/${paper.id}">arXiv:${paper.id}</a></dt>
      <dd><div class="list-title">Title: ${paper.title}</div>
      <div class="list-authors"><a>Fixture Author</a></div>
      <div class="list-subjects"><span class="primary-subject">Computer Vision (cs.CV)</span></div>
      <p class="mathjax">We compare depth estimates from two cameras on a synthetic sequence.</p></dd>
  `;
}

function listingDate(day, length) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: length,
    day: "numeric",
    month: length,
    year: "numeric",
  }).formatToParts(new Date(day));
  const part = (type) => parts.find((value) => value.type === type).value;
  return `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}`;
}

function listing(late) {
  const paper = late ? tuesdayPaper : mondayPaper;
  const label = listingDate(late ? tuesday : monday, "long");
  return `<div id="dlpage">
    <h3>Showing new listings for ${label}</h3>
    <dl>${listingItem(paper)}</dl></div>`;
}

function journal(late) {
  const item = (id, title) => `<item><title>${title}</title>
    <link>https://www.jmlr.org/papers/v26/${id}.html</link>
    <author>Fixture Author</author><description>A synthetic study with a furnished abstract.</description>
    </item>`;
  return `<rss version="2.0"><channel>
    ${item("25-001", "Previously published journal paper")}
    ${late ? item("25-002", venueTitle) : ""}
  </channel></rss>`;
}

export async function startFixtures() {
  let late = false;
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (body) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    requests.push(url.pathname + url.search);
    if (url.pathname === "/list/cs.CV/new") res.end(listing(late));
    else if (url.pathname === "/list/cs.CV/recent")
      res.end(`<div id="dlpage">
        <dl><h3>${listingDate(tuesday, "short")}</h3>${listingItem(tuesdayPaper)}</dl>
        <dl><h3>${listingDate(monday, "short")}</h3>${listingItem(mondayPaper)}</dl>
        </div>`);
    else if (url.pathname === "/jmlr.xml") res.end(journal(late));
    else if (url.pathname === "/api/daily_papers") {
      const signal = {
        [monday]: { id: mondayPaper.id, upvotes: 7 },
        [tuesday]: { id: tuesdayPaper.id, upvotes: 13 },
      }[url.searchParams.get("date")];
      json(signal ? [{ paper: signal }] : []);
    } else {
      res.statusCode = 404;
      res.end("Unexpected fixture route");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    releaseLateBatch: () => {
      late = true;
    },
    requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
