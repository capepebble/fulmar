import type { SpecDef } from "./specs";

// Les 26 contrôles ajoutés par l'agent le 2026-11-26 (conceptions
// 2026-11-26-meilleur-produit et 2026-11-26-failles-fin-de-vie), mêmes textes que l'agent,
// seuils par défaut. `AGENT_ORDER` donne l'ordre de l'agent pour les 47 contrôles.

export const AGENT_ORDER = [
  "system.reachable",
  "system.cpu",
  "system.memory",
  "system.temperature",
  "system.ntp",
  "updates.dsm",
  "updates.packages",
  "updates.reboot",
  "updates.advisories",
  "updates.lifecycle",
  "accounts.admin_two_factor",
  "accounts.builtin_admin",
  "accounts.guest",
  "accounts.password_policy",
  "accounts.protection",
  "access.ssh",
  "access.telnet",
  "access.firewall",
  "access.auto_block",
  "access.quickconnect",
  "access.smb1",
  "access.cleartext",
  "access.https",
  "access.logins",
  "certificates.validity",
  "backup.recent_success",
  "backup.last_result",
  "backup.integrity",
  "backup.offsite",
  "backup.coverage",
  "backup.encryption",
  "backup.abb_devices",
  "backup.cloud_accounts",
  "backup.abb_offsite",
  "storage.volume_usage",
  "storage.disks",
  "storage.pools",
  "storage.disk_wear",
  "storage.smart_tests",
  "storage.scrubbing",
  "storage.redundancy",
  "containers.state",
  "ups.configured",
  "security_advisor.critical",
  "shares.recycle_bin",
  "shares.snapshots",
  "shares.file_activity",
];

export const MORE_DEFS: SpecDef[] = [
  {
    id: "system.reachable",
    title: { en: "DSM reachable", fr: "DSM joignable" },
    short: { en: "Online", fr: "En ligne" },
    severity: "high",
    expected: {
      en: "DSM answers the agent; an alert after 5 min of silence.",
      fr: "DSM répond à l'agent ; une alerte au bout de 5 min de silence.",
    },
    advice: {
      en: "Check that the NAS is on and connected (cable, router, power cut), then that DSM answers on its address.",
      fr: "Vérifier que le NAS est allumé et sur le réseau (câble, box, coupure de courant), puis que DSM répond sur son adresse.",
    },
    sources: ["system.info"],
  },
  {
    id: "system.cpu",
    title: { en: "Processor", fr: "Processeur" },
    short: { en: "CPU", fr: "Proc." },
    severity: "medium",
    expected: {
      en: "Processor below 90 % on average over 15 min.",
      fr: "Processeur sous 90 % en moyenne sur 15 min.",
    },
    advice: {
      en: "Find what keeps the processor busy (Resource Monitor, containers, photo indexing); a lasting load slows the whole NAS.",
      fr: "Chercher ce qui occupe le processeur (Moniteur de ressources, conteneurs, indexation des photos) ; une charge durable ralentit tout le NAS.",
    },
    sources: ["system.utilization"],
  },
  {
    id: "system.memory",
    title: { en: "Memory", fr: "Mémoire" },
    short: { en: "RAM", fr: "Mém." },
    severity: "medium",
    expected: {
      en: "Memory below 90 % on average over 15 min.",
      fr: "Mémoire sous 90 % en moyenne sur 15 min.",
    },
    advice: {
      en: "Stop what is not needed (packages, containers) or add memory: a NAS short of memory swaps to its disks and slows down.",
      fr: "Arrêter ce qui ne sert pas (paquets, conteneurs) ou ajouter de la mémoire : un NAS à court de mémoire écrit sur ses disques et ralentit.",
    },
    sources: ["system.utilization"],
  },
  {
    id: "system.temperature",
    title: { en: "Temperatures", fr: "Températures" },
    short: { en: "Temp.", fr: "Temp." },
    severity: "high",
    expected: {
      en: "Disks below 50 °C (failure at 60 °C), system below 70 °C.",
      fr: "Disques sous 50 °C (échec à 60 °C), système sous 70 °C.",
    },
    advice: {
      en: "Clear the vents, dust the NAS, check the fans and the room: heat wears disks out.",
      fr: "Dégager les aérations, dépoussiérer, vérifier les ventilateurs et la pièce : la chaleur use les disques.",
    },
    sources: ["system.info", "storage.overview"],
  },
  {
    id: "system.ntp",
    title: { en: "NAS clock", fr: "Heure du NAS" },
    short: { en: "Clock", fr: "Heure" },
    severity: "medium",
    expected: {
      en: "Clock synchronized with an NTP server.",
      fr: "Heure synchronisée avec un serveur NTP.",
    },
    advice: {
      en: "Turn on synchronization with an NTP server (Control Panel, Regional Options, Time).",
      fr: "Activer la synchronisation avec un serveur NTP (Panneau de configuration, Options régionales, Heure).",
    },
    sources: ["system.time"],
  },
  {
    id: "updates.reboot",
    title: { en: "Restart pending", fr: "Redémarrage en attente" },
    short: { en: "Restart", fr: "Redém." },
    severity: "medium",
    expected: {
      en: "No update waiting for a restart.",
      fr: "Aucune mise à jour n'attend de redémarrage.",
    },
    advice: {
      en: "Restart the NAS at a quiet time, after a backup.",
      fr: "Redémarrer le NAS à un moment calme, après une sauvegarde.",
    },
    sources: ["dsm.update"],
  },
  {
    id: "accounts.password_policy",
    title: { en: "Passwords", fr: "Mots de passe" },
    short: { en: "Passw.", fr: "Mots de p." },
    severity: "medium",
    expected: {
      en: "At least 10 characters, common passwords refused.",
      fr: "Au moins 10 caractères, mots de passe courants refusés.",
    },
    advice: {
      en: "Harden the policy (Control Panel, User & Group, Advanced): at least 12 characters, and refuse common passwords.",
      fr: "Durcir la politique (Panneau de configuration, Utilisateur et groupe, Avancé) : au moins 12 caractères, et refuser les mots de passe courants.",
    },
    sources: ["security.settings"],
  },
  {
    id: "accounts.protection",
    title: { en: "Account protection", fr: "Protection des comptes" },
    short: { en: "Lockout", fr: "Blocage" },
    severity: "medium",
    expected: {
      en: "An account is blocked after repeated failures.",
      fr: "Un compte se bloque après des échecs répétés.",
    },
    advice: {
      en: "Turn account protection on (Control Panel, Security, Account).",
      fr: "Activer la protection des comptes (Panneau de configuration, Sécurité, Compte).",
    },
    sources: ["security.settings"],
  },
  {
    id: "access.smb1",
    title: { en: "SMB1", fr: "SMB1" },
    short: { en: "SMB1", fr: "SMB1" },
    severity: "high",
    expected: { en: "SMB1 and NTLMv1 refused.", fr: "SMB1 et NTLMv1 refusés." },
    advice: {
      en: "Set the minimum SMB protocol to SMB2 (Control Panel, File Services, SMB, Advanced Settings).",
      fr: "Passer le protocole SMB minimal à SMB2 (Panneau de configuration, Services de fichiers, SMB, Paramètres avancés).",
    },
    sources: ["services.list"],
  },
  {
    id: "access.cleartext",
    title: { en: "Unencrypted services", fr: "Services sans chiffrement" },
    short: { en: "Clear", fr: "En clair" },
    severity: "medium",
    expected: {
      en: "No FTP without TLS, rsync in daemon mode, SNMP v1 or v2c, or AFP.",
      fr: "Ni FTP sans TLS, ni rsync en mode démon, ni SNMP v1 ou v2c, ni AFP.",
    },
    advice: {
      en: "Replace FTP with FTPS or SFTP, rsync with rsync over SSH, SNMP v1/v2c with SNMP v3, AFP with SMB (Control Panel, File Services, Terminal & SNMP).",
      fr: "Remplacer FTP par FTPS ou SFTP, rsync par rsync sur SSH, SNMP v1/v2c par SNMP v3, AFP par SMB (Panneau de configuration, Services de fichiers, Terminal et SNMP).",
    },
    sources: ["services.list"],
  },
  {
    id: "access.https",
    title: { en: "DSM over HTTPS", fr: "DSM en HTTPS" },
    short: { en: "HTTPS", fr: "HTTPS" },
    severity: "medium",
    expected: {
      en: "DSM redirects HTTP to HTTPS.",
      fr: "DSM redirige HTTP vers HTTPS.",
    },
    advice: {
      en: "Turn on automatic redirection to HTTPS (Control Panel, Login Portal, DSM).",
      fr: "Activer la redirection automatique vers HTTPS (Panneau de configuration, Portail de connexion, DSM).",
    },
    sources: ["services.list"],
  },
  {
    id: "access.logins",
    title: { en: "Failed sign-ins", fr: "Échecs de connexion" },
    short: { en: "Sign-ins", fr: "Connex." },
    severity: "high",
    expected: {
      en: "Fewer than 10 failures in 24 h, never 20 within 10 minutes.",
      fr: "Moins de 10 échecs en 24 h, jamais 20 en 10 minutes.",
    },
    advice: {
      en: "See where the attempts come from (Log Center, Connections); block the address, close the Internet access it uses, enforce two-factor authentication.",
      fr: "Voir d'où viennent les essais (Centre des journaux, Connexions) ; bloquer l'adresse, fermer l'accès depuis Internet qu'elle utilise, imposer la double authentification.",
    },
    sources: ["security.logins"],
  },
  {
    id: "backup.offsite",
    title: { en: "A copy off the NAS", fr: "Une copie hors du NAS" },
    short: { en: "Off-site", fr: "Ailleurs" },
    severity: "high",
    expected: {
      en: "At least one task backs up off the NAS (another NAS, Synology C2, cloud).",
      fr: "Au moins une tâche sauvegarde hors du NAS (autre NAS, Synology C2, nuage).",
    },
    advice: {
      en: "Add a Hyper Backup task to another NAS, Synology C2 or cloud storage: the 3-2-1 rule wants one copy elsewhere.",
      fr: "Ajouter une tâche Hyper Backup vers un autre NAS, Synology C2 ou un stockage en ligne : la règle 3-2-1 veut une copie ailleurs.",
    },
    sources: ["backup.hyperbackup.tasks"],
  },
  {
    id: "backup.coverage",
    title: { en: "Backed-up folders", fr: "Dossiers sauvegardés" },
    short: { en: "Folders", fr: "Dossiers" },
    severity: "medium",
    expected: {
      en: "Every shared folder is in a backup.",
      fr: "Chaque dossier partagé est dans une sauvegarde.",
    },
    advice: {
      en: "Add these folders to a Hyper Backup task, or back them up another way.",
      fr: "Ajouter ces dossiers à une tâche Hyper Backup, ou les sauvegarder autrement.",
    },
    sources: ["backup.hyperbackup.tasks", "shares.list"],
  },
  {
    id: "backup.encryption",
    title: { en: "Encrypted copies", fr: "Copies chiffrées" },
    short: { en: "Encrypt.", fr: "Chiffr." },
    severity: "medium",
    expected: {
      en: "Every copy off the NAS is encrypted client-side.",
      fr: "Chaque copie hors du NAS est chiffrée côté client.",
    },
    advice: {
      en: "Recreate the task with client-side encryption: elsewhere, only this encryption protects the data from whoever holds the storage.",
      fr: "Recréer la tâche avec le chiffrement côté client : ailleurs, seul ce chiffrement protège les données de qui détient le stockage.",
    },
    sources: ["backup.hyperbackup.tasks"],
  },
  {
    id: "updates.advisories",
    title: { en: "Known Synology flaws", fr: "Failles connues de Synology" },
    short: { en: "Flaws", fr: "Failles" },
    severity: "high",
    expected: {
      en: "No flaw published by Synology affects the DSM version or the installed packages.",
      fr: "Aucune faille publiée par Synology ne touche la version de DSM ni les paquets installés.",
    },
    advice: {
      en: "Install the update that fixes it (Control Panel, Update & Restore; Package Center for a package), critical flaws first.",
      fr: "Installer la mise à jour qui corrige (Panneau de configuration, Mise à jour et restauration ; Centre de paquets pour un paquet), en commençant par les failles critiques.",
    },
    sources: ["updates.synology"],
  },
  {
    id: "updates.lifecycle",
    title: {
      en: "Model support by Synology",
      fr: "Suivi du modèle par Synology",
    },
    short: { en: "Support", fr: "Suivi" },
    severity: "high",
    expected: {
      en: "Synology still publishes updates for this model.",
      fr: "Synology publie encore des mises à jour pour ce modèle.",
    },
    advice: {
      en: "Replace this NAS; until then, cut it off from the Internet (QuickConnect, ports open on the router) and keep a backup off it.",
      fr: "Remplacer ce NAS ; d'ici là, le couper d'Internet (QuickConnect, ports ouverts sur la box) et garder une sauvegarde hors de lui.",
    },
    sources: ["updates.synology"],
  },
  {
    id: "backup.abb_devices",
    title: {
      en: "Active Backup: devices backed up",
      fr: "Active Backup : appareils sauvegardés",
    },
    short: { en: "Devices", fr: "Appareils" },
    severity: "high",
    expected: {
      en: "Every device backed up successfully: servers and virtual machines less than 26 h ago, computers less than 7 days ago.",
      fr: "Chaque appareil sauvegardé avec succès : serveurs et machines virtuelles depuis moins de 26 h, postes depuis moins de 7 jours.",
    },
    advice: {
      en: "Open the task in Active Backup for Business: check that the device is on and connected to the NAS, read the log of the last backup, then run it again.",
      fr: "Ouvrir la tâche dans Active Backup for Business : vérifier que l'appareil est allumé et relié au NAS, lire le journal de la dernière sauvegarde, puis la relancer.",
    },
    sources: ["backup.activebackup"],
  },
  {
    id: "backup.cloud_accounts",
    title: {
      en: "Microsoft 365 and Google Workspace",
      fr: "Microsoft 365 et Google Workspace",
    },
    short: { en: "M365", fr: "M365" },
    severity: "high",
    expected: {
      en: "Every Active Backup for Microsoft 365 or Google Workspace task active, without errors, run less than 26 h ago or as its schedule requires.",
      fr: "Chaque tâche Active Backup for Microsoft 365 ou Google Workspace active, sans erreur, exécutée depuis moins de 26 h ou selon son planning.",
    },
    advice: {
      en: "Open the package: check the connection to the Microsoft or Google account (app permissions, service key), the destination folder, and read the task's log.",
      fr: "Ouvrir le paquet : vérifier la connexion au compte Microsoft ou Google (droits de l'application, clé de service), le dossier de destination, et lire le journal de la tâche.",
    },
    sources: ["backup.activebackup_cloud"],
  },
  {
    id: "backup.abb_offsite",
    title: {
      en: "Active Backup: copy off the NAS",
      fr: "Active Backup : copie hors du NAS",
    },
    short: { en: "ABB copy", fr: "Copie ABB" },
    severity: "medium",
    expected: {
      en: "Device backups are copied off the NAS.",
      fr: "Les sauvegardes des appareils sont copiées hors du NAS.",
    },
    advice: {
      en: "Add the @ActiveBackup folder of the folder concerned to a Hyper Backup task to another NAS or Synology C2, or replicate this folder to another NAS with Snapshot Replication (the agent does not read replication yet).",
      fr: "Ajouter le dossier @ActiveBackup du dossier en cause à une tâche Hyper Backup vers un autre NAS ou Synology C2, ou répliquer ce dossier vers un autre NAS avec Snapshot Replication (l'agent ne lit pas encore la réplication).",
    },
    sources: ["backup.activebackup", "backup.hyperbackup.tasks"],
  },
  {
    id: "storage.disk_wear",
    title: { en: "Weakening disks", fr: "Disques qui faiblissent" },
    short: { en: "Wear", fr: "Usure" },
    severity: "high",
    expected: {
      en: "No pending or uncorrectable sector, no rising reallocated sectors, SSDs above 10 % life.",
      fr: "Aucun secteur en attente ni illisible, aucun secteur réalloué en hausse, SSD à plus de 10 % de vie.",
    },
    advice: {
      en: "Watch the disk, check its cable or tray, and plan its replacement; an up-to-date backup first.",
      fr: "Surveiller le disque, vérifier son câble ou son tiroir, et prévoir son remplacement ; une sauvegarde à jour avant tout.",
    },
    sources: ["storage.smart"],
  },
  {
    id: "storage.smart_tests",
    title: { en: "SMART tests", fr: "Tests SMART" },
    short: { en: "Tests", fr: "Tests" },
    severity: "medium",
    expected: {
      en: "A scheduled SMART test, no failed test.",
      fr: "Un test SMART planifié, aucun test en échec.",
    },
    advice: {
      en: "Schedule a quick test every week and an extended test every quarter (Storage Manager, HDD/SSD, Test Scheduler).",
      fr: "Planifier un test rapide chaque semaine et un test étendu chaque trimestre (Gestionnaire de stockage, HDD/SSD, Planificateur de tests).",
    },
    sources: ["storage.smart"],
  },
  {
    id: "storage.scrubbing",
    title: { en: "Data scrubbing", fr: "Nettoyage des données" },
    short: { en: "Scrub", fr: "Nettoy." },
    severity: "medium",
    expected: {
      en: "On a redundant pool, scrubbing scheduled or done less than 180 days ago.",
      fr: "Sur un groupe redondant, nettoyage planifié ou fait depuis moins de 180 jours.",
    },
    advice: {
      en: "Schedule data scrubbing (Storage Manager, Storage, Data Scrubbing): it repairs what decays silently.",
      fr: "Planifier le nettoyage des données (Gestionnaire de stockage, Stockage, Nettoyage des données) : il répare ce qui s'abîme en silence.",
    },
    sources: ["storage.overview"],
  },
  {
    id: "storage.redundancy",
    title: { en: "Redundancy", fr: "Redondance" },
    short: { en: "RAID", fr: "RAID" },
    severity: "medium",
    expected: {
      en: "Every storage pool survives the loss of a disk.",
      fr: "Chaque groupe de stockage survit à la perte d'un disque.",
    },
    advice: {
      en: "Add a disk to move to protected SHR or RAID 1, and keep a backup off the NAS until then.",
      fr: "Ajouter un disque pour passer en SHR protégé ou en RAID 1, et garder d'ici là une sauvegarde hors du NAS.",
    },
    sources: ["storage.overview"],
  },
  {
    id: "containers.state",
    title: { en: "Containers", fr: "Conteneurs" },
    short: { en: "Contain.", fr: "Conten." },
    severity: "medium",
    expected: {
      en: "No container looping, unhealthy or stopped on its own.",
      fr: "Aucun conteneur en boucle, en mauvaise santé ou arrêté seul.",
    },
    advice: {
      en: "Open the container’s log in Container Manager and fix the cause (configuration, memory, image).",
      fr: "Ouvrir le journal du conteneur dans Container Manager et corriger la cause (configuration, mémoire, image).",
    },
    sources: ["containers.list"],
  },
  {
    id: "shares.file_activity",
    title: { en: "Mass deletions", fr: "Suppressions en masse" },
    short: { en: "Deletions", fr: "Suppr." },
    severity: "high",
    expected: {
      en: "Never 200 deletions or renames within 10 minutes by one account.",
      fr: "Jamais 200 suppressions ou renommages en 10 minutes par un même compte.",
    },
    advice: {
      en: "Cut off the account’s access right away and unplug the computer using it; then restore from a snapshot or a backup.",
      fr: "Couper sans attendre l'accès du compte en cause et débrancher le poste qui l'utilise ; puis restaurer depuis un instantané ou une sauvegarde.",
    },
    sources: ["files.activity"],
  },
];
