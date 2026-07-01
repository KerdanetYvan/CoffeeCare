---
description: Prépare une nouvelle release Cleaner PC (docs + tag) et déclenche le build/publish CI
---

Tu prépares une nouvelle release de Cleaner PC. Suis ces étapes dans l'ordre, sans sauter la pause de confirmation avant le push (un tag poussé déclenche une publication GitHub publique, difficile à annuler proprement).

1. **Lire la version cible** : lis le champ `version` de `package.json` (ex. `0.1.0-alpha.2`).

2. **Vérifier qu'elle n'est pas déjà publiée** : lance `git tag -l "v<version>"`. Si le tag existe déjà, arrête-toi et préviens l'utilisateur — il a probablement oublié de bumper `package.json`, ou la release existe déjà.

3. **Identifier ce qui a changé** : trouve le tag précédent le plus récent (`git describe --tags --abbrev=0` ou équivalent) et regarde `git log <tag-précédent>..HEAD --oneline` ainsi que les diffs pertinents pour comprendre les changements notables côté utilisateur depuis la dernière release (nouvelles fonctionnalités, corrections, changements de comportement). Ignore le bruit purement technique (refactors internes, config de tooling) sauf s'il a un impact visible.

4. **Mettre à jour `CHANGELOG.md`** : insère une nouvelle section en tête du fichier (juste après le `---` d'introduction), au format Keep a Changelog déjà en place :
   ```
   ## [<version>] — <date du jour, format YYYY-MM-DD>

   <tagline courte en une phrase, comme "Première version alpha publique.">

   ### Ajouté
   - ...

   ### Modifié
   - ...

   ### Corrigé
   - ...

   ### Connu
   - ...
   ```
   N'inclus que les catégories pertinentes (ne mets pas de section vide). Reste dans le ton et le niveau de détail de l'entrée `[0.1.0-alpha.1]` déjà présente — grand public, sans jargon technique, cohérent avec les règles de `CLAUDE.md` sur le vocabulaire utilisateur.

5. **Vérifier `README.md`** : si le tableau "Fonctionnalités" ou toute autre section ne reflète plus l'état réel de l'app (nouveau module, changement de statut), mets-le à jour. Sinon ne touche à rien.

6. **Vérifier `docs/PRESENTATION.md`** : ce fichier est un pitch marketing évergreen, pas régénéré à chaque release. Ne le modifie que si une nouveauté majeure de cette version change fondamentalement le pitch produit (nouveau module phare, repositionnement). Dans le doute, laisse-le tel quel.

7. **Résumer et faire confirmer les docs** : montre à l'utilisateur un résumé clair (diff) des fichiers modifiés (`CHANGELOG.md`, éventuellement `README.md`/`docs/PRESENTATION.md`).

8. **Commit local** : une fois les docs validées, commit avec un message du style `docs: prépare la release v<version>` (fichiers doc uniquement, pas de `git add -A`).

9. **Pause obligatoire avant publication** : arrête-toi ici. Résume clairement ce qui va se passer si l'utilisateur confirme :
   - création du tag annoté `v<version>`
   - `git push` (le commit) puis `git push origin v<version>` (le tag)
   - ce push déclenche `.github/workflows/release.yml` qui va builder l'installeur Windows et publier une release GitHub publique avec les artefacts.
   Demande une confirmation explicite avant de continuer. Ne pousse jamais sans cette confirmation, même si l'utilisateur semble pressé.

10. **Sur confirmation** : crée le tag (`git tag -a v<version> -m "Cleaner PC v<version>"`), pousse le commit puis le tag.

11. **Rapporter** : donne le lien vers l'exécution du workflow (`gh run list --workflow=release.yml --limit=1` ou lien direct `https://github.com/<owner>/<repo>/actions`) et, une fois le workflow terminé, le lien vers la page de release (`https://github.com/<owner>/<repo>/releases/tag/v<version>`).
