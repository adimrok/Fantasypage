import { mkdir, writeFile } from "node:fs/promises";

const LEAGUE_ID = 335725;
const SEASON = "2025/26";
const OUTPUT_FILE = new URL("../data/season-2025-26.json", import.meta.url);

const DISPLAY_OVERRIDES = {
  1869839: { displayName: "Sophie", avatar: "SC.png", order: 1 },
  2137464: { displayName: "Dion", avatar: "DW.png", order: 2 },
  4469476: { displayName: "Patrick T", avatar: "PT.png", order: 3 },
  1868126: { displayName: "Adrian", avatar: "AMr.png", order: 4 },
  1633871: { displayName: "Clair", avatar: "ck.png", order: 5 },
  2819224: { displayName: "Carly L", avatar: "cl.png", order: 6 },
  3216960: { displayName: "Claire P", avatar: "cp.png", order: 7 },
  3180861: { displayName: "Dave C", avatar: "dc.png", order: 8 },
  2904337: { displayName: "Gemma", avatar: "gc.png", order: 9 },
  2818734: { displayName: "Harry", avatar: "hh.png", order: 10 },
  3166733: { displayName: "Michelle", avatar: "ms.png", order: 11 },
  2782391: { displayName: "Stuart B", avatar: "sbx.png", order: 12 },
  2763732: { displayName: "Sarah B", avatar: "seb.png", order: 13 },
  2983920: { displayName: "Phill", avatar: "ps.png", order: 14 },
  3470993: { displayName: "Ian", avatar: "iw.png", order: 15 },
  4176478: { displayName: "Patrick W", avatar: "pw.png", order: 16 },
  4315654: { displayName: "Suyash", avatar: "sup.png", order: 17 },
  4451954: { displayName: "Ben", avatar: "BL.png", order: 18 },
  4792228: { displayName: "Gideon", avatar: "GS.png", order: 19 },
  5366325: { displayName: "Lee S", avatar: "LS.png", order: 20 },
  4778516: { displayName: "Mike", avatar: "MMC.png", order: 21 },
  3160020: { displayName: "Conor", avatar: "cb.png", order: 22 },
  1768005: { displayName: "Stephen", avatar: "ss.png", order: 23 }
};

const FPL_BASE_URL = "https://fantasy.premierleague.com/api";

async function getJson(path) {
  const response = await fetch(`${FPL_BASE_URL}${path}`, {
    headers: {
      "accept": "application/json",
      "user-agent": "Estates Dream Teams season builder"
    }
  });

  if (!response.ok) {
    throw new Error(`FPL request failed: ${response.status} ${response.statusText} for ${path}`);
  }

  return response.json();
}

async function getLeagueStandings() {
  const results = [];
  let page = 1;
  let league = null;

  while (true) {
    const data = await getJson(`/leagues-classic/${LEAGUE_ID}/standings/?page_standings=${page}`);
    league = data.league;
    results.push(...data.standings.results);

    if (!data.standings.has_next) {
      return { league, results };
    }

    page += 1;
  }
}

function normalisePlayer(row) {
  const override = DISPLAY_OVERRIDES[row.entry] || {};
  const fallbackName = row.player_name.split(/\s+/)[0] || row.player_name;

  return {
    entry: row.entry,
    displayName: override.displayName || fallbackName,
    managerName: row.player_name,
    teamName: row.entry_name,
    avatar: override.avatar || null,
    originalOrder: override.order || 999,
    finalRank: row.rank,
    finalTotal: row.total,
    finalGameweekPoints: row.event_total
  };
}

function sortRoundRows(rows) {
  return [...rows].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (b.points !== a.points) return b.points - a.points;
    return a.entry - b.entry;
  });
}

function buildRounds(players, histories, events) {
  const eventIds = [...new Set(
    players.flatMap((player) => histories.get(player.entry).map((round) => round.event))
  )].sort((a, b) => a - b);

  let previousPositions = new Map(players.map((player) => [player.entry, player.originalOrder]));

  return eventIds.map((eventId) => {
    const eventMeta = events.find((event) => event.id === eventId);
    const playerRows = players.map((player) => {
      const history = histories.get(player.entry).find((round) => round.event === eventId);

      return {
        entry: player.entry,
        points: history?.points ?? 0,
        total: history?.total_points ?? 0
      };
    });

    const standings = sortRoundRows(playerRows).map((row, index) => {
      const position = index + 1;
      const previousPosition = previousPositions.get(row.entry) || position;

      return {
        ...row,
        position,
        previousPosition,
        movement: previousPosition - position
      };
    });

    previousPositions = new Map(standings.map((row) => [row.entry, row.position]));

    return {
      event: eventId,
      name: eventMeta?.name || `Gameweek ${eventId}`,
      shortName: `GW${eventId}`,
      deadline: eventMeta?.deadline_time || null,
      finished: Boolean(eventMeta?.finished),
      dataChecked: Boolean(eventMeta?.data_checked),
      totalRoundPoints: standings.reduce((sum, player) => sum + player.points, 0),
      totalCumulativePoints: standings.reduce((sum, player) => sum + player.total, 0),
      standings
    };
  });
}

async function main() {
  const [bootstrap, leagueStandings] = await Promise.all([
    getJson("/bootstrap-static/"),
    getLeagueStandings()
  ]);

  const players = leagueStandings.results
    .map(normalisePlayer)
    .sort((a, b) => a.originalOrder - b.originalOrder);

  const histories = new Map();

  await Promise.all(players.map(async (player) => {
    const history = await getJson(`/entry/${player.entry}/history/`);
    histories.set(player.entry, history.current || []);
  }));

  const rounds = buildRounds(players, histories, bootstrap.events || []);

  const database = {
    generatedAt: new Date().toISOString(),
    season: SEASON,
    source: {
      leagueId: LEAGUE_ID,
      leagueUrl: `https://fantasy.premierleague.com/leagues/${LEAGUE_ID}/standings/c`
    },
    league: {
      id: leagueStandings.league.id,
      name: leagueStandings.league.name,
      created: leagueStandings.league.created,
      startEvent: leagueStandings.league.start_event,
      scoring: leagueStandings.league.scoring,
      entryCount: players.length
    },
    players,
    rounds
  };

  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(database)}\n`, "utf8");
  console.log(`Wrote ${database.rounds.length} rounds for ${database.players.length} players to ${OUTPUT_FILE.pathname}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

