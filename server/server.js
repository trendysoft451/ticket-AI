import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import cors from "cors";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/** ✅ FIX Render/ESM static */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("/", (request, response) => response.sendFile(path.join(publicDir, "index.html")));

const upload = multer({ dest: "uploads/" });
const execFileAsync = promisify(execFile);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = "gpt-4.1-mini";

/** Config CNX (env > mémoire) */
let runtimeConfig = {
  baseUrl: process.env.CNX_BASE_URL || "",
  identifiant: process.env.CNX_IDENTIFIANT || "",
  motdepasse: process.env.CNX_MOTDEPASSE || "",
  codeDossier: process.env.CNX_CODE_DOSSIER || "" // requis
};

function required(v, label) {
  if (v === null || v === undefined || String(v).trim() === "") {
    throw new Error(`Champ obligatoire manquant : ${label}`);
  }
  return v;
}

function toNumberOrNull(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const x = parseFloat(v.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function isoDateOnly(d) {
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) throw new Error("Date invalide");
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** ===== TVA / comptes ===== */
const VAT = {
  "20": { code_tva: "TN", compte_tva_44566: "44566200" },
  "10": { code_tva: "TI", compte_tva_44566: "44566100" },
  "0": { code_tva: "", compte_tva_44566: "" }
};

function chargesAccount(categoryKey, vatRate) {
  switch (categoryKey) {
    case "petites_fournitures":
      if (vatRate === "20") return "60631000";
      if (vatRate === "10") return "60630000";
      return "";
    case "carburant":
      return vatRate === "20" ? "60614000" : "";
    case "repas_pro":
      return vatRate === "10" ? "62511000" : "";
    case "repas":
      return vatRate === "0" ? "62510000" : "";
    case "papeterie":
      return vatRate === "20" ? "60640000" : "";
    case "peages":
      return vatRate === "20" ? "62512000" : "";
    case "parking":
      return vatRate === "20" ? "62512000" : "";
    default:
      return "";
  }
}

/** ===== Mapping auto catégorie + compte fournisseur (F...) ===== */
function suggestFromText(text) {
  const t = (text || "").toLowerCase();
  const hasAny = (arr) => arr.some((k) => t.includes(k));

  if (hasAny(["repas", "restaurant", "café", "cafe", "brasserie", "bistrot", "menu"])) {
    return { categorie_ui: "repas_pro", compteF: "FREPAS", tva_rate: "10" };
  }
  if (hasAny(["carburant", "gasoil", "gazole", "go", "super", "sp", "essence", "station-service"])) {
    return { categorie_ui: "carburant", compteF: "FCARBU", tva_rate: "20" };
  }
  if (hasAny(["parking", "stationnement", "park"])) {
    return { categorie_ui: "parking", compteF: "FPARKING", tva_rate: "20" };
  }
  if (hasAny(["peage", "péage", "asf", "escota", "aprr", "sanef"])) {
    return { categorie_ui: "peages", compteF: "FPEAGE", tva_rate: "20" };
  }
  return { categorie_ui: null, compteF: "FDIVERS", tva_rate: null };
}

function guessVatRateFromAmounts(ht, tva) {
  if (typeof ht !== "number" || !Number.isFinite(ht) || ht <= 0) return null;
  if (typeof tva !== "number" || !Number.isFinite(tva) || tva < 0) return null;
  const r = tva / ht;
  if (Math.abs(r - 0.2) < 0.03) return "20";
  if (Math.abs(r - 0.1) < 0.02) return "10";
  if (tva === 0) return "0";
  return null;
}

/** PDF -> PNG */
async function pdfFirstPageToPng(pdfPath) {
  const outBase = path.join("uploads", crypto.randomUUID());
  await execFileAsync("pdftoppm", ["-f", "1", "-l", "1", "-png", pdfPath, outBase]);
  return `${outBase}-1.png`;
}

/** OpenAI JSON parsing robuste */
function parseOpenAIJson(raw) {
  const cleaned = String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const i = cleaned.indexOf("{");
  const j = cleaned.lastIndexOf("}");
  if (i === -1 || j === -1 || j <= i) throw new Error(`OpenAI: JSON introuvable: ${cleaned}`);

  const jsonOnly = cleaned.slice(i, j + 1);
  try {
    return JSON.parse(jsonOnly);
  } catch {
    throw new Error(`OpenAI: JSON invalide: ${jsonOnly}`);
  }
}

async function openaiExtractFromImage(dataUrl) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY manquante (env)");

  const prompt = `
Tu extrais les infos d'un ticket/facture.
Renvoie STRICTEMENT un JSON valide :
{
  "date_document": "AAAA-MM-JJ",
  "numero_ticket": "string",
  "montant_ttc": 123.45,
  "montant_ht": 100.00,
  "montant_tva": 23.45,
  "raison_sociale": "Nom visible sur le ticket",
  "mots_cles": ["repas","restaurant","parking","peage","gasoil","super","sp","stationnement"]
}`.trim();

  const body = {
    model: OPENAI_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: dataUrl }
        ]
      }
    ]
  };

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) throw new Error(`OpenAI error (${resp.status}): ${await resp.text()}`);

  const json = await resp.json();
  const raw =
    json.output_text ??
    json.output?.[0]?.content?.find((c) => c.type === "output_text")?.text ??
    json.output?.[0]?.content?.[0]?.text ??
    null;

  if (!raw) throw new Error("OpenAI: pas de texte exploitable");
  return parseOpenAIJson(raw);
}

/** ===== CNX auth + session dossier + GED upload ===== */
let cachedUuid = { value: "", at: 0 };

function getConfig() {
  return {
    baseUrl: runtimeConfig.baseUrl || process.env.CNX_BASE_URL || "",
    identifiant: runtimeConfig.identifiant || process.env.CNX_IDENTIFIANT || "",
    motdepasse: runtimeConfig.motdepasse || process.env.CNX_MOTDEPASSE || "",
    codeDossier: runtimeConfig.codeDossier || process.env.CNX_CODE_DOSSIER || ""
  };
}

async function cnxAuthenticate() {
  const { baseUrl, identifiant, motdepasse } = getConfig();
  required(baseUrl, "CNX_BASE_URL");
  required(identifiant, "CNX_IDENTIFIANT");
  required(motdepasse, "CNX_MOTDEPASSE");

  if (cachedUuid.value && Date.now() - cachedUuid.at < 10 * 60 * 1000) return cachedUuid.value;

  const url = `${baseUrl.replace(/\/$/, "")}/v1/authentification`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifiant, motdepasse })
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Authentification CNX (${resp.status}): ${text}`);

  const out = (() => {
    try { return JSON.parse(text); } catch { return { raw: text }; }
  })();

  const uuid = out?.UUID || out?.uuid || out?.data?.UUID || out?.data?.uuid || "";
  if (!uuid) throw new Error(`UUID introuvable dans la réponse auth: ${text}`);

  cachedUuid = { value: String(uuid), at: Date.now() };
  return cachedUuid.value;
}

/**
 * ✅ EXACTEMENT comme ton curl :
 * - accept: text/plain
 * - Content-Type: application/json-patch+json
 * - body: "\"DA_CONSEIL\"" (JSON string)
 */
async function cnxOpenDossierSession(codeDossier) {
  const { baseUrl } = getConfig();
  const uuid = await cnxAuthenticate();

  const cd = required(codeDossier, "codeDossier");
  const url = `${baseUrl.replace(/\/$/, "")}/v2/sessions/dossier`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      accept: "text/plain",
      UUID: uuid,
      "Content-Type": "application/json-patch+json"
    },
    body: JSON.stringify(String(cd)) // => "DA_CONSEIL"
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Session dossier CNX (${resp.status}): ${text}`);

  // souvent text/plain => on renvoie le texte
  return { raw: text };
}

/** ✅ Champ GED: idArboGed */
async function cnxUploadGedDocument({ filePath, filename, arboId = 945 }) {
  const { baseUrl } = getConfig();
  const uuid = await cnxAuthenticate();
  const url = `${baseUrl.replace(/\/$/, "")}/v1/ged/documents`;

  const boundary = "----WebKitFormBoundary" + crypto.randomUUID().replace(/-/g, "");
  const fileBuf = await fs.readFile(filePath);

  const parts = [];
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="idArboGed"\r\n\r\n` +
        `${String(arboId)}\r\n`
    )
  );
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/pdf\r\n\r\n`
    )
  );
  parts.push(fileBuf);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, UUID: uuid },
    body: Buffer.concat(parts)
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Upload GED (${resp.status}): ${text}`);

  const out = (() => {
    try { return JSON.parse(text); } catch { return { raw: text }; }
  })();

  const id = out?.Id || out?.id || out?.data?.Id || out?.data?.id || "";
  if (!id) throw new Error(`Id GED introuvable dans la réponse upload: ${text}`);

  return String(id);
}

/** Payload écritures (3 lignes) */
function buildEcriturePayload({
  journal,
  referenceGedId,
  dateTicketISO,
  numeroTicket,
  compteFournisseur,
  raisonSociale,
  compteCharges,
  codeTVA,
  compteTVA44566,
  ttc,
  ht,
  tva,
  numeroPiece = "001"
}) {
  const dt = new Date(dateTicketISO);
  if (!Number.isFinite(dt.getTime())) throw new Error("dateTicketISO invalide");

  const annee = dt.getFullYear();
  const mois = dt.getMonth() + 1;
  const jour = dt.getDate();

  const lignes = [
    {
      jour,
      numeroPiece,
      numeroFacture: String(numeroTicket),
      compte: String(compteFournisseur),
      libelle: String(raisonSociale),
      credit: round2(ttc),
      debit: 0,
      modeReglement: ""
    },
    {
      jour,
      numeroPiece,
      numeroFacture: String(numeroTicket),
      compte: String(compteCharges),
      libelle: String(raisonSociale),
      credit: 0,
      debit: round2(ht),
      ...(codeTVA ? { codeTVA: String(codeTVA) } : {})
    }
  ];

  if (typeof tva === "number" && Number.isFinite(tva) && tva > 0) {
    if (!compteTVA44566) throw new Error("compteTVA44566 manquant");
    lignes.push({
      jour,
      numeroPiece,
      numeroFacture: String(numeroTicket),
      compte: String(compteTVA44566),
      libelle: String(raisonSociale),
      credit: 0,
      debit: round2(tva)
    });
  }

  return { journal: String(journal), mois, annee, ReferenceGed: String(referenceGedId), lignesEcriture: lignes };
}

/** Admin config endpoint */
app.post("/api/admin/config", (request, response) => {
  try {
    const { baseUrl, identifiant, motdepasse, codeDossier } = request.body || {};
    runtimeConfig.baseUrl = String(baseUrl || "").trim();
    runtimeConfig.identifiant = String(identifiant || "").trim();
    runtimeConfig.motdepasse = String(motdepasse || "").trim();
    runtimeConfig.codeDossier = String(codeDossier || "").trim();
    cachedUuid = { value: "", at: 0 };
    response.json({ ok: true });
  } catch (e) {
    response.status(400).json({ error: String(e.message || e) });
  }
});

/** Public admin info (sans secrets) : récupérer code dossier */
app.get("/api/admin/public", (request, response) => {
  const { codeDossier } = getConfig();
  response.json({ codeDossier: codeDossier || "" });
});

/** Admin: ouvrir dossier via /v2/sessions/dossier (body = "CODE") */
app.post("/api/cnx/session-dossier", async (request, response) => {
  try {
    const codeDossier = String(request.body?.codeDossier || "").trim();
    const out = await cnxOpenDossierSession(codeDossier);
    response.json({ ok: true, result: out });
  } catch (e) {
    response.status(400).json({ error: String(e.message || e) });
  }
});

/** Upload PDF -> GED + OCR (+ suggestion auto) */
app.post("/api/ged/upload", upload.single("pdf"), async (request, response) => {
  let pdfPath = null;
  let pngPath = null;

  try {
    if (!request.file) throw new Error("Aucun PDF");
    pdfPath = request.file.path;

    // ✅ Dossier requis avant upload GED
    const { codeDossier } = getConfig();
    required(codeDossier, "codeDossier (admin)");

    // ✅ Ouvre la session dossier AVANT GED
    await cnxOpenDossierSession(codeDossier);

    const gedId = await cnxUploadGedDocument({
      filePath: pdfPath,
      filename: request.file.originalname || "ticket.pdf",
      arboId: 945
    });

    pngPath = await pdfFirstPageToPng(pdfPath);
    const pngB64 = await fs.readFile(pngPath, { encoding: "base64" });
    const extraction = await openaiExtractFromImage(`data:image/png;base64,${pngB64}`);

    const montant_ttc = toNumberOrNull(extraction.montant_ttc);
    const montant_ht = toNumberOrNull(extraction.montant_ht);
    const montant_tva = toNumberOrNull(extraction.montant_tva);

    const mots_cles = Array.isArray(extraction.mots_cles) ? extraction.mots_cles.map(String) : [];
    const textForSuggest = [extraction.raison_sociale || "", ...mots_cles].join(" ");
    const sug = suggestFromText(textForSuggest);

    const guessedRate = guessVatRateFromAmounts(montant_ht, montant_tva);

    response.json({
      ok: true,
      gedId,
      extraction: {
        date_document: extraction.date_document || null,
        numero_ticket: extraction.numero_ticket || null,
        raison_sociale: extraction.raison_sociale || null,
        montant_ttc,
        montant_ht,
        montant_tva,
        mots_cles
      },
      suggestion: {
        categorie_ui: sug.categorie_ui,
        compteF: sug.compteF,
        tva_rate: guessedRate || sug.tva_rate
      }
    });
  } catch (e) {
    response.status(400).json({ error: String(e.message || e) });
  } finally {
    if (pdfPath) await fs.unlink(pdfPath).catch(() => {});
    if (pngPath) await fs.unlink(pngPath).catch(() => {});
  }
});

/** Build Écritures JSON */
app.post("/api/receipts/process", upload.none(), async (request, response) => {
  try {
    const meta = JSON.parse(request.body.meta || "{}");

    const journal = required(meta.journal, "journal");
    const referenceGedId = required(meta.referenceGedId, "referenceGedId");
    const compteFournisseur = required(meta.compteFournisseur, "compteFournisseur (F...)");

    const categorie_ui = required(meta.categorie_ui, "categorie_ui");
    const tva_rate = required(meta.tva_rate, "tva_rate (20/10/0)");

    const charges = chargesAccount(categorie_ui, tva_rate);
    if (!charges) throw new Error("Combinaison catégorie/TVA invalide");

    const vat = VAT[tva_rate];
    if (!vat) throw new Error("tva_rate invalide (20/10/0)");

    const date_ticket = required(meta.date_ticket ? isoDateOnly(meta.date_ticket) : null, "date_ticket");
    const numero_ticket = required(meta.numero_ticket || null, "numero_ticket");
    const raison_sociale = required(meta.raison_sociale || null, "raison_sociale");

    const ttc = required(toNumberOrNull(meta.montant_ttc), "montant_ttc");
    const ht = required(toNumberOrNull(meta.ht), "ht");

    let tva = toNumberOrNull(meta.tva_montant);
    if (tva == null && typeof ttc === "number" && typeof ht === "number") {
      const computedTva = ttc - ht;
      if (Number.isFinite(computedTva) && computedTva >= 0) tva = computedTva;
    }

    const ecritures = buildEcriturePayload({
      journal,
      referenceGedId,
      dateTicketISO: date_ticket,
      numeroTicket: numero_ticket,
      compteFournisseur,
      raisonSociale: raison_sociale,
      compteCharges: charges,
      codeTVA: vat.code_tva,
      compteTVA44566: vat.compte_tva_44566,
      ttc: Number(ttc),
      ht: Number(ht),
      tva: tva != null ? Number(tva) : 0
    });

    response.json({ ok: true, ecritures });
  } catch (e) {
    response.status(400).json({ error: String(e.message || e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("API running"));
