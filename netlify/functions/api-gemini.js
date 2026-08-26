const crypto = require("crypto");

// ---------------------------------------------------------------------------
// État en mémoire de l'instance de fonction (voir note importante en bas du fichier)
// ---------------------------------------------------------------------------
const compteurParIP = new Map();   // ip -> [timestamps des requêtes récentes]
const cacheReponses = new Map();   // hash du prompt -> { data, expire }

const FENETRE_MS = 60 * 1000;      // fenêtre glissante d'1 minute
const LIMITE_PAR_FENETRE = 5;      // 5 requêtes/minute/IP (aligné sur le quota gratuit Gemini)
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2h : un même match posé plusieurs fois réutilise la réponse

function nettoyerAncien(map, estExpire){
  const maintenant = Date.now();
  for (const [cle, valeur] of map){
    if (estExpire(valeur, maintenant)) map.delete(cle);
  }
}

function ipDuVisiteur(event){
  // Netlify transmet la vraie IP via ce header derrière son proxy
  const brut = event.headers["x-nf-client-connection-ip"]
    || event.headers["x-forwarded-for"]
    || "inconnue";
  return brut.split(",")[0].trim();
}

function estAutorise(ip){
  nettoyerAncien(compteurParIP, (horodatages) => {
    const dernier = horodatages[horodatages.length - 1];
    return Date.now() - dernier > FENETRE_MS;
  });

  const maintenant = Date.now();
  const horodatages = (compteurParIP.get(ip) || []).filter(t => maintenant - t < FENETRE_MS);

  if (horodatages.length >= LIMITE_PAR_FENETRE) {
    compteurParIP.set(ip, horodatages);
    return false;
  }

  horodatages.push(maintenant);
  compteurParIP.set(ip, horodatages);
  return true;
}

function cleCache(corpsBrut){
  return crypto.createHash("sha256").update(corpsBrut).digest("hex");
}

function depuisCache(cle){
  nettoyerAncien(cacheReponses, (valeur, maintenant) => valeur.expire < maintenant);
  const entree = cacheReponses.get(cle);
  return entree ? entree.data : null;
}

function versCache(cle, data){
  cacheReponses.set(cle, { data, expire: Date.now() + CACHE_TTL_MS });
}

exports.handler = async function(event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Méthode non autorisée" } })
    };
  }

  const ip = ipDuVisiteur(event);

  // --- Rate limiting : protège le quota Gemini contre le spam / les bots ---
  if (!estAutorise(ip)) {
    return {
      statusCode: 429,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: { message: "Trop de requêtes depuis cette adresse. Merci de patienter une minute." }
      })
    };
  }

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Clé GEMINI_API_KEY non configurée sur Netlify." } })
    };
  }

  // --- Cache : évite de rappeler Gemini pour un prompt identique récent ---
  const cle = cleCache(event.body || "");
  const enCache = depuisCache(cle);
  if (enCache) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "X-Cache": "HIT" },
      body: JSON.stringify(enCache)
    };
  }

  const MODELE = "gemini-3.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELE}:generateContent?key=${API_KEY}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: event.body
    });

    const data = await response.json();

    // On ne met en cache que les réponses réussies et exploitables
    if (response.ok && !data.error) {
      versCache(cle, data);
    }

    return {
      statusCode: response.status,
      headers: { "Content-Type": "application/json", "X-Cache": "MISS" },
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error("Erreur fonction Netlify :", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: { message: "Erreur de communication avec l'IA" } })
    };
  }
};

// ---------------------------------------------------------------------------
// NOTE IMPORTANTE : les Map ci-dessus vivent en mémoire de l'instance de la
// fonction Netlify. Ça fonctionne bien tant que l'instance reste "chaude"
// (appels rapprochés), mais :
//  - un "cold start" (fonction pas appelée depuis un moment) réinitialise tout
//  - si Netlify fait tourner plusieurs instances en parallèle (gros trafic),
//    chaque instance a son propre compteur/cache, donc la limite réelle peut
//    être dépassée d'un facteur N
// Pour un vrai partage entre instances, l'étape suivante serait Netlify Blobs
// (@netlify/blobs, stockage clé-valeur géré par Netlify, quasi identique en
// usage) ou un service externe comme Upstash Redis. Pour ton volume actuel,
// cette version en mémoire suffit largement et règle déjà le problème de quota.
// ---------------------------------------------------------------------------
