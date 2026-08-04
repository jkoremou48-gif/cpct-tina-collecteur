import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, doc, getDoc, setDoc, updateDoc,
  addDoc, collection, query, where, onSnapshot, serverTimestamp,
  getDocs, deleteDoc,
  creerCompteSecondaire, uploaderPhotoProfil,
} from "./firebase-config.js";

import {
  genererCodeParrain, formatGNF, formatDate, nomMois, calculerSoldes, notifier, calculerStatutContrat,
} from "./utils.js";

const AVATAR_DEFAUT = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' fill='%23ddd'/></svg>";

const state = {
  entreprise: null,
  currentUser: null,
  users: [],
  contracts: [],
  payments: [],
  decaissements: [],
  membresEnAttente: [],
  substitutionId: null,
  prets: [],
  remboursements: [],
  versementsCollecteur: [],
  collecteurSelectionne: null,
  retraits: [],
  retraitsConfirmes: [],
  interetsPartages: [],
  unsubscribers: [],
};
let creationEnCours = false;

function telephoneVersEmailTechnique(telephone) {
  const chiffres = telephone.replace(/\D/g, "");
  return `${chiffres}@membre.cpct-tina.local`;
}

const screens = ["screen-loading", "screen-onboarding-entreprise", "screen-onboarding-pdg", "screen-login", "screen-dashboard"];
function showScreen(id) {
  screens.forEach((s) => document.getElementById(s).classList.toggle("hidden", s !== id));
}

async function demarrer() {
  showScreen("screen-loading");
  const entrepriseSnap = await getDoc(doc(db, "entreprise", "info"));
  if (entrepriseSnap.exists()) {
    state.entreprise = entrepriseSnap.data();
    document.getElementById("login-entreprise-nom").textContent = state.entreprise.nom;
  }

  onAuthStateChanged(auth, async (user) => {
    if (creationEnCours) return;
    if (user) {
      const userSnap = await getDoc(doc(db, "users", user.uid));
      if (userSnap.exists() && userSnap.data().role === "pdg") {
        state.currentUser = { uid: user.uid, ...userSnap.data() };
        lancerDashboard();
        return;
      } else {
        await signOut(auth);
      }
    }
    if (state.entreprise) {
      showScreen("screen-login");
    } else {
      showScreen("screen-onboarding-entreprise");
    }
  });
}

document.getElementById("form-entreprise").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const data = {
    nom: fd.get("nom").trim(),
    siege: fd.get("siege").trim(),
    date_creation: fd.get("date_creation"),
    fondateur: fd.get("fondateur").trim(),
    contact: fd.get("contact").trim(),
  };
  try {
    await setDoc(doc(db, "entreprise", "info"), data);
    state.entreprise = data;
    showScreen("screen-onboarding-pdg");
  } catch (err) {
    notifier("Erreur lors de la création de l'entreprise : " + err.message, "erreur");
  }
});

document.getElementById("form-pdg").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get("email").trim();
  const password = fd.get("password");
  const nom = fd.get("nom").trim();
  const telephone = fd.get("telephone").trim();
  const residence = fd.get("residence").trim();

  creationEnCours = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const codeParrain = genererCodeParrain("PDG");
    const userData = {
      role: "pdg",
      nom, telephone, email, residence,
      code_parrain: codeParrain,
      parrain_id: null,
      statut: "actif",
      date_creation: serverTimestamp(),
    };
    await setDoc(doc(db, "users", cred.user.uid), userData);
    notifier("Compte PDG créé avec succès.", "succes");
    state.currentUser = { uid: cred.user.uid, ...userData };
    creationEnCours = false;
    lancerDashboard();
  } catch (err) {
    notifier("Erreur : " + err.message, "erreur");
    if (auth.currentUser) {
      try { await auth.currentUser.delete(); } catch (e2) { /* ignore */ }
      try { await signOut(auth); } catch (e3) { /* ignore */ }
    }
    creationEnCours = false;
  }
});

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await signInWithEmailAndPassword(auth, fd.get("email").trim(), fd.get("password"));
  } catch (err) {
    notifier("Identifiants incorrects.", "erreur");
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  state.unsubscribers.forEach((u) => u());
  state.unsubscribers = [];
  await signOut(auth);
  showScreen("screen-login");
});

// --- Photo de profil du PDG ---
document.getElementById("pdg-avatar-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !state.currentUser) return;
  try {
    const url = await uploaderPhotoProfil(state.currentUser.uid, file);
    await updateDoc(doc(db, "users", state.currentUser.uid), { photoURL: url });
    state.currentUser.photoURL = url;
    document.getElementById("pdg-avatar").src = url;
    notifier("Photo de profil mise à jour.", "succes");
  } catch (err) {
    console.error(err);
    notifier("Erreur lors de l'envoi de la photo : " + err.message, "erreur");
  }
});

function lancerDashboard() {
  showScreen("screen-dashboard");
  document.getElementById("db-entreprise-nom").textContent = state.entreprise?.nom || "CPCT-TINA";
  document.getElementById("db-pdg-nom").textContent = state.currentUser.nom;
  document.getElementById("pdg-avatar").src = state.currentUser.photoURL || AVATAR_DEFAUT;

  const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
    state.users = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    render();
  });
  const unsubContracts = onSnapshot(collection(db, "contracts"), (snap) => {
    state.contracts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubPayments = onSnapshot(collection(db, "payments"), (snap) => {
    state.payments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubDecaissements = onSnapshot(collection(db, "decaissements"), (snap) => {
    state.decaissements = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubAttente = onSnapshot(collection(db, "membres_en_attente_validation"), (snap) => {
    state.membresEnAttente = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((m) => m.statut === "en_attente_validation");
    render();
  });
  const unsubRetraits = onSnapshot(
    query(collection(db, "withdrawalRequests"), where("statut", "==", "en_attente")),
    (snap) => {
      state.retraits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  const unsubRetraitsConfirmes = onSnapshot(
    query(collection(db, "withdrawalRequests"), where("statut", "==", "confirme")),
    (snap) => {
      state.retraitsConfirmes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
  const unsubPrets = onSnapshot(collection(db, "prets"), (snap) => {
    state.prets = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubRemboursements = onSnapshot(collection(db, "remboursements_prets"), (snap) => {
    state.remboursements = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubVersementsCollecteur = onSnapshot(collection(db, "versements_collecteur"), (snap) => {
    state.versementsCollecteur = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  const unsubInterets = onSnapshot(collection(db, "interets_prets_repartis"), (snap) => {
    state.interetsPartages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  state.unsubscribers.push(unsubUsers, unsubContracts, unsubPayments, unsubDecaissements, unsubAttente, unsubRetraits, unsubRetraitsConfirmes, unsubPrets, unsubRemboursements, unsubVersementsCollecteur, unsubInterets);
}

function render() {
  renderApercu();
  renderCollecteurs();
  renderMembres();
  renderConfirmations();
  renderMembresEnAttente();
  renderRetraits();
}

function renderApercu() {
  const { totalEpargnes, totalCommissions, parMois } = calculerSoldes(state.payments, state.contracts);
  const totalDecaisse = (state.decaissements || []).reduce((s, d) => s + Number(d.montant), 0);
  const totalInteretsPdg = state.interetsPartages.reduce((s, i) => s + Number(i.montant_pdg || 0), 0);
  const commissionsDisponibles = totalCommissions + totalInteretsPdg - totalDecaisse;

  const totalRetraitsConfirmes = (state.retraitsConfirmes || []).reduce((s, r) => s + Number(r.montant || 0), 0);
  const totalPretsEnCours = state.prets.filter((p) => p.statut === "actif").reduce((s, p) => s + Number(p.montant_initial || 0), 0);
  const totalRemboursements = (state.remboursements || []).reduce((s, r) => s + Number(r.montant || 0), 0);
  // Un remboursement contient capital + intérêt. Seul le capital doit revenir dans l'épargne :
  // l'intérêt est déjà compté séparément dans la commission (totalInteretsPdg ci-dessus) et ne
  // doit jamais réintégrer le solde d'épargne, sinon il est compté deux fois.
  const totalInteretsRecuperes = state.interetsPartages.reduce((s, i) => s + Number(i.montant_collecteur || 0) + Number(i.montant_pdg || 0), 0);
  const totalCapitalRembourse = Math.max(0, totalRemboursements - totalInteretsRecuperes);
  const soldeGlobalEpargnes = totalEpargnes - totalRetraitsConfirmes - totalPretsEnCours + totalCapitalRembourse;

  document.getElementById("stat-total-epargnes").textContent = formatGNF(soldeGlobalEpargnes > 0 ? soldeGlobalEpargnes : 0);
  document.getElementById("stat-total-commissions").textContent = formatGNF(commissionsDisponibles);
  document.getElementById("stat-nb-collecteurs").textContent = state.users.filter((u) => u.role === "collecteur" && u.statut === "actif").length;
  document.getElementById("stat-nb-membres").textContent = state.users.filter((u) => u.role === "membre").length;

  const cles = Object.keys(parMois).sort().reverse();
  const container = document.getElementById("monthly-breakdown");
  if (cles.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucune donnée pour le moment.</p>`;
  } else {
    container.innerHTML = cles.slice(0, 12).map((cle) => `
      <div class="monthly-row">
        <span class="monthly-mois">${nomMois(cle)}</span>
        <span class="monthly-detail">
          Épargnes : <b class="epargne">${formatGNF(parMois[cle].epargnes)}</b><br/>
          Commissions : <b class="commission">${formatGNF(parMois[cle].commissions)}</b>
        </span>
      </div>
    `).join("");
  }
}

document.getElementById("titre-historique-mensuel").addEventListener("click", () => {
  const titre = document.getElementById("titre-historique-mensuel");
  const zone = document.getElementById("monthly-breakdown");
  zone.classList.toggle("hidden");
  titre.classList.toggle("ouvert");
});

// --- Épargne nette d'un contrat : le prêt NE la réduit PAS (règle validée le 2 août) ---
function calculerEpargneNetteContrat(contrat) {
  const versements = state.payments.filter((p) => p.contract_id === contrat.id);
  return versements
    .filter((p) => p.statut === "confirme" && p.jour_numero > 1)
    .reduce((s, p) => s + Number(p.montant || 0), 0);
}

function calculerSoldeDisponible(contrat) {
  const epargneNette = calculerEpargneNetteContrat(contrat);
  const pret = (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === "actif");
  const pretDu = pret ? calculerMontantDuPret(pret) : 0;
  return Math.max(0, epargneNette - pretDu);
}

function avatarImg(u, taille) {
  const classe = taille === "mini" ? "avatar-mini" : "avatar-pdg";
  return `<img class="${classe}" src="${u && u.photoURL ? u.photoURL : AVATAR_DEFAUT}" alt="${u ? u.nom : ''}" />`;
}

function renderCollecteurs() {
  const collecteurs = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime");
  const container = document.getElementById("liste-collecteurs");
  if (collecteurs.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun collecteur enregistré. Générez un code pour en inviter un.</p>`;
    return;
  }

  const versementsConfirmesTous = state.payments.filter((p) => p.statut === "confirme");

  container.innerHTML = collecteurs.map((c) => {
    const nbClients = state.users.filter((u) => u.role === "membre" && u.parrain_id === c.uid).length;
    const badgeClasse = c.statut === "actif" ? "badge-actif" : c.statut === "suspendu" ? "badge-suspendu" : "badge-licencie";

    const contratsCollecteur = state.contracts.filter((ct) => ct.collecteur_id === c.uid);
    let nbActifs = 0;
    let nbInactifs = 0;
    let soldeEpargneTotal = 0;
    contratsCollecteur.forEach((ct) => {
      if (ct.statut === "actif") {
        const statutCalc = calculerStatutContrat(ct, versementsConfirmesTous);
        if (statutCalc === "inactif") {
          nbInactifs++;
        } else {
          nbActifs++;
        }
        soldeEpargneTotal += Math.max(0, calculerEpargneNetteContrat(ct));
      }
    });

    const TC = state.payments.filter((p) => p.collecteur_id === c.uid).reduce((s, p) => s + Number(p.montant || 0), 0);
    const TV = state.versementsCollecteur.filter((v) => v.collecteur_id === c.uid).reduce((s, v) => s + Number(v.montant || 0), 0);
    const resteAVerser = TC - TV;

    const pretsCollecteur = state.prets.filter((p) => p.collecteur_id === c.uid && p.statut === "actif");
    const totalPretsEnCours = pretsCollecteur.reduce((s, p) => s + Number(p.montant_initial || 0), 0);

    return `
      <div class="entity-card" data-uid="${c.uid}">
        <div class="entity-card-top">
          <div style="display:flex; align-items:center;">
            ${avatarImg(c, "mini")}
            <div>
              <p class="entity-nom" style="cursor:pointer; text-decoration:underline;" data-action="voir-membres" data-uid="${c.uid}">${c.nom}</p>
              <p class="entity-sub">${c.telephone} · ${nbClients} client(s)</p>
            </div>
          </div>
          <span class="badge ${badgeClasse}">${c.statut}</span>
        </div>
        <div class="detail-line"><span>Contrats actifs</span><span>${nbActifs}</span></div>
        <div class="detail-line"><span>Contrats inactifs</span><span style="${nbInactifs > 0 ? 'color:#c0392b; font-weight:bold;' : ''}">${nbInactifs}</span></div>
        <div class="detail-line"><span>Solde global d'épargne</span><span>${formatGNF(soldeEpargneTotal)}</span></div>
        <div class="detail-line"><span>Total collecté</span><span>${formatGNF(TC)}</span></div>
        <div class="detail-line"><span>Versé au PDG</span><span>${formatGNF(TV)}</span></div>
        <div class="detail-line"><span>Reste à verser</span><span style="${resteAVerser > 0 ? 'color:#c0392b; font-weight:bold;' : ''}">${formatGNF(resteAVerser)}</span></div>
        <div class="detail-line"><span>Prêts en cours (ses membres)</span><span>${formatGNF(totalPretsEnCours)}</span></div>
        <div class="entity-actions">
          <button class="btn btn-secondary btn-sm" data-action="enregistrer-versement" data-uid="${c.uid}" data-nom="${c.nom}">Enregistrer un versement</button>
          ${c.statut === "actif" ? `<button class="btn btn-ghost-sm" data-action="suspendre" data-uid="${c.uid}">Suspendre</button>` : ""}
          ${c.statut === "suspendu" ? `<button class="btn btn-ghost-sm" data-action="reactiver" data-uid="${c.uid}">Réactiver</button>` : ""}
          ${c.statut !== "licencie" ? `<button class="btn btn-danger btn-sm" data-action="licencier" data-uid="${c.uid}">Licencier</button>` : ""}
          ${c.statut !== "actif" ? `<button class="btn btn-secondary btn-sm" data-action="substituer" data-uid="${c.uid}" data-nom="${c.nom}">Gérer ses clients</button>` : ""}
          <button class="btn btn-danger btn-sm" data-action="supprimer-collecteur" data-uid="${c.uid}" data-nom="${c.nom}">Supprimer</button>
        </div>
      </div>
    `;
  }).join("");
}

function ouvrirVersementCollecteur(collecteurId, nom) {
  const TC = state.payments.filter((p) => p.collecteur_id === collecteurId).reduce((s, p) => s + Number(p.montant || 0), 0);
  const TV = state.versementsCollecteur.filter((v) => v.collecteur_id === collecteurId).reduce((s, v) => s + Number(v.montant || 0), 0);
  const resteAVerser = TC - TV;

  ouvrirModal(`
    <h2>Versement reçu — ${nom}</h2>
    <p class="subtitle-sm">Reste à verser actuellement : <b>${formatGNF(resteAVerser)}</b></p>
    <form id="form-versement-collecteur">
      <div class="field-row">
        <label>Montant physiquement reçu (GNF)</label>
        <input type="number" name="montant" min="1" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Confirmer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-versement-collecteur").addEventListener("submit", async (e) => {
    e.preventDefault();
    const montant = Number(new FormData(e.target).get("montant"));
    try {
      await addDoc(collection(db, "versements_collecteur"), {
        collecteur_id: collecteurId,
        montant,
        pdg_id: state.currentUser.uid,
        date: serverTimestamp(),
      });
      notifier("Versement enregistré.", "succes");
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

document.getElementById("liste-collecteurs").addEventListener("click", async (e) => {
  const nomCliquable = e.target.closest("[data-action='voir-membres']");
  if (nomCliquable) {
    state.collecteurSelectionne = nomCliquable.dataset.uid;
    document.querySelector('.tab-btn[data-tab="membres"]').click();
    renderMembres();
    return;
  }
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, uid, nom } = btn.dataset;

  if (action === "enregistrer-versement") {
    ouvrirVersementCollecteur(uid, nom);
    return;
  }
  if (action === "suspendre" || action === "reactiver") {
    await updateDoc(doc(db, "users", uid), { statut: action === "suspendre" ? "suspendu" : "actif" });
    notifier(action === "suspendre" ? "Collecteur suspendu." : "Collecteur réactivé.", "succes");
  }
  if (action === "licencier") {
    ouvrirModalConfirmation(
      "Licencier ce collecteur ?",
      "Cette action est définitive. Le collecteur perdra l'accès à son compte. Vous pourrez continuer à gérer ses clients via le mode substitution.",
      async () => {
        await updateDoc(doc(db, "users", uid), { statut: "licencie" });
        notifier("Collecteur licencié.", "succes");
        fermerModal();
      }
    );
  }
  if (action === "substituer") {
    state.substitutionId = uid;
    document.getElementById("banner-substitution").classList.remove("hidden");
    document.getElementById("banner-substitution-text").textContent = `Mode substitution actif — vous gérez les clients de ${nom}.`;
    document.querySelector('.tab-btn[data-tab="membres"]').click();
    renderMembres();
  }
  if (action === "supprimer-collecteur") {
    ouvrirSuppressionCollecteur(uid, nom);
  }
});

function ouvrirSuppressionCollecteur(collecteurId, nom) {
  const autresCollecteurs = state.users.filter((u) => u.role === "collecteur" && u.statut !== "supprime" && u.uid !== collecteurId);
  const nbClients = state.users.filter((u) => u.role === "membre" && u.parrain_id === collecteurId).length;

  ouvrirModal(`
    <h2>Supprimer ${nom} ?</h2>
    <p class="subtitle-sm">${nbClients} client(s) seront transférés. Le compte sera désactivé et le collecteur ne pourra plus se connecter.</p>
    <div class="field-row">
      <label>Transférer ses clients vers</label>
      <select name="destination" id="select-destination-clients">
        <option value="pdg">Moi-même (portefeuille PDG)</option>
        ${autresCollecteurs.map((c) => `<option value="${c.uid}">${c.nom}</option>`).join("")}
      </select>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
      <button type="button" class="btn btn-danger" id="modal-confirmer-suppression" style="flex:1;">Confirmer la suppression</button>
    </div>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("modal-confirmer-suppression").addEventListener("click", async () => {
    const destinationId = document.getElementById("select-destination-clients").value;
    try {
      await reassignerClientsCollecteur(collecteurId, destinationId);
      await updateDoc(doc(db, "users", collecteurId), { statut: "supprime" });
      notifier("Collecteur supprimé et clients transférés.", "succes");
      fermerModal();
    } catch (err) {
      console.error(err);
      notifier("Erreur : " + err.message, "erreur");
    }
  });
}

async function reassignerClientsCollecteur(ancienCollecteurId, nouveauCollecteurId) {
  const nouvelUid = nouveauCollecteurId === "pdg" ? state.currentUser.uid : nouveauCollecteurId;

  const membres = state.users.filter((u) => u.role === "membre" && u.parrain_id === ancienCollecteurId);
  for (const membre of membres) {
    await updateDoc(doc(db, "users", membre.uid), { parrain_id: nouvelUid });
  }

  const contrats = state.contracts.filter((c) => c.collecteur_id === ancienCollecteurId);
  for (const contrat of contrats) {
    await updateDoc(doc(db, "contracts", contrat.id), { collecteur_id: nouvelUid });
  }

  const paiements = state.payments.filter((p) => p.collecteur_id === ancienCollecteurId);
  for (const paiement of paiements) {
    await updateDoc(doc(db, "payments", paiement.id), { collecteur_id: nouvelUid });
  }
}

document.getElementById("btn-quitter-substitution").addEventListener("click", () => {
  state.substitutionId = null;
  document.getElementById("banner-substitution").classList.add("hidden");
  renderMembres();
});

function calculerMontantDuPret(pret) {
  const dateDebut = pret.date_debut && pret.date_debut.toDate ? pret.date_debut.toDate() : new Date();
  const nbSemaines = Math.floor((new Date() - dateDebut) / (1000 * 60 * 60 * 24 * 7)) + 1;
  const montantDuBrut = pret.montant_initial * (1 + pret.taux_hebdo * nbSemaines);
  const dejaRembourse = (state.remboursements || [])
    .filter((r) => r.pret_id === pret.id)
    .reduce((s, r) => s + Number(r.montant || 0), 0);
  return Math.max(0, montantDuBrut - dejaRembourse);
}

function trouverContratsNonSoldes(membreId, contratExclureId) {
  return state.contracts.filter((c) =>
    c.membre_id === membreId &&
    c.statut === "cloture" &&
    c.id !== contratExclureId &&
    !c.epargne_soldee
  );
}

function renderMembres() {
  let membres = state.users.filter((u) => u.role === "membre");
  if (state.substitutionId) {
    membres = membres.filter((m) => m.parrain_id === state.substitutionId);
  } else if (state.collecteurSelectionne) {
    membres = membres.filter((m) => m.parrain_id === state.collecteurSelectionne);
  }
  const recherche = (document.getElementById("recherche-membres").value || "").toLowerCase();
  if (recherche) {
    membres = membres.filter((m) => m.nom.toLowerCase().includes(recherche) || (m.telephone || "").includes(recherche));
  }

  const enteteContainer = document.getElementById("entete-membres");
  if (enteteContainer) {
    if (state.collecteurSelectionne && !state.substitutionId) {
      const collecteur = state.users.find((u) => u.uid === state.collecteurSelectionne);
      enteteContainer.innerHTML = `
        <button class="btn btn-ghost-sm" id="btn-retour-collecteurs" style="margin-bottom:10px;">← Retour aux collecteurs</button>
        <p style="font-weight:bold; margin-bottom:8px;">Membres de ${collecteur ? collecteur.nom : ""}</p>
      `;
      document.getElementById("btn-retour-collecteurs").addEventListener("click", () => {
        state.collecteurSelectionne = null;
        renderMembres();
      });
    } else {
      enteteContainer.innerHTML = "";
    }
  }
  const container = document.getElementById("liste-membres");
  if (membres.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun membre trouvé.</p>`;
    return;
  }

  const versementsConfirmesTous = state.payments.filter((p) => p.statut === "confirme");

  container.innerHTML = membres.map((m) => {
    const contrat = state.contracts.find((c) => c.membre_id === m.uid && c.statut === "actif")
      || state.contracts.filter((c) => c.membre_id === m.uid).sort((a, b) => (b.date_debut || "").localeCompare(a.date_debut || ""))[0];
    const versements = state.payments.filter((p) => contrat && p.contract_id === contrat.id);
    const totalVerse = versements.filter((p) => p.statut === "confirme" && p.jour_numero > 1).reduce((s, p) => s + p.montant, 0);
    let statutContrat = contrat ? contrat.statut : "aucun contrat";
    let estInactif = false;
    if (contrat && calculerStatutContrat(contrat, versementsConfirmesTous) === "inactif") {
      statutContrat = "inactif";
      estInactif = true;
    }
    const pret = contrat ? (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === "actif") : null;

    const contratsNonSoldes = trouverContratsNonSoldes(m.uid, contrat ? contrat.id : null);
    const totalNonSolde = contratsNonSoldes.reduce((s, c) => s + Math.max(0, calculerEpargneNetteContrat(c)), 0);

    return `
      <div class="entity-card" data-uid="${m.uid}">
          <div class="entity-card-top">
            <div style="display:flex; align-items:center;">
              ${avatarImg(m, "mini")}
              <div>
                <p class="entity-nom">${m.nom}</p>
                <p class="entity-sub" style="${estInactif ? "color:#c0392b; font-weight:bold;" : ""}">${m.telephone} · ${statutContrat}</p>
                ${pret ? `<p class="entity-sub" style="color:#c0392b;">Prêt en cours : ${formatGNF(calculerMontantDuPret(pret))}</p>` : ""}
                ${totalNonSolde > 0 ? `<p class="entity-sub" style="color:#c0392b; font-weight:bold;">Contrat non soldé : ${formatGNF(totalNonSolde)}</p>` : ""}
              </div>
            </div>
            <span class="badge badge-actif">${formatGNF(totalVerse)}</span>
          </div>
          <div class="entity-actions">
            ${pret ? `<button class="btn btn-secondary btn-sm" data-action="rembourser-pret" data-pret="${pret.id}">Rembourser prêt</button>` : ""}
            <button class="btn btn-danger btn-sm" data-action="supprimer-membre" data-uid="${m.uid}" data-nom="${m.nom}">Supprimer</button>
          </div>
        </div>
    `;
  }).join("");
}

document.getElementById("recherche-membres").addEventListener("input", renderMembres);

// --- PDG crée directement un membre (choisit son collecteur) ---
document.getElementById("btn-nouveau-membre-pdg").addEventListener("click", () => {
  const collecteursActifs = state.users.filter((u) => u.role === "collecteur" && u.statut === "actif");
  if (collecteursActifs.length === 0) {
    notifier("Créez d'abord un collecteur actif avant d'ajouter un membre.", "erreur");
    return;
  }
  ouvrirModal(`
    <h2>Nouveau membre</h2>
    <p class="subtitle-sm">Ce membre sera rattaché au collecteur choisi. Un mot de passe est généré automatiquement.</p>
    <form id="form-nouveau-membre-pdg">
      <div class="field-row">
        <label>Collecteur responsable</label>
        <select name="collecteur_id" required>
          ${collecteursActifs.map((c) => `<option value="${c.uid}">${c.nom}</option>`).join("")}
        </select>
      </div>
      <div class="field-row"><label>Nom complet</label><input type="text" name="nom" required /></div>
      <div class="field-row"><label>Téléphone (identifiant de connexion)</label><input type="tel" name="telephone" required /></div>
      <div class="field-row"><label>E-mail</label><input type="email" name="email" required /></div>
      <div class="field-row"><label>Résidence</label><input type="text" name="residence" required /></div>
      <div class="field-row"><label>Montant du versement quotidien (GNF)</label><input type="number" name="montantJour" min="1" required /></div>
      <div class="field-row"><label>Commission encaissée aujourd'hui (jour 1, GNF)</label><input type="number" name="commission" min="1" required /></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Créer le compte</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-nouveau-membre-pdg").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const collecteurId = fd.get("collecteur_id");
    const nom = fd.get("nom").trim();
    const telephone = fd.get("telephone").trim();
    const email = fd.get("email").trim();
    const residence = fd.get("residence").trim();
    const montantJour = Number(fd.get("montantJour"));
    const commission = Number(fd.get("commission"));
    const password = telephone.replace(/\D/g, "").slice(-6);

    try {
      const emailTechnique = telephoneVersEmailTechnique(telephone);
      const uid = await creerCompteSecondaire(emailTechnique, password);

      await setDoc(doc(db, "users", uid), {
        role: "membre",
        nom, telephone, email, residence,
        parrain_id: collecteurId,
        statut: "actif",
        date_creation: serverTimestamp(),
      });

      const contratRef = await addDoc(collection(db, "contracts"), {
        membre_id: uid,
        membre_nom: nom,
        collecteur_id: collecteurId,
        statut: "actif",
        commission,
        montant_mise: montantJour,
        date_debut: new Date().toISOString(),
      });

      await addDoc(collection(db, "payments"), {
        contract_id: contratRef.id,
        collecteur_id: collecteurId,
        membre_id: uid,
        montant: commission,
        jour_numero: 1,
        statut: "collecte",
        date: serverTimestamp(),
      });

      fermerModal();
      ouvrirModal(`
        <h2>Identifiants du membre</h2>
        <p class="subtitle-sm">À transmettre oralement à ${nom}</p>
        <div class="detail-line"><span>Téléphone</span><span><b>${telephone}</b></span></div>
        <div class="detail-line"><span>Mot de passe</span><span><b>${password}</b></span></div>
        <div class="modal-actions"><button class="btn btn-primary" id="modal-fermer-id" style="flex:1;">J'ai transmis les identifiants</button></div>
      `);
      document.getElementById("modal-fermer-id").addEventListener("click", fermerModal);
    } catch (err) {
      console.error(err);
      notifier("Erreur : " + err.message, "erreur");
    }
  });
});

document.getElementById("liste-membres").addEventListener("click", (e) => {
  const btnSupprimer = e.target.closest("button[data-action='supprimer-membre']");
  if (btnSupprimer) {
    const { uid, nom } = btnSupprimer.dataset;
    ouvrirModalConfirmation(
      `Supprimer ${nom} ?`,
      "Le compte sera désactivé et le membre ne pourra plus se connecter. L'historique de ses versements reste conservé.",
      async () => {
        try {
          await updateDoc(doc(db, "users", uid), { statut: "supprime" });
          const contratActif = state.contracts.find((c) => c.membre_id === uid && c.statut === "actif");
          if (contratActif) {
            await updateDoc(doc(db, "contracts", contratActif.id), { statut: "annule" });
          }
          notifier("Membre supprimé.", "succes");
          fermerModal();
        } catch (err) {
          console.error(err);
          notifier("Erreur : " + err.message, "erreur");
        }
      }
    );
    return;
  }
  const card = e.target.closest(".entity-card");
  if (!card) return;
  afficherDetailMembre(card.dataset.uid);
});

function afficherDetailMembre(uid) {
  const membre = state.users.find((u) => u.uid === uid);
  const contrats = state.contracts.filter((c) => c.membre_id === uid).sort((a, b) => (b.date_debut || "").localeCompare(a.date_debut || ""));
  const contrat = contrats[0];
  const versements = contrat ? state.payments.filter((p) => p.contract_id === contrat.id).sort((a, b) => a.jour_numero - b.jour_numero) : [];
  const totalVerse = versements.filter((p) => p.statut === 'confirme' && p.jour_numero > 1).reduce((s, p) => s + p.montant, 0);

  const contratsNonSoldes = trouverContratsNonSoldes(uid, contrat ? contrat.id : null);
  const totalNonSolde = contratsNonSoldes.reduce((s, c) => s + Math.max(0, calculerEpargneNetteContrat(c)), 0);

  const pret = contrat ? (state.prets || []).find((p) => p.contract_id === contrat.id && p.statut === "actif") : null;
  const datePret = pret && pret.date_debut && pret.date_debut.toDate ? pret.date_debut.toDate() : null;
  const soldeDisponible = contrat ? calculerSoldeDisponible(contrat) : 0;

  const html = `
    <h2 style="display:flex; align-items:center; gap:10px;">${avatarImg(membre, "mini")}${membre.nom}</h2>
    <p class="subtitle-sm">Identifiant de connexion (téléphone) : <b>${membre.telephone}</b></p>
    ${membre.residence ? `<p class="subtitle-sm">Résidence : ${membre.residence}</p>` : ""}
    <div class="detail-line"><span>Statut du contrat</span><span>${contrat ? contrat.statut : "—"}</span></div>
    <div class="detail-line"><span>Début du contrat</span><span>${contrat ? formatDate(contrat.date_debut) : "—"}</span></div>
    <div class="detail-line"><span>Commission (jour 1)</span><span>${contrat ? formatGNF(contrat.commission) : "—"}</span></div>
    <div class="detail-line"><span>Total épargné (épargne nette)</span><span>${formatGNF(totalVerse)}</span></div>
    ${pret ? `<div class="detail-line"><span style="color:#c0392b;">Solde disponible (après prêt)</span><span style="color:#c0392b;"><b>${formatGNF(soldeDisponible)}</b></span></div>` : ""}
    ${totalNonSolde > 0 ? `<div class="detail-line"><span style="color:#c0392b;">Contrat(s) non soldé(s)</span><span style="color:#c0392b;">${formatGNF(totalNonSolde)}</span></div>` : ""}
    ${pret ? `
      <h2 style="margin-top:18px; font-size:15px; color:#c0392b;">Prêt en cours</h2>
      <div class="detail-line"><span>Capital emprunté</span><span>${formatGNF(pret.montant_initial)}</span></div>
      <div class="detail-line"><span>Montant dû actuellement</span><span><b>${formatGNF(calculerMontantDuPret(pret))}</b></span></div>
      <div class="detail-line"><span>Date du prêt</span><span>${datePret ? formatDate(datePret) : "—"}</span></div>
    ` : ""}
    <h2 style="margin-top:18px; font-size:15px;">Historique des versements</h2>
    <div style="max-height:220px; overflow-y:auto; margin-top:8px;">
      ${versements.length === 0 ? '<p class="empty-state">Aucun versement enregistré.</p>' : versements.map((v) => `
        <div class="detail-line"><span>Jour ${v.jour_numero} — ${formatDate(v.date)}</span><span>${formatGNF(v.montant)}</span></div>
      `).join("")}
    </div>
    <div class="modal-actions"><button class="btn btn-ghost-sm" id="btn-fermer-modal-membre" style="flex:1;">Fermer</button></div>
  `;
  ouvrirModal(html);
  document.getElementById("btn-fermer-modal-membre").addEventListener("click", fermerModal);
}

function renderMembresEnAttente() {
  const container = document.getElementById("liste-attente");
  if (!container) return;

  if (state.membresEnAttente.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun membre en attente de validation.</p>`;
    return;
  }

  container.innerHTML = state.membresEnAttente.map((m) => {
    const collecteur = state.users.find((u) => u.uid === m.collecteur_id);
    return `
      <div class="entity-card" data-id="${m.id}">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${m.nom}</p>
            <p class="entity-sub">${m.telephone} · enregistré par ${collecteur ? collecteur.nom : "collecteur inconnu"}</p>
          </div>
          <span class="badge badge-suspendu">en attente</span>
        </div>
        <div class="entity-actions">
          <button class="btn btn-primary btn-sm" data-action="valider" data-id="${m.id}">Valider</button>
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("liste-attente")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action='valider']");
  if (!btn) return;
  ouvrirValidationMembre(btn.dataset.id);
});

function ouvrirValidationMembre(membreEnAttenteId) {
  const m = state.membresEnAttente.find((x) => x.id === membreEnAttenteId);
  if (!m) return;

  ouvrirModal(`
    <h2>Valider ${m.nom}</h2>
    <p class="subtitle-sm">Ce membre se connectera avec son numéro de téléphone et le mot de passe que vous définissez ici. Transmettez-lui ces identifiants.</p>
    <form id="form-valider-membre">
      <div class="field-row">
        <label>Téléphone (identifiant de connexion)</label>
        <input type="tel" value="${m.telephone}" disabled />
      </div>
      <div class="field-row">
        <label>Mot de passe à créer (6 caractères min)</label>
        <input type="text" name="password" minlength="6" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Créer le compte</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-valider-membre").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get("password");
    await validerMembre(m, password);
  });
}

async function validerMembre(membreEnAttente, password) {
  try {
    const emailTechnique = telephoneVersEmailTechnique(membreEnAttente.telephone);
    const uid = await creerCompteSecondaire(emailTechnique, password);

    await setDoc(doc(db, "users", uid), {
      role: "membre",
      nom: membreEnAttente.nom,
      telephone: membreEnAttente.telephone,
      parrain_id: membreEnAttente.collecteur_id,
      statut: "actif",
      date_creation: serverTimestamp(),
    });

    const contratsLies = state.contracts.filter((c) => c.membre_en_attente_id === membreEnAttente.id);
    for (const contrat of contratsLies) {
      await updateDoc(doc(db, "contracts", contrat.id), { membre_id: uid });
    }

    await updateDoc(doc(db, "membres_en_attente_validation", membreEnAttente.id), {
      statut: "valide",
      membre_id: uid,
      date_validation: serverTimestamp(),
    });

    notifier(`Compte créé. Transmettez au membre : téléphone ${membreEnAttente.telephone} + le mot de passe choisi.`, "succes");
    fermerModal();
  } catch (err) {
    console.error(err);
    notifier("Erreur : " + err.message, "erreur");
  }
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
  });
});

function ouvrirModal(html) {
  document.getElementById("modal-content").innerHTML = html;
  const overlay = document.getElementById("modal-overlay");
  overlay.classList.remove("hidden");
  overlay.style.display = "flex";
}
function fermerModal() {
  const overlay = document.getElementById("modal-overlay");
  overlay.classList.add("hidden");
  overlay.style.display = "none";
  document.getElementById("modal-content").innerHTML = "";
}
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") fermerModal();
});
function ouvrirModalConfirmation(titre, texte, onConfirm) {
  ouvrirModal(`
    <h2>${titre}</h2>
    <p class="subtitle-sm">${texte}</p>
    <div class="modal-actions">
      <button class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
      <button class="btn btn-danger" id="modal-confirmer" style="flex:1;">Confirmer</button>
    </div>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("modal-confirmer").addEventListener("click", onConfirm);
}

document.getElementById("btn-decaisser").addEventListener("click", () => {
  const { totalCommissions } = calculerSoldes(state.payments, state.contracts);
  const totalDecaisse = (state.decaissements || []).reduce((s, d) => s + Number(d.montant), 0);
  const totalInteretsPdg = state.interetsPartages.reduce((s, i) => s + Number(i.montant_pdg || 0), 0);
  const disponible = totalCommissions + totalInteretsPdg - totalDecaisse;
  ouvrirModal(`
    <h2>Décaisser des commissions</h2>
    <p class="subtitle-sm">Montant disponible : <b>${formatGNF(disponible)}</b></p>
    <form id="form-decaisser">
      <div class="field-row">
        <label>Montant à décaisser (GNF)</label>
        <input type="number" name="montant" min="1" max="${disponible}" required />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
        <button type="submit" class="btn btn-primary" style="flex:1;">Confirmer</button>
      </div>
    </form>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("form-decaisser").addEventListener("submit", async (e) => {
    e.preventDefault();
    const montant = Number(new FormData(e.target).get("montant"));
    if (montant > disponible) { notifier("Montant supérieur au solde disponible.", "erreur"); return; }
    await addDoc(collection(db, "decaissements"), {
      montant, pdg_id: state.currentUser.uid, date: new Date().toISOString(),
    });
    notifier("Décaissement enregistré.", "succes");
    fermerModal();
  });
});

document.getElementById("btn-nouveau-partenaire").addEventListener("click", () => {
  ouvrirModal(`
    <h2>Créer un nouveau partenaire</h2>
    <p class="subtitle-sm">Choisissez le type de compte à inviter. Un code sera généré : transmettez-le à la personne pour qu'elle finalise son inscription sur l'application correspondante.</p>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="btn-code-collecteur" style="flex:1;">Nouveau collecteur</button>
    </div>
  `);
  document.getElementById("btn-code-collecteur").addEventListener("click", () => genererEtAfficherCode("collecteur"));
});

document.getElementById("btn-nouveau-collecteur").addEventListener("click", () => genererEtAfficherCode("collecteur"));

async function genererEtAfficherCode(type) {
  const prefixe = type === "collecteur" ? "COL" : "MBR";
  const code = genererCodeParrain(prefixe);
  await setDoc(doc(db, "codes_parrainage", code), {
    proprietaire_id: state.currentUser.uid,
    type,
    actif: true,
    date_creation: serverTimestamp(),
  });
  ouvrirModal(`
    <h2>Code généré</h2>
    <p class="subtitle-sm">Transmettez ce code au futur ${type === "collecteur" ? "collecteur" : "membre"}. Il devra le saisir lors de son inscription.</p>
    <div class="code-display">${code}</div>
    <div class="modal-actions"><button class="btn btn-primary" id="modal-fermer-code" style="flex:1;">Terminé</button></div>
  `);
  document.getElementById("modal-fermer-code").addEventListener("click", fermerModal);
}

function renderConfirmations() {
  const container = document.getElementById("liste-confirmations");
  if (!container) return;

  const enAttente = state.payments.filter((p) => p.statut === "collecte");

  if (enAttente.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucun versement en attente de confirmation.</p>`;
    return;
  }

  container.innerHTML = enAttente.map((p) => {
    const membre = state.users.find((u) => u.uid === p.membre_id);
    const collecteur = state.users.find((u) => u.uid === p.collecteur_id);
    return `
      <div class="entity-card" data-id="${p.id}">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${membre ? membre.nom : "Membre inconnu"}</p>
            <p class="entity-sub">Jour ${p.jour_numero} · collecté par ${collecteur ? collecteur.nom : "—"}</p>
          </div>
          <span class="badge badge-suspendu">${formatGNF(p.montant)}</span>
        </div>
        <div class="entity-actions">
          <button class="btn btn-primary btn-sm" data-action="confirmer" data-id="${p.id}">Confirmer</button>
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("liste-confirmations")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action='confirmer']");
  if (!btn) return;
  const id = btn.dataset.id;
  try {
    await updateDoc(doc(db, "payments", id), {
      statut: "confirme",
      date_confirmation: serverTimestamp(),
    });
    notifier("Versement confirmé.", "succes");
  } catch (err) {
    console.error(err);
    notifier("Erreur : " + err.message, "erreur");
  }
});

function infoTypeRetrait(type) {
  const infos = {
    'pret': { libelle: 'Prêt (2%/semaine)', classe: 'badge-suspendu', actionLabel: 'Valider comme prêt' },
    'solde_contrat_termine': { libelle: 'Solde de contrat terminé', classe: 'badge-actif', actionLabel: 'Confirmer' },
    'retrait_final': { libelle: 'Retrait final (clôture)', classe: 'badge-licencie', actionLabel: 'Confirmer' },
  };
  return infos[type] || { libelle: 'Retrait d\'épargne', classe: 'badge-actif', actionLabel: 'Confirmer' };
}

function renderRetraits() {
  const container = document.getElementById("liste-retraits");
  if (!container) return;

  if (state.retraits.length === 0) {
    container.innerHTML = `<p class="empty-state">Aucune demande de retrait en attente.</p>`;
    return;
  }

  container.innerHTML = state.retraits.map((r) => {
    const membre = state.users.find((u) => u.uid === r.memberId);
    const info = infoTypeRetrait(r.type);
    return `
      <div class="entity-card" data-id="${r.id}">
        <div class="entity-card-top">
          <div>
            <p class="entity-nom">${membre ? membre.nom : r.memberName || "Membre inconnu"}</p>
            <p class="entity-sub">${info.libelle}</p>
          </div>
          <span class="badge ${info.classe}">${formatGNF(r.montant)}</span>
        </div>
        <div class="entity-actions">
          <button class="btn btn-primary btn-sm" data-action="traiter-retrait" data-id="${r.id}">${info.actionLabel}</button>
        </div>
      </div>
    `;
  }).join("");
}

document.getElementById("liste-retraits")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action='traiter-retrait']");
  if (!btn) return;
  const id = btn.dataset.id;
  const retrait = state.retraits.find((r) => r.id === id);
  if (!retrait) return;
  const info = infoTypeRetrait(retrait.type);

  ouvrirModalConfirmation(
    `${info.actionLabel} ce retrait ?`,
    `Montant : ${formatGNF(retrait.montant)} · Type : ${info.libelle}`,
    async () => {
      try {
        if (retrait.type === "pret") {
          const contrat = state.contracts.find((c) => c.id === retrait.contractId);
          const collecteurId = contrat ? contrat.collecteur_id : (state.users.find((u) => u.uid === retrait.memberId)?.parrain_id || null);

          await addDoc(collection(db, "prets"), {
            membre_id: retrait.memberId,
            collecteur_id: collecteurId,
            contract_id: retrait.contractId || null,
            montant_initial: retrait.montant,
            taux_hebdo: 0.02,
            statut: "actif",
            interet_deja_reconnu: 0,
            date_debut: serverTimestamp(),
            pdg_id: state.currentUser.uid,
          });

          await updateDoc(doc(db, "withdrawalRequests", id), {
            statut: "confirme",
            date_confirmation: serverTimestamp(),
          });

          notifier("Prêt validé et enregistré.", "succes");
        } else if (retrait.type === "retrait_final") {
          await updateDoc(doc(db, "withdrawalRequests", id), {
            statut: "confirme",
            date_confirmation: serverTimestamp(),
          });

          if (retrait.contractId) {
            await updateDoc(doc(db, "contracts", retrait.contractId), {
              statut: "cloture",
              epargne_soldee: true,
            });
          }

          await addDoc(collection(db, "propositions_reconduction"), {
            membre_id: retrait.memberId,
            contrat_precedent_id: retrait.contractId || null,
            statut: "en_attente",
            date_creation: serverTimestamp(),
          });

          notifier("Retrait confirmé, contrat clôturé. Le membre peut choisir de reconduire.", "succes");
        } else {
          await updateDoc(doc(db, "withdrawalRequests", id), {
            statut: "confirme",
            date_confirmation: serverTimestamp(),
          });

          const contratsNonSoldes = trouverContratsNonSoldes(retrait.memberId, null);
          for (const contrat of contratsNonSoldes) {
            await updateDoc(doc(db, "contracts", contrat.id), { epargne_soldee: true });
          }

          notifier("Retrait traité.", "succes");
        }
        fermerModal();
      } catch (err) {
        console.error(err);
        notifier("Erreur : " + err.message, "erreur");
      }
    }
  );
});

// --- Réinitialisation complète (PDG y compris) — retour à l'écran de création d'entreprise ---
async function reinitialiserTout() {
  const collectionsASupprimer = [
    "users", "contracts", "payments", "decaissements",
    "membres_en_attente_validation", "withdrawalRequests",
    "prets", "remboursements_prets", "versements_collecteur",
    "interets_prets_repartis", "codes_parrainage", "propositions_reconduction",
  ];

  try {
    for (const nomCollection of collectionsASupprimer) {
      const snap = await getDocs(collection(db, nomCollection));
      for (const d of snap.docs) {
        await deleteDoc(doc(db, nomCollection, d.id));
      }
    }
    await deleteDoc(doc(db, "entreprise", "info"));

    state.unsubscribers.forEach((u) => u());
    state.unsubscribers = [];
    state.entreprise = null;
    state.currentUser = null;

    try {
      if (auth.currentUser) await auth.currentUser.delete();
    } catch (e) {
      // Si la suppression du compte Auth échoue (session ancienne), on se contente de se déconnecter
    }
    try { await signOut(auth); } catch (e) { /* déjà déconnecté si le compte Auth a été supprimé */ }

    notifier("Application réinitialisée. Redémarrage...", "succes");
    setTimeout(() => window.location.reload(), 1500);
  } catch (err) {
    console.error(err);
    notifier("Erreur lors de la réinitialisation : " + err.message, "erreur");
  }
}

document.getElementById("btn-reinitialiser-tout")?.addEventListener("click", () => {
  ouvrirModal(`
    <h2 style="color:#c0392b;">⚠️ Réinitialiser complètement l'application ?</h2>
    <p class="subtitle-sm">Cette action supprimera <b>définitivement</b> toutes les données : entreprise, PDG, collecteurs, membres, contrats, versements, prêts, retraits. L'application redémarrera comme à l'installation. Cette action est <b>irréversible</b>.</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost-sm" id="modal-annuler" style="flex:1;">Annuler</button>
      <button type="button" class="btn btn-danger" id="modal-confirmer-reset-1" style="flex:1;">Continuer</button>
    </div>
  `);
  document.getElementById("modal-annuler").addEventListener("click", fermerModal);
  document.getElementById("modal-confirmer-reset-1").addEventListener("click", () => {
    ouvrirModal(`
      <h2 style="color:#c0392b;">⚠️ Dernière confirmation</h2>
      <p class="subtitle-sm">Toutes les données seront supprimées et l'application redémarrera comme neuve. Confirmez-vous ?</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost-sm" id="modal-annuler-2" style="flex:1;">Annuler</button>
        <button type="button" class="btn btn-danger" id="modal-confirmer-reset-2" style="flex:1;">Oui, tout supprimer</button>
      </div>
    `);
    document.getElementById("modal-annuler-2").addEventListener("click", fermerModal);
    document.getElementById("modal-confirmer-reset-2").addEventListener("click", async () => {
      fermerModal();
      await reinitialiserTout();
    });
  });
});

demarrer();
