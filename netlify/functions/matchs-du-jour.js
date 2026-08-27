// ---------------------------------------------------------------------------
// Fonction Netlify : renvoie la liste des matchs du jour pour les grandes
// compétitions suivies par football-data.org (plan gratuit).
//
// Nécessite une variable d'environnement FOOTBALL_DATA_API_KEY sur Netlify.
// Clé gratuite à obtenir sur https://www.football-data.org/client/register
// (le plan gratuit couvre les grands championnats européens + coupes
// d'Europe, avec une limite de 10 requêtes/minute — largement suffisant ici
// grâce au cache ci-dessous).
// ---------------------------------------------------------------------------

let matchsEnCache = null;   // { data, expire }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min : les horaires du jour ne changent pas souvent

const ORIGINES_AUTORISEES = [
  "https://alain-pronostic-ia.netlify.app"
];

function origineAutorisee(event){
  const origine = event.headers.origin || event.headers.referer || "";
  return ORIGINES_AUTORISEES.some(o => origine.startsWith(o));
}

function dateDuJourISO(){
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function formaterHeure(dateISO){
  try {
    return new Date(dateISO).toLocaleTimeString('fr-FR', {
      hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
    }) + ' UTC';
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

  // --- Cache : un seul appel externe toutes les 10 minutes max ---
  if (matchsEnCache && matchsEnCache.expire > Date.now()) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
      body: JSON.stringify({ matchs: matchsEnCache.data })
    };
  }

  const jour = dateDuJourISO();
  const url = `https://api.football-data.org/v4/matches?dateFrom=${jour}&dateTo=${jour}`;

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

    const matchs = (data.matches || []).map(m => ({
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
