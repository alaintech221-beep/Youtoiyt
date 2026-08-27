// ---------------------------------------------------------------------------
// Fonction Netlify : renvoie les dernières confrontations directes entre
// deux équipes, à partir de football-data.org (plan gratuit).
//
// Comme le plan gratuit ne fournit pas de recherche d'équipe par nom, on
// construit et met en cache la liste des équipes des grandes compétitions
// suivies, puis on fait une correspondance approximative avec les noms
// saisis par l'utilisateur. Si une des deux équipes n'est pas reconnue
// (championnat non couvert, faute de frappe trop éloignée...), on renvoie
// simplement { disponible: false } et le site masque le bloc sans erreur.
// ---------------------------------------------------------------------------

const COMPETITIONS_SUIVIES = ["PL", "PD", "SA", "BL1", "FL1", "CL"];
const CACHE_EQUIPES_TTL_MS = 24 * 60 * 60 * 1000; // 24h : les effectifs de clubs changent peu
const CACHE_H2H_TTL_MS = 6 * 60 * 60 * 1000;       // 6h : pas besoin de re-vérifier plus souvent

let cacheEquipes = null;          // { data, expire }
const cacheH2H = new Map();       // "idA-idB" -> { data, expire }

const ORIGINES_AUTORISEES = [
  "https://alain-pronostic-ia.netlify.app"
];

function origineAutorisee(event){
  const origine = event.headers.origin || event.headers.referer || "";
  return ORIGINES_AUTORISEES.some(o => origine.startsWith(o));
}

function normaliser(txt){
  return String(txt || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

async function chargerEquipes(API_KEY){
  if (cacheEquipes && cacheEquipes.expire > Date.now()) return cacheEquipes.data;

  const listes = await Promise.all(COMPETITIONS_SUIVIES.map(code =>
    fetch(`https://api.football-data.org/v4/competitions/${code}/teams`, {
      headers: { "X-Auth-Token": API_KEY }
    })
      .then(r => r.ok ? r.json() : { teams: [] })
      .then(d => d.teams || [])
      .catch(() => [])
  ));

  const equipes = listes.flat().map(t => ({
    id: t.id,
    nom: t.name,
    court: t.shortName || t.tla || t.name
  }));

  cacheEquipes = { data: equipes, expire: Date.now() + CACHE_EQUIPES_TTL_MS };
  return equipes;
}

function trouverEquipe(nomSaisi, equipes){
  const cible = normaliser(nomSaisi);
  if (!cible) return null;

  let trouve = equipes.find(e => normaliser(e.nom) === cible || normaliser(e.court) === cible);
  if (trouve) return trouve;

  trouve = equipes.find(e => {
    const n = normaliser(e.nom), c = normaliser(e.court);
    return (n && (n.includes(cible) || cible.includes(n))) ||
           (c && (c.includes(cible) || cible.includes(c)));
  });
  return trouve || null;
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

  const params = event.queryStringParameters || {};
  const equipeA = (params.equipeA || "").slice(0, 100);
  const equipeB = (params.equipeB || "").slice(0, 100);
  if (!equipeA || !equipeB) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Paramètres equipeA et equipeB requis" } })
    };
  }

  try {
    const equipes = await chargerEquipes(API_KEY);
    const eqA = trouverEquipe(equipeA, equipes);
    const eqB = trouverEquipe(equipeB, equipes);

    if (!eqA || !eqB || eqA.id === eqB.id) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disponible: false })
      };
    }

    const cle = [eqA.id, eqB.id].sort().join('-');
    const enCache = cacheH2H.get(cle);
    if (enCache && enCache.expire > Date.now()) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
        body: JSON.stringify({ disponible: true, confrontations: enCache.data })
      };
    }

    const reponse = await fetch(`https://api.football-data.org/v4/teams/${eqA.id}/matches?status=FINISHED&limit=100`, {
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

    const confrontations = (data.matches || [])
      .filter(m =>
        (m.homeTeam?.id === eqA.id && m.awayTeam?.id === eqB.id) ||
        (m.homeTeam?.id === eqB.id && m.awayTeam?.id === eqA.id)
      )
      .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
      .slice(0, 5)
      .map(m => ({
        date: new Date(m.utcDate).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }),
        domicile: m.homeTeam?.name || "?",
        exterieur: m.awayTeam?.name || "?",
        scoreDomicile: m.score?.fullTime?.home ?? null,
        scoreExterieur: m.score?.fullTime?.away ?? null,
        competition: m.competition?.name || ""
      }));

    cacheH2H.set(cle, { data: confrontations, expire: Date.now() + CACHE_H2H_TTL_MS });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
      body: JSON.stringify({ disponible: true, confrontations })
    };

  } catch (error) {
    console.error("Erreur fonction head-to-head :", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Erreur de communication avec football-data.org" } })
    };
  }
};
