// ==========================
// CPCT-TINA — App Collecteur
// Partie 1 : Auth + Chargement
// ==========================

let currentUser = null;
let currentCollecteurData = null;
let membersList = [];
let withdrawalRequests = [];

const loginScreen = document.getElementById('loginScreen');
const loading = document.getElementById('loading');
const dashboard = document.getElementById('dashboard');
const loginError = document.getElementById('loginError');

// --- Connexion ---
document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  loginError.textContent = '';

  if (!email || !password) {
    loginError.textContent = 'Veuillez remplir tous les champs.';
    return;
  }

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    loginError.textContent = 'Email ou mot de passe incorrect.';
    console.error(err);
  }
});

// --- Déconnexion ---
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await signOut(auth);
});

// --- Écoute de l'état de connexion ---
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    loginScreen.classList.add('hidden');
    loading.classList.remove('hidden');
    dashboard.classList.add('hidden');

    await loadCollecteurData(user.uid);
  } else {
    currentUser = null;
    loginScreen.classList.remove('hidden');
    loading.classList.add('hidden');
    dashboard.classList.add('hidden');
  }
});

// --- Charger les données du collecteur connecté ---
async function loadCollecteurData(uid) {
  try {
    const collecteurRef = doc(db, 'collecteurs', uid);
    const collecteurSnap = await getDoc(collecteurRef);

    if (!collecteurSnap.exists()) {
      loginError.textContent = 'Compte collecteur non trouvé.';
      loading.classList.add('hidden');
      loginScreen.classList.remove('hidden');
      await signOut(auth);
      return;
    }

    currentCollecteurData = collecteurSnap.data();

    // Écoute en temps réel du solde et infos collecteur
    onSnapshot(collecteurRef, (snap) => {
      if (snap.exists()) {
        currentCollecteurData = snap.data();
        renderCollecteurHeader();
      }
    });

    listenToMembers(uid);
    listenToWithdrawalRequests(uid);

    loading.classList.add('hidden');
    dashboard.classList.remove('hidden');
    renderCollecteurHeader();

  } catch (err) {
    console.error(err);
    loading.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    loginError.textContent = 'Erreur de chargement. Réessayez.';
  }
}

// --- Affichage en-tête collecteur ---
function renderCollecteurHeader() {
  document.getElementById('collectorName').textContent =
    currentCollecteurData.nom || 'Collecteur';
  document.getElementById('collectorStats').textContent =
    `Solde commission : ${formatMontant(currentCollecteurData.soldeCollecteur || 0)}`;
}// ==========================
// Partie 2 : Membres + Paiements
// ==========================

// --- Écoute des membres assignés à ce collecteur ---
function listenToMembers(collecteurUid) {
  const membersRef = collection(db, 'membres');
  const q = query(membersRef, where('collecteurId', '==', collecteurUid));

  onSnapshot(q, (snapshot) => {
    membersList = [];
    snapshot.forEach((docSnap) => {
      membersList.push({ id: docSnap.id, ...docSnap.data() });
    });
    renderMembersList();
  });
}

// --- Affichage de la liste des membres ---
function renderMembersList() {
  const container = document.getElementById('membersList');
  container.innerHTML = '';

  if (membersList.length === 0) {
    container.innerHTML = '<p style="color:#999;">Aucun membre assigné.</p>';
    return;
  }

  membersList.forEach((membre) => {
    const statut = getStatutMembre(membre);
    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = `
      <div>
        <strong>${membre.nom}</strong><br>
        <small>Jour ${membre.jourActuel || 0}/31</small>
      </div>
      <div style="text-align:right;">
        <span class="badge ${statut.classe}">${statut.texte}</span><br>
        <button style="margin-top:6px; width:auto; padding:6px 10px; font-size:13px;"
          onclick="ouvrirPaiement('${membre.id}')">Encaisser</button>
      </div>
    `;
    container.appendChild(row);
  });
}

// --- Déterminer le statut d'un membre ---
function getStatutMembre(membre) {
  if ((membre.jourActuel || 0) >= 31) {
    return { texte: 'Terminé', classe: 'ok' };
  }
  const aujourdHui = new Date();
  const dernierPaiement = membre.dernierPaiementDate
    ? membre.dernierPaiementDate.toDate()
    : null;

  if (!dernierPaiement) {
    return { texte: 'À démarrer', classe: 'due' };
  }

  const diffJours = Math.floor((aujourdHui - dernierPaiement) / (1000 * 60 * 60 * 24));
  if (diffJours >= 2) {
    return { texte: 'En retard', classe: 'late' };
  } else if (diffJours >= 1) {
    return { texte: 'À jour', classe: 'due' };
  }
  return { texte: 'Payé aujourd\'hui', classe: 'ok' };
}

// --- Ouvrir le formulaire d'encaissement ---
function ouvrirPaiement(membreId) {
  const membre = membersList.find(m => m.id === membreId);
  if (!membre) return;

  const montant = prompt(`Montant reçu de ${membre.nom} (jour ${((membre.jourActuel || 0) + 1)}/31) :`);
  if (montant === null) return;

  const montantNum = parseFloat(montant);
  if (isNaN(montantNum) || montantNum <= 0) {
    alert('Montant invalide.');
    return;
  }

  enregistrerPaiement(membre, montantNum);
}

// --- Enregistrer le paiement + répartition commission si jour 1 ---
async function enregistrerPaiement(membre, montant) {
  try {
    const membreRef = doc(db, 'membres', membre.id);
    const nouveauJour = (membre.jourActuel || 0) + 1;
    const estPremierJour = nouveauJour === 1;

    await updateDoc(membreRef, {
      jourActuel: nouveauJour,
      dernierPaiementDate: serverTimestamp()
    });

    await addDoc(collection(db, 'paiements'), {
      membreId: membre.id,
      membreNom: membre.nom,
      collecteurId: currentUser.uid,
      montant: montant,
      jour: nouveauJour,
      date: serverTimestamp()
    });

    // Si c'est le jour 1 : répartition de la commission 30/70
    if (estPremierJour && membre.commissionContrat) {
      const commissionCollecteur = membre.commissionContrat * 0.30;
      const commissionPDG = membre.commissionContrat * 0.70;

      const collecteurRef = doc(db, 'collecteurs', currentUser.uid);
      await updateDoc(collecteurRef, {
        soldeCollecteur: (currentCollecteurData.soldeCollecteur || 0) + commissionCollecteur
      });

      // Le PDG est identifié par un champ fixe ou récupéré via config
      const pdgRef = doc(db, 'pdg', 'compte_principal');
      const pdgSnap = await getDoc(pdgRef);
      const soldeActuelPDG = pdgSnap.exists() ? (pdgSnap.data().soldeCommission || 0) : 0;
      await updateDoc(pdgRef, {
        soldeCommission: soldeActuelPDG + commissionPDG
      });
    }

    afficherRecu({
      type: 'Encaissement',
      nom: membre.nom,
      montant: montant,
      jour: nouveauJour,
      date: new Date()
    });

  } catch (err) {
    console.error(err);
    alert('Erreur lors de l\'enregistrement du paiement.');
  }
} // ==========================
// Partie 3 : Décaissements + Reçu
// ==========================

// --- Écoute des demandes de décaissement pour ce collecteur ---
function listenToWithdrawalRequests(collecteurUid) {
  const requestsRef = collection(db, 'demandesDecaissement');
  const q = query(
    requestsRef,
    where('collecteurId', '==', collecteurUid),
    where('statut', 'in', ['en_attente_collecteur'])
  );

  onSnapshot(q, (snapshot) => {
    withdrawalRequests = [];
    snapshot.forEach((docSnap) => {
      withdrawalRequests.push({ id: docSnap.id, ...docSnap.data() });
    });
    renderWithdrawalRequests();
  });
}

// --- Affichage des demandes en attente ---
function renderWithdrawalRequests() {
  let container = document.getElementById('withdrawalRequestsList');
  if (!container) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>Demandes de décaissement</h3><div id="withdrawalRequestsList"></div>`;
    document.getElementById('dashboard').insertBefore(card, document.getElementById('logoutBtn'));
    container = document.getElementById('withdrawalRequestsList');
  }

  container.innerHTML = '';

  if (withdrawalRequests.length === 0) {
    container.innerHTML = '<p style="color:#999;">Aucune demande en attente.</p>';
    return;
  }

  withdrawalRequests.forEach((demande) => {
    const row = document.createElement('div');
    row.className = 'member-row';
    const dateSouhaitee = demande.dateSouhaitee
      ? demande.dateSouhaitee.toDate().toLocaleDateString('fr-FR')
      : '—';
    row.innerHTML = `
      <div>
        <strong>${demande.demandeurNom}</strong> (${demande.typeDemandeur})<br>
        <small>${formatMontant(demande.montant)} — souhaité le ${dateSouhaitee}</small><br>
        <small>Bénéficiaire : ${demande.beneficiaire}</small>
      </div>
      <div style="text-align:right;">
        <button style="margin-top:4px; width:auto; padding:6px 10px; font-size:13px;"
          onclick="approuverDemande('${demande.id}')">Approuver</button>
        <button class="secondary" style="margin-top:4px; width:auto; padding:6px 10px; font-size:13px;"
          onclick="reporterDemande('${demande.id}')">Reporter</button>
      </div>
    `;
    container.appendChild(row);
  });
}

// --- Approuver une demande ---
async function approuverDemande(demandeId) {
  try {
    const demandeRef = doc(db, 'demandesDecaissement', demandeId);
    await updateDoc(demandeRef, {
      statut: 'approuve_collecteur',
      dateApprobationCollecteur: serverTimestamp()
    });
    alert('Demande approuvée. Le PDG doit maintenant confirmer.');
  } catch (err) {
    console.error(err);
    alert('Erreur lors de l\'approbation.');
  }
}

// --- Reporter une demande ---
async function reporterDemande(demandeId) {
  const commentaire = prompt('Raison du report (optionnel) :');
  try {
    const demandeRef = doc(db, 'demandesDecaissement', demandeId);
    await updateDoc(demandeRef, {
      statut: 'reporte',
      commentaireCollecteur: commentaire || '',
      dateReport: serverTimestamp()
    });
    alert('Demande reportée.');
  } catch (err) {
    console.error(err);
    alert('Erreur lors du report.');
  }
}

// --- Demande de décaissement de commission (par le collecteur lui-même) ---
async function demanderDecaissementCommission() {
  const montant = prompt('Montant à décaisser (votre commission) :');
  if (!montant) return;
  const montantNum = parseFloat(montant);
  if (isNaN(montantNum) || montantNum <= 0) {
    alert('Montant invalide.');
    return;
  }

  const dateSouhaitee = prompt('Date souhaitée (JJ/MM/AAAA, au moins demain) :');
  if (!dateSouhaitee) return;

  const beneficiaire = prompt('Numéro Orange Money ou "Espèces" :');
  if (!beneficiaire) return;

  try {
    await addDoc(collection(db, 'demandesDecaissement'), {
      collecteurId: currentUser.uid,
      demandeurNom: currentCollecteurData.nom,
      typeDemandeur: 'collecteur',
      montant: montantNum,
      dateSouhaitee: parseDateFr(dateSouhaitee),
      beneficiaire: beneficiaire,
      statut: 'en_attente_pdg',
      dateCreation: serverTimestamp()
    });
    alert('Demande envoyée au PDG.');
  } catch (err) {
    console.error(err);
    alert('Erreur lors de la demande.');
  }
}

// --- Affichage du reçu (fait pour la capture d'écran) ---
function afficherRecu(data) {
  const overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.top = 0;
  overlay.style.left = 0;
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.background = 'rgba(0,0,0,0.6)';
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.zIndex = 1000;

  const recu = document.createElement('div');
  recu.style.background = 'white';
  recu.style.borderRadius = '12px';
  recu.style.padding = '24px';
  recu.style.width = '85%';
  recu.style.maxWidth = '350px';
  recu.style.textAlign = 'center';

  recu.innerHTML = `
    <h2 style="color:#0d6efd;">CPCT-TINA</h2>
    <p style="color:#666; margin-bottom:12px;">Reçu de ${data.type}</p>
    <hr>
    <p style="margin:12px 0;"><strong>${data.nom}</strong></p>
    <p style="font-size:22px; color:#198754; font-weight:bold;">${formatMontant(data.montant)}</p>
    ${data.jour ? `<p>Jour ${data.jour} / 31</p>` : ''}
    <p style="color:#999; font-size:13px; margin-top:12px;">
      ${data.date.toLocaleDateString('fr-FR')} à ${data.date.toLocaleTimeString('fr-FR')}
    </p>
    <hr>
    <p style="font-size:12px; color:#aaa;">Faites une capture d'écran de ce reçu</p>
    <button style="margin-top:16px;" onclick="this.closest('div').parentElement.remove()">Fermer</button>
  `;

  overlay.appendChild(recu);
  document.body.appendChild(overlay);
}

// Ajout d'un bouton pour demander décaissement commission (ajouté au chargement)
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const dashboard = document.getElementById('dashboard');
    if (dashboard && !document.getElementById('demandeCommissionBtn')) {
      const btn = document.createElement('button');
      btn.id = 'demandeCommissionBtn';
      btn.textContent = 'Demander décaissement de ma commission';
      btn.className = 'secondary';
      btn.style.marginTop = '10px';
      btn.onclick = demanderDecaissementCommission;
      dashboard.insertBefore(btn, document.getElementById('logoutBtn'));
    }
  }, 500);
});
