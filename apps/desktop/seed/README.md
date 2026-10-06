# Amorce d'agrégats

Déposer ici un `aggregates.json` pour qu'il soit embarqué dans l'installeur et
copié au premier lancement, chez un utilisateur qui n'a encore rien collecté.
Ça lui évite d'attendre un à deux jours avant d'avoir des builds affichables.

Généré par `npm run seed:update`, qui copie la collecte de la machine courante.

Les agrégats sont cloisonnés par patch : une amorce devient inutile dès que le
patch change. À régénérer et republier à chaque patch, sinon elle est ignorée.
