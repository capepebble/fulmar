// Au démarrage du serveur : dans la console du projet, tant que personne n'a choisi de mot de
// passe, le code d'installation s'écrit dans le journal du conteneur, que seul l'administrateur
// du NAS lit (Container Manager, projet, Journal).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { authStore, passwordMode } = await import("@/lib/auth");
  if (!passwordMode()) return;
  const { formatInstallCode } = await import("@/lib/auth/store");
  const code = authStore().installCode();
  if (code) {
    // Le journal ne connaît pas la langue de l'administrateur : les deux.
    const shown = formatInstallCode(code);
    console.log(
      `Console install code: ${shown} (enter it on the welcome page).`,
    );
    console.log(
      `Code d'installation de la console : ${shown} (à saisir sur la page de bienvenue).`,
    );
  }
}
