// js/tournante-commun.js — Fonctions communes de la tontine tournante (PDG et Collecteur)
import { db, auth, doc, getDoc, updateDoc, collection, query, where, serverTimestamp } from "./firebase-config.js";
import { getDocs, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const PCT_COLLECTEUR = 30;
export const PCT_SECURITE = 40; // le PDG reçoit le reste (30 % + arrondis)

export const PERIODICITES = {
  jour: "Journalière",
  semaine: "Hebdomadaire",
  mois: "Mensuelle",
  trimestre: "Trimestrielle",
  semestre: "Semestrielle",
  annee: "Annuelle",
};

export function esc(t) {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function entier(v) {
  return Math.max(0, Math.round(Number(v) || 0));
}

export function libelleStatutCaisse(s) {
  return s === "inscriptions" ? "Inscriptions ouvertes" : s === "en_cours" ? "En cours" : "Clôturée";
}

export function calculerRepartition(total, nbMembres) {
  const collecteur = Math.floor((total * PCT_COLLECTEUR) / 100);
  const securiteTotal = Math.floor((total * PCT_SECURITE) / 100);
  const parMembre = nbMembres > 0 ? Math.floor(securiteTotal / nbMembres) : 0;
  const distribue = parMembre * nbMembres;
  const pdg = total - collecteur - distribue; // 30 % + reste d'arrondi
  return { total, collecteur, parMembre, distribue, pdg };
}

export function inscriptionsOuvertes(caisse) {
  return !!caisse && caisse.statut === "inscriptions" &&
    new Date() <= new Date(`${caisse.date_limite_inscription}T23:59:59`);
}

// Caisses d'un collecteur encore ouvertes aux inscriptions
export async function listerCaissesOuvertes(collecteurId) {
  const snap = await getDocs(query(collection(db, "caisses_tournantes"), where("collecteur_id", "==", collecteurId)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter(inscriptionsOuvertes)
    .sort((a, b) => String(a.nom || "").localeCompare(String(b.nom || ""), "fr"));
}

// Solde de sécurité d'un membre + ses opérations (les plus récentes d'abord)
export async function chargerSoldeSecurite(membreDocId) {
  const snap = await getDocs(query(collection(db, "tournante_operations"), where("membre_id", "==", membreDocId)));
  const operations = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.date?.toMillis?.() || 0) - (a.date?.toMillis?.() || 0));
  const solde = operations.reduce((s, o) => s + Number(o.montant || 0), 0);
  return { solde, operations };
}

function operation(caisse, membreDocId, membreUid, type, montant, libelle) {
  return {
    caisse_id: caisse.id,
    membre_id: membreDocId,
    membre_uid: membreUid ?? null,
    type,
    montant,
    libelle,
    tour: null,
    reunion_id: null,
    date: serverTimestamp(),
    auteur_id: auth.currentUser ? auth.currentUser.uid : null,
  };
}

// Inscrit un membre TINA (compte déjà créé) dans une caisse tournante.
// Tout est écrit en une seule opération : fiche du membre, caution,
// frais d'inscription prélevés sur la caution, commissions 30 % / 30 %
// (collection frais_inscription, donc ajoutées aux totaux existants) et
// part de 40 % répartie sur le solde de sécurité de chaque membre.
// Les identifiants des documents sont fixes : refaire l'opération ne crée pas de doublon.
export async function adhererCaisse({ caisse, membreUid, membreNom, membreTelephone = "", propositionId = null }) {
  if (!caisse || !caisse.id) throw new Error("Caisse introuvable.");
  if (!inscriptionsOuvertes(caisse)) throw new Error("Les inscriptions sont closes pour cette caisse.");

  const membreDocId = `${caisse.id}_${membreUid}`;
  const refMembre = doc(db, "tournante_membres", membreDocId);
  const [dejaSnap, existantsSnap] = await Promise.all([
    getDoc(refMembre),
    getDocs(query(collection(db, "tournante_membres"), where("caisse_id", "==", caisse.id))),
  ]);
  if (dejaSnap.exists()) throw new Error("Ce membre est déjà inscrit dans cette caisse.");

  const existants = existantsSnap.docs.map((d) => ({ id: d.id, membre_uid: d.data().membre_uid ?? null }));
  const batch = writeBatch(db);

  batch.set(refMembre, {
    caisse_id: caisse.id,
    collecteur_id: caisse.collecteur_id,
    membre_uid: membreUid,
    nom: membreNom,
    telephone: membreTelephone,
    rang: null,
    ordre_inscription: Date.now(),
    arrieres: [],
    solde_retire: false,
    date_inscription: serverTimestamp(),
  });

  const caution = entier(caisse.montant_caution);
  const frais = entier(caisse.frais_inscription);

  if (caution > 0) {
    batch.set(
      doc(db, "tournante_operations", `${membreDocId}_caution`),
      operation(caisse, membreDocId, membreUid, "caution", caution, "Caution déposée à l'inscription")
    );
  }

  if (frais > 0) {
    batch.set(
      doc(db, "tournante_operations", `${membreDocId}_frais`),
      operation(caisse, membreDocId, membreUid, "frais_inscription", -frais, "Frais d'inscription")
    );
    const tous = [...existants, { id: membreDocId, membre_uid: membreUid }];
    const rep = calculerRepartition(frais, tous.length);
    if (rep.pdg !== 0 || rep.collecteur !== 0) {
      batch.set(doc(db, "frais_inscription", `tt_${membreDocId}`), {
        contract_id: null,
        membre_id: membreUid,
        collecteur_id: caisse.collecteur_id,
        montant_total: frais,
        montant_pdg: rep.pdg,
        montant_collecteur: rep.collecteur,
        date: serverTimestamp(),
        source: "tontine_tournante",
        caisse_id: caisse.id,
        libelle: "Frais d'inscription — tontine tournante",
      });
    }
    if (rep.parMembre !== 0) {
      tous.forEach((m) => {
        batch.set(
          doc(db, "tournante_operations", `${membreDocId}_part_${m.id}`),
          operation(caisse, m.id, m.membre_uid, "part_securite", rep.parMembre, "Part 40 % — frais d'inscription")
        );
      });
    }
  }

  if (propositionId) {
    batch.update(doc(db, "propositions_nouveau_contrat", propositionId), {
      adhesion_traitee: true,
      adhesion_date: serverTimestamp(),
    });
  }

  await batch.commit();
  return membreDocId;
}

// Finalise les adhésions dont le membre a confirmé la proposition
// (statut "accepte") mais qui ne sont pas encore inscrites dans la caisse.
// Une seule tentative par proposition et par session.
const dejaTentees = new Set();

export async function finaliserAdhesionsEnAttente(propositions) {
  const aTraiter = (propositions || []).filter((p) =>
    p.type_contrat === "tournante" && p.statut === "accepte" &&
    p.adhesion_traitee !== true && p.caisse_id && !dejaTentees.has(p.id)
  );

  for (const p of aTraiter) {
    dejaTentees.add(p.id);
    try {
      const refProp = doc(db, "propositions_nouveau_contrat", p.id);
      const propSnap = await getDoc(refProp);
      if (!propSnap.exists() || propSnap.data().adhesion_traitee === true) continue;

      const clore = (motif) => updateDoc(refProp, {
        adhesion_traitee: true, adhesion_refusee: true, adhesion_motif: motif, adhesion_date: serverTimestamp(),
      });

      const caisseSnap = await getDoc(doc(db, "caisses_tournantes", p.caisse_id));
      if (!caisseSnap.exists()) { await clore("Caisse introuvable"); continue; }
      const caisse = { id: caisseSnap.id, ...caisseSnap.data() };

      const dejaSnap = await getDoc(doc(db, "tournante_membres", `${caisse.id}_${p.membre_id}`));
      if (dejaSnap.exists()) {
        await updateDoc(refProp, { adhesion_traitee: true, adhesion_date: serverTimestamp() });
        continue;
      }
      if (!inscriptionsOuvertes(caisse)) { await clore("Inscriptions closes"); continue; }

      let telephone = "";
      try {
        const u = await getDoc(doc(db, "users", p.membre_id));
        if (u.exists()) telephone = u.data().telephone || "";
      } catch (e) { /* ignore */ }

      await adhererCaisse({
        caisse,
        membreUid: p.membre_id,
        membreNom: p.membre_nom || "",
        membreTelephone: telephone,
        propositionId: p.id,
      });
    } catch (err) {
      console.error("Adhésion tontine tournante :", err);
    }
  }
}
