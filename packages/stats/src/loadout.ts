/**
 * Sorts d'invocateur et runes, lus dans le détail de partie.
 *
 * Contrairement à l'ordre de build, ces données n'exigent aucune timeline :
 * elles s'accumulent donc sur toutes les parties collectées.
 */

import type { ParticipantDto } from '@laneform/riot-client';

export interface RuneSetup {
  /** Rune clé : premier choix de la branche principale. */
  keystoneId: number;
  primaryStyleId: number;
  subStyleId: number;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Paire de sorts, triée.
 *
 * Le tri rend la clé stable : l'ordre des emplacements varie d'un joueur à
 * l'autre sans que le choix soit différent.
 */
export function spellPair(participant: ParticipantDto): [number, number] | null {
  const a = num(participant['summoner1Id']);
  const b = num(participant['summoner2Id']);
  if (a <= 0 || b <= 0) return null;
  return a <= b ? [a, b] : [b, a];
}

export function spellPairKey(pair: readonly [number, number]): string {
  return `${pair[0]}+${pair[1]}`;
}

/**
 * Rune clé et branches.
 *
 * Volontairement limité à ces trois identifiants plutôt qu'à la page
 * complète : neuf choix produiraient des milliers de combinaisons distinctes,
 * et aucune n'atteindrait un effectif exploitable. La rune clé et les deux
 * branches sont de toute façon ce qu'on regarde au draft.
 */
export function runeSetup(participant: ParticipantDto): RuneSetup | null {
  const perks = participant['perks'];
  if (typeof perks !== 'object' || perks === null) return null;

  const styles = (perks as Record<string, unknown>)['styles'];
  if (!Array.isArray(styles)) return null;

  let primaryStyleId = 0;
  let subStyleId = 0;
  let keystoneId = 0;

  for (const raw of styles) {
    if (typeof raw !== 'object' || raw === null) continue;
    const style = raw as Record<string, unknown>;
    const description = style['description'];
    const styleId = num(style['style']);

    if (description === 'primaryStyle') {
      primaryStyleId = styleId;
      const selections = style['selections'];
      if (Array.isArray(selections) && selections.length > 0) {
        const first = selections[0];
        if (typeof first === 'object' && first !== null) {
          keystoneId = num((first as Record<string, unknown>)['perk']);
        }
      }
    } else if (description === 'subStyle') {
      subStyleId = styleId;
    }
  }

  // Une page incomplète ne décrit aucun choix : mieux vaut l'ignorer que de
  // créer une entrée à zéro qui remonterait en tête des classements.
  if (keystoneId <= 0 || primaryStyleId <= 0 || subStyleId <= 0) return null;
  return { keystoneId, primaryStyleId, subStyleId };
}

/**
 * Toutes les runes retenues : les choix des deux branches et les fragments.
 *
 * Comptées INDIVIDUELLEMENT, et non comme une page entière. Les neuf choix
 * combinés produiraient des milliers de clés distinctes dont aucune
 * n'atteindrait un effectif exploitable, alors que « cette rune est prise
 * dans 72 % des parties » reste lisible dès quelques dizaines d'observations.
 */
export function allPerks(participant: ParticipantDto): number[] {
  const perks = participant['perks'];
  if (typeof perks !== 'object' || perks === null) return [];
  const root = perks as Record<string, unknown>;

  const out: number[] = [];

  const styles = root['styles'];
  if (Array.isArray(styles)) {
    for (const raw of styles) {
      if (typeof raw !== 'object' || raw === null) continue;
      const selections = (raw as Record<string, unknown>)['selections'];
      if (!Array.isArray(selections)) continue;
      for (const selection of selections) {
        if (typeof selection !== 'object' || selection === null) continue;
        const id = num((selection as Record<string, unknown>)['perk']);
        if (id > 0) out.push(id);
      }
    }
  }

  // Fragments : trois valeurs nommées plutôt qu'un tableau.
  const stats = root['statPerks'];
  if (typeof stats === 'object' && stats !== null) {
    for (const value of Object.values(stats as Record<string, unknown>)) {
      const id = num(value);
      if (id > 0) out.push(id);
    }
  }

  // Dédoublonné : un même identifiant ne doit pas compter deux fois pour une
  // seule partie.
  return [...new Set(out)];
}

export function runeKey(setup: RuneSetup): string {
  return `${setup.primaryStyleId}:${setup.keystoneId}:${setup.subStyleId}`;
}

export function parseRuneKey(key: string): RuneSetup | null {
  const parts = key.split(':').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return { primaryStyleId: parts[0]!, keystoneId: parts[1]!, subStyleId: parts[2]! };
}
