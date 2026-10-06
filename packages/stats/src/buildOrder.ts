/**
 * Ordre de construction, extrait des timelines.
 *
 * Ces informations n'existent PAS dans le détail d'une partie : l'inventaire
 * final ne contient ni les objets de départ (revendus) ni l'ordre d'achat.
 * Seule la timeline porte les événements d'achat, avec leur horodatage.
 *
 * Fonctions pures : la timeline est parcourue puis jetée, seuls des compteurs
 * sont conservés.
 */

import type { TimelineDto } from '@laneform/riot-client';

/**
 * Au-delà de cet instant, un achat n'est plus un « objet de départ ».
 *
 * 90 secondes couvre l'achat au point de départ et un éventuel ajustement,
 * tout en restant avant le premier retour à la base. HEURISTIQUE : à
 * réévaluer si le rythme de début de partie change.
 */
export const STARTER_WINDOW_MS = 90_000;

/**
 * En dessous de ce coût cumulé, un objet terminé reste un composant aux yeux
 * du joueur (bottes de base, objets de soutien de début). HEURISTIQUE.
 */
export const COMPLETED_MIN_PRICE = 1600;

export interface ItemMeta {
  price: number;
  /** Vide = l'objet ne se construit en rien d'autre, donc terminé. */
  buildsInto: number[];
  consumable: boolean;
  isBoots: boolean;
}

/** Métadonnées d'objets, indexées par identifiant. */
export type ItemIndex = ReadonlyMap<number, ItemMeta>;

export interface Purchase {
  participantId: number;
  itemId: number;
  timestamp: number;
}

/**
 * Achats effectivement conservés, annulations comprises.
 *
 * `ITEM_UNDO` est indispensable : sans lui, un joueur qui achète puis annule
 * fait compter un objet qu'il n'a jamais eu. L'événement porte l'objet repris
 * dans `beforeId`.
 */
export function extractPurchases(timeline: TimelineDto): Purchase[] {
  const purchases: Purchase[] = [];

  for (const frame of timeline.info.frames ?? []) {
    for (const event of frame.events ?? []) {
      const participantId = Number(event['participantId']);
      if (!Number.isInteger(participantId)) continue;

      if (event.type === 'ITEM_PURCHASED') {
        const itemId = Number(event['itemId']);
        if (Number.isInteger(itemId) && itemId > 0) {
          purchases.push({ participantId, itemId, timestamp: event.timestamp });
        }
        continue;
      }

      if (event.type === 'ITEM_UNDO') {
        const undone = Number(event['beforeId']);
        if (!Number.isInteger(undone) || undone <= 0) continue;
        // On retire le dernier achat correspondant, pas le premier : une
        // annulation défait toujours l'achat le plus récent.
        for (let i = purchases.length - 1; i >= 0; i--) {
          const candidate = purchases[i]!;
          if (candidate.participantId === participantId && candidate.itemId === undone) {
            purchases.splice(i, 1);
            break;
          }
        }
      }
    }
  }

  return purchases;
}

function isCompleted(meta: ItemMeta | undefined): boolean {
  if (!meta || meta.consumable) return false;
  // Un objet qui se construit en autre chose est un composant, quel qu'en soit
  // le prix. Les bottes terminées comptent, elles font partie du build.
  if (meta.buildsInto.length > 0) return false;
  return meta.isBoots || meta.price >= COMPLETED_MIN_PRICE;
}

export interface ParticipantBuild {
  /** Objets achetés au point de départ, triés pour servir de clé stable. */
  starters: number[];
  /** Objets terminés, dans l'ordre d'achat. */
  completed: number[];
}

/** Reconstruit le parcours d'achats d'un joueur. */
export function buildForParticipant(
  purchases: readonly Purchase[],
  participantId: number,
  items: ItemIndex,
): ParticipantBuild {
  const mine = purchases
    .filter((p) => p.participantId === participantId)
    .sort((a, b) => a.timestamp - b.timestamp);

  const starters: number[] = [];
  const completed: number[] = [];
  const seenCompleted = new Set<number>();

  for (const purchase of mine) {
    const meta = items.get(purchase.itemId);

    if (purchase.timestamp <= STARTER_WINDOW_MS) {
      // Les consommables de départ (potions) ne caractérisent pas le choix.
      if (meta && !meta.consumable) starters.push(purchase.itemId);
      continue;
    }

    if (isCompleted(meta)) {
      // Un même objet racheté après revente ne compte qu'une fois : c'est
      // l'ordre de construction qui nous intéresse, pas les allers-retours.
      if (!seenCompleted.has(purchase.itemId)) {
        seenCompleted.add(purchase.itemId);
        completed.push(purchase.itemId);
      }
    }
  }

  return { starters: [...new Set(starters)].sort((a, b) => a - b), completed };
}

/** Clé stable d'un ensemble d'objets de départ, p.ex. « 1055+2003 ». */
export function startersKey(starters: readonly number[]): string {
  return starters.join('+');
}
