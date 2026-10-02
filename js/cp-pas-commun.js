// ==========================================================
// CP-PAS — MODULE COMMUN (étape 2) : produits d'épargne, comptes, grand livre.
//
// Fichier IDENTIQUE à placer à côté de firebase-config.js dans l'application
// PDG ET dans l'application Collecteur (chaque application le charge à la
// demande avec import('./cp-pas-commun.js') : s'il est absent ou en erreur,
// le reste de l'application continue de fonctionner).
//
// Règles de conception (cahier des charges CP-PAS) :
// - le grand livre (ledger_entries) est en ajout seul : jamais de modification
//   ni de suppression d'une écriture ;
// - le solde d'un compte est matérialisé pour la performance, mais il doit
//   toujours pouvoir être reconstruit à partir du grand livre
//   (voir verifierIntegriteGrandLivre) ;
// - chaque opération est exécutée dans UNE transaction Firestore (tout ou
//   rien) : compte, caisse, écritures et compteurs sont écrits ensemble ;
// - aucune règle financière n'est codée en dur : elles viennent des produits.
// ==========================================================
import {
  db, doc, collection, query, where, getDocs, runTransaction, serverTimestamp,
  onSnapshot, orderBy, limit,
} from "./firebase-config.js";

export const TYPES_PRODUIT = {
  LIBRE: 'Épargne libre',
  PROJET: 'Épargne projet',
  PREVOYANCE: 'Épargne prévoyance',
  TERME: 'Épargne à terme',
};

export const STATUTS_COMPTE = {
  EN_ATTENTE_KYC: "En attente du dossier d'identité",
  ACTIF: 'Actif',
  BLOQUE: 'Bloqué',
  CLOTURE: 'Clôturé',
};

export const TYPES_OPERATION = {
  DEPOT_OUVERTURE: "Dépôt d'ouverture",
};

export function normaliserCodeProduit(texte) {
  return String(texte || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Les 4 produits du cahier des charges. Ils sont créés INACTIFS et avec des
// valeurs financières à zéro : les paramètres définitifs (minimums, plafonds,
// frais, rémunération, durées) sont à valider avant toute activation.
export function produitsTypes() {
  const base = {
    depot_minimum: 0,
    solde_minimum: 0,
    plafond: 0,
    frais_ouverture: 0,
    taux_remuneration_annuel: 0,
    duree_mois: 0,
    regles_retrait: 'À définir avant activation.',
    conditions_cloture: 'À définir avant activation.',
    statut: 'inactif',
  };
  return [
    {
      ...base,
      code: 'EPARGNE_LIBRE',
      nom: 'Épargne libre',
      type: 'LIBRE',
      objectif: 'Dépôts réguliers, retraits selon contrat, consultation du solde et de l\'historique.',
    },
    {
      ...base,
      code: 'EPARGNE_PROJET',
      nom: 'Épargne projet',
      type: 'PROJET',
      objectif: 'Objectif chiffré et échéance (scolarité, équipement, activité commerciale).',
    },
    {
      ...base,
      code: 'EPARGNE_PREVOYANCE',
      nom: 'Épargne prévoyance',
      type: 'PREVOYANCE',
      objectif: 'Réserve destinée aux besoins futurs, selon des conditions contractuelles précises.',
    },
    {
      ...base,
      code: 'EPARGNE_TERME',
      nom: 'Épargne à terme',
      type: 'TERME',
      objectif: 'Montant immobilisé pour une durée définie, avec règles d\'échéance et de retrait anticipé.',
      duree_mois: 12,
    },
  ];
}

function pad(n, taille = 6) {
  return String(n).padStart(taille, '0');
}

function millis(ts) {
  return ts && ts.toMillis ? ts.toMillis() : 0;
}

function ajouterMois(date, n) {
  const d = new Date(date.getTime());
  d.setMonth(d.getMonth() + n);
  return d;
}

// ----------------------------------------------------------
// Ouverture d'un compte d'épargne (avec dépôt d'ouverture éventuel).
// Tout est écrit dans une seule transaction :
//  - le compte (statut ACTIF si le dossier d'identité est vérifié, sinon
//    EN_ATTENTE_KYC : dans ce cas aucun dépôt n'est possible) ;
//  - si dépôt : 2 écritures au grand livre (compte + caisse de l'agence)
//    liées par le même transaction_id, et les soldes correspondants ;
//  - les compteurs de numérotation (CPC-2026-000001, CP-2026-000001).
// Idempotent : le compte a un identifiant fixé à l'avance ; un double envoi
// est refusé au lieu d'être comptabilisé deux fois.
// ----------------------------------------------------------
export async function ouvrirCompteEpargne(p) {
  const { compteId, membre, collecteurId, collecteurNom, produit, agence } = p;
  const depot = Number(p.depotInitial || 0);
  const kycVerifie = !!p.kycVerifie;

  if (!compteId || !membre || !membre.uid || !produit || !agence || !agence.uid) {
    throw new Error('Données incomplètes pour ouvrir le compte.');
  }
  if (!(depot >= 0)) throw new Error('Montant du dépôt invalide.');
  if (produit.statut !== 'actif') throw new Error("Ce produit d'épargne n'est pas actif.");
  if (depot > 0 && !kycVerifie) {
    throw new Error("Dépôt impossible tant que le dossier d'identité n'est pas vérifié : le compte reste en attente.");
  }
  if (kycVerifie) {
    const minimum = Math.max(Number(produit.depot_minimum || 0), Number(produit.solde_minimum || 0));
    if (depot < minimum) {
      throw new Error(`Le dépôt d'ouverture doit être d'au moins ${minimum} GNF pour ce produit.`);
    }
  }
  if (Number(produit.plafond || 0) > 0 && depot > Number(produit.plafond)) {
    throw new Error(`Le dépôt dépasse le plafond du produit (${produit.plafond} GNF).`);
  }

  let objectifMontant = null;
  let echeance = null;
  if (produit.type === 'PROJET') {
    objectifMontant = Number(p.objectifMontant || 0);
    echeance = p.echeance || null;
    if (!(objectifMontant > 0) || !echeance) {
      throw new Error("Pour une épargne projet, l'objectif chiffré et l'échéance sont obligatoires.");
    }
  } else if (produit.type === 'TERME' && Number(produit.duree_mois || 0) > 0) {
    echeance = ajouterMois(new Date(), Number(produit.duree_mois)).toISOString().slice(0, 10);
  }

  const annee = new Date().getFullYear();
  const compteRef = doc(db, 'comptes_epargne', compteId);
  const compteursRef = doc(db, 'compteurs', 'cp_pas');
  const configRef = doc(db, 'configuration', 'cp_pas');
  const caisseRef = doc(db, 'caisses_agence', agence.uid);

  return runTransaction(db, async (tx) => {
    // --- Lectures (toutes avant les écritures) ---
    const cfgSnap = await tx.get(configRef);
    if (!cfgSnap.exists() || cfgSnap.data().epargne_active !== true) {
      throw new Error("Le module d'épargne CP-PAS n'est pas activé par le PDG.");
    }
    const existant = await tx.get(compteRef);
    if (existant.exists()) {
      throw new Error('Ce compte a déjà été créé (double envoi évité).');
    }
    const cptSnap = await tx.get(compteursRef);
    const caisseSnap = depot > 0 ? await tx.get(caisseRef) : null;

    const compteurs = cptSnap.exists() ? cptSnap.data() : {};
    const cleComptes = `comptes_${annee}`;
    const cleTransactions = `transactions_${annee}`;
    const nComptes = Number(compteurs[cleComptes] || 0) + 1;
    const numero = `CPC-${annee}-${pad(nComptes)}`;

    // --- Écritures ---
    tx.set(compteRef, {
      compte_id: compteId,
      numero,
      membre_id: membre.uid,
      membre_nom: membre.nom || '',
      membre_telephone: membre.telephone || '',
      collecteur_id: collecteurId || null,
      collecteur_nom: collecteurNom || '',
      produit_code: produit.code || produit.id,
      produit_nom: produit.nom || '',
      produit_type: produit.type || '',
      produit_version: Number(produit.version || 1),
      regles_produit: {
        depot_minimum: Number(produit.depot_minimum || 0),
        solde_minimum: Number(produit.solde_minimum || 0),
        plafond: Number(produit.plafond || 0),
      },
      agence_id: agence.uid,
      agence_nom: agence.nom || '',
      prefecture: agence.prefecture || '',
      statut: kycVerifie ? 'ACTIF' : 'EN_ATTENTE_KYC',
      kyc_verifie: kycVerifie,
      solde: depot,
      objectif_montant: objectifMontant,
      echeance,
      duree_mois: Number(produit.duree_mois || 0) || null,
      ouvert_par: agence.uid,
      date_ouverture: serverTimestamp(),
      date_maj: serverTimestamp(),
    });

    const maj = { [cleComptes]: nComptes };
    let reference = null;

    if (depot > 0) {
      const nTransactions = Number(compteurs[cleTransactions] || 0) + 1;
      reference = `CP-${annee}-${pad(nTransactions)}`;
      const transactionId = `TX-${annee}-${pad(nTransactions)}`;
      const soldeCaisseApres = (caisseSnap && caisseSnap.exists() ? Number(caisseSnap.data().solde || 0) : 0) + depot;

      const commun = {
        transaction_id: transactionId,
        reference,
        member_id: membre.uid,
        collecteur_id: collecteurId || null,
        operation_type: 'DEPOT_OUVERTURE',
        status: 'EXECUTE',
        actor_id: agence.uid,
        validator_id: null,
        agency_id: agence.uid,
        prefecture: agence.prefecture || '',
        timestamp: serverTimestamp(),
      };

      tx.set(doc(db, 'ledger_entries', `${transactionId}-1`), {
        ...commun,
        ledger_entry_id: `${transactionId}-1`,
        account_id: compteId,
        account_type: 'COMPTE_EPARGNE',
        account_numero: numero,
        amount: depot,
        direction: 'CREDIT',
        solde_apres: depot,
        description: `Dépôt d'ouverture du compte ${numero} (${produit.nom || ''})`,
      });
      tx.set(doc(db, 'ledger_entries', `${transactionId}-2`), {
        ...commun,
        ledger_entry_id: `${transactionId}-2`,
        account_id: `CAISSE_${agence.uid}`,
        account_type: 'CAISSE_AGENCE',
        account_numero: `CAISSE-${agence.nom || agence.uid}`,
        amount: depot,
        direction: 'CREDIT',
        solde_apres: soldeCaisseApres,
        description: `Espèces reçues pour l'ouverture du compte ${numero}`,
      });
      tx.set(caisseRef, {
        agence_id: agence.uid,
        agence_nom: agence.nom || '',
        prefecture: agence.prefecture || '',
        solde: soldeCaisseApres,
        date_maj: serverTimestamp(),
      });
      maj[cleTransactions] = nTransactions;
    }

    tx.set(compteursRef, maj, { merge: true });
    return { compteId, numero, reference };
  });
}

// ----------------------------------------------------------
// Historique d'un compte (écritures du grand livre, plus récentes d'abord).
// Pour une agence, passer la préfecture : la requête doit être bornée à sa
// préfecture pour être autorisée par les règles Firestore.
// ----------------------------------------------------------
export async function chargerHistoriqueCompte(compteId, prefecture) {
  const contraintes = [where('account_id', '==', compteId)];
  if (prefecture) contraintes.push(where('prefecture', '==', prefecture));
  const snap = await getDocs(query(collection(db, 'ledger_entries'), ...contraintes));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => millis(b.timestamp) - millis(a.timestamp));
}

// ----------------------------------------------------------
// Flux en direct des dernières écritures du grand livre (PDG).
// Retourne la fonction pour arrêter l'écoute.
// ----------------------------------------------------------
export function ecouterDernieresEcritures(nombre, rappel, rappelErreur) {
  const q = query(collection(db, 'ledger_entries'), orderBy('timestamp', 'desc'), limit(nombre));
  return onSnapshot(
    q,
    (snap) => rappel(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => { if (rappelErreur) rappelErreur(err); }
  );
}

// ----------------------------------------------------------
// Contrôle d'intégrité (PDG) : reconstruit chaque solde à partir du grand
// livre (crédits - débits) et le compare au solde affiché. Tout écart est
// signalé (jamais corrigé silencieusement). À lancer à la demande : il lit
// tout le grand livre.
// ----------------------------------------------------------
export async function verifierIntegriteGrandLivre() {
  const [ledgerSnap, comptesSnap, caissesSnap] = await Promise.all([
    getDocs(collection(db, 'ledger_entries')),
    getDocs(collection(db, 'comptes_epargne')),
    getDocs(collection(db, 'caisses_agence')),
  ]);

  const attendus = {};
  ledgerSnap.docs.forEach((d) => {
    const e = d.data();
    const signe = e.direction === 'CREDIT' ? 1 : -1;
    attendus[e.account_id] = (attendus[e.account_id] || 0) + signe * Number(e.amount || 0);
  });

  const ecarts = [];
  const connus = new Set();

  comptesSnap.docs.forEach((d) => {
    const c = d.data();
    connus.add(d.id);
    const attendu = attendus[d.id] || 0;
    const affiche = Number(c.solde || 0);
    if (Math.abs(attendu - affiche) > 0.5) {
      ecarts.push({ id: d.id, libelle: `${c.numero || d.id} — ${c.membre_nom || ''}`, attendu, affiche });
    }
  });
  caissesSnap.docs.forEach((d) => {
    const c = d.data();
    const id = `CAISSE_${d.id}`;
    connus.add(id);
    const attendu = attendus[id] || 0;
    const affiche = Number(c.solde || 0);
    if (Math.abs(attendu - affiche) > 0.5) {
      ecarts.push({ id, libelle: `Caisse de l'agence ${c.agence_nom || d.id}`, attendu, affiche });
    }
  });

  const orphelines = Object.keys(attendus).filter((id) => !connus.has(id));

  return {
    nbEcritures: ledgerSnap.size,
    nbComptes: comptesSnap.size,
    nbCaisses: caissesSnap.size,
    ecarts,
    orphelines,
    date: new Date(),
  };
}
