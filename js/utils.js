export function genererCodeParrain(prefixe) {
  const caracteres = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += caracteres[Math.floor(Math.random() * caracteres.length)];
  }
  return `${prefixe}-${code}`;
}

export function formatGNF(montant) {
  const n = Number(montant) || 0;
  return n.toLocaleString("fr-FR") + " GNF";
}

export function formatMontant(montant) {
  return formatGNF(montant);
}

export function formatDate(dateVal) {
  if (!dateVal) return "—";
  const d = dateVal.toDate ? dateVal.toDate() : new Date(dateVal);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateHeure(dateVal) {
  if (!dateVal) return "—";
  const d = dateVal.toDate ? dateVal.toDate() : new Date(dateVal);
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function moisDeDate(dateVal) {
  if (!dateVal) return "inconnu";
  const d = dateVal.toDate ? dateVal.toDate() : new Date(dateVal);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function nomMois(cleMoisAnnee) {
  const [annee, mois] = cleMoisAnnee.split("-");
  const d = new Date(Number(annee), Number(mois) - 1, 1);
  return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

// ==========================================================
// --- NOUVEAU (25 août 2026) : types de contrats ---
// Le contrat "journalier" existant garde son fonctionnement propre
// (géré directement dans les app.js : 31 jours, prêt 2%/semaine).
// Les 2 nouveaux types partagent les mêmes règles de clôture que le
// journalier, mais avec une durée et une périodicité différentes,
// et un prêt à 8% par mois entamé (au lieu de 2%/semaine).
// ==========================================================

export const TYPES_CONTRAT = {
  journalier: {
    cle: "journalier",
    label: "Journalier (31 jours)",
    duree: 31,
    unitePeriode: "jour",
    labelPeriode: "jour",
    labelVersement: "versement quotidien",
  },
  hebdomadaire: {
    cle: "hebdomadaire",
    label: "Hebdomadaire (52 semaines)",
    duree: 52,
    unitePeriode: "semaine",
    labelPeriode: "semaine",
    labelVersement: "versement hebdomadaire",
  },
  mensuel: {
    cle: "mensuel",
    label: "Mensuel (12 mois)",
    duree: 12,
    unitePeriode: "mois",
    labelPeriode: "mois",
    labelVersement: "versement mensuel",
  },
};

export function infoTypeContrat(typeContrat) {
  return TYPES_CONTRAT[typeContrat] || TYPES_CONTRAT.journalier;
}

// Nombre de mois entamés depuis une date de début (utilisé pour l'intérêt
// à 8%/mois entamé sur les contrats hebdomadaire et mensuel).
export function nbMoisEntames(dateDebut) {
  const debut = dateDebut && dateDebut.toDate ? dateDebut.toDate() : new Date(dateDebut || Date.now());
  const maintenant = new Date();
  let mois = (maintenant.getFullYear() - debut.getFullYear()) * 12 + (maintenant.getMonth() - debut.getMonth());
  if (maintenant.getDate() >= debut.getDate()) mois += 1; // le mois en cours est "entamé"
  return Math.max(1, mois);
}

// Calcule le montant dû d'un prêt selon son type de contrat d'origine :
// - "journalier" : 2%/semaine entamée (comportement historique, taux_hebdo sur le prêt)
// - "hebdomadaire" / "mensuel" : 8%/mois entamé (taux_mensuel sur le prêt)
export function calculerMontantDuPretGeneralise(pret, remboursements) {
  const dejaRembourse = (remboursements || [])
    .filter((r) => r.pret_id === pret.id)
    .reduce((s, r) => s + Number(r.montant || 0), 0);

  let montantDuBrut;
  if (pret.type_contrat === "hebdomadaire" || pret.type_contrat === "mensuel") {
    const nbMois = nbMoisEntames(pret.date_debut);
    montantDuBrut = pret.montant_initial * (1 + (pret.taux_mensuel || 0.08) * nbMois);
  } else {
    const dateDebut = pret.date_debut && pret.date_debut.toDate ? pret.date_debut.toDate() : new Date();
    const nbSemaines = Math.floor((new Date() - dateDebut) / (1000 * 60 * 60 * 24 * 7)) + 1;
    montantDuBrut = pret.montant_initial * (1 + (pret.taux_hebdo || 0.02) * nbSemaines);
  }
  return Math.max(0, montantDuBrut - dejaRembourse);
}

export function calculerSoldes(payments, contracts) {
  let totalEpargnes = 0;
  let totalCommissions = 0;
  let totalMises = 0;
  const parMois = {};
  const contractsById = Object.fromEntries(contracts.map((c) => [c.id, c]));

  for (const p of payments) {
    const cle = moisDeDate(p.date);
    if (!parMois[cle]) parMois[cle] = { epargnes: 0, commissions: 0 };
    if (p.jour_numero === 1) {
      totalCommissions += p.montant;
      parMois[cle].commissions += p.montant;
    } else {
      const contrat = contractsById[p.contract_id];
      if (contrat && contrat.statut === "actif") {
        totalEpargnes += p.montant;
      }
      parMois[cle].epargnes += p.montant;
    }
  }
  for (const c of contracts) {
    if (c.statut === "cloture" && c.montant_mise) {
      totalMises += c.montant_mise;
    }
  }
  return { totalEpargnes, totalCommissions, totalMises, parMois };
}

export function calculerStatutContrat(contrat, versementsConfirmes) {
  if (!contrat || contrat.statut !== 'actif') return contrat ? contrat.statut : null;

  const versementsDuContrat = versementsConfirmes.filter((v) => v.contract_id === contrat.id);
  let dateReference;

  if (versementsDuContrat.length === 0) {
    dateReference = contrat.date_debut ? new Date(contrat.date_debut) : null;
  } else {
    const dernier = versementsDuContrat.reduce((a, b) => {
      const da = a.date && a.date.toDate ? a.date.toDate() : new Date(a.date || 0);
      const db = b.date && b.date.toDate ? b.date.toDate() : new Date(b.date || 0);
      return db > da ? b : a;
    });
    dateReference = dernier.date && dernier.date.toDate ? dernier.date.toDate() : new Date(dernier.date);
  }

  if (!dateReference) return 'actif';
  const diffJours = Math.floor((new Date() - dateReference) / (1000 * 60 * 60 * 24));
  return diffJours >= 7 ? 'inactif' : 'actif';
}

export function badgeStatut(statut) {
  const config = {
    en_attente: { label: 'En attente', couleur: '#f39c12' },
    confirme: { label: 'Confirmé', couleur: '#27ae60' },
    valide: { label: 'Validé', couleur: '#27ae60' },
    refuse: { label: 'Refusé', couleur: '#c0392b' },
    annule: { label: 'Annulé', couleur: '#c0392b' },
    actif: { label: 'Actif', couleur: '#27ae60' },
    inactif: { label: 'Inactif', couleur: '#c0392b' },
    cloture: { label: 'Clôturé', couleur: '#7f8c8d' },
  };
  const info = config[statut] || { label: statut || '—', couleur: '#7f8c8d' };
  return `<span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; color:#fff; background:${info.couleur};">${info.label}</span>`;
}

export function afficherMessage(elementId, message, couleur = 'black') {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.style.color = couleur;
}

export function notifier(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast-visible"));
  setTimeout(() => {
    el.classList.remove("toast-visible");
    setTimeout(() => el.remove(), 300);
  }, 3200);
}
