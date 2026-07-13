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

export function formatDate(dateVal) {
  if (!dateVal) return "—";
  const d = dateVal.toDate ? dateVal.toDate() : new Date(dateVal);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
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
