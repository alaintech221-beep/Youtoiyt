exports.handler = async function(event, context) {
  // On s'assure d'accepter uniquement les requêtes POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Méthode non autorisée" };
  }

  // La clé API est récupérée depuis les variables d'environnement de Netlify
  const API_KEY = process.env.GEMINI_API_KEY;
  const MODELE = "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELE}:generateContent?key=${API_KEY}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // On transfère exactement ce que le frontend nous a envoyé
      body: event.body
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error("Erreur fonction Netlify :", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: "Erreur de communication avec l'IA" } })
    };
  }
};
