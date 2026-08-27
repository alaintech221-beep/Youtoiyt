// ---------------------------------------------------------------------------
// Fonction Netlify : renvoie la liste des matchs des 7 prochains jours pour
// les grandes compétitions suivies par football-data.org (plan gratuit).
//
// Nécessite une variable d'environnement FOOTBALL_DATA_API_KEY sur Netlify.
// Clé gratuite à obtenir sur https://www.football-data.org/client/register
// (le plan gratuit couvre les grands championnats européens + coupes
// d'Europe, avec une limite de 10 requêtes/minute — largement suffisant ici
// grâce au cache ci-dessous). Le plan gratuit autorise une fenêtre de dates
// de 10 jours maximum, on reste large en dessous avec 7 jours.
// ---------------------------------------------------------------------------

let matchsEnCache = null;   // { data, expire }
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min : une fenêtre de 7 jours change peu d'une minute à l'autre
const NB_JOURS_FENETRE = 7;

const ORIGINES_AUTORISEES = [
  "https://alain-pronostic-ia.netlify.app"
];

function origineAutorisee(event){
  const origine = event.headers.origin || event.headers.referer || "";
  return ORIGINES_AUTORISEES.some(o => origine.startsWith(o));
}

function dateISO(decalageJours){
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + decalageJours);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function formaterHeure(dateISOComplete){
  try {
    return new Date(dateISOComplete).toLocaleTimeString('fr-FR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
    }) + ' UTC';
  } catch(e){ return ''; }
}

function formaterJour(dateISOComplete){
  try {
    return new Date(dateISOComplete).toLocaleDateString('fr-FR', {
      weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC'
    });
  } catch(e){ return ''; }
}

exports.handler = async function(event, context) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Méthode non autorisée" } })
    };
  }

  if (!origineAutorisee(event)) {
    return {
      statusCode: 403,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Origine non autorisée" } })
    };
  }

  const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Clé FOOTBALL_DATA_API_KEY non configurée sur Netlify." } })
    };
  }

  // --- Cache : un seul appel externe toutes les 30 minutes max ---
  if (matchsEnCache && matchsEnCache.expire > Date.now()) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
      body: JSON.stringify({ matchs: matchsEnCache.data })
    };
  }

  const dateFrom = dateISO(0);
  const dateTo = dateISO(NB_JOURS_FENETRE - 1);
  const url = `https://api.football-data.org/v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

  try {
    const reponse = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY }
    });
    const data = await reponse.json();

    if (!reponse.ok) {
      return {
        statusCode: reponse.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: { message: data?.message || "Erreur football-data.org" } })
      };
    }

    const matchs = (data.matches || [])
      .filter(m => m.status === "SCHEDULED" || m.status === "TIMED")
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
      .map(m => ({
        jour: formaterJour(m.utcDate),
        competition: m.competition?.name || "Autre",
        equipeA: m.homeTeam?.name || "?",
        equipeB: m.awayTeam?.name || "?",
        heure: formaterHeure(m.utcDate)
      }));

    matchsEnCache = { data: matchs, expire: Date.now() + CACHE_TTL_MS };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
      body: JSON.stringify({ matchs })
    };

  } catch (error) {
    console.error("Erreur fonction matchs-du-jour :", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Erreur de communication avec football-data.org" } })
    };
  }
};
