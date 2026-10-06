import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { emptyStore, pruneStalePatches, repairBuildOrder, type AggregateStore } from '@laneform/stats';

/**
 * Persistance des agrégats, dans un simple fichier JSON.
 *
 * Pas de base de données : on écrit quelques mégaoctets de compteurs toutes
 * les minutes, et on les relit une fois au démarrage. SQLite n'apporterait
 * rien ici, et ajouterait une dépendance native à compiler pour Windows.
 */
export class AggregateFile {
  private readonly path: string;
  private dirty = false;

  constructor(
    userDataDir: string,
    readonly store: AggregateStore = emptyStore(),
  ) {
    this.path = join(userDataDir, 'aggregates.json');
  }

  private static read(path: string): AggregateStore | null {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as AggregateStore;
      // Un fichier d'une version antérieure est écarté plutôt que migré :
      // ce sont des statistiques, pas des données irremplaçables.
      if (parsed?.version === 1 && parsed.patches && Array.isArray(parsed.seen)) {
        // Auto-réparation au chargement : des relevés d'ordre vides bloqueraient
        // définitivement la collecte de timelines pour ces champions.
        repairBuildOrder(parsed);
        return parsed;
      }
    } catch {
      // Absent ou corrompu.
    }
    return null;
  }

  /**
   * Charge la collecte locale, ou à défaut l'amorce livrée avec l'application.
   *
   * L'amorce n'est utilisée que si l'utilisateur n'a RIEN : on ne veut ni
   * l'écraser, ni la fusionner. Fusionner gonflerait les compteurs, puisque
   * deux collectes indépendantes croisent forcément les mêmes parties et que
   * la liste de dédoublonnage est plafonnée.
   */
  static load(userDataDir: string, seedPath?: string): AggregateFile {
    const local = AggregateFile.read(join(userDataDir, 'aggregates.json'));
    if (local) return new AggregateFile(userDataDir, local);

    if (seedPath) {
      const seed = AggregateFile.read(seedPath);
      if (seed) {
        const file = new AggregateFile(userDataDir, seed);
        // Écrit tout de suite : au prochain démarrage c'est une collecte
        // locale ordinaire, et l'amorce ne sert plus.
        file.flush(true);
        return file;
      }
    }

    return new AggregateFile(userDataDir);
  }

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Remplace le contenu par celui d'un autre agrégat.
   *
   * Mute l'objet existant au lieu d'en créer un neuf : le collecteur garde une
   * référence vers ce `store`, un échange d'objet le laisserait écrire dans
   * l'ancien jusqu'au prochain démarrage.
   *
   * Remplacement et non fusion : additionner deux collectes qui partagent une
   * base commune compterait deux fois les parties communes, et les compteurs
   * agrégés ne permettent pas de défaire cet apport.
   */
  replaceWith(incoming: AggregateStore): void {
    this.store.patches = incoming.patches;
    this.store.seen = incoming.seen;
    this.dirty = true;
    this.flush(true);
  }

  /** Lecture validée d'un fichier d'agrégats arbitraire. */
  static readFile(path: string): AggregateStore | null {
    return AggregateFile.read(path);
  }

  /**
   * Écriture atomique : fichier temporaire puis renommage.
   *
   * Une coupure pendant l'écriture laisserait sinon un JSON tronqué, et toute
   * la collecte accumulée serait perdue au prochain démarrage.
   */
  flush(force = false): boolean {
    if (!this.dirty && !force) return false;
    pruneStalePatches(this.store);
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.store), 'utf8');
      renameSync(tmp, this.path);
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }
}
